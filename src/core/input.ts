import { VIEW_W, VIEW_H, DIG } from '../config';
import { Display } from './display';

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

/** Порядок перебора по кругу и подписи для кадра. */
const MODE_CYCLE: readonly ToolModeValue[] = [ToolMode.Dig, ToolMode.Collect, ToolMode.Build];
const MODE_NAMES: Record<ToolModeValue, string> = {
  [ToolMode.Dig]: 'Копание',
  [ToolMode.Collect]: 'Сбор',
  [ToolMode.Build]: 'Строительство',
};

/**
 * Текущий режим инструмента.
 *
 * Перебор по кругу списком, а не переключатель на два положения: следующий
 * шаг добавляет строительство, и «переключить» перестанет означать
 * «инвертировать».
 */
export class ToolModeState {
  private index = 0;

  get mode(): ToolModeValue {
    return MODE_CYCLE[this.index]!;
  }

  get name(): string {
    return MODE_NAMES[this.mode];
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
   * Следующий режим по кругу.
   *
   * Перебор списком, а не переключатель: добавление режима MUST NOT требовать
   * новой клавиши, иначе раскладка растёт вместе с числом зданий. Третий режим
   * встал сюда одной строкой — правила перебора не поменялись.
   */
  cycle(): void {
    this.index = (this.index + 1) % MODE_CYCLE.length;
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
 * `Space` или ЛКМ, высыпание `F` или ПКМ, режим `R`, вещество `C`, вид
 * постройки `X`, оверлей `T`, прицел вниз `S` (`↓`). Инвариант: у каждой
 * кнопки мыши есть клавиша — игра полностью проходится без мыши.
 *
 * Кому достанутся нажатия, снапшот не знает: при открытом оверлее та же
 * раскладка означает другое, и решает это игровой цикл.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();

  /** Позиция курсора в координатах буфера кадра. */
  mouseX = VIEW_W / 2;
  mouseY = VIEW_H / 2;
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
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    this.hasInteracted = true;
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
    this.mouseX = Math.max(0, Math.min(VIEW_W - 1, p.x));
    this.mouseY = Math.max(0, Math.min(VIEW_H - 1, p.y));
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
   * Сбросить всё удерживаемое.
   *
   * Публичный, а не только обработчик потери фокуса: открытие оверлея обязано
   * делать то же самое и ТЕМ ЖЕ способом. Клавиша, зажатая в момент открытия,
   * иначе оставляет персонажа бегущим всё время, пока игрок читает дерево, —
   * ровно то залипание, от которого потеря фокуса уже защищена.
   */
  releaseAll = (): void => {
    for (const code of this.held) this.released.add(code);
    this.held.clear();
    // Кнопки мыши тоже отпускаем: иначе персонаж вернётся в копающем состоянии.
    this.mouseLeftHeld = false;
    this.mouseRightHeld = false;
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
   */
  get toolHeld(): boolean {
    return this.mouseLeftHeld || this.isHeld('Space');
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
    return this.mouseLeftJustPressed || this.wasPressed('Space');
  }

  /** Высыпание из инвентаря. Доступно в любом режиме и своим органом управления. */
  get dumpHeld(): boolean {
    return this.mouseRightHeld || this.isHeld('KeyF');
  }

  /** Сменить режим инструмента. */
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
   * Направление ленты при этом два отдельных вида каталога, а не поворот.
   */
  get buildKindPressed(): boolean {
    return this.wasPressed('KeyX');
  }

  /** Открыть или закрыть оверлей исследований. */
  get researchTogglePressed(): boolean {
    return this.wasPressed('KeyT');
  }

  /**
   * Шаг по списку оверлея вверх и вниз.
   *
   * Те же клавиши направления, что и в мире, — учить вторую раскладку ради
   * четырёх строк списка незачем, а двусмысленности нет: открытый оверлей
   * виден. НАЖАТИЕ, а не удержание: список из четырёх строк при удержании
   * проскакивался бы целиком за один кадр.
   */
  get menuUpPressed(): boolean {
    return this.wasPressed('KeyW') || this.wasPressed('ArrowUp');
  }

  get menuDownPressed(): boolean {
    return this.wasPressed('KeyS') || this.wasPressed('ArrowDown');
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
