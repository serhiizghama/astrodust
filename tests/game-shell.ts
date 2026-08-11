import { World, MAT } from '../src/world';
import { Camera } from '../src/render';
import { Digger, Builder } from '../src/systems';
import {
  LandingModule,
  BuildingRegistry,
  CONVEYOR_KIND,
  BUILD_CATALOG,
  BuildCatalogState,
  Player,
  NO_INPUT,
  SEPARATOR_KIND,
  Separator,
} from '../src/entities';
import {
  PLAYER,
  BASE_VIEW_W,
  BASE_VIEW_H,
  MAX_VIEW_W,
  MAX_VIEW_H,
  DIG,
  BUILD_MODULE,
  FIXED_DT,
  SEPARATOR,
} from '../src/config';
import {
  Input,
  fitFrame,
  screenFrame,
  aimDirection,
  aimTarget,
  actionTarget,
  cursorSide,
  AimSourceTracker,
  ActionBarState,
  ACTION_SLOTS,
  ToolMode,
} from '../src/core';
import { check, UNLOCKED, luna, FakeInput, asInput } from './harness';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Game } from '../src/app';
import { Research } from '../src/progress';
import { box, ground } from './fixtures/world';

const first = luna();
const { world } = first;

// --- Кадр под окно ---
//
// Правило подбора вынесено чистой функцией именно ради этой проверки: канвас,
// `window.innerWidth` и слушатель `resize` браузерные, а само правило — нет.
{
  const fullHd = fitFrame(1920, 1080);
  check(
    'Кадр: окно, кратное опорному, даёт ровно опорный кадр',
    fullHd.w === BASE_VIEW_W && fullHd.h === BASE_VIEW_H && fullHd.scale === 3,
    `${fullHd.w}×${fullHd.h} ×${fullHd.scale}`,
  );

  const windowed = fitFrame(1908, 980);
  check(
    'Кадр: окно, не кратное ни одному множителю, покрывается целиком',
    windowed.scale === 3 && windowed.w === 636 && windowed.h === 327,
    `${windowed.w}×${windowed.h} ×${windowed.scale}`,
  );

  // Полос нет ни при каком окне: канвас не меньше окна, а свес — меньше
  // одного множителя, то есть срезается краем окна, а не оставляет пустоту.
  {
    let uncovered = 0;
    let overhang = 0;
    let tooBig = 0;
    let fractional = 0;
    for (let w = 320; w <= 3840; w += 7) {
      for (let h = 200; h <= 2160; h += 13) {
        const fit = fitFrame(w, h);
        if (fit.w * fit.scale < w || fit.h * fit.scale < h) uncovered++;
        if (fit.w * fit.scale - w >= fit.scale || fit.h * fit.scale - h >= fit.scale) overhang++;
        if (fit.w > MAX_VIEW_W || fit.h > MAX_VIEW_H) tooBig++;
        if (!Number.isInteger(fit.scale) || fit.scale < 1) fractional++;
      }
    }
    check('Кадр: канвас не меньше окна ни при каком его размере', uncovered === 0, `${uncovered}`);
    check('Кадр: свес меньше одного множителя', overhang === 0, `${overhang}`);
    check('Кадр: буфер не выходит за потолок', tooBig === 0, `${tooBig}`);
    check('Кадр: множитель целый и не меньше единицы', fractional === 0, `${fractional}`);
  }

  // Потолок отсекает окно, при котором множитель 1 сделал бы кадр равным окну.
  {
    const small = fitFrame(900, 500);
    check(
      'Кадр: при упоре в потолок повышается множитель, а не размер буфера',
      small.scale === 2 && small.w <= MAX_VIEW_W && small.h <= MAX_VIEW_H,
      `${small.w}×${small.h} ×${small.scale}`,
    );
  }

  // Изменение окна меняет и множитель, и размер буфера — константы тут нет.
  {
    const a = fitFrame(1280, 720);
    const b = fitFrame(2560, 1440);
    check(
      'Кадр: разные окна дают разные множители при том же опорном кадре',
      a.scale !== b.scale && a.w === BASE_VIEW_W && b.w === BASE_VIEW_W,
      `×${a.scale} и ×${b.scale}`,
    );
  }

  // Экранный буфер учитывает плотность экрана — ради слоя интерфейса: текст
  // и подложки рисуются в нём, а не в буфере мира.
  {
    const fit = fitFrame(1920, 1080);
    const one = screenFrame(fit, 1);
    const two = screenFrame(fit, 2);
    check(
      'Кадр: экранный буфер растёт вместе с плотностью экрана',
      one.w === fit.w * fit.scale &&
        two.w === one.w * 2 &&
        two.h === one.h * 2 &&
        two.pixelScale === fit.scale * 2,
      `${one.w}×${one.h} и ${two.w}×${two.h}`,
    );

    // Плотность НЕ меняет ни разрешение буфера мира, ни множитель: сколько
    // видно мира, решает размер окна и только он.
    check(
      'Кадр: плотность экрана не меняет ни буфер мира, ни множитель',
      fit.w === BASE_VIEW_W && fit.h === BASE_VIEW_H && fit.scale === 3,
      `${fit.w}×${fit.h} ×${fit.scale}`,
    );

    // Потолок плотности: вдевятеро дороже опорного кадра не платим.
    check(
      'Кадр: плотность экрана ограничена сверху и снизу',
      screenFrame(fit, 8).pixelScale === fit.scale * 3 &&
        screenFrame(fit, 0).pixelScale === fit.scale &&
        screenFrame(fit, 1.5).pixelScale === fit.scale * 1.5,
      `×${screenFrame(fit, 8).pixelScale} при плотности 8`,
    );
  }
}

