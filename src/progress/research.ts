import { Tuning } from './tuning';
import { TECHNOLOGIES, TECH_BY_ID } from './technologies';
import { stepTo } from './tech-layout';
import type { Technology } from './technologies';

/**
 * Состояние технологии для игрока. Четыре, а не два, и это не украшение:
 * «не хватает кредитов» лечится работой, «закрыта предпосылкой» — другой
 * покупкой, и одинаковый серый на обеих превращает дерево в загадку.
 */
export type TechStatus =
  /** Куплена. Действует навсегда. */
  | 'open'
  /** Предпосылки выполнены, кредитов хватает. */
  | 'available'
  /** Предпосылки выполнены, кредитов не хватает. */
  | 'poor'
  /** Хотя бы одна предпосылка не открыта. Счёт роли не играет. */
  | 'blocked';

/**
 * Кредитный счёт, из которого платят за технологию.
 *
 * Узкий контракт, а не ссылка на модуль: `entities` лежит НИЖЕ `progress`
 * по слоям, и ссылка вверх запрещена. Счёт при этом остаётся один — тот же,
 * что растёт на сдаче: второй счётчик рядом с ним однажды разошёлся бы
 * с первым.
 */
export interface CreditAccount {
  readonly credits: number;
  spend(amount: number): boolean;
}

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
 * Купленные технологии и профиль, который они правят.
 *
 * Счётчика валюты ЗДЕСЬ НЕТ: кредиты живут в посадочном модуле и приходят
 * параметром. Валюта в игре одна, и второй её счётчик в дереве означал бы
 * две кривые накопления из одного источника.
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

  private readonly opened = new Set<string>();
  private readonly unlocked = new Set<string>();

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

  /**
   * Состояние технологии при данном счёте.
   *
   * Счёт ПАРАМЕТРОМ, а не полем: дерево не владеет валютой и не имеет права
   * ответить «доступна» по своей копии счёта, разошедшейся с настоящим.
   */
  status(tech: Technology, credits: number): TechStatus {
    if (this.opened.has(tech.id)) return 'open';
    if (!this.ready(tech)) return 'blocked';
    return credits >= tech.cost ? 'available' : 'poor';
  }

  /** Названия неоткрытых предпосылок — подсказке, чтобы причина читалась словами. */
  missing(tech: Technology): string[] {
    return tech.requires
      .filter((id) => !this.opened.has(id))
      .map((id) => TECH_BY_ID.get(id)?.name ?? id);
  }

  /**
   * Покупка. Инвариант: все отказы проходятся ДО списания — отвергнутая покупка
   * не стоит ни кредита. Однократность первым условием, отмены с возвратом нет:
   * откатываемый прогресс — это расходуемый счёт, а не прогресс.
   *
   * Это ЕДИНСТВЕННАЯ невозвратная трата в игре: постройка бесплатна, и вернуть
   * потраченное больше неоткуда.
   *
   * @returns состоялась ли покупка
   */
  buy(id: string, account: CreditAccount): boolean {
    const tech = TECH_BY_ID.get(id);
    if (!tech) return false;
    if (this.opened.has(tech.id)) return false;
    if (!this.ready(tech)) return false;
    if (!account.spend(tech.cost)) return false;

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
 * Причина недоступности СЛОВАМИ.
 *
 * Здесь, а не в сборке кадра: цвет отвечает «нельзя» и не отвечает «почему»,
 * а причины требуют разных действий — «не хватает» лечится работой, «закрыта
 * предпосылкой» другой покупкой. Правило, живущее в бутстрапе, не проверяется
 * без браузера, и первая же правка тихо оставила бы дерево без объяснений.
 *
 * Нехватка называет НЕДОСТАЮЩУЮ сумму, а не цену: цена стоит под узлом,
 * а игроку нужно знать, сколько ещё донести.
 *
 * @returns пустая строка, если объяснять нечего — узел куплен или доступен
 */
export function statusNote(
  tech: Technology,
  status: TechStatus,
  credits: number,
  research: Research,
): string {
  if (status === 'poor') return `нужно ещё ${tech.cost - credits} ₡`;
  if (status === 'blocked') return `требует: ${research.missing(tech).join(', ')}`;
  return '';
}

/**
 * Что из снапшота ввода читает оверлей.
 *
 * Те же клавиши направления, что и в мире: направление ходит по дереву,
 * пробел покупает выбранное. Учить вторую раскладку незачем, а двусмысленности
 * нет — открытый оверлей виден.
 *
 * Подтверждение с клавиатуры и нажатие мыши РАЗВЕДЕНЫ намеренно. Общее
 * «применение инструмента» означало бы, что нажатие мышью по пустому месту
 * панели покупает выбранное клавиатурой, — то есть промах тратит счёт.
 */
export interface OverlayInput {
  readonly menuUpPressed: boolean;
  readonly menuDownPressed: boolean;
  readonly menuLeftPressed: boolean;
  readonly menuRightPressed: boolean;
  /** Подтверждение с клавиатуры. Покупает ВЫБРАННЫЙ узел. */
  readonly menuConfirmPressed: boolean;
  /** Нажатие левой кнопки. Покупает узел ПОД КУРСОРОМ, если он там есть. */
  readonly pointerPressed: boolean;
}

/**
 * Оверлей исследований: открыт ли он и какой узел выбран.
 *
 * Состояние, а не отрисовка: что нарисовать, решает рендер, а что выбрано
 * и что происходит по нажатию — игровая логика, и проверить её без канваса
 * можно только здесь.
 *
 * Ходит по КОЛОНКАМ И СТРОКАМ раскладки, а не по индексу списка: дерево
 * двумерно, и «следующий по таблице» на нём означал бы прыжок через полкадра.
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
   * Перемещение по дереву. Упирается в края, а не заворачивается по кругу:
   * дерево видно целиком, и перескок с края на край читался бы как промах.
   */
  move(dx: number, dy: number): void {
    this.index = stepTo(this.index, dx, dy);
  }

  /** Покупка выбранного узла. Отказ ничего не меняет и ни о чём не сообщает. */
  buySelected(research: Research, account: CreditAccount): boolean {
    return research.buy(this.selected.id, account);
  }

  /**
   * Весь ввод шага при открытом оверлее. Здесь, а не в игровом цикле: «весь
   * цикл проходится без мыши» — требование, и проверить его можно только там,
   * где его можно позвать. Подтверждения покупки нет намеренно: повторная
   * покупка не бывает случайной, уже открытая технология не списывает ничего.
   *
   * @param pointerNode узел под курсором, или `null` — курсор мимо узлов.
   *   Считает его рендер по своей раскладке, здесь пикселей нет.
   */
  handle(
    input: OverlayInput,
    research: Research,
    account: CreditAccount,
    pointerNode: number | null = null,
  ): void {
    if (input.menuUpPressed) this.move(0, -1);
    if (input.menuDownPressed) this.move(0, 1);
    if (input.menuLeftPressed) this.move(-1, 0);
    if (input.menuRightPressed) this.move(1, 0);

    if (input.menuConfirmPressed) this.buySelected(research, account);

    // Нажатие мимо узлов не покупает НИЧЕГО: иначе промах по пустому месту
    // панели тратит счёт на технологию, в которую игрок не целился.
    if (input.pointerPressed && pointerNode !== null) {
      this.index = pointerNode;
      this.buySelected(research, account);
    }
  }
}
