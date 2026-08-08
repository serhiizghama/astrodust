import { VIEW_W, VIEW_H, CAMERA, WORLD_SEED } from './config';
import { Display } from './core/display';
import { Input, ToolModeState, aimDirection, actionTarget } from './core/input';
import { GameLoop } from './core/loop';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import type { HudState } from './render/renderer';
import { Player } from './entities/player';
import { Inventory } from './entities/inventory';
import { LandingModule } from './entities/landing-module';
import { generateLuna } from './world/worlds/luna';
import { Simulation } from './world/simulation';
import { Digger } from './world/digging';
import { Vacuum } from './world/vacuum';
import { DebugPainter } from './world/painter';
import { MATERIALS, PORTABLE_MATERIALS } from './world/materials';
import { Soundscape } from './audio/soundscape';
import { createSignals, resetSignals } from './audio/signals';
import { PLAYER } from './config';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Канвас #game не найден');

const display = new Display(canvas);
const input = new Input(display);

const { world, spawn, surface, receiver } = generateLuna(WORLD_SEED);
const player = new Player(spawn.x, spawn.y);

const camera = new Camera(world.width, world.height);
camera.snapTo(player.centerX, player.centerY);

const renderer = new Renderer(display, world, surface, WORLD_SEED);
const simulation = new Simulation();
const digger = new Digger();
const vacuum = new Vacuum();
const painter = new DebugPainter();
const tool = new ToolModeState();
const inventory = new Inventory();
const landingModule = new LandingModule(receiver);

// Звук — читатель, а не участник: он получает счётчики уже отработавшего шага
// и ничего в мире не трогает. Снапшот сигналов переиспользуется, как и снапшот
// ввода: аллокаций на шаге нет.
const soundscape = new Soundscape();
const signals = createSignals();

let showDebug = true;
let targetInReach = false;
/**
 * Накопленное время симуляции. Орбитальный объект на заднике обязан двигаться
 * по часам, а не по номеру кадра: на 144 Гц он иначе пересекал бы небо вдвое
 * быстрее.
 */
