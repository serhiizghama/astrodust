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
   * Игрок воспользовался устройством.
   *
   * Пока копание удерживается, источник заморожен: иначе дрожание мыши на столе
   * во время прокопки с клавиатуры уводило бы кисть на другой конец экрана,
   * а нажатие клавиши движения во время копания мышью перебивало бы курсор.
   */
  note(device: AimSource, digHeld: boolean): void {
    if (digHeld) return;
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
): { x: number; y: number } {
  return {
    x: Math.round(centerX + dirX * DIG.aimDistance),
    y: Math.round(centerY + dirY * DIG.aimDistance),
  };
}

/**
 * Цель копания: её задаёт удерживаемый орган управления, а не глобальный режим.
 *
 * Мышь выигрывает при удержании обоих: у неё есть видимая обратная связь —
 * крестик, — а у клавиатуры её нет, и копать не там, где показывает крестик,
 * молча нельзя.
 */
export function digTarget(
  mouseLeftHeld: boolean,
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number,
  dirX: number,
  dirY: number,
): { x: number; y: number } {
  if (mouseLeftHeld) return { x: cursorX, y: cursorY };
  return aimTarget(centerX, centerY, dirX, dirY);
}

/**
 * Снапшот ввода на текущий шаг симуляции.
 *
 * Различает три состояния клавиши: нажата в этом шаге / удерживается /
 * отпущена в этом шаге. Без «нажата в этом шаге» удержание `W` читалось бы
 * как непрерывная серия прыжков.
 *
 * Раскладка: ходьба `A`/`D` (`←`/`→`), прыжок и ранец `W` (`↑`), копание
 * `Space` или левая кнопка мыши, прицел вниз `S` (`↓`). Обе половины —
 * WASD и стрелки — равноправны, и игра полностью проходится без мыши.
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
    // Правая кнопка пойдёт под высыпание из инвентаря — контекстное меню
    // над канвасом мешало бы уже сейчас.
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
    if (AIM_KEYS.has(e.code)) this.aim.note('keys', this.digHeld);
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
    this.aim.note('mouse', this.digHeld);
  };

  private onMouseDown = (e: MouseEvent): void => {
    // Любая кнопка — действие игрока, даже та, которую игра не использует.
    this.hasInteracted = true;
    if (e.button !== 0) return;
    this.aim.note('mouse', this.digHeld);
    if (!this.mouseLeftHeld) this.mouseLeftPressed = true;
    this.mouseLeftHeld = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.mouseLeftHeld = false;
  };

  private releaseAll = (): void => {
    for (const code of this.held) this.released.add(code);
    this.held.clear();
    // Кнопку мыши тоже отпускаем: иначе персонаж вернётся в копающем состоянии.
    this.mouseLeftHeld = false;
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

  /** Копание: пробел и левая кнопка мыши равноправны, разница только в прицеле. */
  get digHeld(): boolean {
    return this.mouseLeftHeld || this.isHeld('Space');
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
