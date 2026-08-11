import { BASE_VIEW_W, BASE_VIEW_H, DIG } from '../config';
import { Display } from './display';

/**
 * Клавиши прямого выбора слота, по порядку слотов. `Digit0` десятый: на
 * клавиатуре ноль стоит после девятки, а не перед единицей.
 */
const DIGIT_KEYS = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
] as const;

/** Клавиши, которые игра забирает себе — браузер не должен на них реагировать. */
const GAME_KEYS = new Set([
  'KeyA',
  'KeyD',
  'KeyW',
  'KeyS',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'F3',
  // Отключение звука.
  'KeyM',
  // Инвентарь: смена режима инструмента, высыпание, выбор вещества.
  // Каждая новая кнопка мыши обязана иметь клавиатурный эквивалент —
  // это записанное требование, а не удобство.
  'KeyR',
  'KeyF',
  'KeyC',
  // Строительство: перебор вида постройки по кругу. Отдельно от `C` намеренно —
  // высыпание доступно в любом режиме, и отбирать выбор высыпаемого на время
  // строительства нечем оправдать.
  'KeyX',
  // Оверлей исследований: открыть и закрыть. Одна клавиша на то и другое —
  // открытый оверлей виден, и второй клавиши учить незачем.
  'KeyT',
  // Отладка: переключение вещества и его установка под курсором.
  'KeyQ',
  'KeyE',
  // Прямой выбор слота панели действий. Цифровой ряд целиком, включая пустые
  // слоты: клавиша, на которую игра не отзывается, не должна отзываться
  // и страница.
  ...DIGIT_KEYS,
]);

/**
 * Клавиши, задающие направление прицела. Нажатие любой из них означает, что
 * игрок целится с клавиатуры, а не мышью.
 */
const AIM_KEYS = new Set([
  'KeyA',
  'KeyD',
  'KeyW',
  'KeyS',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
]);

/**
 * Что делает применение инструмента.
 *
 * Режим, а не «кисть решает сама по материалу»: без него нельзя прокопать ход,
 * не набив инвентарь, и нельзя собрать реголит, не разрушив стену за ним.
 * Игрок теряет выбор ровно там, где он содержательный.
 */
export const ToolMode = {
  Dig: 0,
  Collect: 1,
  Build: 2,
} as const;

export type ToolModeValue = (typeof ToolMode)[keyof typeof ToolMode];

/**
 * Раскладка слотов панели действий. Пустой слот — это `null`, а не отсутствие
 * записи: пустые слоты занимают место в раскладке кадра и показывают, что
 * место под будущее есть.
 */
export const ACTION_SLOTS: readonly (ToolModeValue | null)[] = [
  ToolMode.Dig,
  ToolMode.Build,
  ToolMode.Collect,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];

/**
 * Панель действий: что выбрано и чем выбирается.
 *
 * Живёт здесь, а не в отдельной подсистеме: панель — это тот же выбор режима
 * инструмента, показанный иначе, и разносить состояние с его единственным
 * читателем незачем.
 *
 * Прямой выбор и перебор по кругу существуют ОДНОВРЕМЕННО и меняют одно и то же
 * состояние: клавиш прямого выбора конечное число, а режимов со временем будет
 * больше, и перебор остаётся способом добраться до того, чему клавиши не хватило.
 */
export class ActionBarState {
  readonly slots = ACTION_SLOTS;
  private index = 0;

  get activeSlot(): number {
    return this.index;
  }

  get mode(): ToolModeValue {
    return this.slots[this.index]!;
  }

  get digging(): boolean {
    return this.mode === ToolMode.Dig;
  }

  get collecting(): boolean {
    return this.mode === ToolMode.Collect;
  }

  get building(): boolean {
    return this.mode === ToolMode.Build;
  }

  /**
   * Выбрать слот напрямую.
   *
   * Пустой слот активным не становится: инструмент, который «ничего не делает»,
   * неотличим от поломки, и прежний выбор остаётся в силе.
   */
  select(slot: number): void {
    if (slot < 0 || slot >= this.slots.length) return;
    if (this.slots[slot] === null) return;
    this.index = slot;
  }

  /**
   * Следующий НЕПУСТОЙ слот по кругу.
   *
   * Перебор списком, а не переключатель: добавление режима MUST NOT требовать
   * новой клавиши, иначе раскладка растёт вместе с числом зданий.
   */
  cycle(): void {
    const n = this.slots.length;
    for (let step = 1; step <= n; step++) {
      const next = (this.index + step) % n;
      if (this.slots[next] !== null) {
        this.index = next;
        return;
      }
    }
  }
}

