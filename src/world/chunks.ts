import { CHUNK_SIZE } from '../config';

/**
 * Учёт активных областей мира: автомат обходит только чанки, где на прошлом
 * шаге что-то двигалось. Полный проход — 524 288 ячеек, на 60 Гц это 31 млн
 * посещений в секунду, и кадр этого не выдержит.
 *
 * Инвариант: флаги в ДВУХ поколениях — `current` обрабатываем, `next` разбудили
 * по ходу шага. С одним массивом пробуждение внутри шага либо теряется, либо
 * крутит чанк вечно.
 */
export class ChunkGrid {
  readonly cols: number;
  readonly rows: number;
  private current: Uint8Array;
  private next: Uint8Array;
  /**
   * Чанки, изменившиеся с момента последнего пересчёта карты освещённости.
   *
   * ТРЕТЬЕ поколение, а не переиспользование `current`/`next`: те двое
   * переворачиваются каждый шаг, а карта пересчитывается с потолком и может
   * отставать на несколько кадров. Читая их, она теряла бы изменения тех
   * шагов, до которых не дошла.
   *
   * Снимается только тем, кто пересчитал, — методом `clearLightDirty`.
   */
  private readonly lightDirty: Uint8Array;

  constructor(worldW: number, worldH: number) {
    this.cols = Math.ceil(worldW / CHUNK_SIZE);
    this.rows = Math.ceil(worldH / CHUNK_SIZE);
    this.current = new Uint8Array(this.cols * this.rows);
    this.next = new Uint8Array(this.cols * this.rows);
    // Единицами: карта ещё не считалась ни разу, грязен весь мир.
    this.lightDirty = new Uint8Array(this.cols * this.rows).fill(1);
  }

  /** Изменился ли чанк с последнего пересчёта карты освещённости. */
  isLightDirty(ci: number): boolean {
    return this.lightDirty[ci] === 1;
  }

  /** Снимает пометку — вызывает только тот, кто чанк пересчитал. */
  clearLightDirty(ci: number): void {
    this.lightDirty[ci] = 0;
  }

  /** Сколько всего чанков в сетке. */
  get count(): number {
    return this.cols * this.rows;
  }

  /**
   * Будит чанки, содержащие (x±1, y±1) — до четырёх. Правило намеренно грубое:
   * точный учёт границы легко ошибается, и движение встаёт ровно на шве между
   * чанками — это читается багом физики, а не экономией.
   */
  touch(x: number, y: number): void {
    const cx0 = Math.max(0, ((x - 1) / CHUNK_SIZE) | 0);
    const cx1 = Math.min(this.cols - 1, ((x + 1) / CHUNK_SIZE) | 0);
    const cy0 = Math.max(0, ((y - 1) / CHUNK_SIZE) | 0);
    const cy1 = Math.min(this.rows - 1, ((y + 1) / CHUNK_SIZE) | 0);

    for (let cy = cy0; cy <= cy1; cy++) {
      const base = cy * this.cols;
      for (let cx = cx0; cx <= cx1; cx++) {
        this.next[base + cx] = 1;
        this.lightDirty[base + cx] = 1;
      }
    }
  }

  /** Активен ли чанк на текущем шаге. */
  isActive(cx: number, cy: number): boolean {
    return this.current[cy * this.cols + cx] === 1;
  }

  /** Пробуждён ли чанк на следующий шаг (для проверок и диагностики). */
  isPending(cx: number, cy: number): boolean {
    return this.next[cy * this.cols + cx] === 1;
  }

  activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.current.length; i++) n += this.current[i];
    return n;
  }

  /** Меняет поколения местами: разбуженное становится активным. */
  advance(): void {
    const swap = this.current;
    this.current = this.next;
    this.next = swap;
    this.next.fill(0);
  }

  /** Будит весь мир — нужно на старте, чтобы висящий материал сразу осел. */
  wakeAll(): void {
    this.next.fill(1);
  }
}
