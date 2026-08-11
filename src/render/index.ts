/**
 * Вывод кадра. Кадр двухслойный: мир — пиксели `ImageData`, интерфейс — вектор
 * поверх выведенного мира.
 *
 * Читает мир и снапшот состояния, не меняя ни того, ни другого.
 *
 * Это ЕДИНСТВЕННЫЙ вход в подсистему извне: снаружи импортируют отсюда,
 * внутри — напрямую друг у друга. Что не перечислено здесь — не публично.
 */
export {
  Renderer,
  BRUSH_OUTLINE,
  VACUUM_OUTLINE,
  vacuumOutline,
  stripeOffset,
  MACHINE_STATE_COLORS,
} from './renderer';
export type { HudState, GhostView, FrameView } from './renderer';
export { Camera } from './camera';
export { Backdrop } from './backdrop';
/**
 * Дерево технологий: раскладка публична РАДИ ПОПАДАНИЯ КУРСОРА — игровой шаг
 * обязан знать, над каким узлом стоит курсор, и считать это по своей копии
 * геометрии он не должен. То же правило, что и у панели действий.
 */
export {
  techTreeLayout,
  techTreeSize,
  nodeOrigin,
  nodeAtPoint,
  gridOf,
  drawResearchOverlay,
} from './overlay';
export type {
  OverlayView,
  OverlayNode,
  OverlayEdge,
  OverlayNodeStatus,
  OverlayNodeKind,
  TechTreeLayout,
} from './overlay';
/**
 * Раскладка панели — ОДНА на отрисовку и на попадание курсора. Публична ради
 * второго: игровой шаг обязан знать, над каким слотом стоит курсор, и считать
 * это по своей копии геометрии он не должен.
 */
export { hudLayout, slotAtPoint, overBar } from './hud';
export type { HudLayout, HudSlot, SlotAction } from './hud';
/**
 * Слой интерфейса: вектор поверх выведенного мира. Публичны поверхность
 * рисования (в браузере — канвас, в проверке — журнал) и общий вид, потому что
 * кадр интерфейса собирается снаружи и проверяется по журналу.
 */
export {
  CanvasSurface,
  RecordingSurface,
  fitText,
  SHADOW_INK,
  BAR_PLATE,
  OVERLAY_PLATE,
  smallText,
  bodyText,
  titleText,
} from './ui';
export type {
  UiSurface,
  UiIcon,
  UiPoint,
  UiOp,
  TextStyle,
  PanelStyle,
  LineStyle,
  ScreenTarget,
} from './ui';
export { CONVEYOR_STRIPE_COLOR, MAT_SHADES } from './material-colors';
export { BAYER, DITHER_LEVELS } from './dither';
export { Lightmap, LIGHT_NEUTRAL } from './lightmap';
/**
 * Палитра спрайта космонавта. Публична РАДИ ИНВАРИАНТА, а не ради рисования:
 * тёмный контур обязан оставаться отличимым и от каждой ступени интерьера
 * пещеры, и от неба, а проверить это можно, только зная его цвет.
 */
export { SPRITE_PALETTE } from './sprites/player';
