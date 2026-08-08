import { World } from '../world/world';
import { MAT } from '../world/materials';

/**
 * Здание — это ДВЕ вещи сразу, и ни одной из них по отдельности не хватает.
 *
 * Корпус живёт в СЕТКЕ: она единственный источник правды о геометрии, и
 * здание-спрайт персонаж прошёл бы насквозь, а вещество провалилось бы сквозь
 * корпус. Пришлось бы заводить второй механизм коллизии специально для построек.
 *
 * Состояние живёт в РЕЕСТРЕ: у машины есть накопитель и ход обработки, а в байте
 * материала их хранить негде. Связь между сеткой и реестром — прямоугольник
 * координат в записи.
 */

/** Что показывать про машину в кадре. */
export type MachineState = 'idle' | 'working' | 'blocked';

/**
 * Описание вида здания: всё, что известно о нём ДО постановки.
 *
 * Форма корпуса — маска, а не процедура: контур будущего здания, выкладывание
 * при постановке и очистка при сносе обязаны говорить об одних и тех же ячейках,
 * и три независимых описания одной формы разошлись бы на первой же правке.
 */
export interface BuildingKind {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly cost: number;
  readonly hull: number;
  /** Маска корпуса построчно: 1 — корпус, 0 — пустота внутри области. */
  readonly shape: Uint8Array;
  create(x: number, y: number): Building;
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
   * Что вернуть в мир при сносе — по одной ячейке на элемент.
   *
   * Список, а не число: внутри может лежать и сырьё, и уже готовый продукт,
   * и вернуться обязано именно то, что там лежит. Снос не имеет права ни съесть
   * вещество, ни превратить его во что-то другое.
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
    const { width, height, shape, hull } = this.kind;
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (shape[dy * width + dx] === 1) world.set(this.x + dx, this.y + dy, hull);
      }
    }
  }

  /**
   * Убирает корпус в ПУСТОТУ, а не в породу: здание ничего в мире не создавало
   * и при сносе ничего оставить не должно.
   */
  clear(world: World): void {
    const { width, height, shape } = this.kind;
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (shape[dy * width + dx] === 1) world.set(this.x + dx, this.y + dy, MAT.VACUUM);
      }
    }
  }
}

/**
 * Реестр стоящих в мире зданий.
 *
 * Порядок обновления — порядок постановки. Детерминированность нужна та же,
 * что и у автомата, а сортировка по координатам ничего к ней не добавляет:
 * порядок списка уже воспроизводим.
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
   * Общий шаг: список, а не проход по сетке.
   *
   * Правило внутри автомата означало бы проверку «а не здание ли здесь»
   * на каждой из полумиллиона ячеек мира. Зданий же единицы, и каждое смотрит
   * на два своих ряда.
   */
  update(world: World, dt: number): void {
    for (const b of this.list) b.update(world, dt);
  }
}
