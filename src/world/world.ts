import { MAT, MAT_SOLID, MAT_RISES, MAT_IS_LIQUID } from './materials';
import { ChunkGrid } from './chunks';

/**
 * Слой силуэтов на горизонте.
 *
 * Форма задаётся высотой на колонку, а не картинкой: колонка кадра тогда
 * рисуется сплошными вертикальными пробегами, без попиксельной проверки
 * «принадлежу ли я слою».
 */
export interface BackdropLayerSpec {
  /** Доля смещения камеры, которую проходит слой. 0 — бесконечно далеко. */
  readonly parallax: number;
  readonly fill: number;
  /** Положение гребня в координатах мира. */
  readonly crestY: number;
  /** Размах формы вокруг гребня, в пикселях. */
  readonly amplitude: number;
  /**
   * Число опорных точек шума на оборот. Больше — мельче и изрезаннее.
   * Атмосферы нет, выцветать по дистанции нечему, поэтому дальность читается
   * в том числе через размер формы: ближние слои крупные и гладкие.
   */
  readonly detail: number;
}

/**
 * Параметры задника: всё, что рисуется за миром, но перед пустотой.
 *
 * Живёт в профиле мира, а не в рендере: новый мир должен получать свой задник
 * из своего профиля, без правок в коде отрисовки.
 */
export interface BackdropSpec {
  /** Доля ячеек неба, занятых звездой. */
  readonly starDensity: number;
  /** Цвета звёзд от тусклых к ярким. */
  readonly starColors: readonly number[];
  /** Доли каждого уровня яркости; сумма — единица. */
  readonly starWeights: readonly number[];
  /** Общий для звёзд и небесных тел параллакс. Близок к нулю, но не ноль. */
  readonly skyParallax: number;
  /** Полоса галактики: сгущение звёзд и слабое свечение. */
  readonly milkyWay: {
    readonly centerY: number;
    readonly halfWidth: number;
    /** Наклон полосы: сдвиг по y на пиксель по x. */
    readonly tilt: number;
    /** Во сколько раз плотнее звёзды внутри полосы. */
    readonly densityBoost: number;
    readonly glowColor: number;
  } | null;
  readonly layers: readonly BackdropLayerSpec[];
  /**
   * Направление на Солнце по горизонтали: -1 — слева, +1 — справа.
   * То же поле позже понадобится для теней на самом рельефе, поэтому оно
   * свойство мира, а не константа рендера.
   */
  readonly sunDirX: -1 | 1;
  /** Кромка склона, обращённого к Солнцу. */
  readonly rimWarm: number;
  /** Кромка склона, обращённого к отражённому свету соседнего тела. */
  readonly rimCold: number;
  /** Соседнее небесное тело: на Луне — Земля. */
  readonly companion: { readonly x: number; readonly y: number } | null;
  /** Орбитальный объект — единственная автономная анимация задника. */
  readonly orbiter: {
    readonly color: number;
    readonly y: number;
    /** Полный цикл, секунды: проход плюс пауза. */
    readonly periodSec: number;
    /** Сколько секунд занимает сам проход через кадр. */
    readonly crossSec: number;
  } | null;
}

/**
 * Описание небесного тела. Гравитация и палитра — свойства мира, а не
 * глобальные константы: смена мира должна менять ощущение прыжка без правок
 * в коде движения.
 */
export interface WorldProfile {
  readonly id: string;
  readonly name: string;
  /** Ускорение свободного падения, px/с². */
  readonly gravity: number;
  /** Цвет неба (0xRRGGBB) для ячеек пустоты выше поверхности. */
  readonly skyColor: number;
  /** Цвет пустоты ниже поверхности — иначе пещера выглядела бы открытым небом. */
  readonly caveColor: number;
  readonly backdrop: BackdropSpec;
}

/**
 * Мир — плоская сетка ячеек, где каждая ячейка хранит id материала.
 * Одна ячейка = один экранный пиксель при масштабе x1.
 *
 * Это единственный источник правды о геометрии: по этим же ячейкам считается
 * коллизия и строится картинка. Отдельного тайлового представления нет —
 * поэтому разрушаемость и физика материалов сводятся к записи в массив.
 */
export class World {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  readonly profile: WorldProfile;
  /** Какие области симулировать. Запись в ячейку будит её окрестность. */
  readonly chunks: ChunkGrid;
  /** Сколько в мире всплывающих ячеек. Ноль — проход для газов не нужен. */
  gasCells = 0;
  /** Сколько в мире жидких ячеек. Ноль — карта уровня не нужна вовсе. */
  liquidCells = 0;

  constructor(width: number, height: number, profile: WorldProfile) {
    this.width = width;
    this.height = height;
    this.profile = profile;
    this.cells = new Uint8Array(width * height);
    this.chunks = new ChunkGrid(width, height);
  }

  /** Материал ячейки. За пределами сетки — порода (мир замкнут). */
  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return MAT.ROCK;
    return this.cells[y * this.width + x]!;
  }

  /** Записывает материал и будит окрестность — иначе изменение не оживёт. */
  set(x: number, y: number, material: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    this.trackCounts(this.cells[i]!, material);
    this.cells[i] = material;
    this.chunks.touch(x, y);
  }

  /**
   * Запись без пробуждения — только для массовой заливки при генерации мира.
   * Там пробуждать нечего: мир строится целиком и сразу будится один раз.
   */
  setRaw(x: number, y: number, material: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    this.trackCounts(this.cells[i]!, material);
    this.cells[i] = material;
  }

  /**
   * Счётчики газовых и жидких ячеек.
   *
   * Оба существуют ради одного и того же: пропускать целый проход, когда
   * обрабатывать нечего. Всплывающие вещества требуют отдельного прохода
   * сверху вниз, жидкости — расчёта карты уровня; и то и другое дорого, а на
   * Луне генератор мира не размещает ни того, ни другого. Пара выборок из
   * массива на запись дешевле, чем обход десятков тысяч ячеек впустую.
   */
  private trackCounts(from: number, to: number): void {
    if (from === to) return;
    this.gasCells += MAT_RISES[to]! - MAT_RISES[from]!;
    this.liquidCells += MAT_IS_LIQUID[to]! - MAT_IS_LIQUID[from]!;
  }

  /**
   * Твёрдая ли ячейка.
   *
   * За пределами сетки — всегда true. Это убирает проверки границ из кода
   * движения: покинуть мир нельзя по построению, а не благодаря отдельному
   * условию, которое кто-то забудет добавить.
   */
  isSolid(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true;
    return MAT_SOLID[this.cells[y * this.width + x]!] === 1;
  }

  /** Пересекает ли прямоугольник (в ячейках) хотя бы одну твёрдую ячейку. */
  rectHitsSolid(x: number, y: number, w: number, h: number): boolean {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        if (this.isSolid(px, py)) return true;
      }
    }
    return false;
  }
}
