import { Tuning } from './tuning';
import { TECHNOLOGIES, TECH_BY_ID } from './technologies';
import type { Technology } from './technologies';

/**
 * Состояние технологии для игрока. Четыре, а не два, и это не украшение:
 * «не хватает очков» лечится работой, «закрыта предпосылкой» — другой покупкой,
 * и одинаковый серый на обеих превращает дерево в загадку.
 */
export type TechStatus =
  /** Куплена. Действует навсегда. */
  | 'open'
  /** Предпосылки выполнены, очков хватает. */
  | 'available'
  /** Предпосылки выполнены, очков не хватает. */
  | 'poor'
  /** Хотя бы одна предпосылка не открыта. Очки роли не играют. */
  | 'blocked';

/**
 * Что открыто из содержимого. Ровно один вопрос — «открыто ли это»,
 * и задаёт его каталог построек, которому знать про исследования незачем.
 */
export interface ContentUnlocks {
  has(content: string): boolean;
}

/** Ничего не открыто — состояние начала партии. Умолчание для проверок. */
export const NO_UNLOCKS: ContentUnlocks = { has: () => false };

/**
 * Очки исследований, купленные технологии и профиль, который они правят.
 *
 * Профиль ЖИВЁТ ЗДЕСЬ, а раздаётся наружу отдельно (`research.tuning`):
 * технологии — единственное, что имеет право его менять, а читателям параметра
 * достаётся только он сам, без всякого следа исследований.
 *
 * Сохранений в проекте нет, поэтому дерево сбрасывается при перезагрузке
 * страницы вместе с миром, инвентарём и постройками. Это принятая цена
 * до появления сохранений, а не отдельный дефект.
 */
export class Research implements ContentUnlocks {
  /** Профиль настраиваемых параметров. Правят его только покупки. */
  readonly tuning = new Tuning();

  /**
   * Очки. Целые и НЕОТРИЦАТЕЛЬНЫЕ: растут на сдаче вещества с ненулевой
   * ставкой исследований, убывают на покупке технологии. Ни частичной оплаты,
   * ни долга в модели нет и вводить их ради дерева незачем.
   */
  points = 0;

  private readonly opened = new Set<string>();
  private readonly unlocked = new Set<string>();

  /** Начисление со сдачи. Отрицательное начисление — не начисление. */
  earn(amount: number): void {
    if (amount > 0) this.points += amount;
  }

  isOpen(id: string): boolean {
    return this.opened.has(id);
  }

  has(content: string): boolean {
    return this.unlocked.has(content);
  }

  /** Выполнены ли все предпосылки. Пустой список выполнен всегда. */
  private ready(tech: Technology): boolean {
    return tech.requires.every((id) => this.opened.has(id));
  }

  status(tech: Technology): TechStatus {
    if (this.opened.has(tech.id)) return 'open';
    if (!this.ready(tech)) return 'blocked';
    return this.points >= tech.cost ? 'available' : 'poor';
  }

  /** Названия неоткрытых предпосылок — оверлею, чтобы причина читалась словами. */
  missing(tech: Technology): string[] {
    return tech.requires
      .filter((id) => !this.opened.has(id))
      .map((id) => TECH_BY_ID.get(id)?.name ?? id);
  }

  /**
   * Покупка.
   *
   * Все отказы проходятся ДО списания: отвергнутая покупка не имеет права
   * стоить ни одного очка. Однократность — первым условием: уже открытая
   * технология не покупается повторно ни при каком количестве очков,
   * и отмены с возвратом не существует — прогресс, который можно откатить,
   * это тот же расходуемый счёт, а не прогресс.
   *
   * @returns состоялась ли покупка
   */
  buy(id: string): boolean {
    const tech = TECH_BY_ID.get(id);
    if (!tech) return false;
    if (this.opened.has(tech.id)) return false;
    if (!this.ready(tech)) return false;
    if (this.points < tech.cost) return false;

    this.points -= tech.cost;
    this.opened.add(tech.id);

    // Эффект применяется В МОМЕНТ покупки и виден сразу: ни перезапуска,
    // ни повторного применения инструмента не требуется. Веток по имени
    // технологии здесь нет и быть не может — только по виду эффекта,
    // а видов ровно два.
    const effect = tech.effect;
    if (effect.kind === 'unlock') this.unlocked.add(effect.content);
    else this.tuning.set(effect.param, effect.value);

    return true;
  }
}

/**
 * Что из снапшота ввода читает оверлей.
 *
 * Те же клавиши, что и в мире: направление выбирает строку, применение
 * инструмента покупает. Учить вторую раскладку ради четырёх строк списка
 * незачем, а двусмысленности нет — открытый оверлей виден.
 */
export interface OverlayInput {
  readonly menuUpPressed: boolean;
  readonly menuDownPressed: boolean;
  readonly toolPressed: boolean;
}

/**
 * Оверлей исследований: открыт ли он и какая строка выбрана.
 *
 * Состояние, а не отрисовка: что нарисовать, решает рендер, а что выбрано
 * и что происходит по нажатию — игровая логика, и проверить её без канваса
 * можно только здесь.
 */
export class ResearchOverlay {
  open = false;
  private index = 0;

  /** Одна клавиша открывает и закрывает: второй учить незачем. */
  toggle(): boolean {
    this.open = !this.open;
    return this.open;
  }

  get selectedIndex(): number {
    return this.index;
  }

  get selected(): Technology {
    return TECHNOLOGIES[this.index]!;
  }

  /**
   * Перемещение по списку. Упирается в края, а не заворачивается по кругу:
   * список короткий и виден целиком, и перескок с конца в начало читался бы
   * как промах, а не как навигация.
   */
  move(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= TECHNOLOGIES.length) return;
    this.index = next;
  }

  /** Покупка выбранной строки. Отказ ничего не меняет и ни о чём не сообщает. */
  buySelected(research: Research): boolean {
    return research.buy(this.selected.id);
  }

  /**
   * Весь ввод шага, пока оверлей открыт.
   *
   * Здесь, а не в игровом цикле: «весь цикл проходится без мыши» — записанное
   * требование, и проверить его можно только там, где его можно позвать.
   * В цикле остаётся ветвление «кому достался ввод», и больше ничего.
   *
   * Подтверждения покупки намеренно нет: диалог ради четырёх строк дороже
   * ошибки, которую он предотвращает, а повторная покупка не бывает случайной —
   * уже открытая технология не списывает ничего.
   */
  handle(input: OverlayInput, research: Research): void {
    if (input.menuUpPressed) this.move(-1);
    if (input.menuDownPressed) this.move(1);
    if (input.toolPressed) this.buySelected(research);
  }
}