// --- Камера ---
{
  const cam = new Camera(world.width, world.height);
  cam.snapTo(500, 300);
  const cx = BASE_VIEW_W / 2;
  const cy = BASE_VIEW_H / 2;
  check(
    'Камера: snapTo центрирует цель',
    cam.x === 500 - cx && cam.y === 300 - cy,
    `(${cam.x},${cam.y})`,
  );

  const beforeX = cam.x;
  for (let i = 0; i < 20; i++) cam.follow(510, 300);
  check('Камера: движение в мёртвой зоне не двигает кадр', cam.x === beforeX, `x=${cam.x}`);

  for (let i = 0; i < 200; i++) cam.follow(700, 300);
  check('Камера: догоняет цель за мёртвой зоной', Math.abs(cam.x - (700 - cx)) <= 55, `x=${cam.x}`);

  for (let i = 0; i < 400; i++) cam.follow(5, 5);
  check(
    'Камера: не выезжает за левый/верхний край',
    cam.x === 0 && cam.y === 0,
    `(${cam.x},${cam.y})`,
  );

  for (let i = 0; i < 800; i++) cam.follow(world.width - 5, world.height - 5);
  check(
    'Камера: не выезжает за правый/нижний край',
    cam.x === world.width - BASE_VIEW_W && cam.y === world.height - BASE_VIEW_H,
    `(${cam.x},${cam.y})`,
  );

  // Цель — единственное, от чего зависит кадр: слагаемых, отвечающих на курсор,
  // у камеры нет и заводить их нельзя.
  cam.snapTo(500, 300);
  const restX = cam.x;
  const restY = cam.y;
  for (let i = 0; i < 600; i++) cam.follow(500, 300);
  check(
    'Камера: у неподвижной цели кадр не двигается',
    cam.x === restX && cam.y === restY,
    `(${restX},${restY}) → (${cam.x},${cam.y})`,
  );

  const wp = cam.screenToWorld(10, 20);
  check('Камера: экран → мир учитывает смещение', wp.x === cam.x + 10 && wp.y === cam.y + 20);
}

