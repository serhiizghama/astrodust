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
 * Очки, купленные технологии и профиль, который они правят.
 *
 * Профиль ЖИВЁТ ЗДЕСЬ, а раздаётся отдельно (`research.tuning`): менять его
 * имеют право только технологии, а читателю параметра достаётся он сам,
 * без следа исследований.
 *
 * Сохранений нет: дерево сбрасывается при перезагрузке вместе с миром.
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
   * Покупка. Инвариант: все отказы проходятся ДО списания — отвергнутая покупка
   * не стоит ни очка. Однократность первым условием, отмены с возвратом нет:
   * откатываемый прогресс — это расходуемый счёт, а не прогресс.
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
   * Весь ввод шага при открытом оверлее. Здесь, а не в игровом цикле: «весь
   * цикл проходится без мыши» — требование, и проверить его можно только там,
   * где его можно позвать. Подтверждения покупки нет намеренно: повторная
   * покупка не бывает случайной, уже открытая технология не списывает ничего.
   */
  handle(input: OverlayInput, research: Research): void {
    if (input.menuUpPressed) this.move(-1);
    if (input.menuDownPressed) this.move(1);
    if (input.toolPressed) this.buySelected(research);
  }
}
