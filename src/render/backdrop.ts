import { VIEW_W, VIEW_H, BACKDROP, WORLD_W } from '../config';
import type { BackdropSpec, WorldProfile } from '../world';
import { mulberry32, makeNoise } from '../world';
import { RAMP } from '../palette';

/**
 * Задник неба: звёзды, полоса галактики, соседнее тело и слои силуэтов.
 *
 * Три правила, из которых следует всё остальное.
 *
 * 1. В вакууме ничто не мерцает. Автономно движется только орбитальный объект;
 *    вся остальная жизнь задника — реакция на движение камеры. Поэтому при
 *    неподвижном персонаже соседние кадры совпадают пиксель в пиксель.
 * 2. Вся геометрия считается один раз при создании мира. В кадре — только
 *    чтение таблиц, заливка пробегами и постановка точек. Никакого шума и
 *    тригонометрии на пиксель.
 * 3. Силуэт — функция от колонки, а не картинка. Колонка кадра делится на
 *    непересекающиеся полосы и заливается сплошняком, поэтому ни один пиксель
 *    не пишется дважды.
 */

/** Матрица упорядоченного дизеринга 4×4. Значения 0..15. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Полубаза, на которой берётся уклон гребня для выбора цвета подсветки. */
const RIM_SLOPE_SPAN = 3;

/**
 * Поверхность соседнего тела в клетках 2×2 — форма диска считается отдельно.
 * Крупные клетки не небрежность: на диске в 22 пикселя мелкий рисунок
 * превращается в шум, а блоки 2×2 читаются как материки.
 *
 * `O` океан, `g` суша, `G` светлая суша, `c` облака и лёд, `.` — океан по
 * умолчанию (нужен только чтобы рисунок было видно глазом в исходнике).
 */
const COMPANION_PATTERN = [
  '...cccc....',
  '..OgggOcO..',
  '.OggGggOgO.',
  '.OOggOOggO.',
  'OOOgGgOgOOO',
  'OOOOggOOOOO',
  'OOOOgggOgOO',
  '.OOOggGggO.',
  '.OOOcggOOO.',
  '..OcccOOO..',
  '...cccc....',
];

/**
 * Палитра соседнего тела. Индекс 0 — прозрачный.
 *
 * Земля — самое яркое пятно неба, и так и должно быть: это единственный
 * цветной объект в кадре, у которого есть узнаваемая форма. Суша уходит
 * в чистый зелёный вместо болотного, облака светлеют со 156 до 204.
 *
 * Ни одна ступень не совпадает с цветом орбитального объекта (`gray[9]`):
 * на его уникальности среди всего, что задник способен вывести, держится
 * проверка прохода спутника.
 *
 * Облака взяли бирюзу льда, а не белую `gray[8]`: `gray[8]` достался иридию,
 * а иридий СЧИТАЮТ — снимок сепаратора меряет кучу под машиной подсчётом
 * пикселей ровно его цвета, и облака Земли в том же кадре добавляли в неё
 * тринадцать своих. Со льдом такого не выйдет: лёд не считает никто, и в небе
 * его не бывает.
 */
const COMPANION_PALETTE = [
  RAMP.gray[0], // 0 — прозрачно, рендером не читается
  RAMP.gray[3], // 1 — ночная сторона
  RAMP.blue[0], // 2 — лимб и глубокий океан
  RAMP.blue[1], // 3 — океан
  RAMP.green[2], // 4 — суша
  RAMP.green[3], // 5 — светлая суша
  RAMP.blue[5], // 6 — облака и лёд
];

const PATTERN_TO_INDEX: Record<string, number> = {
  O: 3,
  g: 4,
  G: 5,
  c: 6,
  '.': 3,
};

export class Backdrop {
  private readonly spec: BackdropSpec;

  // --- Слои силуэтов ---
  // Открыты на чтение по тем же соображениям, что и `world.cells`: это данные,
  // а не состояние, и проверкам нужно видеть инварианты напрямую.
  readonly layerHeights: Int16Array[] = [];
  private readonly layerParallax: number[] = [];
  private readonly layerR: number[] = [];
  private readonly layerG: number[] = [];
  private readonly layerB: number[] = [];

  /**
   * Точки неба: звёзды и свечение галактики, ОТСОРТИРОВАННЫЕ ПО X.
   * Сортировка — не деталь реализации, а контракт: на ней держится поиск
   * видимого среза, и без неё часть звёзд просто не попадёт в кадр.
   */
  readonly pointX: Int16Array;
  readonly pointY: Int16Array;
  readonly pointColor: Int32Array;

  private readonly companion: Uint8Array | null;

