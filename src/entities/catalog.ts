import { SEPARATOR_KIND } from './separator';
import { CONVEYOR_LEFT_KIND, CONVEYOR_RIGHT_KIND } from './conveyor';
import { NO_UNLOCKS } from '../progress/research';
import type { ContentUnlocks } from '../progress/research';
import type { BuildingKind } from './buildings';

/**
 * Каталог построек: всё, что игрок может поставить, в порядке перебора.
 *
 * Один список, а не набор переменных по месту использования: выбор вида,
 * контур под целью и постановка обязаны говорить об одном и том же наборе,
 * и три независимых перечисления разошлись бы на первой же новой постройке.
 */
export const BUILD_CATALOG: readonly BuildingKind[] = [
  SEPARATOR_KIND,
  CONVEYOR_LEFT_KIND,
  CONVEYOR_RIGHT_KIND,
];

/**
 * Вид секционной постройки по материалу её корпуса, или `null`.
 *
 * Нужен сносу: у машины запись в реестре отвечает, что здесь стоит постройка,
 * а у секционной реестра нет вовсе — единственный её след в мире это ячейки
 * сетки. Обратный поиск по материалу и есть тот же вопрос, заданный сетке.
 *
 * Таблица, а не перебор списка: снос спрашивает на каждое применение
 * инструмента, а материал — целое число.
 */
const SECTION_BY_HULL = new Map<number, BuildingKind>(
  BUILD_CATALOG.filter((k) => k.create === null).map((k) => [k.hull, k]),
);

export function sectionKindByHull(hull: number): BuildingKind | null {
  return SECTION_BY_HULL.get(hull) ?? null;
}

/**
 * Открыт ли вид прямо сейчас.
 *
 * Одна функция на каталог и на постановку: показывать в переборе одно,
 * а ставить разрешать другое — два источника правды об одном и том же.
 */
export function isKindOpen(kind: BuildingKind, unlocks: ContentUnlocks): boolean {
  return kind.unlock === null || unlocks.has(kind.unlock);
}

/**
 * Выбранный вид постройки.
 *
 * Перебор по кругу списком, а не клавиша на вид: раскладка не должна расти
 * вместе с каталогом — тот же довод, что и у режимов инструмента. Отдельно
 * от выбора вещества инвентаря: высыпание доступно в любом режиме, и отбирать
 * у игрока выбор высыпаемого на время строительства нечем оправдать.
 *
 * Перебор идёт ТОЛЬКО ПО ОТКРЫТЫМ видам. Показывать в каталоге то, что нельзя
 * построить, — значит заставлять игрока пролистывать отказы; место, где видно
 * закрытое и цена его открытия, — оверлей исследований, а не каталог.
 *
 * Открытое пересчитывается на каждом обращении, а не запоминается при создании:
 * покупка технологии обязана быть видна немедленно, следующим же перебором,
 * без перезапуска партии.
 */
export class BuildCatalogState {
  /**
   * Индекс в ПОЛНОМ каталоге, а не в списке открытых. Индекс в отфильтрованном
   * списке сдвигался бы под ногами при каждой покупке: открылась лента —
   * и выбранным молча стал другой вид.
   */
  private index = 0;

  constructor(private readonly unlocks: ContentUnlocks = NO_UNLOCKS) {}

  /** Виды, доступные перебору прямо сейчас. Пустым не бывает: сепаратор открыт. */
  get open(): readonly BuildingKind[] {
    return BUILD_CATALOG.filter((k) => isKindOpen(k, this.unlocks));
  }

  get kind(): BuildingKind {
    const current = BUILD_CATALOG[this.index]!;
    // Выбранным мог остаться вид, который открыт не был: индекс переживает
    // покупки, а до них перебор его просто не достигал. Отдаём первый открытый.
    if (isKindOpen(current, this.unlocks)) return current;
    return this.open[0]!;
  }

  get name(): string {
    return this.kind.name;
  }

  cycle(): void {
    // Со следующего за текущим и до первого открытого: закрытые проматываются
    // молча, а не отдаются игроку как строка каталога, на которой ничего
    // не происходит. Полный круг заведомо упирается в сепаратор.
    const n = BUILD_CATALOG.length;
    const from = BUILD_CATALOG.indexOf(this.kind);
    for (let step = 1; step <= n; step++) {
      const next = (from + step) % n;
      if (isKindOpen(BUILD_CATALOG[next]!, this.unlocks)) {
        this.index = next;
        return;
      }
    }
  }
}
