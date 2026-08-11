import { WORLD_SEED, BUILD_AIM_DISTANCE, PLAYER } from './config';
import {
  Display,
  Input,
  ActionBarState,
  ToolMode,
  aimDirection,
  actionTarget,
  cursorSide,
  GameLoop,
} from './core';
import {
  Camera,
  Renderer,
  CanvasSurface,
  hudLayout,
  slotAtPoint,
  overBar,
  techTreeLayout,
  nodeAtPoint,
  overClose,
} from './render';
import type { HudState, HudSlot, SlotAction, GhostView, OverlayView, FrameView } from './render';
import {
  Research,
  ResearchOverlay,
  TECHNOLOGIES,
  statusNote,
  TECH_NODES,
  TECH_EDGES,
  TECH_COLS,
  TECH_ROWS,
} from './progress';
import type { PointerTarget } from './progress';
import {
  Player,
  NO_INPUT,
  Inventory,
  LandingModule,
  BuildCatalogState,
  kindLabel,
} from './entities';
import type { BuildingKind } from './entities';
import { generateLuna, MATERIALS, PORTABLE_MATERIALS } from './world';
import { Digger, Vacuum, Builder, BuildRun, DebugPainter } from './systems';
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
// Размер кадра — производная окна, поэтому камера узнаёт его от канваса,
// а не от константы. Подписка срабатывает сразу же, до `snapTo`: без размера
// камера не может ограничить кадр границами мира.
display.onViewportChange((w, h) => camera.setViewport(w, h));
camera.snapTo(player.centerX, player.centerY);

const landingModule = new LandingModule(receiver);
const game = new Game(world, player, camera, landingModule);
const buildings = game.buildings;

const renderer = new Renderer(display, world, surface, WORLD_SEED, new CanvasSurface(display));
const digger = new Digger();
const vacuum = new Vacuum(research.tuning);
const painter = new DebugPainter();
const tool = new ActionBarState();
const catalog = new BuildCatalogState(research);
const inventory = new Inventory();

// Звук — читатель, а не участник: он получает счётчики уже отработавшего шага
// и ничего в мире не трогает.
const soundscape = new Soundscape();

let showDebug = true;
let targetInReach = false;
/**
 * Слот панели под курсором. Считается в шаге, а не в кадре: по нему решается
 * и подсветка, и то, доходит ли мышиное применение инструмента до мира.
 */
let hoveredSlot: number | null = null;
/**
 * Что под курсором в открытом меню: узел, крестик или ничего. Считается только
 * при открытом оверлее — закрытое меню курсором не задевается.
 */
let pointerTarget: PointerTarget = null;
/**
 * Узел дерева под курсором. Считается только при открытом оверлее — закрытое
 * меню курсором не задевается.
 */
let hoveredNode: number | null = null;
/**
 * Контур будущего здания. Считается в шаге, а не в кадре: годность зависит
 * от хитбокса персонажа и счёта, а те живут по шагам симуляции.
 */
let ghost: GhostView | null = null;
/**
 * Идущий жест протяжки. Единственное состояние строительства, живущее между
 * шагами: остальное считается заново из мира и прицела.
 */
const run = new BuildRun();
/** Почему место негодно, словами. Пустая строка — годно или не строим. */
let buildIssue = '';
/**
 * Накопленное время симуляции. Орбитальный объект на заднике обязан двигаться
 * по часам, а не по номеру кадра: на 144 Гц он иначе пересекал бы небо вдвое
 * быстрее.
 */
let simTime = 0;

/** Причина отказа словами. Все они про место и исправимы прямо сейчас. */
function placementIssueText(preview: BuildPreview): string {
  switch (preview.issue) {
    case 'far':
      return 'слишком далеко';
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

    // Попадание курсора в панель — ДО применения инструментов: клик по слоту
    // выбирает действие и до мира не доходит. Раскладка берётся у рендера, своей
    // копии геометрии здесь нет.
    const layout = hudLayout(display.width, display.height);
    hoveredSlot = slotAtPoint(input.mouseX, input.mouseY, layout);
    // Мир не трогаем над ВСЕЙ панелью, а не только над слотом: промах в зазор
    // между слотами не должен копать дыру под ней.
    input.overUi = overBar(input.mouseX, input.mouseY, layout);
    if (hoveredSlot !== null && input.mouseLeftJustPressed) tool.select(hoveredSlot);

    // Переключатели читаются ДО применения инструмента: нажатие режима должно
    // менять то, что произойдёт на этом же шаге, а не на следующем.
    const slot = input.slotPressed;
    if (slot !== null) tool.select(slot);
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

    // Единственный ответ игры на положение мыши: кадр на неё не отзывается,
    // отзывается персонаж. При клавиатурном источнике сторона не назначается
    // вовсе — забытый курсор иначе держал бы персонажа развёрнутым.
    const faceX =
      input.aimSource === 'mouse' ? cursorSide(cursorX, player.centerX, PLAYER.hitboxW) : 0;

    return {
      input,
      faceX,
      dig: { converted, x: aim.x, y: aim.y },
    };
  },
};

