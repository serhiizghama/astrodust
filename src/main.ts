import { VIEW_W, VIEW_H, CAMERA, WORLD_SEED, BUILD_AIM_DISTANCE, PLAYER } from './config';
import { Display, Input, ToolModeState, aimDirection, actionTarget, GameLoop } from './core';
import { Camera, Renderer } from './render';
import type { HudState, GhostView, OverlayView, FrameView } from './render';
import { Research, ResearchOverlay, TECHNOLOGIES } from './progress';
import {
  Player,
  NO_INPUT,
  Inventory,
  LandingModule,
  BuildCatalogState,
  machineSummary,
} from './entities';
import { generateLuna, MATERIALS, PORTABLE_MATERIALS } from './world';
import { Digger, Vacuum, Builder, DebugPainter } from './systems';
import type { BuildPreview } from './systems';
import { Game } from './app';
import type { GameState, StepIntent } from './app';
import { Soundscape } from './audio';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Канвас #game не найден');

const display = new Display(canvas);
const input = new Input(display);

const { world, spawn, surface, receiver } = generateLuna(WORLD_SEED);

// Исследования создаются ПЕРВЫМИ: профиль настроек, который они правят,
// нужен всем, кто читает настраиваемые параметры, — персонажу и пылесосу.
// Сами исследования при этом не знают о них ничего, а они — об исследованиях:
// между ними стоит профиль, и через него проходит всё.
const research = new Research();
const overlay = new ResearchOverlay();

const player = new Player(spawn.x, spawn.y, research.tuning);

const camera = new Camera(world.width, world.height);
camera.snapTo(player.centerX, player.centerY);

const landingModule = new LandingModule(receiver, research);
const game = new Game(world, player, camera, landingModule);
const buildings = game.buildings;

const renderer = new Renderer(display, world, surface, WORLD_SEED);
const digger = new Digger();
const vacuum = new Vacuum(research.tuning);
const painter = new DebugPainter();
const tool = new ToolModeState();
const catalog = new BuildCatalogState(research);
const inventory = new Inventory();

// Звук — читатель, а не участник: он получает счётчики уже отработавшего шага
// и ничего в мире не трогает.
const soundscape = new Soundscape();

let showDebug = true;
let targetInReach = false;
/**
 * Контур будущего здания. Считается в шаге, а не в кадре: годность зависит
 * от хитбокса персонажа и счёта, а те живут по шагам симуляции.
 */
let ghost: GhostView | null = null;
/** Почему место негодно, словами. Пустая строка — годно или не строим. */
let buildIssue = '';
/**
 * Накопленное время симуляции. Орбитальный объект на заднике обязан двигаться
 * по часам, а не по номеру кадра: на 144 Гц он иначе пересекал бы небо вдвое
 * быстрее.
 */
let simTime = 0;

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/**
 * Причина отказа словами.
 *
 * Нехватка кредитов называет НЕДОСТАЮЩУЮ сумму, а не цену: цена и так стоит
 * рядом с видом постройки, а игроку нужно знать, сколько ещё донести.
 */
function placementIssueText(preview: BuildPreview, cost: number): string {
  switch (preview.issue) {
    case 'far':
      return 'слишком далеко';
    case 'funds':
      return `не хватает ${cost - landingModule.credits} ₡`;
    case 'occupied':
      return 'место занято';
    case 'unsupported':
      return 'нет опоры';
    case 'locked':
      // Недостижимо по построению: перебор каталога закрытых видов не отдаёт,
      // и выбранным закрытый вид оказаться не может. Ветка стоит здесь ради
      // полноты разбора — молчаливое «» на неизвестной причине читалось бы
      // игроком как «годно», а рамка при этом была бы красной.
      return 'не открыто';
    default:
      return '';
  }
}

/**
 * Мир: ввод принадлежит игроку целиком.
 *
 * Всё, что здесь происходит, — это ПОДГОТОВКА намерения и применение
 * инструментов, меняющих мир. Сам шаг мира идёт после, в `Game.advanceWorld`,
 * и он один на все состояния.
 */
