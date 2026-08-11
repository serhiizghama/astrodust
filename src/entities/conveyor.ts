import { MAT } from '../world';
import { CONTENT } from '../progress';
import { sectionKind } from './buildings';
import type { BuildingKind } from './buildings';

/**
 * Конвейер — первое соединение между зданиями и первая секционная постройка.
 *
 * Ни записи в реестре, ни состояния: сторона — это идентификатор материала,
 * а всё поведение живёт в таблице веществ полем `carry`. Здесь остаётся
 * каталожная часть: подпись и пара корпусов.
 *
 * Направление — ОДИН вид с двумя корпусами, а не два вида каталога. Каталог
 * перечисляет, ЧТО строится, а не как оно повёрнуто; сторону задаёт жест
 * укладки, и в переборе видов ей делать нечего.
 */
export const CONVEYOR_KIND: BuildingKind = sectionKind(
  'conveyor',
  'Конвейер',
  [MAT.CONVEYOR_LEFT, MAT.CONVEYOR_RIGHT],
  CONTENT.CONVEYOR,
);
