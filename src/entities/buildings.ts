import { BUILD_MODULE } from '../config';
import { World, MAT } from '../world';

/**
 * Здание — ДВЕ вещи сразу, и по отдельности ни одной не хватает.
 *
 * Корпус живёт в СЕТКЕ: иначе вещество провалится сквозь здание-спрайт.
 * Персонажа корпус при этом НЕ держит — «блокирует персонажа» и правила
 * движения вещества независимы.
 *
 * Состояние живёт в РЕЕСТРЕ: накопитель и ход обработки в байте материала
 * хранить негде. Связь между ними — прямоугольник координат в записи.
 */

/** Что показывать про машину в кадре. */
export type MachineState = 'idle' | 'working' | 'blocked';

/**
 * Описание вида постройки: всё, что известно о нём ДО постановки.
 *
 * Видов ДВА, и различает их одно поле — `create`:
 *
 * ```
 *   машина                            секционная постройка
 *   ▓▓▓▓▓▓▓▓▓▓▓▓  + запись            ▶▶▶▶  и всё
 *   ▓░░░░░░░░░░▓    { накоплено,      ▶▶▶▶
 *   ▓▓▓▓░░░░▓▓▓▓      таймер }        ▶▶▶▶
 *                                     ▶▶▶▶
 * ```
 *
 * Форма корпуса — маска, а не процедура: контур будущей постройки, выкладывание
 * при постановке и очистка при сносе обязаны говорить об одних и тех же ячейках,
 * и три независимых описания одной формы разошлись бы на первой же правке.
 */
export interface BuildingKind {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Корпус по умолчанию. У вида со сторонами — `sideHulls[1]`. */
  readonly hull: number;
  /**
   * Корпуса по стороне переноса: `[влево, вправо]`. `null` — стороны у вида
   * нет.
   *
   * Сторона живёт в МАТЕРИАЛЕ ячейки, а не в записи: у секционной постройки
   * записи нет вовсе, а автомат читает, куда тащить, из ячейки под грузом.
   * Поэтому направление — два материала и один вид, а не наоборот.
   */
  readonly sideHulls: readonly [number, number] | null;
  /** Маска корпуса построчно: 1 — корпус, 0 — пустота внутри области. */
  readonly shape: Uint8Array;
  /**
   * Требуется ли опора. Поле ВИДА, а не общая проверка: машине она обязательна
   * (висящее здание читается ошибкой рендера), ленте запрещена — перенос над
   * пустотой и есть то, ради чего её ставят.
   */
  readonly needsSupport: boolean;
  /**
   * Что открывает этот вид, или `null` — открыт с начала партии.
   *
   * Ссылка на содержимое, а не флаг «закрыт»: технология открывает то, что
   * можно строить, и вид ссылается на него, а не хранит собственный признак.
   *
   * Инвариант: хотя бы один вид открыт с начала — пустой каталог оставляет
   * режим строительства без единого действия и читается поломкой.
   */
  readonly unlock: string | null;
  /**
   * Создаёт запись реестра. `null` — секционная постройка: записывать нечего,
   * а лента в экран длиной дала бы восемьдесят записей и превратила общий шаг
   * в проход по всему построенному.
   */
  readonly create: ((x: number, y: number) => Building) | null;
}

/**
 * Секционная постройка: квадрат в один модуль, без опоры и без записи
 * в реестре. Фабрика, а не выписанные поля: различаются ровно подпись
 * и материалы корпуса.
 *
 * Размер не параметр: секция РАВНА модулю. Секция крупнее модуля означала бы,
 * что снос не может вывести её границы из сетки; мельче — что в одной клетке
 * сетки их несколько, и границы каждой негде взять.
 *
 * Инвариант: корпус сплошной. Пустота внутри секции ловит груз навсегда —
 * выбраться из колодца в статичном веществе сыпучему нечем.
 */