// --- Снапшот ввода ---
//
// `Input` вешает слушатели на `window` и `document`, и до сих пор это означало,
// что раскладка не проверяется вовсе: без DOM класс нельзя было даже создать.
// Заглушка нужна ровно на две функции — «запомни обработчик» и «позови его», —
// после чего проверяется настоящий класс, а не его пересказ.
{
  type Listener = (event: never) => void;
  class FakeTarget {
    private readonly listeners = new Map<string, Listener[]>();
    addEventListener(type: string, fn: Listener): void {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type: string, event: Record<string, unknown>): void {
      for (const fn of this.listeners.get(type) ?? []) fn(event as never);
    }
  }

  /** Событие клавиши с учётом того, отменил ли его обработчик. */
  function keyEvent(code: string): {
    code: string;
    repeat: boolean;
    prevented: boolean;
    preventDefault(): void;
  } {
    return {
      code,
      repeat: false,
      prevented: false,
      preventDefault(): void {
        this.prevented = true;
      },
    };
  }

  const win = new FakeTarget();
  const doc = new FakeTarget();
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedWindow = globals.window;
  const savedDocument = globals.document;
  globals.window = win;
  globals.document = Object.assign(doc, { hidden: false });

  const display = {
    width: BASE_VIEW_W,
    height: BASE_VIEW_H,
    clientToBuffer: (x: number, y: number) => ({ x: x / 2, y: y / 2 }),
  } as unknown as import('../src/core').Display;
  const input = new Input(display);

  globals.window = savedWindow;
  globals.document = savedDocument;

  const down = (code: string) => {
    const e = keyEvent(code);
    win.emit('keydown', e);
    return e;
  };
  const up = (code: string) => {
    const e = keyEvent(code);
    win.emit('keyup', e);
    return e;
  };

  // Первое действие игрока: до него признак ложен.
  check('Ввод: до первого нажатия признак взаимодействия ложен', !input.hasInteracted);

  // Одиночное нажатие читается один раз, удержание — на всех шагах.
  {
    down('KeyW');
    let pressedSteps = 0;
    let heldSteps = 0;
    for (let i = 0; i < 10; i++) {
      if (input.jumpPressed) pressedSteps++;
      if (input.jumpHeld) heldSteps++;
      input.endStep();
    }
    up('KeyW');
    check(
      'Ввод: одиночное нажатие истинно ровно на одном шаге, удержание — на всех десяти',
      pressedSteps === 1 && heldSteps === 10,
      `нажата ${pressedSteps}, удерживается ${heldSteps}`,
    );
    check('Ввод: первое нажатие включило признак взаимодействия', input.hasInteracted);
  }

  // Прыжок с обеих половин раскладки, и `Space` к нему отношения не имеет.
  {
    down('ArrowUp');
    const byArrow = input.jumpPressed;
    up('ArrowUp');
    input.endStep();
    const space = down('Space');
    const jumpedBySpace = input.jumpPressed;
    const toolBySpace = input.toolHeld;
    up('Space');
    input.endStep();
    check('Ввод: прыжок работает и со стрелки', byArrow);
    check(
      'Ввод: пробел применяет инструмент, а не прыгает',
      !jumpedBySpace && toolBySpace,
      `прыжок ${jumpedBySpace}, инструмент ${toolBySpace}`,
    );
    check('Ввод: пробел подавляет прокрутку страницы', space.prevented);
  }

  // Каждая новая кнопка мыши имеет клавишу, и все три подавляют прокрутку.
  {
    const r = down('KeyR');
    const modeByKey = input.toolModePressed;
    up('KeyR');
    input.endStep();

    const f = down('KeyF');
    const dumpByKey = input.dumpHeld;
    up('KeyF');
    input.endStep();

    const c = down('KeyC');
    const cycleByKey = input.cycleCarriedPressed;
    up('KeyC');
    input.endStep();

    check(
      'Ввод: режим, высыпание и выбор вещества доступны с клавиатуры',
      modeByKey && dumpByKey && cycleByKey,
      `R ${modeByKey}, F ${dumpByKey}, C ${cycleByKey}`,
    );
    check('Ввод: новые клавиши подавляют прокрутку', r.prevented && f.prevented && c.prevented);
  }

  // Вид постройки живёт на СВОЕЙ клавише. Отбирать `C` на время строительства
  // нечем оправдать: высыпание доступно в любом режиме, и клавиша, означающая
  // в одном режиме одно, а в другом другое, — это ошибка на каждом переключении.
  {
    const x = down('KeyX');
    const kindByKey = input.buildKindPressed;
    const carriedUntouched = !input.cycleCarriedPressed;
    up('KeyX');
    input.endStep();

    down('KeyC');
    const carriedByKey = input.cycleCarriedPressed;
    const kindUntouched = !input.buildKindPressed;
    up('KeyC');
    input.endStep();

    check(
      'Ввод: вид постройки перебирается своей клавишей, а `C` остаётся за веществом',
      kindByKey && carriedUntouched && carriedByKey && kindUntouched && x.prevented,
      `X ${kindByKey}, C ${carriedByKey}`,
    );
  }

  // Оверлей исследований: одна клавиша на открыть и закрыть, и та же клавиша
  // забрана у браузера наравне с остальными игровыми.
  {
    const t = down('KeyT');
    const byKey = input.researchTogglePressed;
    const nothingElse =
      !input.buildKindPressed && !input.toolModePressed && !input.cycleCarriedPressed;
    up('KeyT');
    input.endStep();
    check(
      'Ввод: оверлей исследований живёт на своей клавише и подавляет прокрутку',
      byKey && nothingElse && t.prevented,
    );

    // Одноразовое состояние: удержание не переключает оверлей каждый шаг.
    down('KeyT');
    const firstStep = input.researchTogglePressed;
    input.endStep();
    const secondStep = input.researchTogglePressed;
    up('KeyT');
    input.endStep();
    check(
      'Ввод: клавиша оверлея читается ровно один шаг, а не каждый кадр удержания',
      firstStep && !secondStep,
    );
  }

  // Открытие оверлея сбрасывает удерживаемое ТЕМ ЖЕ механизмом, что и потеря
  // фокуса окном: клавиша, зажатая в момент открытия, иначе оставляет
  // персонажа бегущим всё время, пока игрок читает дерево.
  {
    down('KeyD');
    down('Space');
    const runningBefore = input.moveAxis === 1 && input.toolHeld;
    input.endStep();

    input.releaseAll();
    const stopped = input.moveAxis === 0 && !input.toolHeld && !input.mouseLeftHeld;
    input.endStep();

    check(
      'Ввод: сброс удерживаемого снимает и клавиши, и кнопки мыши',
      runningBefore && stopped,
      `до сброса бег ${runningBefore}, после ${input.moveAxis}`,
    );
    up('KeyD');
    up('Space');
    input.endStep();
  }

  // Сброс снимает и РАЗОВОЕ нажатие этого шага. Нажатие, пережившее сброс,
  // достаётся миру тем же шагом — то есть ровно тот случай, ради которого
  // сброс и существует: клик по крестику меню иначе ставит здание там, куда
  // игрок нажал «закрыть».
  {
    win.emit('mousedown', { button: 0 });
    down('Space');
    const armed = input.mouseLeftJustPressed && input.toolPressed;

    input.releaseAll();
    const disarmed = !input.mouseLeftJustPressed && !input.toolPressed && !input.toolHeld;
    win.emit('mouseup', { button: 0 });
    up('Space');
    input.endStep();

    check(
      'Ввод: сброс снимает и разовое нажатие, а не только удержание',
      armed && disarmed,
      `до сброса ${armed}, после ${disarmed}`,
    );
  }

  // `Escape` — «закрыть открытое меню». Игра его читает, но НЕ отбирает
  // у браузера: ею выходят из полноэкранного режима, и в нём браузер её
  // всё равно не отдаёт.
  {
    const e = down('Escape');
    const byKey = input.menuClosePressed;
    const nothingElse = !input.researchTogglePressed && !input.menuConfirmPressed;
    input.endStep();
    const secondStep = input.menuClosePressed;
    up('Escape');
    input.endStep();

    check(
      'Ввод: Escape читается ровно один шаг и остаётся у браузера',
      byKey && nothingElse && !secondStep && !e.prevented,
      `нажата ${byKey}, следующий шаг ${secondStep}, подавлена ${e.prevented}`,
    );
  }

  // Не игровая клавиша остаётся браузеру.
  {
    const e = down('KeyZ');
    up('KeyZ');
    input.endStep();
    check('Ввод: посторонняя клавиша странице не мешает', !e.prevented);
  }

  // Отключение звука — одноразовое состояние.
  {
    down('KeyM');
    const first1 = input.muteTogglePressed;
    input.endStep();
    const second = input.muteTogglePressed;
    up('KeyM');
    input.endStep();
    check('Ввод: переключение звука истинно ровно на одном шаге', first1 && !second);
  }

  // Правая кнопка: удерживаемое состояние и никакого контекстного меню.
  {
    let prevented = false;
    win.emit('contextmenu', {
      preventDefault: () => {
        prevented = true;
      },
    });
    win.emit('mousedown', { button: 2 });
    const heldRight = input.mouseRightHeld;
    const heldLeft = input.mouseLeftHeld;
    const dumpByMouse = input.dumpHeld;
    win.emit('mouseup', { button: 2 });
    check(
      'Ввод: правая кнопка удерживается и не открывает меню браузера',
      prevented && heldRight && !heldLeft && dumpByMouse && !input.mouseRightHeld,
      `меню отменено ${prevented}, удержание ${heldRight}, высыпание ${dumpByMouse}`,
    );
  }

  // Потеря фокуса отпускает обе кнопки и все клавиши: иначе персонаж вернётся
  // из свёрнутой вкладки копающим и бегущим.
  {
    down('KeyD');
    win.emit('mousedown', { button: 0 });
    win.emit('mousedown', { button: 2 });
    win.emit('blur', {});
    check(
      'Ввод: потеря фокуса отпускает клавиши и обе кнопки мыши',
      !input.moveRight && !input.mouseLeftHeld && !input.mouseRightHeld,
    );
    input.endStep();
  }

  // Позиция курсора приходит в координатах буфера кадра.
  {
    win.emit('mousemove', { clientX: 100, clientY: 60 });
    check(
      'Ввод: позиция курсора пересчитана из координат страницы',
      input.mouseX === 50 && input.mouseY === 30,
      `(${input.mouseX},${input.mouseY})`,
    );
  }

  // Полный экономический цикл — только клавиатурой, ни одного события мыши.
  {
    const seen = { mode: false, tool: false, cycle: false, dump: false };
    down('KeyR');
    seen.mode = input.toolModePressed;
    up('KeyR');
    input.endStep();
    down('Space');
    seen.tool = input.toolHeld;
    up('Space');
    input.endStep();
    down('KeyC');
    seen.cycle = input.cycleCarriedPressed;
    up('KeyC');
    input.endStep();
    down('KeyF');
    seen.dump = input.dumpHeld;
    up('KeyF');
    input.endStep();
    check(
      'Ввод: весь цикл — режим, сбор, выбор вещества, высыпание — проходится без мыши',
      seen.mode &&
        seen.tool &&
        seen.cycle &&
        seen.dump &&
        !input.mouseLeftHeld &&
        !input.mouseRightHeld,
      JSON.stringify(seen),
    );
  }

  // Прокладка ленты — тоже только клавиатурой: выбрать режим, выбрать вид,
  // применить несколько раз подряд, снести. Ни одного события мыши.
  {
    const tool = new ActionBarState();
    // Технология ленты уже открыта: проверяется прокладка с клавиатуры,
    // а не путь, которым лента стала доступна.
    const catalog = new BuildCatalogState(UNLOCKED);

    // Слот строительства — прямым выбором, за одно нажатие. Цифра берётся
    // из раскладки, а не выписывается: порядок слотов правится в одном месте.
    const digit = down(`Digit${ACTION_SLOTS.findIndex((e) => e?.mode === ToolMode.Build) + 1}`);
    const slot = input.slotPressed;
    if (slot !== null) tool.select(slot);
    up(`Digit${ACTION_SLOTS.findIndex((e) => e?.mode === ToolMode.Build) + 1}`);
    input.endStep();

    let picked = false;
    for (let i = 0; i < BUILD_CATALOG.length; i++) {
      down('KeyX');
      if (input.buildKindPressed) catalog.cycle();
      up('KeyX');
      input.endStep();
      if (catalog.kind === CONVEYOR_KIND) {
        picked = true;
        break;
      }
    }

    const size = BUILD_MODULE;
    const w = new World(64, 64, first.world.profile);
    const registry = new BuildingRegistry();
    let laid = 0;
    for (let i = 0; i < 3; i++) {
      down('Space');
      if (input.toolPressed && tool.building) {
        const at = 20 + i * size;
        if (Builder.apply(w, registry, catalog.kind, at, 32, at, 32, UNLOCKED) === 'placed') {
          laid++;
        }
      }
      up('Space');
      input.endStep();
    }

    const mid = 20 + size;
    down('Space');
    const removed =
      input.toolPressed &&
      Builder.apply(w, registry, catalog.kind, mid + 1, 33, mid + 1, 33, UNLOCKED) === 'demolished';
    up('Space');
    input.endStep();

    check(
      'Ввод: лента выбирается, прокладывается и сносится одной клавиатурой',
      tool.building &&
        picked &&
        laid === 3 &&
        removed &&
        w.get(20, 32) === MAT.CONVEYOR_RIGHT &&
        w.get(mid, 32) === MAT.VACUUM &&
        w.get(mid + size, 32) === MAT.CONVEYOR_RIGHT &&
        !input.mouseLeftHeld,
      `вид ${catalog.name}, положено ${laid}, снято ${removed}`,
    );
    check('Ввод: цифра слота подавляет переключение вкладки браузером', digit.prevented);
  }

  // --- Модификатор стороны и жест протяжки ---
  //
  // Ввод о мире не знает: он различает начало применения и его продолжение,
  // а точку, откуда тянуть, помнит тот, кто ставит. Второй признак того же
  // состояния однажды разошёлся бы с первым.
  {
    const plain = input.buildSide;
    const sh = down('ShiftLeft');
    const shifted = input.buildSide;
    const heldNextStep = (input.endStep(), input.buildSide);
    up('ShiftLeft');
    const released = input.buildSide;
    input.endStep();
    check(
      'Ввод: Shift переворачивает сторону и читается как УДЕРЖАНИЕ, а не нажатие',
      plain === 1 && shifted === -1 && heldNextStep === -1 && released === 1,
      `без ${plain}, с ${shifted}, на следующем шаге ${heldNextStep}, после ${released}`,
    );
    check('Ввод: Shift не отбирается у браузера — он часть системных сочетаний', !sh.prevented);

    // Начало жеста отличается от продолжения: без первого протяжённая
    // постройка не знает, на каком шаге запомнить точку начала.
    down('Space');
    const began = input.toolPressed && input.toolHeld;
    input.endStep();
    const continues = !input.toolPressed && input.toolHeld;
    input.endStep();
    check(
      'Ввод: начало жеста отличается от его продолжения',
      began && continues,
      `начало ${began}, продолжение ${continues}`,
    );

    // Сброс кончает жест сам: удержание снято, и отдельного «жест прерван»
    // заводить незачем.
    input.releaseAll();
    const afterReset = !input.toolHeld && !input.toolPressed;
    up('Space');
    input.endStep();
    check('Ввод: сброс кончает жест вместе с удержанием', afterReset);
  }

  // --- Прокладка ленты одним жестом ---
  //
  // Жест обязан быть ОДИН на оба ввода: действие, у которого мышь и клавиатура
  // работают по разным правилам, приходится изучать дважды, и одно из двух
  // правил всегда оказывается хуже проверено.
  {
    const w = new World(128, 64, first.world.profile);
    const anchorX = 4 * BUILD_MODULE;
    const anchorY = 4 * BUILD_MODULE;
    const targetX = anchorX + 6 * BUILD_MODULE;

    const byKeys = Builder.line(
      w,
      CONVEYOR_KIND,
      anchorX,
      anchorY,
      targetX,
      anchorX,
      anchorY,
      1,
      UNLOCKED,
    );
    Builder.applyLine(w, CONVEYOR_KIND, byKeys);

    const w2 = new World(128, 64, first.world.profile);
    const byMouse = Builder.line(
      w2,
      CONVEYOR_KIND,
      anchorX,
      anchorY,
      targetX,
      anchorX,
      anchorY,
      1,
      UNLOCKED,
    );
    Builder.applyLine(w2, CONVEYOR_KIND, byMouse);

    let same = true;
    for (let i = 0; i < w.cells.length; i++) if (w.cells[i] !== w2.cells[i]) same = false;
    check(
      'Ввод: жест протяжки одинаков на клавиатуре и на мыши',
      byKeys.count === 7 && byMouse.count === 7 && same,
      `клавиатурой ${byKeys.count}, мышью ${byMouse.count}, миры совпали ${same}`,
    );
  }

  // --- Курсор над интерфейсом ---
  //
  // Признак нужен ровно затем, чтобы клик по панели не копал дыру под ней,
  // и ровно НЕ затем, чтобы забытая над панелью мышь отбирала у клавиатуры
  // основное действие игры.
  {
    win.emit('mousedown', { button: 0 });
    input.overUi = true;
    const mouseBlocked = !input.toolHeld && !input.toolPressed;
    down('Space');
    const keyStillWorks = input.toolHeld && input.toolPressed;
    up('Space');
    win.emit('mouseup', { button: 0 });
    input.endStep();

    win.emit('mousedown', { button: 0 });
    input.overUi = false;
    const mousePasses = input.toolHeld && input.toolPressed;
    win.emit('mouseup', { button: 0 });
    input.endStep();

    check(
      'Ввод: над интерфейсом мышиное применение до мира не доходит, а клавиша доходит',
      mouseBlocked && keyStillWorks && mousePasses,
      `мышь над панелью ${!mouseBlocked}, клавиша ${keyStillWorks}, мышь над миром ${mousePasses}`,
    );
  }

  // Сочетание с модификатором принадлежит браузеру: `Ctrl`+цифра переключает
  // вкладку, и отбирать это у игрока игра не вправе.
  {
    const e = keyEvent('Digit3');
    win.emit('keydown', Object.assign(e, { ctrlKey: true }));
    const stolen = input.slotPressed !== null;
    win.emit('keyup', keyEvent('Digit3'));
    input.endStep();
    check(
      'Ввод: цифра с модификатором остаётся браузеру и слот не выбирает',
      !e.prevented && !stolen,
    );
  }
}

