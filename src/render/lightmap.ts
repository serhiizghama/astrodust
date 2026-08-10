/**
 * Карта освещённости: свет, который светящиеся вещества отдают вокруг себя.
 *
 * Разрешение 1 к `lightScale`: свет — величина низкочастотная, и хранить его
 * по ячейке значило бы платить полмегабайта за данные, которые всё равно
 * размазаны дизерингом.
 *
 * Затенения по плотности толщи здесь НЕТ, и это решение, а не пропуск.
 * Внутри сплошной породы плотность окна постоянна, поэтому такое затенение
 * даёт всей толще один и тот же сдвиг — не объём, а третий независимый
 * дизеринг поверх зерна и глубины, то есть шум без сведений. Близость ячейки
 * к пустоте уже выражена экспозицией, удаление от поверхности — глубиной;
 * оба вклада дешевле и несут то, чего плотность окна не несёт.
 *
 * Три правила, из которых следует всё устройство.
 *
 * 1. **Освещённость — функция состояния мира, а не его истории.** Значение
 *    ячейки карты зависит ТОЛЬКО от содержимого окна вокруг неё. Поэтому
 *    пересчёт грязного чанка с полем шириной в радиус окна даёт ровно тот же
 *    результат, что и полный пересчёт мира. Схема с распространением света
 *    обходом (заливка, итеративное размытие) этого свойства не имеет: её
 *    результат зависит от порядка и границ обхода, и две одинаковые пещеры —
 *    выкопанная и сгенерированная — светились бы по-разному.
 * 2. **Считается в два прохода.** Сначала по 4×4 ячейкам мира собирается
 *    сумма светимостей, потом по этим сводкам — окно. В один проход окно
 *    радиуса 3 стоило бы 784 чтения сетки на ячейку карты вместо 16 + 49.
 * 3. **Пересчёт с потолком на кадр.** Обрушение большой области не имеет права
 *    уронить кадр; свет догоняет мир за несколько кадров, и это незаметно там,
 *    где порода уже осыпалась.
 */
import { CHUNK_SIZE, SHADING } from '../config';
import type { World } from '../world';
import { MAT_EMIT } from '../world';

const SCALE = SHADING.lightScale;
const SHIFT = Math.log2(SCALE);
const RADIUS = SHADING.lightRadius;

/**
 * Уровень «света нет». Значение карты выше нейтрали осветляет; ниже нейтрали
 * значений не бывает — гасить свету нечего.
 */
export const LIGHT_NEUTRAL = 16;

/**
 * Предел шкалы: нейтраль плюс полный набор уровней дизеринга. Выше означало бы
 * «осветлить больше чем на ступень», а ступень у набора одна.
 */
const LIGHT_MAX = LIGHT_NEUTRAL + 15;

export class Lightmap {
  readonly cols: number;
  readonly rows: number;

  /** Уровень освещённости, 0..31. Нейтраль — `LIGHT_NEUTRAL`. */
  readonly level: Uint8Array;

  /** Сумма светимостей блока 4×4. Промежуточная сводка первого прохода. */
  private readonly emit: Uint16Array;

  /** Ширина сетки чанков — по ней идёт обход грязных. */
  private readonly chunkCols: number;
  /** С какого чанка продолжать обход: потолок на кадр рвёт его посередине. */
  private cursor = 0;

  constructor(private readonly world: World) {
    this.cols = Math.ceil(world.width / SCALE);
    this.rows = Math.ceil(world.height / SCALE);
    this.level = new Uint8Array(this.cols * this.rows).fill(LIGHT_NEUTRAL);
    this.emit = new Uint16Array(this.cols * this.rows);
    this.chunkCols = world.chunks.cols;
  }

  /**
   * Считает карту целиком. Нужен один раз после генерации мира: чанки при
   * создании помечены грязными все, и без этого первые кадры шли бы
   * с неосвещённой картой, догоняя мир по потолку.
   */
  rebuildAll(): void {
    const chunks = this.world.chunks;
    for (let ci = 0; ci < chunks.count; ci++) {
      this.rebuildChunk(ci);
      chunks.clearLightDirty(ci);
    }
  }

