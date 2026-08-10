/**
 * Вывод кадра.
 *
 * Пишет пиксели прямо в `ImageData`. Читает мир и снапшот состояния, не меняя
 * ни того, ни другого.
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
export type { OverlayView } from './overlay';
export { CONVEYOR_STRIPE_COLOR, MAT_R, MAT_G, MAT_B } from './material-colors';