/**
 * Строительство: контур и постановка. На НАЖАТИЕ, а не на удержание — иначе
 * одно здание ставится и сносится тридцать раз в секунду. Клавиатурная цель
 * СВОЯ и дальше копательной: при общей дистанции она не дотягивается до места
 * под постройку, и клавиатурный путь строительства обрывается на первом шаге.
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
  if (kind.create === null) {
    applySectionGesture(kind, buildAim.x, buildAim.y);
    return;
  }

  // Машина ставится разово, на нажатие: протяжённой конструкции из машин нет,
  // а линия из сепараторов была бы промахом, а не намерением.
  run.end();
  const preview = Builder.preview(
    world,
    buildings,
    kind,
    player.centerX,
    player.centerY,
    buildAim.x,
    buildAim.y,
    research,
  );
  ghost = { ...preview, side: 0 };
  buildIssue = placementIssueText(preview);

  if (input.toolPressed) {
    Builder.apply(
      world,
      buildings,
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
 * Подпись вида с его стороной переноса.
 *
 * Сторона берётся из контура, когда тот её знает, и из модификатора, когда
 * нет: подпись обязана меняться вместе с нажатием `Shift`, а не после
 * постановки.
 */
function buildKindLabel(): string {
  const side = ghost !== null && ghost.side !== 0 ? ghost.side : input.buildSide;
  return kindLabel(catalog.kind, side);
}

/**
 * Жест протяжки: секции кладутся ПО ХОДУ удержания, а не на отпускании.
 *
 * Лента, появляющаяся только при отпускании, лишает игрока возможности
 * остановиться, увидев, что кладётся не туда. Повторная укладка той же секции
 * при этом безвредна: `applyLine` пропускает записи-пустышки и чанков не будит.
 *
 * Снос, наоборот, ждёт ОТПУСКАНИЯ и только если жест не сдвинулся с места.
 * Снос на нажатии означал бы, что нажать на ленту, чтобы её продлить, нельзя:
 * первый же шаг жеста её бы и убрал.
 */
function applySectionGesture(kind: BuildingKind, aimX: number, aimY: number): void {
  if (input.toolPressed) {
    const at = Builder.originFor(kind, aimX, aimY);
    const standing =
      buildings.findAt(aimX, aimY) !== null ||
      Builder.sectionState(world, kind, at.x, at.y) !== 'free';
    run.begin(aimX, aimY, standing);
  }
  const anchor = run.anchor;

  // Жеста нет: контур показывает то же, что показывал бы одиночному нажатию.
  if (anchor === null) {
    const preview = Builder.preview(
      world,
      buildings,
      kind,
      player.centerX,
      player.centerY,
      aimX,
      aimY,
      research,
    );
    ghost = { ...preview, side: preview.issue === null ? input.buildSide : 0 };
    buildIssue = placementIssueText(preview);
    return;
  }

  run.note(aimX, aimY);

  // Жест, начатый на постройке и никуда не поведший, — снос. Пока он не
  // сдвинулся, класть нечего, и контур обводит то, что исчезнет.
  if (run.isDemolishClick) {
    const preview = Builder.preview(
      world,
      buildings,
      kind,
      player.centerX,
      player.centerY,
      anchor.x,
      anchor.y,
      research,
    );
    ghost = { ...preview, side: 0 };
    buildIssue = placementIssueText(preview);
    if (!input.toolHeld) {
      Builder.apply(
        world,
        buildings,
        kind,
        player.centerX,
        player.centerY,
        anchor.x,
        anchor.y,
        research,
      );
      run.end();
    }
    return;
  }

  const line = Builder.line(
    world,
    kind,
    anchor.x,
    anchor.y,
    aimX,
    player.centerX,
    player.centerY,
    input.buildSide,
    research,
  );
  ghost = {
    x: line.x,
    y: line.y,
    w: Math.max(line.count, 1) * kind.width,
    h: kind.height,
    ok: line.count > 0,
    side: line.count > 0 ? line.side : 0,
  };
  buildIssue = placementIssueText({
    x: line.x,
    y: line.y,
    w: kind.width,
    h: kind.height,
    ok: line.count > 0,
    issue: line.count > 0 ? null : line.issue,
  });

  Builder.applyLine(world, kind, line);

  if (!input.toolHeld) run.end();
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
    overlay.handle(input, research, landingModule, pointerTarget);
    ghost = null;
    buildIssue = '';
    // Ввод принадлежит меню целиком, и панель под ним неактивна: попадание
    // курсора не считается вовсе.
    hoveredSlot = null;
    input.overUi = false;
    // Персонаж получает пустой ввод, но физику проходит: он не зависает
    // в воздухе на время чтения дерева.
    return { input: NO_INPUT, faceX: 0, dig: null };
  },
};

