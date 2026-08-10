/**
 * Процедурный звук.
 *
 * Читатель, а не участник: получает счётчики уже отработавшего шага и ничего
 * в мире не трогает.
 *
 * Это ЕДИНСТВЕННЫЙ вход в подсистему извне: снаружи импортируют отсюда,
 * внутри — напрямую друг у друга. Что не перечислено здесь — не публично.
 */
export { Soundscape, createVoices } from './soundscape';
export { createSignals, resetSignals } from './signals';
export type { AudioSignals } from './signals';
export { createBus } from './context';
export {
  AudioClock,
  VoiceSlots,
  attenuation,
  attenuationAt,
  changed,
  fillNoise,
  gridHz,
  panFor,
  scaleToneIn,
  snapToScale,
} from './model';
export { createDigState, createDigParams, digParams, mergeStrike } from './voices/dig';
export { createDustState, createDustParams, dustParams, dustIntensity } from './voices/dust';