// --- Прицел с клавиатуры ---
{
  // Восемь направлений: пары (moveAxis, aimAxisY).
  const DIRS: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  // Инвариант расстояния: кисть обязана дотягиваться до тела.
  check(
    'Прицел: расстояние не превышает полуширину хитбокса плюс радиус кисти',
    DIG.aimDistance <= PLAYER.hitboxW / 2 + DIG.radius,
    `aimDistance=${DIG.aimDistance}, предел=${PLAYER.hitboxW / 2 + DIG.radius}`,
  );

  // Сборка направления.
  {
    const seen = new Set<string>();
    for (const [ax, ay] of DIRS) {
      const d = aimDirection(ax, ay, 1);
      seen.add(`${d.x.toFixed(3)},${d.y.toFixed(3)}`);
    }
    check('Прицел: восемь комбинаций дают восемь разных направлений', seen.size === 8);

    const right = aimDirection(0, 0, 1);
    const left = aimDirection(0, 0, -1);
    check(
      'Прицел: без клавиш направление берётся из facing',
      right.x === 1 && right.y === 0 && left.x === -1 && left.y === 0,
    );

    // Диагональ нормируется: иначе она била бы в 1.41 раза дальше прямой.
    const diag = aimDirection(1, 1, 1);
    const len = Math.hypot(diag.x, diag.y);
    check('Прицел: диагональ нормирована', Math.abs(len - 1) < 1e-9, `длина=${len}`);

    const t = aimTarget(60, 60, diag.x, diag.y);
    check(
      'Прицел: диагональная цель не дальше aimDistance',
      Math.hypot(t.x - 60, t.y - 60) <= DIG.aimDistance + 1,
      `(${t.x - 60}, ${t.y - 60})`,
    );
  }

  // Взаимное гашение осей.
  {
    // Та же формула, что в геттерах moveAxis и aimAxisY.
    const axis = (neg: boolean, pos: boolean): number => (pos ? 1 : 0) - (neg ? 1 : 0);
    const bothX = axis(true, true); // A и D вместе
    const bothY = axis(true, true); // W и S вместе
    const d = aimDirection(bothX, bothY, -1);
    check(
      'Прицел: обе клавиши оси гасят друг друга и остаётся facing',
      bothX === 0 && bothY === 0 && d.x === -1 && d.y === 0,
    );
  }

  // Достижимость и отсутствие зазора между телом и выемкой.
  {
    const hw = PLAYER.hitboxW;
    const hh = PLAYER.hitboxH;
    const px = 60;
    const py = 60;
    const cx = px + hw / 2;
    const cy = py + hh / 2;

    let allInReach = true;
    let allTouching = true;
    let allConverted = true;
    const gaps: string[] = [];

    for (const [ax, ay] of DIRS) {
      const w = new World(128, 128, first.world.profile);
      for (let x = 0; x < 128; x++) for (let y = 0; y < 128; y++) w.set(x, y, MAT.ROCK);

      const d = aimDirection(ax, ay, 1);
      const t = aimTarget(cx, cy, d.x, d.y);
      if (!Digger.inReach(cx, cy, t.x, t.y)) allInReach = false;

      const converted = Digger.applyBrush(w, t.x, t.y);
      if (converted === 0) allConverted = false;

      // Кольцо шириной в ячейку вокруг хитбокса: хотя бы одна его ячейка
      // обязана быть выкопана, иначе между телом и выемкой останется порода
      // и в собственный прокоп не шагнуть. Кисть — сплошной круг, поэтому
      // касания кольца достаточно для связности. Разрушена ячейка или отдала
      // материал — неважно: связность даёт сам факт выемки.
      let touches = false;
      for (let y = py - 1; y <= py + hh; y++) {
        for (let x = px - 1; x <= px + hw; x++) {
          const inside = x >= px && x < px + hw && y >= py && y < py + hh;
          if (inside) continue;
          if (w.get(x, y) !== MAT.ROCK) touches = true;
        }
      }
      if (!touches) {
        allTouching = false;
        gaps.push(`(${ax},${ay})`);
      }
    }

    check('Прицел: клавиатурная цель всегда в пределах досягаемости', allInReach);
    check('Прицел: кисть в каждом направлении что-то выкапывает', allConverted);
    check(
      'Прицел: между телом и выемкой нет зазора ни в одном направлении',
      allTouching,
      gaps.length ? `зазор: ${gaps.join(' ')}` : '',
    );
  }

  // Выбор цели: её задаёт удерживаемый орган, а не режим.
  {
    const cx = 60;
    const cy = 60;
    const cursorX = 200;
    const cursorY = 30;
    const d = aimDirection(1, 0, 1);

    const byMouse = actionTarget(true, cursorX, cursorY, cx, cy, d.x, d.y);
    check(
      'Цель: при удержании ЛКМ копается под курсором',
      byMouse.x === cursorX && byMouse.y === cursorY,
    );

    const byKeys = actionTarget(false, cursorX, cursorY, cx, cy, d.x, d.y);
    check(
      'Цель: без ЛКМ копается вплотную к персонажу, а не под курсором',
      Math.hypot(byKeys.x - cx, byKeys.y - cy) <= DIG.aimDistance,
      `(${byKeys.x - cx}, ${byKeys.y - cy})`,
    );

    // Оба органа удерживаются: побеждает мышь — у неё есть крестик.
    check(
      'Цель: при обоих органах побеждает мышь',
      actionTarget(true, cursorX, cursorY, cx, cy, d.x, d.y).x === cursorX,
    );

    // Крестик не зависит от клавиш: цель мыши одна и та же при любом
    // направлении клавиатуры.
    const other = aimDirection(-1, 1, -1);
    check(
      'Цель мыши не зависит от нажатых клавиш направления',
      actionTarget(true, cursorX, cursorY, cx, cy, other.x, other.y).x === cursorX,
    );
  }

  // Арбитраж источника — влияет только на смещение кадра.
  {
    const t = new AimSourceTracker();
    check('Источник прицела: до первого ввода — клавиатура', t.source === 'keys');

    t.note('mouse', false);
    check('Источник прицела: движение мыши переключает на мышь', t.source === 'mouse');

    t.note('keys', false);
    check('Источник прицела: клавиша направления переключает обратно', t.source === 'keys');

    t.note('mouse', true);
    check('Источник прицела: во время копания не переключается', t.source === 'keys');

    t.note('mouse', false);
    check('Источник прицела: после отпускания копания переключается снова', t.source === 'mouse');
    t.note('keys', true);
    check('Источник прицела: заморозка работает в обе стороны', t.source === 'mouse');
  }
}

