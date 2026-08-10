import { BASE_VIEW_W, BASE_VIEW_H, MAX_VIEW_W, MAX_VIEW_H } from '../config';

/** Разрешение буфера и экранный множитель для окна данного размера. */
export interface FrameFit {
  readonly scale: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Подбор кадра под окно. Чистая функция — проверяется без браузера,
 * держит `tests/game-shell.ts`.
 *
 * `ceil`, а не `floor`: при `floor` канвас оказывается на пиксель-другой уже
 * окна, и вокруг кадра возвращается полоса. При `ceil` канвас не меньше окна,
 * свес меньше одного множителя и срезается краем окна.
 *
 * `round`, а не `floor`, в выборе множителя: `floor` на окне 1908×980 дал бы
 * ×2 и кадр 954×490 — почти весь мир разом.
 */
export function fitFrame(windowW: number, windowH: number): FrameFit {
  const w = Math.max(1, windowW);
  const h = Math.max(1, windowH);
  let scale = Math.max(1, Math.round(Math.min(w / BASE_VIEW_W, h / BASE_VIEW_H)));
  while (Math.ceil(w / scale) > MAX_VIEW_W || Math.ceil(h / scale) > MAX_VIEW_H) scale++;
  return { scale, w: Math.ceil(w / scale), h: Math.ceil(h / scale) };
}

/**
 * Канвас, покрывающий окно целиком, с целочисленным апскейлом.
 *
 * Размер буфера — производная окна, а не константа: кадр фиксированного
 * разрешения не делится на окно нацело ни при каком целом множителе, и вокруг
 * него оставался бы леттербокс.
 *
 * Свес канваса за край окна (меньше множителя) срезается `overflow: hidden`
 * в `index.html`. Интерфейс отступает от края на четыре ячейки и в срез
 * не попадает — поставленный вплотную к краю попадёт.
 */
export class Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** RGBA-буфер кадра. Рендер пишет сюда, present() выводит на экран. */
  image!: ImageData;
  pixels!: Uint8ClampedArray;

  /** Размер буфера в ячейках. Меняется вместе с окном. */
  width = 0;
  height = 0;
  scale = 1;

  private viewportChanged: ((w: number, h: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2D недоступен');
    this.ctx = ctx;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Подписка на изменение размера кадра. Вызывается сразу же: подписчику нужен
   * текущий размер, а не только следующий.
   */
  onViewportChange(fn: (w: number, h: number) => void): void {
    this.viewportChanged = fn;
    fn(this.width, this.height);
  }

  private resize(): void {
    const fit = fitFrame(window.innerWidth, window.innerHeight);
    this.scale = fit.scale;
    this.canvas.style.width = `${fit.w * fit.scale}px`;
    this.canvas.style.height = `${fit.h * fit.scale}px`;
    if (fit.w === this.width && fit.h === this.height) return;

    this.width = fit.w;
    this.height = fit.h;
    // Запись в canvas.width сбрасывает состояние контекста, поэтому сглаживание
    // выставляется здесь, а не один раз в конструкторе.
    this.canvas.width = fit.w;
    this.canvas.height = fit.h;
    this.ctx.imageSmoothingEnabled = false;

    this.image = this.ctx.createImageData(fit.w, fit.h);
    this.pixels = this.image.data;
    // Канвас непрозрачный: альфа выставляется один раз на буфер и больше
    // не трогается, рендер пишет только RGB.
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;

    this.viewportChanged?.(fit.w, fit.h);
  }

  /** Выводит буфер кадра на экран. */
  present(): void {
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** Переводит координаты события мыши в координаты буфера кадра. */
  clientToBuffer(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / this.scale,
      y: (clientY - rect.top) / this.scale,
    };
  }
}