/** Какое устройство задаёт цель прямо сейчас. */
export type AimSource = 'mouse' | 'keys';

/**
 * Активный источник прицела.
 *
 * Начинает с клавиатуры намеренно: до первого движения мыши курсор стоит в
 * центре кадра по умолчанию, и прицел мыши означал бы цель, которую игрок
 * никуда не наводил, плюс постоянно перекошенный кадр.
 */
export class AimSourceTracker {
  source: AimSource = 'keys';

  /**
   * Игрок воспользовался устройством. Пока действие удерживается, источник
   * заморожен: иначе дрожание мыши на столе уводит кисть на другой конец
   * экрана посреди штриха с клавиатуры. Замораживает ЛЮБОЕ удерживаемое
   * действие с прицелом, а не одно копание.
   */
  note(device: AimSource, actionHeld: boolean): void {
    if (actionHeld) return;
    this.source = device;
  }
}

/**
 * Направление прицела из уже нажатых клавиш. Отдельного режима прицеливания
 * нет: те же клавиши продолжают двигать персонажа.
 *
 * Когда не нажато ни одной клавиши направления, целимся туда, куда персонаж
 * смотрит, — иначе копать «просто вперёд» было бы нечем.
 *
 * @returns единичный вектор; диагональ нормируется, иначе она била бы дальше
 *   прямого направления в 1.41 раза.
 */
export function aimDirection(
  moveAxis: number,
  aimAxisY: number,
  facing: 1 | -1,
): { x: number; y: number } {
  if (moveAxis === 0 && aimAxisY === 0) return { x: facing, y: 0 };
  const len = Math.hypot(moveAxis, aimAxisY);
  return { x: moveAxis / len, y: aimAxisY / len };
}

/**
 * Клавиатурная цель: вплотную к персонажу, а не на всю дальность вытянутой руки.
 *
 * Расстояние выбрано так, что кисть примыкает к хитбоксу без зазора (см.
 * `DIG.aimDistance`), поэтому выкопанное проходимо сразу и прокоп с клавиатуры
 * работает как тоннель вокруг себя. Точность на расстоянии остаётся за мышью.
 */
export function aimTarget(
  centerX: number,
  centerY: number,
  dirX: number,
  dirY: number,
  distance: number = DIG.aimDistance,
): { x: number; y: number } {
  return {
    x: Math.round(centerX + dirX * distance),
    y: Math.round(centerY + dirY * distance),
  };
}

/**
 * Сторона курсора относительно персонажа: `-1`, `1` или `0` — «стороны нет».
 *
 * Полоса нечувствительности — полширины персонажа: пока курсор лежит на нём
 * самом, стороны нет и разворот не меняется. Без полосы курсор на центральной
 * колонке переворачивал бы спрайт на каждом дрожании руки.
 */
export function cursorSide(cursorX: number, centerX: number, hitboxW: number): -1 | 0 | 1 {
  const offset = cursorX - centerX;
  if (offset > hitboxW / 2) return 1;
  if (offset < -hitboxW / 2) return -1;
  return 0;
}

/**
 * Цель действия: её задаёт удерживаемый орган управления, а не глобальный режим.
 * При удержании обоих выигрывает мышь — у неё есть видимая обратная связь,
 * и действовать не там, где показывает крестик, молча нельзя.
 */
export function actionTarget(
  mouseHeld: boolean,
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number,
  dirX: number,
  dirY: number,
  distance?: number,
): { x: number; y: number } {
  if (mouseHeld) return { x: cursorX, y: cursorY };
  return aimTarget(centerX, centerY, dirX, dirY, distance);
}

