/**
 * Мир и вещество.
 *
 * Плоская сетка ячеек `Uint8Array` — единственный источник правды о геометрии:
 * по ней же считается коллизия и строится картинка. Свойства веществ лежат
 * в типизированных таблицах и выбираются по агрегатному состоянию, поэтому новое
 * вещество — строка таблицы, а не правка автомата.
 *
 * Ничего не знает ни о персонаже, ни о постройках, ни о том, как его показывают.
 *
 * Это ЕДИНСТВЕННЫЙ вход в подсистему извне: снаружи импортируют отсюда,
 * внутри — напрямую друг у друга. Что не перечислено здесь — не публично.
 */
export { World } from './world';
export type { WorldProfile, BackdropSpec } from './world';
export {
  MAT,
  MATERIALS,
  PORTABLE_MATERIALS,
  MatterState,
  MAT_CARRY,
  MAT_EMIT,
  MAT_CREDIT_RATE,
  MAT_DENSITY,
  MAT_DIGGABLE,
  MAT_PORTABLE,
  MAT_RESEARCH_RATE,
  MAT_SLIP,
  MAT_SOLID,
  MAT_SPREAD,
  MAT_STATE,
  MAT_YIELDS,
  MAT_YIELD_RATE,
} from './materials';
export { Simulation } from './simulation';
export { REACTIONS, reactAround } from './reactions';
export { hashChance, makeNoise, mulberry32 } from './rng';
export { generateLuna, LUNA } from './worlds/luna';
