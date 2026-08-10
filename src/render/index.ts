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
export { CONVEYOR_STRIPE_COLOR, MAT_SHADES } from './material-colors';
export { BAYER, DITHER_LEVELS } from './dither';
export { Lightmap, LIGHT_NEUTRAL } from './lightmap';
/**
 * Палитра спрайта космонавта. Публична РАДИ ИНВАРИАНТА, а не ради рисования:
 * тёмный контур обязан оставаться отличимым и от каждой ступени интерьера
 * пещеры, и от неба, а проверить это можно, только зная его цвет.
 */
export { SPRITE_PALETTE } from './sprites/player';
