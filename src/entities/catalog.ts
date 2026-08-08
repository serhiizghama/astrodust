import { SEPARATOR_KIND } from './separator';
import { CONVEYOR_LEFT_KIND, CONVEYOR_RIGHT_KIND } from './conveyor';
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
 * Выбранный вид постройки.
 *
 * Перебор по кругу списком, а не клавиша на вид: раскладка не должна расти
 * вместе с каталогом — тот же довод, что и у режимов инструмента. Отдельно
 * от выбора вещества инвентаря: высыпание доступно в любом режиме, и отбирать
 * у игрока выбор высыпаемого на время строительства нечем оправдать.
 */
export class BuildCatalogState {
  private index = 0;

  get kind(): BuildingKind {
    return BUILD_CATALOG[this.index]!;
  }

  get name(): string {
    return this.kind.name;
  }

  cycle(): void {
    this.index = (this.index + 1) % BUILD_CATALOG.length;
  }
}
