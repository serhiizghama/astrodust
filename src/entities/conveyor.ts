import { CONVEYOR } from '../config';
import { MAT } from '../world';
import { CONTENT } from '../progress';
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
 *
 * Оба ЗАКРЫТЫ до технологии, и оба указывают на ОДНО содержимое: лента — первая
 * вещь, которую игрок хочет, увидев ходку «сепаратор — модуль», и потому лучшая
 * первая цель, а лента, которую можно вести только вправо, не решает задачу,
 * ради которой её открывают. Вторая покупка ради знака была бы налогом
 * на планировку, а не выбором.
 */
export const CONVEYOR_LEFT_KIND: BuildingKind = sectionKind(
  'conveyor-left',
  'Конвейер ◀',
  MAT.CONVEYOR_LEFT,
  CONVEYOR.sectionCost,
  CONVEYOR.size,
  CONTENT.CONVEYOR,
);

export const CONVEYOR_RIGHT_KIND: BuildingKind = sectionKind(
  'conveyor-right',
  'Конвейер ▶',
  MAT.CONVEYOR_RIGHT,
  CONVEYOR.sectionCost,
  CONVEYOR.size,
  CONTENT.CONVEYOR,
);