const playState: GameState = {
  handleInput(dt: number): StepIntent {
    if (input.debugTogglePressed) showDebug = !showDebug;
    if (showDebug && input.debugCycleMaterialPressed) painter.cycle();

    // Переключатели читаются ДО применения инструмента: нажатие режима должно
    // менять то, что произойдёт на этом же шаге, а не на следующем.
    if (input.toolModePressed) tool.cycle();
    if (input.cycleCarriedPressed) inventory.cycleSelected();
    // Вид постройки перебирается своей клавишей и в любом режиме: `C` остаётся
    // за веществом инвентаря, потому что высыпание доступно всегда.
    if (input.buildKindPressed) catalog.cycle();

    // Цель под курсором. Крестик всегда здесь и никуда не переезжает: он
    // указатель мыши, а не индикатор режима.
    const cursor = camera.screenToWorld(input.mouseX, input.mouseY);
    const cursorX = Math.round(cursor.x);
    const cursorY = Math.round(cursor.y);
    targetInReach = Digger.inReach(player.centerX, player.centerY, cursor.x, cursor.y);

    // `player.facing` читается с ПРЕДЫДУЩЕГО шага — инструменты идут до
    // `player.update`, и порядок менять нельзя. Отставание ненаблюдаемо: facing
    // меняется только при нажатой клавише движения, а тогда направление берётся
    // из неё же напрямую.
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
    // и подчиняется той же дальности, что и копание.
    painter.update(
      dt,
      world,
      showDebug,
      input.debugPlaceHeld,
      player.centerX,
      player.centerY,
      cursorX,
      cursorY,
      game.occupant,
    );

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

    applyBuilding(dir, cursorX, cursorY);

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
      game.occupant,
    );

    if (input.muteTogglePressed) soundscape.toggleMute();

    // Взгляд игрока: кадр смещается в сторону ПРИЦЕЛА, показывая больше там,
    // куда смотрит игрок. Мышь целится курсором, клавиатура — направлением;
    // привязка к позиции курсора без мыши держала бы кадр перекошенным.
    const mouseAim = input.aimSource === 'mouse';
    return {
      input,
      lookAheadX: mouseAim
        ? clamp((input.mouseX - VIEW_W / 2) * CAMERA.mouseLookAheadFactor, CAMERA.mouseLookAheadMax)
        : dir.x * CAMERA.keyLookAhead,
      lookAheadY: mouseAim
        ? clamp((input.mouseY - VIEW_H / 2) * CAMERA.mouseLookAheadFactor, CAMERA.mouseLookAheadMax)
        : dir.y * CAMERA.keyLookAhead,
      dig: { converted, x: aim.x, y: aim.y },
    };
  },
};

/**
 * Строительство: контур и постановка. На НАЖАТИЕ, а не на удержание — иначе
 * одно здание ставится и сносится тридцать раз в секунду. Клавиатурная цель
 * СВОЯ и дальше копательной: при общей дистанции построить без мыши нельзя.
 */
function applyBuilding(dir: { x: number; y: number }, cursorX: number, cursorY: number): void {
  if (!tool.building) {
    ghost = null;
    buildIssue = '';
    return;
  }

  // Цель постройки следует за АКТИВНЫМ ИСТОЧНИКОМ прицела, а не за удержанием
  // кнопки, как у кистей. У кистей правило «решает удерживаемый орган» защищает
  // от прыжка цели посреди штриха; у постройки штриха нет, зато есть контур,
  // который показывается ДО нажатия. Показывать одно, а делать другое нельзя.
  const buildAim = actionTarget(
    input.aimSource === 'mouse',
    cursorX,
    cursorY,
    player.centerX,
    player.centerY,
    dir.x,
    dir.y,
    BUILD_AIM_DISTANCE,
  );
  // Клавиатурный прицел ВБОК ставит постройку на уровень ступней, а не пояса.
  // Поправка касается только бокового прицела: вверх и вниз игрок целится
  // намеренно. Мышь не трогается — у неё есть курсор.
  if (input.aimSource !== 'mouse' && dir.y === 0) {
    buildAim.y = Builder.groundedTargetY(catalog.kind, player.y, PLAYER.hitboxH);
  }

  const kind = catalog.kind;
  const preview = Builder.preview(
    world,
    buildings,
    kind,
    player.centerX,
    player.centerY,
    buildAim.x,
    buildAim.y,
    landingModule.credits,
    research,
  );
  ghost = preview;
  buildIssue = placementIssueText(preview, kind.cost);

  if (input.toolPressed) {
    Builder.apply(
      world,
      buildings,
      landingModule,
      kind,
      player.centerX,
      player.centerY,
      buildAim.x,
      buildAim.y,
      research,
    );
  }
}