// --- Разворот персонажа ---
//
// Реакция на мышь одна — разворот; кадр на неё не отвечает. Назначенная сторона
// обязана перекрывать ось движения, иначе мышь вертела бы только стоящего.
{
  const research = new Research();
  const facingAfter = (faceX: -1 | 0 | 1, right: boolean): 1 | -1 => {
    const w = ground(96, 96);
    const p = new Player(40, 94 - PLAYER.hitboxH, research.tuning);
    const zone = { x: 2, y: 2, w: 3, h: 3 };
    const g = new Game(w, p, new Camera(w.width, w.height), new LandingModule(zone));
    const input = new FakeInput();
    input.right = right;
    for (let i = 0; i < 30; i++) {
      g.advanceWorld(FIXED_DT, { input: asInput(input), faceX, dig: null });
    }
    return p.facing;
  };

  check('Разворот: назначенная сторона перевешивает бег', facingAfter(-1, true) === -1);
  check('Разворот: без назначения сторону задаёт ось движения', facingAfter(0, true) === 1);

  check(
    'Разворот: курсор в пределах ширины персонажа стороны не задаёт',
    cursorSide(100, 100, PLAYER.hitboxW) === 0 &&
      cursorSide(100 + (PLAYER.hitboxW >> 1), 100, PLAYER.hitboxW) === 0,
  );
  check(
    'Разворот: сторона курсора считается от центра персонажа',
    cursorSide(120, 100, PLAYER.hitboxW) === 1 && cursorSide(80, 100, PLAYER.hitboxW) === -1,
  );
}

