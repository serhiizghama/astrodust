/**
 * Сборка игры: мир, его шаг и состояния, между которыми делится ввод.
 *
 * Слой над всеми подсистемами. Знает про них всё, они про него — ничего.
 */
export { Game } from './game';
export type { GameState, StepIntent, DigReport, GrabReport } from './game';
