/**
 * Что механики публикуют за шаг симуляции.
 *
 * Направление зависимости — только от звука к механике: ни `Digger`, ни
 * `Simulation`, ни `Player` этот файл не импортируют. Они возвращают числа,
 * а собирает их в снапшот `main.ts` — ровно там же, где живёт `input.endStep()`.
 *
 * Объект один на всю игру и переиспользуется: аллокации на шаге нет, как и у
 * снапшота ввода.
 */
export interface AudioSignals {
  /** Персонаж — точка отсчёта слышимости. Не центр кадра: камера ходит за курсором. */
  listenerX: number;
  listenerY: number;

  /** Ячеек превращено копанием за шаг. */
  digConverted: number;
  /** Где копали. Значимо только при `digConverted > 0`. */
  digX: number;
  digY: number;

  /** Сыпучих ячеек сдвинулось за шаг. */
  powderMoves: number;
  /** Центр масс движения. Значим только при `powderMoves > 0`. */
  powderX: number;
  powderY: number;
}

export function createSignals(): AudioSignals {
  return {
    listenerX: 0,
    listenerY: 0,
    digConverted: 0,
    digX: 0,
    digY: 0,
    powderMoves: 0,
    powderX: 0,
    powderY: 0,
  };
}

/**
 * Обнуляет счётчики перед заполнением на новом шаге.
 *
 * Позиции не трогаются намеренно: они значимы только вместе со своим счётчиком,
 * и лишнее присваивание ничего не даёт.
 */
export function resetSignals(s: AudioSignals): void {
  s.digConverted = 0;
  s.powderMoves = 0;
}
