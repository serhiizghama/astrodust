/**
 * Рантайм-каркас: канвас, ввод, цикл с фиксированным шагом.
 *
 * Ничего игрового не знает — отдаёт кадр, снапшот ввода и такт.
 *
 * Это ЕДИНСТВЕННЫЙ вход в подсистему извне: снаружи импортируют отсюда,
 * внутри — напрямую друг у друга. Что не перечислено здесь — не публично.
 */
export { Display, fitFrame, screenFrame } from './display';
export type { FrameFit, ScreenFit } from './display';
export {
  Input,
  ToolMode,
  ActionBarState,
  ACTION_SLOTS,
  AimSourceTracker,
  aimDirection,
  aimTarget,
  actionTarget,
  cursorSide,
} from './input';
export type { ToolModeValue } from './input';
export { GameLoop } from './loop';