let simTime = 0;

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function step(dt: number): void {
  simTime += dt;
  if (input.debugTogglePressed) showDebug = !showDebug;
  if (showDebug && input.debugCycleMaterialPressed) painter.cycle();

  // Переключатели читаются ДО применения инструмента: нажатие режима должно
  // менять то, что произойдёт на этом же шаге, а не на следующем.
  if (input.toolModePressed) tool.cycle();
  if (input.cycleCarriedPressed) inventory.cycleSelected();

  // Цель под курсором. Крестик всегда здесь и никуда не переезжает: он
  // указатель мыши, а не индикатор режима. Цвет крестика относится к нему же,
  // поэтому достижимость считается по курсорной цели.
  const cursor = camera.screenToWorld(input.mouseX, input.mouseY);
  const cursorX = Math.round(cursor.x);
  const cursorY = Math.round(cursor.y);
  targetInReach = Digger.inReach(player.centerX, player.centerY, cursor.x, cursor.y);

  // Направление прицела с клавиатуры. `player.facing` читается с ПРЕДЫДУЩЕГО
  // шага — копание идёт до player.update, и порядок менять нельзя (см. ниже).
  // Отставание ненаблюдаемо: facing меняется только при нажатой клавише
  // движения, а тогда направление берётся из неё же напрямую, а не из facing.
  const dir = aimDirection(input.moveAxis, input.aimAxisY, player.facing);

  // Цель инструмента и цель высыпания разведены по своим кнопкам, но правило
  // выбора у них одно: мышь целится курсором, клавиатура — направлением.
  const aim = actionTarget(
    input.mouseLeftHeld,
    cursorX,
    cursorY,
    player.centerX,
    player.centerY,
    dir.x,
    dir.y,
  );
  const dumpAim = actionTarget(
    input.mouseRightHeld,
    cursorX,
    cursorY,
    player.centerX,
    player.centerY,
    dir.x,
    dir.y,
  );

  // Отладочная установка вещества: доступна только при включённой диагностике
  // и подчиняется той же дальности, что и копание. Инструмент мышиный —
  // ставит там, где крестик.
  painter.update(
    dt,
    world,
    showDebug,
    input.debugPlaceHeld,
    player.centerX,
    player.centerY,
    cursorX,
    cursorY,
    { x: player.x, y: player.y, w: PLAYER.hitboxW, h: PLAYER.hitboxH },
  );

  // Порядок важен: инструмент меняет мир, игрок разрешает коллизии, и только
  // потом симуляция двигает материал — зная СВЕЖИЙ хитбокс персонажа.
  // При обратном порядке материал успевал бы занять ячейку, куда персонаж
  // как раз переместился, и засыпал бы его изнутри.
  //
  // Кнопка одна, а действие выбирает режим: в режиме сбора кисть копания
  // не применяется ВОВСЕ, иначе стена за кучей рушилась бы вместе с уборкой.
  const converted = digger.update(
    dt,
    world,
    input.toolHeld && tool.digging,
    player.centerX,
    player.centerY,
    aim.x,
    aim.y,
  );

  vacuum.updateSuck(
    dt,
    world,
    inventory,
    input.toolHeld && tool.collecting,
    player.centerX,
    player.centerY,
    aim.x,
    aim.y,
  );

  // Высыпание от режима не зависит: оно доступно всегда и своим органом
  // управления.
  vacuum.updateDump(
    dt,
    world,
    inventory,
    input.dumpHeld,
    player.centerX,
    player.centerY,
    dumpAim.x,
    dumpAim.y,
    { x: player.x, y: player.y, w: PLAYER.hitboxW, h: PLAYER.hitboxH },
  );

  player.update(dt, input, world);

  simulation.update(world, {
    x: player.x,
    y: player.y,
    w: PLAYER.hitboxW,
    h: PLAYER.hitboxH,
  });

  // Приёмник — ПОСЛЕ симуляции: ячейка, скатившаяся в зону на этом шаге,
  // принимается на нём же, а не через кадр. Игроку рядом с модулем задержка
  // читалась бы как «иногда не засчитывает».
  landingModule.update(world);

  // Взгляд игрока: кадр смещается в сторону ПРИЦЕЛА, показывая больше там,
  // куда смотрит игрок. Мышь целится курсором, клавиатура — направлением;
  // привязка к позиции курсора без мыши держала бы кадр перекошенным.
  const mouseAim = input.aimSource === 'mouse';
  const lookAheadX = mouseAim
    ? clamp((input.mouseX - VIEW_W / 2) * CAMERA.mouseLookAheadFactor, CAMERA.mouseLookAheadMax)
    : dir.x * CAMERA.keyLookAhead;
  const lookAheadY = mouseAim
    ? clamp((input.mouseY - VIEW_H / 2) * CAMERA.mouseLookAheadFactor, CAMERA.mouseLookAheadMax)
    : dir.y * CAMERA.keyLookAhead;
  camera.follow(player.centerX, player.centerY, lookAheadX, lookAheadY);

  // Сигналы за шаг — ПОСЛЕ того, как копание и симуляция отработали: это отчёт
  // о случившемся, а не заявка на будущее. И до `input.endStep()`, иначе
  // нажатие отключения звука было бы уже стёрто.
  //
  // Точка отсчёта слышимости — персонаж, а не центр кадра: камера уходит
  // за курсором, и звуковая картина качалась бы при каждом движении мыши.
  resetSignals(signals);
  signals.listenerX = player.centerX;
  signals.listenerY = player.centerY;
  signals.digConverted = converted;
  signals.digX = aim.x;
  signals.digY = aim.y;
  const moves = simulation.lastPowderMoves;
  signals.powderMoves = moves;
  if (moves > 0) {
    signals.powderX = simulation.lastPowderSumX / moves;
    signals.powderY = simulation.lastPowderSumY / moves;
  }

  if (input.muteTogglePressed) soundscape.toggleMute();
  soundscape.update(dt, signals, input.hasInteracted);

  // Одноразовые состояния ввода живут ровно один шаг симуляции.
  input.endStep();
}

/**
 * Снапшот состояния для строки статуса.
 *
 * Собирается на кадр, а не хранится: значения живут в инвентаре и модуле,
 * и дублировать их ради отрисовки означало бы завести второй источник правды,
 * который однажды разойдётся с первым.
 */
function hudState(): HudState {
  return {
    mode: tool.name,
    collecting: tool.collecting,
    carried: PORTABLE_MATERIALS.filter((id) => inventory.count(id) > 0).map((id) => ({
      name: MATERIALS[id]!.name,
      count: inventory.count(id),
    })),
    used: inventory.used,
    capacity: inventory.capacity,
    selected: inventory.selectedName,
    credits: landingModule.credits,
  };
}

function render(): void {
  // Крестик берётся живым из позиции курсора, а не из шага симуляции: иначе
  // на 144 Гц он отставал бы от мыши на кадр.
  renderer.render(
    camera,
    player,
    input.mouseX,
    input.mouseY,
    targetInReach,
    hudState(),
    showDebug ? loop.fps : 0,
    simTime,
    showDebug ? painter.materialName : '',
  );
}

const loop = new GameLoop(step, render);
loop.start();