  // --- Разобранные на каналы цвета, чтобы не сдвигать биты на каждый пиксель ---
  private readonly skyR: number;
  private readonly skyG: number;
  private readonly skyB: number;
  private readonly rimWarm: number;
  private readonly rimCold: number;

  /**
   * Экранная строка верхней кромки ближайшего силуэта в каждой колонке.
   * Заполняется проходом по колонкам и служит клипом для точек: одно чтение
   * на точку вместо повторного разбора слоёв.
   */
  private readonly skyFloor = new Int16Array(VIEW_W);

  /** Черновики на кадр — чтобы не выделять память в цикле отрисовки. */
  private readonly tops: Int32Array;
  private readonly rawTops: Int32Array;
  private readonly offX: Int32Array;
  private readonly offY: Int32Array;

  constructor(
    profile: WorldProfile,
    seed: number,
    private readonly surface: Int16Array,
  ) {
    const spec = profile.backdrop;
    this.spec = spec;

    this.skyR = (profile.skyColor >> 16) & 0xff;
    this.skyG = (profile.skyColor >> 8) & 0xff;
    this.skyB = profile.skyColor & 0xff;
    this.rimWarm = spec.rimWarm;
    this.rimCold = spec.rimCold;

    // Отдельный поток случайных чисел: задник не должен сдвигать генерацию
    // рельефа, иначе добавление слоя перекроило бы весь мир.
    const rand = mulberry32((seed ^ 0x5bf03635) >>> 0);

    this.buildLayers(rand);
    const points = this.buildPoints(rand);
    this.pointX = points.x;
    this.pointY = points.y;
    this.pointColor = points.color;
    this.companion = spec.companion ? buildCompanion() : null;

    const n = spec.layers.length;
    this.tops = new Int32Array(n);
    this.rawTops = new Int32Array(n);
    this.offX = new Int32Array(n);
    this.offY = new Int32Array(n);
  }

  /**
   * Экранное смещение слоя при данном положении камеры.
   *
   * Смещение округляется до целого пикселя: дробное разрушило бы пиксельную
   * сетку. Индекс `-1` — общее смещение звёзд и небесных тел, они дальше
   * любого слоя силуэтов.
   */
  layerOffset(li: number, camX: number, camY: number): { x: number; y: number } {
    const p = li < 0 ? this.spec.skyParallax : this.layerParallax[li]!;
    return {
      x: Math.round(camX * p),
      y: Math.round(Math.min(camY, BACKDROP.vertParallaxLimit) * p),
    };
  }

  /** Наибольшая высота твёрдого верха в видимой полосе колонок. */
  maxSurfaceInView(camX: number): number {
    let max = 0;
    const surface = this.surface;
    for (let sx = 0; sx < VIEW_W; sx++) {
      const h = surface[camX + sx]!;
      if (h > max) max = h;
    }
    return max;
  }

  /**
   * Рисует небо. Возвращает `false`, если неба в кадре нет — тогда проход не
   * выполнил ни одной операции на пиксель.
   *
   * @param time накопленное время симуляции в секундах: орбитальный объект
   *   обязан двигаться по часам, а не по номеру кадра.
   */
  draw(
    px: Uint8ClampedArray,
    camX: number,
    camY: number,
    time: number,
    maxSurface: number,
  ): boolean {
    if (camY >= maxSurface) return false;

    this.drawColumns(px, camX, camY);
    this.drawPoints(px, camX, camY, time);
    return true;
  }

  // ---------------------------------------------------------------- генерация

  private buildLayers(rand: () => number): void {
    const layerW = BACKDROP.layerW;
    for (const spec of this.spec.layers) {
      // Две октавы: одна даёт общий рисунок хребта, вторая — щербатость гребня.
      // Обе периодичны по единице аргумента, поэтому слой смыкается сам с собой
      // и не зависит от ширины мира.
      const coarse = makeNoise(rand, spec.detail);
      const fine = makeNoise(rand, spec.detail * 3);

      const heights = new Int16Array(layerW);
      for (let i = 0; i < layerW; i++) {
        const t = i / layerW;
        heights[i] = Math.round(
          spec.crestY + coarse(t) * spec.amplitude + fine(t) * spec.amplitude * 0.28,
        );
      }

      this.layerHeights.push(heights);
      this.layerParallax.push(spec.parallax);
      this.layerR.push((spec.fill >> 16) & 0xff);
      this.layerG.push((spec.fill >> 8) & 0xff);
      this.layerB.push(spec.fill & 0xff);
    }
  }

