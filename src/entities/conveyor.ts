import { CONVEYOR } from '../config';
import { MAT } from '../world';
import { CONTENT } from '../progress';
import { sectionKind } from './buildings';
import type { BuildingKind } from './buildings';

/**
 * Конвейер — первое соединение между зданиями и первая секционная постройка.
 *
 * Ни записи в реестре, ни состояния: сторона — это идентификатор материала,
 * а всё поведение живёт в таблице полем `carry`. Здесь остаётся каталожная
 * часть: подпись, корпус, размер секции и цена.
 *
 * Направления — ДВА ОТДЕЛЬНЫХ ВИДА, а не поворот: поворота построек в модели
 * нет, и вводить его ради объекта с двумя состояниями дороже строки.
 *
 * Оба указывают на ОДНО содержимое: лента, которую можно вести только вправо,
 * не решает задачу, ради которой её открывают, а вторая покупка ради знака
 * была бы налогом на планировку.
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
