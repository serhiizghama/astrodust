import { MAT, MAT_SOLID, MAT_RISES, MAT_IS_LIQUID } from './materials';
import { ChunkGrid } from './chunks';

/**
 * Слой силуэтов на горизонте. Форма — высота на колонку, а не картинка:
 * колонка кадра тогда рисуется сплошным пробегом, без попиксельной проверки
 * принадлежности слою.
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
   * Атмосферы нет, выцветать нечему: дальность читается размером формы.
   */
  readonly detail: number;
}

/**
 * Параметры задника: всё, что рисуется за миром, но перед пустотой. Живёт
 * в профиле мира, а не в рендере: новый мир не должен править код отрисовки.
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
  /** Направление на Солнце: -1 слева, +1 справа. Свойство мира, не рендера. */
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
 * глобальные константы: смена мира не должна править код движения.
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
 * Мир — плоская сетка ячеек, ячейка хранит id материала и равна пикселю
 * буфера.
 *
 * Инвариант: это ЕДИНСТВЕННЫЙ источник правды о геометрии — по этим же ячейкам
 * считается коллизия и строится картинка. Второго представления (тайлмапа,
 * слоя коллизий) заводить нельзя: разрушаемость держится именно на этом.
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

  /** Запись без пробуждения — только для заливки при генерации мира. */
  setRaw(x: number, y: number, material: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    this.trackCounts(this.cells[i]!, material);
    this.cells[i] = material;
  }

  /**
   * Счётчики газовых и жидких ячеек: позволяют пропустить целый проход, когда
   * обрабатывать нечего. Пара выборок на запись дешевле, чем обход десятков
   * тысяч ячеек впустую.
   */
  private trackCounts(from: number, to: number): void {
    if (from === to) return;
    this.gasCells += MAT_RISES[to]! - MAT_RISES[from]!;
    this.liquidCells += MAT_IS_LIQUID[to]! - MAT_IS_LIQUID[from]!;
  }

  /**
   * Твёрдая ли ячейка. За пределами сетки — всегда true: покинуть мир нельзя
   * по построению, а не отдельным условием, которое кто-то забудет добавить.
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