  /**
   * Звёзды и свечение галактики одним отсортированным списком точек.
   *
   * Маски здесь нет намеренно. Маска опрашивается на каждый пиксель неба —
   * это десятки тысяч чтений в кадр ради нескольких сотен звёзд. Список
   * стоит ровно столько, сколько в нём видимых точек.
   *
   * Полоса галактики запекается сюда же: дизеринг посчитан один раз при
   * генерации, а не в кадре.
   */
  private buildPoints(rand: () => number): {
    x: Int16Array;
    y: Int16Array;
    color: Int32Array;
  } {
    const spec = this.spec;
    const fieldW = WORLD_W;
    const fieldH = BACKDROP.starFieldH;
    const xs: number[] = [];
    const ys: number[] = [];
    const cs: number[] = [];

    const pickStarColor = (r: number): number => {
      let acc = 0;
      for (let i = 0; i < spec.starWeights.length; i++) {
        acc += spec.starWeights[i]!;
        if (r < acc) return spec.starColors[i]!;
      }
      return spec.starColors[spec.starColors.length - 1]!;
    };

    const baseCount = Math.round(fieldW * fieldH * spec.starDensity);
    for (let i = 0; i < baseCount; i++) {
      xs.push(Math.floor(rand() * fieldW));
      ys.push(Math.floor(rand() * fieldH));
      cs.push(pickStarColor(rand()));
    }

    const mw = spec.milkyWay;
    if (mw) {
      const bandCenter = (x: number): number => mw.centerY + (x - fieldW / 2) * mw.tilt;

      // Сгущение звёзд в полосе.
      const extra = Math.round(baseCount * (mw.densityBoost - 1) * ((2 * mw.halfWidth) / fieldH));
      for (let i = 0; i < extra; i++) {
        const x = Math.floor(rand() * fieldW);
        // Сумма двух равномерных даёт треугольное распределение: к середине
        // полосы гуще, к краям реже — без резкой границы.
        const off = (rand() + rand() - 1) * mw.halfWidth;
        const y = Math.round(bandCenter(x) + off);
        if (y < 0 || y >= fieldH) continue;
        xs.push(x);
        ys.push(y);
        cs.push(pickStarColor(rand()));
      }

      // Свечение: упорядоченный дизеринг между небом и цветом полосы.
      //
      // Одной только спадающей к краям плотности мало — получается ровный
      // прямоугольник в клеточку, а не галактика. Поэтому яркость вдоль полосы
      // модулируется шумом (сгущения рукавов), и по ней же змеится тёмная
      // пылевая прожилка — у настоящего Млечного Пути она и есть главная
      // узнаваемая черта.
      const clump = makeNoise(rand, 23);
      const lane = makeNoise(rand, 9);

      for (let x = 0; x < fieldW; x++) {
        const cy = bandCenter(x);
        const t = x / fieldW;
        const density = 0.34 + 0.26 * clump(t);
        const laneOffset = lane(t) * 0.42;
        const from = Math.max(0, Math.ceil(cy - mw.halfWidth));
        const to = Math.min(fieldH, Math.floor(cy + mw.halfWidth));

        for (let y = from; y < to; y++) {
          const rel = (y - cy) / mw.halfWidth;
          let intensity = (1 - rel * rel) * density;
          if (Math.abs(rel - laneOffset) < 0.2) intensity *= 0.22;
          if (BAYER[(y & 3) * 4 + (x & 3)]! / 16 < intensity) {
            xs.push(x);
            ys.push(y);
            cs.push(mw.glowColor);
          }
        }
      }
    }

    // Сортировка по x — на ней держится поиск видимого среза в кадре.
    const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
    const n = order.length;
    const x = new Int16Array(n);
    const y = new Int16Array(n);
    const color = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const j = order[i]!;
      x[i] = xs[j]!;
      y[i] = ys[j]!;
      color[i] = cs[j]!;
    }
    return { x, y, color };
  }

  // ---------------------------------------------------------------- отрисовка

  /**
   * Проход по колонкам: заливка неба и слоёв непересекающимися полосами.
   *
   * Слои перекрывают друг друга, поэтому видимая граница слоя — не его
   * собственный верх, а минимум из его верха и границ всех более близких
   * слоёв. Накопление этого минимума снизу вверх и даёт непересекающиеся
   * полосы за один проход, без буфера глубины и без повторных записей.
   */
  private drawColumns(px: Uint8ClampedArray, camX: number, camY: number): void {
    const layers = this.layerHeights;
    const count = layers.length;
    const mask = BACKDROP.layerW - 1;
    const tops = this.tops;
    const rawTops = this.rawTops;
    const offX = this.offX;
    const offY = this.offY;
    const surface = this.surface;
    const skyFloor = this.skyFloor;

    // Вертикальное смещение ограничено: без предела слои на краях хода камеры
    // отрываются от линии горизонта и повисают сами по себе.
    const vertBase = Math.min(camY, BACKDROP.vertParallaxLimit);
    for (let li = 0; li < count; li++) {
      offX[li] = Math.round(camX * this.layerParallax[li]!);
      offY[li] = Math.round(vertBase * this.layerParallax[li]!);
    }

    for (let sx = 0; sx < VIEW_W; sx++) {
      let bottom = surface[camX + sx]! - camY;
      if (bottom > VIEW_H) bottom = VIEW_H;
      if (bottom <= 0) {
        skyFloor[sx] = 0;
        continue;
      }

      let edge = bottom;
      for (let li = count - 1; li >= 0; li--) {
        const lx = (offX[li]! + sx) & mask;
        const raw = layers[li]![lx]! - offY[li]!;
        rawTops[li] = raw;
        if (raw < edge) edge = raw;
        tops[li] = edge;
      }

      const skyTo = tops[0]! > 0 ? tops[0]! : 0;
      this.fillColumn(px, sx, 0, skyTo, this.skyR, this.skyG, this.skyB);

      for (let li = 0; li < count; li++) {
        const from = tops[li]! > 0 ? tops[li]! : 0;
        const nextTop = li + 1 < count ? tops[li + 1]! : bottom;
        const to = nextTop > 0 ? nextTop : 0;
        if (to <= from) continue;

        this.fillColumn(px, sx, from, to, this.layerR[li]!, this.layerG[li]!, this.layerB[li]!);

        // Кромка ставится только там, где слой действительно выходит на
        // поверхность: срезанный более близким слоем верх подсвечивать нечем.
        if (rawTops[li] === tops[li] && from === tops[li] && from < VIEW_H) {
          this.drawRim(px, sx, from, li, offX[li]!, mask);
        }
      }

      skyFloor[sx] = skyTo;
    }
  }

  /**
   * Подсветка кромки в один пиксель, пунктиром.
   *
   * Источников два, и склон выбирает свой по знаку уклона: обращённый к Солнцу
   * ловит тёплый прямой свет, обращённый в другую сторону — холодный
   * отражённый от соседнего тела. Ровный участок не подсвечивается вовсе.
   *
   * Фаза пунктира считается от колонки В ПРОСТРАНСТВЕ СЛОЯ. От экранной
   * колонки пунктир полз бы по гребню при каждом параллаксном сдвиге.
   */
  private drawRim(
    px: Uint8ClampedArray,
    sx: number,
    y: number,
    li: number,
    offXi: number,
    mask: number,
  ): void {
    const lx = (offXi + sx) & mask;
    if ((lx & 1) !== 0) return;

    // Уклон берётся на базе в несколько колонок, а не между соседними.
    // Высоты округлены до целых, а слой меняется медленнее пикселя на колонку,
    // поэтому у соседей разность почти всегда ровно ноль — по ней склон не
    // определить, и подсветка выродилась бы в редкие случайные точки.
    const heights = this.layerHeights[li]!;
    const slope = heights[(lx + RIM_SLOPE_SPAN) & mask]! - heights[(lx - RIM_SLOPE_SPAN) & mask]!;
    if (slope === 0) return;

    // Меньшая высота = выше пик. Убывание вправо — склон смотрит влево.
    const facesLeft = slope < 0;
    const sunOnLeft = this.spec.sunDirX < 0;
    const color = facesLeft === sunOnLeft ? this.rimWarm : this.rimCold;

    const i = (y * VIEW_W + sx) * 4;
    px[i] = (color >> 16) & 0xff;
    px[i + 1] = (color >> 8) & 0xff;
    px[i + 2] = color & 0xff;
  }

  /** Точки неба и небесные тела. Всё клипится по skyFloor одним сравнением. */
  private drawPoints(px: Uint8ClampedArray, camX: number, camY: number, time: number): void {
    const spec = this.spec;
    const p = spec.skyParallax;
    const offX = Math.round(camX * p);
    const offY = Math.round(Math.min(camY, BACKDROP.vertParallaxLimit) * p);

    const xs = this.pointX;
    const ys = this.pointY;
    const cs = this.pointColor;
    const skyFloor = this.skyFloor;
    const right = offX + VIEW_W;

    // Видимый срез вместо прохода по всему списку.
    let i = lowerBound(xs, offX);
    for (; i < xs.length && xs[i]! < right; i++) {
      const sy = ys[i]! - offY;
      if (sy < 0) continue;
      const sx = xs[i]! - offX;
      if (sy >= skyFloor[sx]!) continue;
      const c = cs[i]!;
      const at = (sy * VIEW_W + sx) * 4;
      px[at] = (c >> 16) & 0xff;
      px[at + 1] = (c >> 8) & 0xff;
      px[at + 2] = c & 0xff;
    }

    if (this.companion && spec.companion) {
      this.drawCompanion(px, spec.companion.x - offX, spec.companion.y - offY);
    }
    if (spec.orbiter) this.drawOrbiter(px, time, offY);
  }

  private drawCompanion(px: Uint8ClampedArray, originX: number, originY: number): void {
    const pixels = this.companion!;
    const size = BACKDROP.companionSize;
    const skyFloor = this.skyFloor;

    for (let y = 0; y < size; y++) {
      const sy = originY + y;
      if (sy < 0 || sy >= VIEW_H) continue;
      for (let x = 0; x < size; x++) {
        const index = pixels[y * size + x]!;
        if (index === 0) continue;
        const sx = originX + x;
        if (sx < 0 || sx >= VIEW_W) continue;
        if (sy >= skyFloor[sx]!) continue;
        const c = COMPANION_PALETTE[index]!;
        const at = (sy * VIEW_W + sx) * 4;
        px[at] = (c >> 16) & 0xff;
        px[at + 1] = (c >> 8) & 0xff;
        px[at + 2] = c & 0xff;
      }
    }
  }

  /**
   * Единственное, что на этом небе движется само.
   *
   * Путь считается в экранных координатах: объект должен пересекать кадр
   * независимо от того, где стоит персонаж, иначе редкое событие раз в
   * полминуты игрок просто не увидит.
   */
  private drawOrbiter(px: Uint8ClampedArray, time: number, offY: number): void {
    const o = this.spec.orbiter!;
    const phase = time % o.periodSec;
    if (phase >= o.crossSec) return;

    const sx = Math.round(-2 + (phase / o.crossSec) * (VIEW_W + 4));
    const sy = o.y - offY;
    if (sx < 0 || sx >= VIEW_W || sy < 0 || sy >= VIEW_H) return;
    if (sy >= this.skyFloor[sx]!) return;

    const at = (sy * VIEW_W + sx) * 4;
    px[at] = (o.color >> 16) & 0xff;
    px[at + 1] = (o.color >> 8) & 0xff;
    px[at + 2] = o.color & 0xff;
  }

  private fillColumn(
    px: Uint8ClampedArray,
    sx: number,
    from: number,
    to: number,
    r: number,
    g: number,
    b: number,
  ): void {
    let i = (from * VIEW_W + sx) * 4;
    const stride = VIEW_W * 4;
    for (let y = from; y < to; y++, i += stride) {
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    }
  }
}