/**
 * Оверлей исследований: ввод достаётся меню целиком, мир идёт дальше.
 *
 * Модальность — условие того, чтобы меню было безопасно открыть: без неё игрок
 * бежит с обрыва, пока читает дерево. Симуляция при этом НЕ останавливается —
 * паузы в модели нет, и сепаратор выдаёт порции, пока игрок выбирает.
 */
const overlayState: GameState = {
  handleInput(): StepIntent {
    overlay.handle(input, research);
    ghost = null;
    buildIssue = '';
    // Персонаж получает пустой ввод, но физику проходит: он не зависает
    // в воздухе на время чтения дерева.
    return { input: NO_INPUT, lookAheadX: 0, lookAheadY: 0, dig: null };
  },
};

function step(dt: number): void {
  simTime += dt;

  // Клавиша оверлея читается ПЕРВОЙ и в обоих состояниях: она единственная,
  // которая работает и в мире, и в меню.
  if (input.researchTogglePressed) {
    // Сброс удерживаемого — ТЕМ ЖЕ способом, что и при потере фокуса окном.
    // Клавиша, зажатая в момент открытия, иначе оставляла бы персонажа бегущим
    // всё время, пока игрок читает дерево.
    input.releaseAll();
    overlay.toggle();
  }

  const intent = (overlay.open ? overlayState : playState).handleInput(dt);
  game.advanceWorld(dt, intent);

  soundscape.update(dt, game.signals, input.hasInteracted);

  // Одноразовые состояния ввода живут ровно один шаг симуляции.
  input.endStep();
}

/**
 * Список технологий для оверлея. Собирается на кадр, а не хранится: второй
 * слепок состояния однажды разошёлся бы с ним. Причина недоступности пишется
 * СЛОВАМИ: «не хватает очков» лечится работой, «закрыта предпосылкой» — другой
 * покупкой, и какой именно, из цвета не следует.
 */
function overlayView(): OverlayView | null {
  if (!overlay.open) return null;
  return {
    points: research.points,
    selected: overlay.selectedIndex,
    rows: TECHNOLOGIES.map((tech) => {
      const status = research.status(tech);
      let note = '';
      if (status === 'poor') note = `нужно ещё ${tech.cost - research.points} ✦`;
      else if (status === 'blocked') note = `требует: ${research.missing(tech).join(', ')}`;
      else if (status === 'available') note = tech.description;
      return { name: tech.name, cost: tech.cost, status, note };
    }),
  };
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
    collectRadius: research.tuning.collectRadius,
    carried: PORTABLE_MATERIALS.filter((id) => inventory.count(id) > 0).map((id) => ({
      name: MATERIALS[id]!.name,
      count: inventory.count(id),
    })),
    used: inventory.used,
    capacity: inventory.capacity,
    selected: inventory.selectedName,
    credits: landingModule.credits,
    research: research.points,
    buildKind: tool.building ? `${catalog.name} ${catalog.kind.cost} ₡` : '',
    buildIssue: tool.building ? buildIssue : '',
    ghost,
    machines: buildings.all.map((b) => ({
      x: b.x,
      y: b.y,
      w: b.kind.width,
      h: b.kind.height,
      state: b.state,
      progress: b.progress,
    })),
    machineSummary: machineSummary(buildings),
    overlay: overlayView(),
  };
}

function render(): void {
  // Крестик берётся живым из позиции курсора, а не из шага симуляции: иначе
  // на 144 Гц он отставал бы от мыши на кадр.
  const view: FrameView = {
    camera,
    player,
    crosshairX: input.mouseX,
    crosshairY: input.mouseY,
    crosshairInReach: targetInReach,
    hud: hudState(),
    fps: showDebug ? loop.fps : 0,
    time: simTime,
    debugMaterial: showDebug ? painter.materialName : '',
  };
  renderer.render(view);
}

const loop = new GameLoop(step, render);
loop.start();