export function sectionKind(
  id: string,
  name: string,
  hulls: number | readonly [number, number],
  unlock: string | null = null,
): BuildingKind {
  const sideHulls = typeof hulls === 'number' ? null : hulls;
  return {
    id,
    name,
    width: BUILD_MODULE,
    height: BUILD_MODULE,
    hull: typeof hulls === 'number' ? hulls : hulls[1],
    sideHulls,
    shape: new Uint8Array(BUILD_MODULE * BUILD_MODULE).fill(1),
    needsSupport: false,
    unlock,
    create: null,
  };
}

/**
 * Материал корпуса для стороны переноса. У вида без сторон сторона ничего
 * не меняет: спрашивать её у стенки должно быть безвредно.
 */
export function hullForSide(kind: BuildingKind, side: -1 | 1): number {
  return kind.sideHulls === null ? kind.hull : kind.sideHulls[side < 0 ? 0 : 1];
}

/**
 * Подпись вида со стороной, которую задаст следующее применение.
 *
 * Сторона в подписи, а не в названии вида: вид один, и в каталоге ей делать
 * нечего. У вида без сторон знака нет вовсе — пустое место под знак, который
 * никогда не появится, читается как недостающее состояние.
 */
export function kindLabel(kind: BuildingKind, side: -1 | 1): string {
  if (kind.sideHulls === null) return kind.name;
  return `${kind.name} ${side < 0 ? '◀' : '▶'}`;
}

/** Экземпляр, стоящий в мире. */
export abstract class Building {
  constructor(
    readonly kind: BuildingKind,
    readonly x: number,
    readonly y: number,
  ) {}

  /** Шаг машины. Мир меняет сама — и только тогда, когда ей есть что менять. */
  abstract update(world: World, dt: number): void;

  /**
   * Что вернуть в мир при сносе — по ячейке на элемент. Список, а не число:
   * внутри лежит и сырьё, и продукт, и снос не имеет права ни съесть вещество,
   * ни превратить его в другое.
   */
  abstract drain(): number[];

  abstract get state(): MachineState;
  /** Ход текущей порции, 0..1. Простой — ноль. */
  abstract get progress(): number;

  contains(px: number, py: number): boolean {
    return (
      px >= this.x &&
      px < this.x + this.kind.width &&
      py >= this.y &&
      py < this.y + this.kind.height
    );
  }

  /** Выкладывает корпус в сетку по маске вида. */
  stamp(world: World): void {
    stampKind(world, this.kind, this.x, this.y, this.kind.hull);
  }

  /**
   * Убирает корпус в ПУСТОТУ, а не в породу: здание ничего в мире не создавало
   * и при сносе ничего оставить не должно.
   */
  clear(world: World): void {
    stampKind(world, this.kind, this.x, this.y, MAT.VACUUM);
  }
}

/**
 * Заливает область по маске вида. Одна функция на постановку, снос и секционную
 * постройку: маска существует затем, чтобы все говорили об одних ячейках.
 */
export function stampKind(
  world: World,
  kind: BuildingKind,
  x: number,
  y: number,
  material: number,
): void {
  const { width, height, shape } = kind;
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (shape[dy * width + dx] === 1) world.set(x + dx, y + dy, material);
    }
  }
}

/**
 * Реестр стоящих зданий. Порядок обновления — порядок постановки: он уже
 * воспроизводим, и сортировка по координатам ничего к этому не добавляет.
 */
export class BuildingRegistry {
  private readonly list: Building[] = [];

  get all(): readonly Building[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  add(building: Building): void {
    this.list.push(building);
  }

  remove(building: Building): void {
    const i = this.list.indexOf(building);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Здание под точкой мира. Именно им отличается снос от постановки. */
  findAt(x: number, y: number): Building | null {
    for (const b of this.list) {
      if (b.contains(x, y)) return b;
    }
    return null;
  }

  /**
   * Общий шаг: список, а не проход по сетке. Правило внутри автомата означало бы
   * проверку «а не здание ли здесь» на каждой из полумиллиона ячеек.
   */
  update(world: World, dt: number): void {
    for (const b of this.list) b.update(world, dt);
  }
}
