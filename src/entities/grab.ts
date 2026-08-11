import { GRAB_CAPACITY } from '../config';
import { MATERIALS } from '../world';

/**
 * Буфер захвата — комок вещества, который персонаж несёт в руках.
 *
 * Устроен как инвентарь (счётчики по id материала при общем пределе), но это
 * ОТДЕЛЬНЫЙ переносчик, а не его вид. Предел равен площади квадрата кисти:
 * игрок видит, сколько влезет, прямо на прицеле, и второго числа для этого
 * держать не должен.
 *
 * Выбранного вещества здесь нет и не будет: выброс отдаёт комок целиком,
 * и выбирать в нём нечего.
 *
 * Общего базового класса с инвентарём нет намеренно: у них расходятся и выбор
 * вещества, и правило выброса, а дублируется десяток строк.
 */
export class Grab {
  /** Счётчики по идентификатору материала. Индекс — id, значение — ячейки. */
  private readonly counts: Uint32Array;
  private total = 0;

  constructor(readonly capacity: number = GRAB_CAPACITY) {
    this.counts = new Uint32Array(MATERIALS.length);
  }

  get used(): number {
    return this.total;
  }

  get free(): number {
    return this.capacity - this.total;
  }

  get isEmpty(): boolean {
    return this.total === 0;
  }

  get isFull(): boolean {
    return this.total >= this.capacity;
  }

  count(material: number): number {
    return this.counts[material] ?? 0;
  }

  /**
   * Кладёт до `amount` и возвращает, сколько поместилось ФАКТИЧЕСКИ. Число —
   * условие сохранения вещества: набор обязан оставить в мире то, что не влезло.
   */
  add(material: number, amount: number): number {
    const taken = Math.min(amount, this.free);
    if (taken <= 0) return 0;
    this.counts[material] += taken;
    this.total += taken;
    return taken;
  }

  /** Забирает до `amount` единиц и возвращает, сколько нашлось. */
  take(material: number, amount: number): number {
    const given = Math.min(amount, this.count(material));
    if (given <= 0) return 0;
    this.counts[material] -= given;
    this.total -= given;
    return given;
  }

  /**
   * Идентификаторы веществ в комке по ВОЗРАСТАНИЮ id.
   *
   * Порядок задан здесь, потому что от него зависит сетка после выброса:
   * порядок «по количеству» менялся бы от ходки к ходке, и один и тот же
   * выброс из одинакового состояния мира давал бы разный результат.
   */
  materials(): number[] {
    const out: number[] = [];
    for (let m = 0; m < this.counts.length; m++) {
      if (this.counts[m]! > 0) out.push(m);
    }
    return out;
  }
}