/**
 * Что под курсором в открытом меню. Считается ОДИН РАЗ за шаг и служит обоим
 * читателям — закрытию и покупке. Раскладка берётся у рендера: своей копии
 * геометрии здесь нет.
 *
 * Крестик проверяется раньше узлов: он лежит в ряду заголовка, куда сетка
 * не доходит, и порядок здесь означает лишь то, что кнопка сильнее пустого
 * места.
 */
function overlayTarget(): PointerTarget {
  const layout = techTreeLayout(display.width, display.height, TECH_COLS, TECH_ROWS);
  if (overClose(input.mouseX, input.mouseY, layout)) return 'close';
  return nodeAtPoint(input.mouseX, input.mouseY, layout, TECH_NODES);
}

function step(dt: number): void {
  simTime += dt;

  pointerTarget = overlay.open ? overlayTarget() : null;
  hoveredNode = typeof pointerTarget === 'number' ? pointerTarget : null;

  // Состояние оверлея меняется ОДНИМ стыком и ДО раздачи ввода. Порядок
  // «сначала закрыли, потом раздали» иначе отдаёт закрывающий шаг миру вместе
  // с удерживаемой клавишей применения инструмента, а сброс после раздачи
  // опаздывает ровно на тот шаг, ради которого он есть.
  const wasOpen = overlay.open;
  if (input.researchTogglePressed) overlay.toggle();
  else if (wasOpen && ResearchOverlay.closeRequested(input, pointerTarget)) overlay.close();

  if (overlay.open !== wasOpen) {
    // Сброс — ТЕМ ЖЕ способом, что и при потере фокуса окном, и на ЛЮБОМ
    // переходе, а не только на открытии: клавиша, зажатая при открытии, иначе
    // оставляет персонажа бегущим, а кнопка, нажавшая крестик, доносит нажатие
    // до мира и ставит здание там, куда игрок нажал «закрыть».
    input.releaseAll();
    // Наведение живёт ровно столько же, сколько открытый оверлей: иначе
    // закрытое меню оставило бы за собой подсвеченный узел до следующего входа.
    if (!overlay.open) {
      hoveredNode = null;
      pointerTarget = null;
    }
  }

  const intent = (overlay.open ? overlayState : playState).handleInput(dt);
  game.advanceWorld(dt, intent);

  soundscape.update(dt, game.signals, input.hasInteracted);

  // Одноразовые состояния ввода живут ровно один шаг симуляции.
  input.endStep();
}

/**
 * Дерево технологий для оверлея. Собирается на кадр, а не хранится: второй
 * слепок состояния однажды разошёлся бы с ним.
 *
 * Раскладка берётся у `progress` целиком: колонка и строка — свойство графа
 * предпосылок, и считать их здесь значило бы завести вторую раскладку рядом
 * с той, по которой ходит навигация.
 */
function overlayView(): OverlayView | null {
  if (!overlay.open) return null;
  const credits = landingModule.credits;
  return {
    credits,
    selected: overlay.selectedIndex,
    hovered: hoveredNode,
    closeHovered: pointerTarget === 'close',
    // Курсор берётся живым из позиции мыши, как и мировой крестик: иначе
    // на 144 Гц он отставал бы от неё на кадр.
    pointerX: input.mouseX,
    pointerY: input.mouseY,
    edges: TECH_EDGES,
    nodes: TECHNOLOGIES.map((tech, i) => {
      const status = research.status(tech, credits);
      const node = TECH_NODES[i]!;
      return {
        name: tech.name,
        description: tech.description,
        cost: tech.cost,
        usage: tech.usage,
        status,
        kind: tech.effect.kind,
        icon: tech.icon,
        col: node.col,
        row: node.row,
        note: statusNote(tech, status, credits, research),
      };
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
/**
 * Слоты панели для кадра: подпись клавиши и вид действия.
 *
 * Собирается ОДИН РАЗ, а не на кадр: раскладка слотов постоянна, а меняются
 * только активный и наведённый. Подпись десятого слота — `0`: на клавиатуре
 * ноль стоит после девятки.
 */
const HUD_SLOTS: readonly HudSlot[] = tool.slots.map((mode, i) => ({
  key: `${(i + 1) % 10}`,
  action:
    mode === null
      ? null
      : mode === ToolMode.Dig
        ? ('dig' as SlotAction)
        : mode === ToolMode.Build
          ? ('build' as SlotAction)
          : ('collect' as SlotAction),
}));

function hudState(): HudState {
  return {
    slots: HUD_SLOTS,
    activeSlot: tool.activeSlot,
    hoveredSlot,
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
    buildKind: tool.building ? buildKindLabel() : '',
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