// --- Порядок обновлений внутри шага ---
//
// Порядок — требование спеки, а не удобство записи: каждое сочленение
// наблюдаемо, и перестановка любого из них видна игроку как дефект.
{
  const research = new Research();
  const spawnWorld = () => luna();

  // Инструменты до персонажа, персонаж до автомата: автомат обязан видеть
  // СВЕЖИЙ хитбокс. При обратном порядке вещество занимает ячейку, в которую
  // персонаж на этом же шаге переместился, и засыпает его изнутри.
  {
    const w = box(160, 96);
    for (let x = 0; x < 160; x++) w.set(x, 94, MAT.ROCK);
    // Потолок из сыпучего прямо над маршрутом: оно сыплется каждый шаг.
    for (let x = 20; x < 140; x++) {
      for (let y = 70; y < 78; y++) w.set(x, y, MAT.REGOLITH_LOOSE);
    }
    const p = new Player(24, 94 - PLAYER.hitboxH, research.tuning);
    const cam = new Camera(w.width, w.height);
    const g = new Game(w, p, cam, new LandingModule({ x: 2, y: 2, w: 3, h: 3 }));

    const input = new FakeInput();
    input.right = true;
    let buried = 0;
    for (let i = 0; i < 900; i++) {
      g.advanceWorld(FIXED_DT, {
        input: asInput(input),
        faceX: 0,
        dig: null,
      });
      if (w.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH)) buried++;
    }
    check(
      'Порядок шага: персонажа не засыпает изнутри под осыпающимся сводом',
      buried === 0,
      `шагов внутри твёрдого ${buried}, дошёл до x=${Math.round(p.x)}`,
    );
  }

  // Приёмник — ПОСЛЕ автомата: ячейка, скатившаяся в зону на этом шаге,
  // засчитывается на нём же, а не через кадр.
  {
    const w = box(96, 96);
    const zone = { x: 40, y: 60, w: 6, h: 5 };
    for (let y = zone.y; y < zone.y + zone.h + 2; y++) {
      for (let d = 0; d < 2; d++) {
        w.set(zone.x - 1 - d, y, MAT.MODULE_HULL);
        w.set(zone.x + zone.w + d, y, MAT.MODULE_HULL);
      }
    }
    for (let y = zone.y + zone.h; y < zone.y + zone.h + 2; y++) {
      for (let x = zone.x - 2; x < zone.x + zone.w + 2; x++) w.set(x, y, MAT.MODULE_HULL);
    }
    const mod = new LandingModule(zone);
    const p = new Player(4, 94 - PLAYER.hitboxH, research.tuning);
    const g = new Game(w, p, new Camera(w.width, w.height), mod);

    // Ячейка стоит РОВНО НАД зоной: попасть внутрь она может только автоматом,
    // и только на этом шаге.
    w.set(zone.x + 2, zone.y - 1, MAT.PULP);
    const before = mod.credits;
    g.advanceWorld(FIXED_DT, { input: NO_INPUT, faceX: 0, dig: null });
    check(
      'Порядок шага: скатившаяся в зону ячейка засчитывается на том же шаге',
      mod.credits > before,
      `кредиты ${before} → ${mod.credits}`,
    );
  }

  // Машины — тоже после автомата и РАНЬШЕ приёмника.
  {
    const w = ground(96, 96);
    const mod = new LandingModule({ x: 2, y: 2, w: 4, h: 4 });
    mod.credits = 10_000;
    const p = new Player(4, 94 - PLAYER.hitboxH, research.tuning);
    const g = new Game(w, p, new Camera(w.width, w.height), mod);

    // Целимся в УГОЛ, а не в центр: все виды притягиваются к сетке модуля,
    // и центрирования на прицеле больше нет ни у кого.
    const bx = Builder.snap(40);
    const by = Builder.snap(96 - 2 - SEPARATOR.height);
    const placed = Builder.apply(w, g.buildings, SEPARATOR_KIND, bx, by, bx, by, UNLOCKED);
    const machine = g.buildings.all[0] as Separator | undefined;
    check(
      'Порядок шага: машина для проверки вообще встала',
      placed === 'placed' && machine !== undefined,
      `постановка ${placed}`,
    );

    if (machine !== undefined) {
      // Пульпа на две ячейки выше приёмной грани: на грань её кладёт автомат.
      w.set(bx + (SEPARATOR.width >> 1), by - 2, MAT.PULP);
      const stored = machine.stored;
      g.advanceWorld(FIXED_DT, { input: NO_INPUT, faceX: 0, dig: null });
      g.advanceWorld(FIXED_DT, { input: NO_INPUT, faceX: 0, dig: null });
      check(
        'Порядок шага: машина принимает сырьё на шаге его прибытия на грань',
        machine.stored > stored,
        `накопитель ${stored} → ${machine.stored}`,
      );
    }
  }

  // Смена режима действует на ЭТОМ же шаге: переключатель читается до
  // применения инструмента.
  {
    const tool = new ActionBarState();
    const wasDigging = tool.digging;
    tool.cycle();
    // Что именно за копанием, здесь неважно: проверяется, что переключатель
    // сработал НА ЭТОМ шаге, а не то, каким по счёту стоит следующий режим.
    check(
      'Порядок шага: смена режима видна немедленно, а не со следующего шага',
      wasDigging && !tool.digging && tool.activeSlot !== 0,
      `слот ${tool.activeSlot}, копание ${tool.digging}`,
    );
  }

  // Отчёт для звука описывает ЗАВЕРШИВШИЙСЯ шаг: счётчики собраны после
  // автомата, а точка отсчёта — персонаж после его движения.
  {
    const w = box(96, 96);
    for (let x = 30; x < 60; x++) {
      for (let y = 20; y < 30; y++) w.set(x, y, MAT.REGOLITH_LOOSE);
    }
    const p = new Player(4, 94 - PLAYER.hitboxH, research.tuning);
    const g = new Game(
      w,
      p,
      new Camera(w.width, w.height),
      new LandingModule({ x: 2, y: 2, w: 3, h: 3 }),
    );
    g.advanceWorld(FIXED_DT, {
      input: NO_INPUT,
      faceX: 0,
      dig: { converted: 7, x: 11, y: 13 },
    });
    check(
      'Порядок шага: отчёт для звука описывает этот шаг, а не предыдущий',
      g.signals.powderMoves === g.simulation.lastPowderMoves &&
        g.signals.powderMoves > 0 &&
        g.signals.listenerX === p.centerX &&
        g.signals.listenerY === p.centerY &&
        g.signals.digConverted === 7,
      `сдвигов ${g.signals.powderMoves}, слушатель (${g.signals.listenerX}, ${g.signals.listenerY})`,
    );
  }
  void spawnWorld;
}