/**
 * Снапшот ввода на текущий шаг симуляции.
 *
 * Три состояния клавиши: нажата в этом шаге / удерживается / отпущена в этом
 * шаге. Без первого удержание `W` читалось бы серией прыжков.
 *
 * Раскладка: ходьба `A`/`D` (`←`/`→`), прыжок и ранец `W` (`↑`), инструмент
 * `Space` или ЛКМ, высыпание `F` или ПКМ, слот панели `1`…`9`/`0` или клик
 * по слоту, перебор режимов `R`, вещество `C`, вид постройки `X`, оверлей `T`,
 * прицел вниз `S` (`↓`). Инвариант: у каждого действия мирового цикла есть
 * клавиша — без мыши он проходится целиком.
 *
 * Кому достанутся нажатия, снапшот не знает: при открытом оверлее та же
 * раскладка означает другое, и решает это игровой цикл.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();

  /**
   * Позиция курсора в координатах буфера кадра. До первого движения мыши —
   * середина опорного кадра: настоящий размер известен только после того,
   * как окно о нём сообщит.
   */
  mouseX = BASE_VIEW_W / 2;
  mouseY = BASE_VIEW_H / 2;
  /** Удерживается ли левая кнопка мыши. */
  mouseLeftHeld = false;
  private mouseLeftPressed = false;
  /** Удерживается ли правая кнопка мыши — высыпание из инвентаря. */
  mouseRightHeld = false;

  /**
   * Состоялось ли первое действие игрока — нажатие любой клавиши или кнопки
   * мыши. Один раз истинен, дальше не сбрасывается.
   *
   * Нужен подсистемам, которые браузер не даёт включить до действия
   * пользователя: сейчас это звук, дальше может быть что угодно ещё.
   * Учитывается ЛЮБАЯ клавиша, а не только игровая: браузеру всё равно, какая.
   */
  hasInteracted = false;

  /**
   * Курсор над интерфейсом. Выставляется игровым циклом из раскладки панели:
   * попадание считает рендер, у которого раскладка и есть, а снапшот его
   * разносит по читателям.
   *
   * Без этого признака клик по панели действий одновременно выбирает инструмент
   * и применяет его к миру под панелью, и отличить одно намерение от другого
   * на стороне мира нечем.
   */
  overUi = false;

  private readonly aim = new AimSourceTracker();

  constructor(private readonly display: Display) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    // Правая кнопка занята высыпанием из инвентаря: контекстное меню над
    // канвасом отбирало бы фокус на каждом втором действии игрока.
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    // Потеря фокуса вкладкой или окном — иначе персонаж «залипает» в беге.
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Сочетание с модификатором принадлежит браузеру целиком: `Ctrl`/`Cmd`
    // с цифрой переключает вкладки, и отбирать это у игрока игра не вправе.
    // Раз сочетание не подавляется, то и игровым нажатием оно не считается —
    // иначе `Cmd`+2 меняет инструмент за спиной ушедшего в другую вкладку.
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (GAME_KEYS.has(e.code) && !modified) e.preventDefault();
    this.hasInteracted = true;
    if (modified) return;
    if (e.repeat) return; // автоповтор ОС не должен считаться новым нажатием
    // Источник переключается ДО учёта самой клавиши: нажатие пробела означает
    // «копаю с клавиатуры», и заморозить прицел оно должно уже на новом источнике.
    if (AIM_KEYS.has(e.code)) this.aim.note('keys', this.aimFrozen);
    if (!this.held.has(e.code)) this.pressed.add(e.code);
    this.held.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    this.held.delete(e.code);
    this.released.add(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    const p = this.display.clientToBuffer(e.clientX, e.clientY);
    this.mouseX = Math.max(0, Math.min(this.display.width - 1, p.x));
    this.mouseY = Math.max(0, Math.min(this.display.height - 1, p.y));
    this.aim.note('mouse', this.aimFrozen);
  };

  private onMouseDown = (e: MouseEvent): void => {
    // Любая кнопка — действие игрока, даже та, которую игра не использует.
    this.hasInteracted = true;
    if (e.button !== 0 && e.button !== 2) return;
    this.aim.note('mouse', this.aimFrozen);
    if (e.button === 2) {
      this.mouseRightHeld = true;
      return;
    }
    if (!this.mouseLeftHeld) this.mouseLeftPressed = true;
    this.mouseLeftHeld = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.mouseRightHeld = false;
    if (e.button === 0) this.mouseLeftHeld = false;
  };

  /**
   * Сбросить ввод целиком: и удержания, и разовые нажатия этого шага.
   *
   * Публичный, а не только обработчик потери фокуса: переключение оверлея
   * обязано делать то же самое и ТЕМ ЖЕ способом. Клавиша, зажатая в момент
   * открытия, иначе оставляет персонажа бегущим всё время, пока игрок читает
   * дерево, — ровно то залипание, от которого потеря фокуса уже защищена.
   *
   * Разовые нажатия снимаются наравне с удержаниями: нажатие переживает сброс,
   * снимающий одно удержание, и достаётся миру ТЕМ ЖЕ шагом — то есть ровно
   * тот случай, ради которого сброс и существует. Нажатие, закрывшее меню,
   * иначе ставит здание там, куда игрок нажал «закрыть».
   *
   * Держит `tests/game-shell.ts`.
   */
  releaseAll = (): void => {
    for (const code of this.held) this.released.add(code);
    this.held.clear();
    this.pressed.clear();
    // Кнопки мыши тоже отпускаем: иначе персонаж вернётся в копающем состоянии.
    this.mouseLeftHeld = false;
    this.mouseRightHeld = false;
    this.mouseLeftPressed = false;
  };

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Нажата ли левая кнопка именно в этом шаге. */
  get mouseLeftJustPressed(): boolean {
    return this.mouseLeftPressed;
  }

  /** Вызывается в конце шага симуляции: одноразовые состояния живут ровно один шаг. */
  endStep(): void {
    this.pressed.clear();
    this.released.clear();
    this.mouseLeftPressed = false;
  }

  // --- Игровые действия ---

  get moveLeft(): boolean {
    return this.isHeld('KeyA') || this.isHeld('ArrowLeft');
  }

  get moveRight(): boolean {
    return this.isHeld('KeyD') || this.isHeld('ArrowRight');
  }

  /** -1 влево, +1 вправо, 0 если ничего или обе сразу. */
  get moveAxis(): number {
    return (this.moveRight ? 1 : 0) - (this.moveLeft ? 1 : 0);
  }

  /**
   * Прыжок и тяга ранца живут на `W`/`↑`, а не на пробеле: в раскладке WASD
   * вертикаль ищут именно там, а пробел освобождён под копание — то, чем игрок
   * занят большую часть времени.
   */
  get jumpPressed(): boolean {
    return this.wasPressed('KeyW') || this.wasPressed('ArrowUp');
  }

  get jumpHeld(): boolean {
    return this.isHeld('KeyW') || this.isHeld('ArrowUp');
  }

  /**
   * Применение инструмента: пробел и левая кнопка мыши равноправны, разница
   * только в прицеле. Что именно произойдёт — копание или сбор, — решает режим,
   * а не кнопка: раскладка, в которой копание занимает свою кнопку навсегда,
   * не оставляет места ни сбору, ни тому, что появится после него.
   *
   * Курсор над интерфейсом вычитает МЫШИНОЕ применение, но не клавиатурное:
   * правило разграничивает панель и мир по тому, куда указывает курсор,
   * а клавиша никуда не указывает. Иначе основное действие игры отключалось бы
   * от того, где лежит забытая мышь.
   */
  get toolHeld(): boolean {
    return (this.mouseLeftHeld && !this.overUi) || this.isHeld('Space');
  }

  /**
   * Применение инструмента, нажатое ИМЕННО В ЭТОМ ШАГЕ.
   *
   * Нужно разовым действиям — постройке и сносу. Кисти работают от удержания
   * и своего интервала, но здание при удержании ставилось бы и сносилось
   * по тридцать раз в секунду, и интервал этого не лечит: он лишь замедлил бы
   * мигание.
   */
  get toolPressed(): boolean {
    return (this.mouseLeftJustPressed && !this.overUi) || this.wasPressed('Space');
  }

  /** Высыпание из инвентаря. Доступно в любом режиме и своим органом управления. */
  get dumpHeld(): boolean {
    return this.mouseRightHeld || this.isHeld('KeyF');
  }

  /**
   * Слот панели действий, выбранный цифрой в этом шаге, или `null`.
   *
   * Прямой выбор — причина существования панели: перебор заставляет попадать
   * в третий инструмент двумя нажатиями с чтением подписи между ними.
   */
  get slotPressed(): number | null {
    for (let i = 0; i < DIGIT_KEYS.length; i++) {
      if (this.wasPressed(DIGIT_KEYS[i]!)) return i;
    }
    return null;
  }

  /** Сменить режим инструмента перебором по кругу. */
  get toolModePressed(): boolean {
    return this.wasPressed('KeyR');
  }

  /** Сменить вещество, выбранное для высыпания. */
  get cycleCarriedPressed(): boolean {
    return this.wasPressed('KeyC');
  }

  /**
   * Сменить вид постройки по кругу.
   *
   * Одна клавиша на любое число построек, как и у режимов: отдельная клавиша
   * на вид кончилась бы тем же — клавиш не хватит на четвёртую постройку.
   * Направления ленты среди видов нет: сторона задаётся жестом укладки.
   */
  get buildKindPressed(): boolean {
    return this.wasPressed('KeyX');
  }

  /**
   * Сторона переноса для ОДИНОЧНОЙ постановки: `-1` при удержании `Shift`,
   * иначе `+1`. Протяжка сторону не спрашивает — её задаёт направление жеста.
   *
   * Удерживаемый модификатор, а не переключатель: переключатель хранил бы
   * сторону между постановками, и игроку пришлось бы помнить, чем кончился
   * прошлый заход.
   *
   * `Shift` НЕ входит в `GAME_KEYS` и браузеру не подавляется: он часть
   * системных сочетаний, а игре нужен только факт его удержания.
   */
  get buildSide(): -1 | 1 {
    return this.isHeld('ShiftLeft') || this.isHeld('ShiftRight') ? -1 : 1;
  }

  /** Открыть или закрыть оверлей исследований. */
  get researchTogglePressed(): boolean {
    return this.wasPressed('KeyT');
  }

  /**
   * Закрыть открытое меню. Только закрыть: у клавиши отмены нет второго
   * значения, и оно не появится оттого, что закрывать нечего.
   *
   * `Escape` НЕ входит в `GAME_KEYS` и браузеру не подавляется: ею выходят
   * из полноэкранного режима, и в нём браузер её всё равно не отдаёт. Игра
   * нажатие читает, но не отбирает.
   */
  get menuClosePressed(): boolean {
    return this.wasPressed('Escape');
  }

  /**
   * Шаг по дереву оверлея вверх и вниз.
   *
   * Те же клавиши направления, что и в мире, — учить вторую раскладку ради
   * четырёх узлов дерева незачем, а двусмысленности нет: открытый оверлей
   * виден. НАЖАТИЕ, а не удержание: дерево из четырёх узлов при удержании
   * проскакивалось бы целиком за один кадр.
   */
  get menuUpPressed(): boolean {
    return this.wasPressed('KeyW') || this.wasPressed('ArrowUp');
  }

  get menuDownPressed(): boolean {
    return this.wasPressed('KeyS') || this.wasPressed('ArrowDown');
  }

  /**
   * Шаг по дереву влево и вправо. Дерево двумерно, и одной вертикали ему мало:
   * колонка — это глубина по предпосылкам, и попасть в соседнюю ветку иначе
   * нечем.
   */
  get menuLeftPressed(): boolean {
    return this.wasPressed('KeyA') || this.wasPressed('ArrowLeft');
  }

  get menuRightPressed(): boolean {
    return this.wasPressed('KeyD') || this.wasPressed('ArrowRight');
  }

  /**
   * Подтверждение покупки С КЛАВИАТУРЫ. Мыши здесь нет намеренно: нажатие
   * кнопкой покупает узел ПОД КУРСОРОМ, и общий признак означал бы, что промах
   * по пустому месту панели тратит счёт на выбранное клавиатурой.
   */
  get menuConfirmPressed(): boolean {
    return this.wasPressed('Space');
  }

  /** Нажатие левой кнопки в меню: цель ему задаёт курсор, а не выбор. */
  get pointerPressed(): boolean {
    return this.mouseLeftJustPressed;
  }

  /**
   * Заморожен ли выбор источника прицела.
   *
   * Любое удерживаемое действие с прицелом, а не одно применение инструмента:
   * высыпание целится теми же двумя способами, и подмена источника посреди
   * него уводила бы кисть так же.
   */
  private get aimFrozen(): boolean {
    return this.toolHeld || this.dumpHeld;
  }

  /**
   * Вертикаль прицела: +1 вниз, -1 вверх, 0 при обеих или ни одной.
   *
   * `W`/`↑` здесь те же, что и прыжок, и это намеренно: «вверх» у игрока —
   * одно намерение, и прокоп вверх выглядит как «выкопал над головой,
   * поднялся в дыру».
   */
  get aimAxisY(): number {
    const down = this.isHeld('KeyS') || this.isHeld('ArrowDown');
    const up = this.jumpHeld;
    return (down ? 1 : 0) - (up ? 1 : 0);
  }

  /** Какое устройство задаёт цель прямо сейчас. */
  get aimSource(): AimSource {
    return this.aim.source;
  }

  /** Отключить или включить весь звук. */
  get muteTogglePressed(): boolean {
    return this.wasPressed('KeyM');
  }

  /** Отладка: сменить выбранное вещество. */
  get debugCycleMaterialPressed(): boolean {
    return this.wasPressed('KeyQ');
  }

  /** Отладка: поставить выбранное вещество в текущей цели прицела. */
  get debugPlaceHeld(): boolean {
    return this.isHeld('KeyE');
  }

  get debugTogglePressed(): boolean {
    return this.wasPressed('F3');
  }
}