  /**
   * Догоняет мир, но не больше `lightChunksPerFrame` чанков за вызов.
   * Возвращает, сколько чанков пересчитано, — по нему видно, идёт ли догон.
   *
   * Обход продолжается с того места, где остановился прошлый вызов: начинать
   * каждый раз с нуля значило бы вечно пересчитывать первые чанки и никогда
   * не доходить до последних.
   */
  update(): number {
    const chunks = this.world.chunks;
    const total = chunks.count;
    let done = 0;

    for (let seen = 0; seen < total && done < SHADING.lightChunksPerFrame; seen++) {
      const ci = this.cursor;
      this.cursor = this.cursor + 1 === total ? 0 : this.cursor + 1;
      if (!chunks.isLightDirty(ci)) continue;
      this.rebuildChunk(ci);
      chunks.clearLightDirty(ci);
      done++;
    }
    return done;
  }

  /**
   * Пересчитывает один чанк: сводки по его блокам и уровень по блокам,
   * расширенным на радиус окна.
   *
   * Поле обязательно: окно соседа заглядывает внутрь чанка, и без расширения
   * на границе чанка остался бы шов из старых значений.
   */
  private rebuildChunk(ci: number): void {
    const ccx = ci % this.chunkCols;
    const ccy = (ci / this.chunkCols) | 0;
    const per = CHUNK_SIZE >> SHIFT;

    const mx0 = ccx * per;
    const my0 = ccy * per;
    const mx1 = Math.min(this.cols, mx0 + per);
    const my1 = Math.min(this.rows, my0 + per);

    for (let my = my0; my < my1; my++) {
      for (let mx = mx0; mx < mx1; mx++) this.summarize(mx, my);
    }

    const lx0 = Math.max(0, mx0 - RADIUS);
    const ly0 = Math.max(0, my0 - RADIUS);
    const lx1 = Math.min(this.cols, mx1 + RADIUS);
    const ly1 = Math.min(this.rows, my1 + RADIUS);

    for (let my = ly0; my < ly1; my++) {
      for (let mx = lx0; mx < lx1; mx++) this.illuminate(mx, my);
    }
  }

  /** Первый проход: сумма светимостей блока 4×4. */
  private summarize(mx: number, my: number): void {
    const cells = this.world.cells;
    const worldW = this.world.width;
    const x0 = mx << SHIFT;
    const y0 = my << SHIFT;
    const x1 = Math.min(worldW, x0 + SCALE);
    const y1 = Math.min(this.world.height, y0 + SCALE);

    let emit = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * worldW;
      for (let x = x0; x < x1; x++) emit += MAT_EMIT[cells[row + x]!]!;
    }

    this.emit[my * this.cols + mx] = emit;
  }

  /**
   * Второй проход: уровень по окну сводок.
   *
   * Свет источника убывает с расстоянием линейно по манхэттенской метрике —
   * не по евклидовой: корень на ячейку карты не окупается, а разницу между
   * кругом и ромбом на радиусе в три ячейки съедает дизеринг.
   */
  private illuminate(mx: number, my: number): void {
    const x0 = Math.max(0, mx - RADIUS);
    const y0 = Math.max(0, my - RADIUS);
    const x1 = Math.min(this.cols - 1, mx + RADIUS);
    const y1 = Math.min(this.rows - 1, my + RADIUS);

    let light = 0;

    for (let y = y0; y <= y1; y++) {
      const row = y * this.cols;
      const dy = y > my ? y - my : my - y;
      for (let x = x0; x <= x1; x++) {
        const e = this.emit[row + x]!;
        if (e === 0) continue;
        const dx = x > mx ? x - mx : mx - x;
        const falloff = RADIUS + 1 - (dx + dy);
        if (falloff <= 0) continue;
        // Делится ДРОБНО, а не сдвигом: сумма одинокой ячейки лавы (15) при
        // целочисленном делении на площадь блока (16) дала бы ноль, и
        // единственный источник не светил бы вовсе.
        light += ((e / (SCALE * SCALE)) * falloff) / (RADIUS + 1);
      }
    }

    let value = LIGHT_NEUTRAL + light;
    if (value > LIGHT_MAX) value = LIGHT_MAX;

    this.level[my * this.cols + mx] = value | 0;
  }
}