/** Первый индекс, где значение не меньше `value`. Массив отсортирован. */
function lowerBound(arr: Int16Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Соседнее тело: диск считается, поверхность рисуется.
 *
 * Форму круга шумом не получить, а материки — узнаваемый рисунок, который
 * нужно именно нарисовать. Поэтому геометрия вычисляется, а рисунок берётся
 * из таблицы: полностью процедурная Земля выглядела бы случайным пятном.
 */
function buildCompanion(): Uint8Array {
  const size = BACKDROP.companionSize;
  const out = new Uint8Array(size * size);
  const radius = size / 2 - 1;
  const center = (size - 1) / 2;

  // Солнце слева, поэтому затенён правый край. Порог смещён от центра, но
  // не к самому лимбу: это растущий гиббоид — фаза должна читаться, а тонкая
  // тёмная полоска у края читается как обводка, а не как ночная сторона.
  const terminator = radius * 0.22;

  for (let y = 0; y < size; y++) {
    const dy = y - center;
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      if (dx * dx + dy * dy > radius * radius) continue;

      const px = Math.min(COMPANION_PATTERN[0]!.length - 1, x >> 1);
      const py = Math.min(COMPANION_PATTERN.length - 1, y >> 1);
      let index = PATTERN_TO_INDEX[COMPANION_PATTERN[py]![px]!] ?? 3;

      // Терминатор с дизерингом: резкая граница на диске в 20 пикселей
      // выглядит сколом, а не тенью.
      const shade = dx - terminator;
      if (shade > 1) index = 1;
      else if (shade > -1 && BAYER[(y & 3) * 4 + (x & 3)]! / 16 < (shade + 1) / 2) index = 1;

      // Тёмная кромка лимба: диск иначе выглядит наклейкой, а не шаром.
      const edge = Math.sqrt(dx * dx + dy * dy) / radius;
      if (index !== 1 && edge > 0.88) index = 2;

      out[y * size + x] = index;
    }
  }
  return out;
}
