import { SEPARATOR_KIND } from './separator';
import { CONVEYOR_LEFT_KIND, CONVEYOR_RIGHT_KIND } from './conveyor';
import { NO_UNLOCKS } from '../progress';
import type { ContentUnlocks } from '../progress';
import type { BuildingKind } from './buildings';

/**
 * Каталог построек в порядке перебора. Один список: выбор вида, контур под
 * целью и постановка обязаны говорить об одном наборе.
 */
export const BUILD_CATALOG: readonly BuildingKind[] = [
  SEPARATOR_KIND,
  CONVEYOR_LEFT_KIND,
  CONVEYOR_RIGHT_KIND,
];

/**
 * Вид секционной постройки по материалу корпуса, или `null`. Нужен сносу:
 * у секционной постройки нет записи в реестре, и единственный её след — ячейки
 * сетки. Таблица, а не перебор: снос спрашивает на каждое применение.
 */
const SECTION_BY_HULL = new Map<number, BuildingKind>(
  BUILD_CATALOG.filter((k) => k.create === null).map((k) => [k.hull, k]),
);

export function sectionKindByHull(hull: number): BuildingKind | null {
  return SECTION_BY_HULL.get(hull) ?? null;
}

/** Открыт ли вид. Одна функция на каталог и постановку: иначе два источника
 * правды о том, что можно построить. */
export function isKindOpen(kind: BuildingKind, unlocks: ContentUnlocks): boolean {
  return kind.unlock === null || unlocks.has(kind.unlock);
}

/**
 * Выбранный вид постройки.
 *
 * Перебор по кругу, а не клавиша на вид: раскладка не должна расти вместе
 * с каталогом. Отдельно от выбора вещества инвентаря — высыпание доступно
 * в любом режиме.
 *
 * Перебор ТОЛЬКО по открытым видам: закрытое с ценой показывает оверлей
 * исследований, а не каталог. Открытое пересчитывается на каждом обращении —
 * покупка обязана быть видна следующим же перебором.
 */
export class BuildCatalogState {
  /**
   * Индекс в ПОЛНОМ каталоге, а не в списке открытых: во втором он сдвигался бы
   * при каждой покупке — открылась лента, и выбранным молча стал другой вид.
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
