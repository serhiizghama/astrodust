import { CHUNK_SIZE } from '../config';

/**
 * Учёт активных областей мира.
 *
 * Полный проход по сетке 1024×512 — это 524 288 ячеек. Шестьдесят раз в секунду
 * получается 31 млн посещений ячейки в секунду, и кадр этого не выдержит.
 * Поэтому симуляция обходит только чанки, в которых на прошлом шаге что-то
 * двигалось, а улёгшийся мир не стоит ничего.
 *
 * Флаги живут в двух поколениях: `current` — что обрабатывать сейчас,
 * `next` — что разбудили по ходу текущего шага. В конце шага поколения
 * меняются местами. Без разделения пробуждение внутри шага либо терялось бы,
 * либо заставляло бы чанк крутиться вечно.
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
   * Будит область вокруг изменившейся ячейки.
   *
   * Помечаются чанки, содержащие (x±1, y±1) — до четырёх штук. Правило
   * намеренно грубое: точный учёт того, лежит ли ячейка на границе чанка,
   * легко ошибается, и тогда движение останавливается ровно на шве между
   * чанками. Это выглядит как баг физики, а не как оптимизация.
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