// --- Единый порядок обновления мира во всех состояниях игры ---
{
  // Состояния различаются ТОЛЬКО намерением. Мир после них идёт одинаково —
  // проверяется на паре прогонов из одного начального состояния.
  function run(dig: { converted: number; x: number; y: number } | null): string {
    const research = new Research();
    const w = box(96, 96);
    for (let x = 20; x < 70; x++) {
      for (let y = 30; y < 40; y++) w.set(x, y, MAT.REGOLITH_LOOSE);
    }
    const p = new Player(10, 94 - PLAYER.hitboxH, research.tuning);
    const mod = new LandingModule({ x: 2, y: 2, w: 3, h: 3 });
    const g = new Game(w, p, new Camera(w.width, w.height), mod);
    for (let i = 0; i < 240; i++) {
      g.advanceWorld(FIXED_DT, { input: NO_INPUT, faceX: 0, dig });
    }
    let sum = 0;
    for (let i = 0; i < w.cells.length; i++) sum += w.cells[i]! * ((i % 97) + 1);
    return `${sum}|${p.x},${p.y}|${g.camera.x},${g.camera.y}|${mod.credits}`;
  }
  check(
    'Мир идёт одинаково при открытом и закрытом оверлее',
    run(null) === run({ converted: 0, x: 0, y: 0 }),
    run(null),
  );
}

// --- Порядок существует в единственном экземпляре ---
{
  // Пока копий последовательности было две (мир и оверлей), они уже успели
  // разойтись. Проверка держит то, ради чего дублирование убирали: добавить
  // третье состояние копией шага мира больше нельзя.
  const src = readdirSync(resolve(process.cwd(), 'src'), { recursive: true }) as string[];
  const files = src
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(resolve(process.cwd(), 'src'), f));
  let callers = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/\bsimulation\.update\(/.test(text) || /this\.simulation\.update\(/.test(text)) callers++;
  }
  check(
    'Шаг мира записан в одном месте: автомат вызывается из единственного модуля',
    callers === 1,
    `модулей с вызовом автомата ${callers}`,
  );
}
