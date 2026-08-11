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
/** Шрифт интерфейса: им пишется весь текст игры, включая проверки полноты набора. */
export { drawText, textWidth, hasGlyph, glyphChars, GLYPH_H, LINE_H, TEXT_SHADOW } from './font';
export { CONVEYOR_STRIPE_COLOR, MAT_SHADES } from './material-colors';
export { BAYER, DITHER_LEVELS } from './dither';
export { Lightmap, LIGHT_NEUTRAL } from './lightmap';
/**
 * Палитра спрайта космонавта. Публична РАДИ ИНВАРИАНТА, а не ради рисования:
 * тёмный контур обязан оставаться отличимым и от каждой ступени интерьера
 * пещеры, и от неба, а проверить это можно, только зная его цвет.
 */
export { SPRITE_PALETTE } from './sprites/player';
