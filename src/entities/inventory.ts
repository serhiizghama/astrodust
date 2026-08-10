import { VACUUM } from '../config';
import { MATERIALS, PORTABLE_MATERIALS } from '../world';

/**
 * Инвентарь персонажа — «вакуумный пылесос».
 *
 * Счётчики по материалам с ОБЩИМ пределом ёмкости, а не слоты с предметами.
 * Ячейка мира — это один байт материала, и всё, что можно унести, — «сколько
 * ячеек какого вещества». Слоты ввели бы сущность, которой в модели мира
 * не существует.
 *
 * Предел существует ради ходки к приёмнику. Без него можно копать бесконечно
 * и сдать всё за один раз, и расположение модуля на карте перестаёт что-либо
 * значить.
 *
 * Названий веществ инвентарь не знает: что переносимо и что выбирается для
 * высыпания, читается из таблицы материалов.
 */
export class Inventory {
  /** Счётчики по идентификатору материала. Индекс — id, значение — ячейки. */
  private readonly counts: Uint32Array;
  private total = 0;
  private selectedIndex = 0;

  constructor(readonly capacity: number = VACUUM.capacity) {
    this.counts = new Uint32Array(MATERIALS.length);
  }

  /** Сколько единиц занято суммарно по всем материалам. */
  get used(): number {
    return this.total;
  }

  /** Сколько ещё влезет. */
  get free(): number {
    return this.capacity - this.total;
  }

  count(material: number): number {
    return this.counts[material] ?? 0;
  }

  /**
   * Кладёт до `amount` единиц и возвращает, сколько поместилось ФАКТИЧЕСКИ.
   *
   * Возвращаемое число — не вежливость, а условие сохранения вещества: сбор
   * обязан оставить в мире ровно то, что не влезло. Кисть, накрывшая больше
   * ячеек, чем есть места, забирает сколько может, а не отказывается целиком:
   * отказ читался бы как поломка инструмента.
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

  /** Какое вещество высыплется. */
  get selected(): number {
    return PORTABLE_MATERIALS[this.selectedIndex]!;
  }

  get selectedName(): string {
    return MATERIALS[this.selected]!.name;
  }

  /**
   * Следующее переносимое вещество по кругу.
   *
   * Перебор идёт по всем переносимым, а не только по тем, что сейчас в наличии:
   * список, меняющий длину от содержимого, означал бы, что одно и то же число
   * нажатий приводит к разному веществу.
   */
  cycleSelected(): void {
    this.selectedIndex = (this.selectedIndex + 1) % PORTABLE_MATERIALS.length;
  }
}
