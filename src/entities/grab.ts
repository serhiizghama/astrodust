import { GRAB_CAPACITY } from '../config';

/**
 * Буфер захвата — комок вещества, который персонаж несёт в руках.
 *
 * Ограничения модуля:
 *
 * 1. В комке ОДНО вещество, и держится это здесь: `add` отказывает, когда
 *    вещество не совпадает с уже набранным. Проверка одна на игру — структура,
 *    умеющая хранить смесь, рано или поздно её получит.
 * 2. Предел равен площади квадрата кисти: игрок видит, сколько влезет, прямо
 *    на прицеле, и второго числа для этого держать не должен.
 * 3. Пустой буфер обязан забывать вещество: иначе следующий комок обречён
 *    быть того же вида, что и прошлый.
 *
 * Общего базового класса с инвентарём нет намеренно: у них расходятся и выбор
 * вещества, и правило выброса, а дублируется десяток строк.
 */
export class Grab {
  /** Вещество комка; `null` — буфер пуст. */
  private held: number | null = null;
  private count = 0;

  constructor(readonly capacity: number = GRAB_CAPACITY) {}

  /** Вещество комка или `null`, если нести нечего. */
  get material(): number | null {
    return this.held;
  }

  get used(): number {
    return this.count;
  }

  get free(): number {
    return this.capacity - this.count;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  get isFull(): boolean {
    return this.count >= this.capacity;
  }

  /** Есть ли в комке это вещество и сколько именно. */
  countOf(material: number): number {
    return this.held === material ? this.count : 0;
  }

  /**
   * Кладёт до `amount` и возвращает, сколько поместилось ФАКТИЧЕСКИ. Число —
   * условие сохранения вещества: набор обязан оставить в мире то, что не влезло.
   *
   * Чужое вещество не помещается вовсе, и это не ошибка вызывающего: набор
   * ведёт квадратом по куче, а под квадрат попадает что угодно.
   */
  add(material: number, amount: number): number {
    if (this.held !== null && this.held !== material) return 0;
    const taken = Math.min(amount, this.free);
    if (taken <= 0) return 0;
    this.held = material;
    this.count += taken;
    return taken;
  }

  /** Забирает до `amount` единиц и возвращает, сколько нашлось. */
  take(amount: number): number {
    const given = Math.min(amount, this.count);
    if (given <= 0) return 0;
    this.count -= given;
    if (this.count === 0) this.held = null;
    return given;
  }
}
