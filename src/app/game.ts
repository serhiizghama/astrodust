import { PLAYER } from '../config';
import type { Rect } from '../geometry';
import { Simulation } from '../world';
import type { World } from '../world';
import { BuildingRegistry } from '../entities';
import type { Player, PlayerInput, LandingModule } from '../entities';
import type { Camera } from '../render';
import { createSignals, resetSignals } from '../audio';
import type { AudioSignals } from '../audio';

/** Что копание сделало за шаг. `null` — не копали. */
export interface DigReport {
  readonly converted: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Намерение игрока на шаг: всё, что состояние игры отдаёт миру.
 *
 * Состояния различаются ТОЛЬКО этим. Мир после них идёт одинаково — в том
 * числе при открытом меню, где намерение пустое, а мир всё равно живёт.
 */
export interface StepIntent {
  readonly input: PlayerInput;
  /**
   * Разворот персонажа, назначенный извне: `-1` влево, `1` вправо, `0` —
   * не назначен, разворот остаётся за осью движения.
   */
  readonly faceX: -1 | 0 | 1;
  readonly dig: DigReport | null;
}

/**
 * Состояние игры. Различать состояния имеет право только обработка ввода.
 *
 * Именованный контракт, а не `if` по флагу меню: третье состояние (пауза,
 * смерть, экран запуска) добавляется реализацией, а не копией шага мира.
 * Пока копий было две, они уже успели разойтись на строку сброса контура.
 */
export interface GameState {
  handleInput(dt: number): StepIntent;
}

/**
 * Мир и его шаг.
 *
 * Держит всё, что обязано обновляться каждый шаг независимо от того, чем занят
 * игрок: персонажа, автомат веществ, машины, приёмник и камеру. Инструменты,
 * инвентарь и меню сюда не входят — они принадлежат состоянию игры и живут
 * до вызова `advanceWorld`.
 */
export class Game {
  readonly simulation = new Simulation();
  readonly buildings = new BuildingRegistry();
  /** Снапшот сигналов переиспользуется: аллокаций на шаге нет. */
  readonly signals: AudioSignals = createSignals();

  constructor(
    readonly world: World,
    readonly player: Player,
    readonly camera: Camera,
    readonly landingModule: LandingModule,
  ) {}

  /** Область, которую автомат обязан считать занятой. */
  get occupant(): Rect {
    return { x: this.player.x, y: this.player.y, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
  }

  /**
   * Шаг мира. ЕДИНСТВЕННОЕ место, где записан порядок обновлений.
   *
   * Порядок — требование спеки `game-shell`, а не удобство записи. Персонаж
   * идёт до автомата, чтобы автомат видел СВЕЖИЙ хитбокс и не засыпал игрока
   * изнутри. Машины и приёмник — после автомата и в этом порядке, чтобы ячейка,
   * скатившаяся на приёмную грань на этом шаге, была обработана на нём же.
   * Отчёт для звука — последним: это отчёт о случившемся, а не заявка.
   */
  advanceWorld(dt: number, intent: StepIntent): void {
    this.player.update(dt, intent.input, this.world);
    // ПОСЛЕ `update`: тот выставляет разворот от оси движения, а назначенный
    // извне обязан его перекрыть — иначе курсор поворачивал бы только стоящего.
    if (intent.faceX !== 0) this.player.facing = intent.faceX;
    this.simulation.update(this.world, this.occupant);
    this.buildings.update(this.world, dt);
    this.landingModule.update(this.world);
    this.camera.follow(this.player.centerX, this.player.centerY);
    this.collectSignals(intent.dig);
  }

  /**
   * Счётчики шага для звука.
   *
   * Точка отсчёта слышимости — персонаж, а не центр кадра: кадр отстаёт
   * от него на сглаживание и мёртвую зону, и звуковая картина уползала бы
   * вбок при ходьбе.
   */
  private collectSignals(dig: DigReport | null): void {
    const s = this.signals;
    resetSignals(s);
    s.listenerX = this.player.centerX;
    s.listenerY = this.player.centerY;
    if (dig !== null) {
      s.digConverted = dig.converted;
      s.digX = dig.x;
      s.digY = dig.y;
    }
    const moves = this.simulation.lastPowderMoves;
    s.powderMoves = moves;
    if (moves > 0) {
      s.powderX = this.simulation.lastPowderSumX / moves;
      s.powderY = this.simulation.lastPowderSumY / moves;
    }
  }
}
