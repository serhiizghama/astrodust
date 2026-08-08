import { CONVEYOR } from '../config';
import { MAT } from '../world/materials';
import { sectionKind } from './buildings';
import type { BuildingKind } from './buildings';

/**
 * Конвейер — первое соединение между зданиями и первая секционная постройка.
 *
 * Ни записи в реестре, ни состояния: лента знает только сторону, а сторона —
 * это идентификатор материала. Всё поведение живёт в таблице материалов полем
 * `carry`, поэтому здесь остаётся ровно каталожная часть — подпись, корпус,
 * размер секции и её цена.
 *
 * Направления — ДВА ОТДЕЛЬНЫХ ВИДА, а не поворот уже выбранного. Поворота
 * и зеркалирования построек в модели нет ни у машин, ни у лент, и вводить их
 * ради объекта с двумя состояниями дороже, чем добавить строку.
 */
export const CONVEYOR_LEFT_KIND: BuildingKind = sectionKind(
  'conveyor-left',
  'Конвейер ◀',
  MAT.CONVEYOR_LEFT,
  CONVEYOR.sectionCost,
  CONVEYOR.size,
);

export const CONVEYOR_RIGHT_KIND: BuildingKind = sectionKind(
  'conveyor-right',
  'Конвейер ▶',
  MAT.CONVEYOR_RIGHT,
  CONVEYOR.sectionCost,
  CONVEYOR.size,
);
