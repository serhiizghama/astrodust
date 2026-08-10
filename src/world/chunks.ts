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

  constructor(worldW: number, worldH: number) {
    this.cols = Math.ceil(worldW / CHUNK_SIZE);
    this.rows = Math.ceil(worldH / CHUNK_SIZE);
    this.current = new Uint8Array(this.cols * this.rows);
    this.next = new Uint8Array(this.cols * this.rows);
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
      for (let cx = cx0; cx <= cx1; cx++) this.next[base + cx] = 1;
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
