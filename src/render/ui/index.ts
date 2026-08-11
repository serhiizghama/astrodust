/**
 * Слой интерфейса: всё, что игра не моделирует, а сообщает.
 *
 * Мир — пиксели буфера, растянутые целым множителем. Интерфейс — вектор поверх
 * выведенного мира, в разрешении устройства: текст со сглаживанием, подложки
 * со скруглением и тенями, линии без лесенки.
 *
 * Раскладка при этом остаётся в ЯЧЕЙКАХ КАДРА — тех же, в которых измеряется
 * мир. Поэтому попадание курсора считается там же, где и раньше, а панель
 * занимает ту же долю кадра при любом окне.
 *
 * Это единственный вход в слой для остального рендера.
 */
export type {
  UiSurface,
  UiIcon,
  UiPoint,
  TextStyle,
  PanelStyle,
  LineStyle,
  FontWeight,
  TextAlign,
} from './surface';
export { fitText } from './surface';
export { CanvasSurface } from './canvas';
export type { ScreenTarget } from './canvas';
export { RecordingSurface } from './record';
export type { UiOp } from './record';
export { SHADOW_INK, BAR_PLATE, OVERLAY_PLATE, smallText, bodyText, titleText } from './skin';
