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

/** Экранный буфер канваса: пиксели устройства на ячейку кадра и размер в них. */
export interface ScreenFit {
  /** Пикселей устройства на ячейку кадра. */
  readonly pixelScale: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Экранный буфер по кадру и плотности экрана. Чистая функция — проверяется
 * без браузера, держит `tests/game-shell.ts`.
 *
 * Плотность входит ТОЛЬКО сюда: разрешение буфера мира и экранный множитель
 * считаются в CSS-пикселях и от неё не зависят. Иначе экран высокой плотности
 * менял бы, сколько мира видно, — а это позволено одному лишь размеру окна.
 *
 * Плотность ограничена сверху: на утроенной экранный буфер стоит вдевятеро
 * дороже опорного, а разница с удвоенной глазом уже не берётся.
 */
export function screenFrame(fit: FrameFit, ratio: number): ScreenFit {
  const clamped = Math.min(3, Math.max(1, ratio || 1));
  const pixelScale = fit.scale * clamped;
  return {
    pixelScale,
    w: Math.round(fit.w * pixelScale),
    h: Math.round(fit.h * pixelScale),
  };
}

/**
 * Канвас, покрывающий окно целиком. Кадр в нём ДВУХСЛОЙНЫЙ.
 *
 * Мир пишется в буфер ячеек (`pixels`) и выводится на экран целым множителем
 * с выключенным сглаживанием — пиксель остаётся квадратом. Интерфейс рисуется
 * поверх выведенного мира тем же контекстом, но в пикселях устройства: слой
 * векторный, и множитель мира ему не указ.
 *
 * Отсюда размер канваса: он ЭКРАННЫЙ (`ceil(окно × плотность)`), а не размером
 * с буфер. Буфер мира живёт на отдельном офскрине, и `present()` переносит его
 * на экран одним `drawImage`.
 *
 * Разрешение буфера и множитель считаются в CSS-пикселях и от плотности экрана
 * НЕ зависят: плотность не имеет права менять, сколько мира видно.
 *
 * Свес канваса за край окна (меньше множителя) срезается `overflow: hidden`
 * в `index.html`. Интерфейс отступает от края на четыре ячейки и в срез
 * не попадает — поставленный вплотную к краю попадёт.
 */
export class Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** RGBA-буфер мира. Рендер пишет сюда, present() выводит на экран. */
  image!: ImageData;
  pixels!: Uint8ClampedArray;

  /** Размер буфера в ячейках. Меняется вместе с окном. */
  width = 0;
  height = 0;
  /** Экранный множитель в CSS-пикселях: им же меряется мышь. */
  scale = 1;
  /** Пикселей устройства на ячейку кадра. Слой интерфейса меряет ими всё. */
  pixelScale = 1;

  /** Офскрин с миром: `putImageData` идёт сюда, а не на экран. */
  private frame!: HTMLCanvasElement;
  private frameCtx!: CanvasRenderingContext2D;

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
    const screen = screenFrame(fit, window.devicePixelRatio);
    this.scale = fit.scale;
    this.pixelScale = screen.pixelScale;
    this.canvas.style.width = `${fit.w * fit.scale}px`;
    this.canvas.style.height = `${fit.h * fit.scale}px`;

    // Экранный буфер пересчитывается и при неизменном кадре: перенос окна
    // на монитор другой плотности меняет только его.
    if (this.canvas.width !== screen.w || this.canvas.height !== screen.h) {
      this.canvas.width = screen.w;
      this.canvas.height = screen.h;
    }

    if (fit.w === this.width && fit.h === this.height) return;

    this.width = fit.w;
    this.height = fit.h;

    this.frame = document.createElement('canvas');
    this.frame.width = fit.w;
    this.frame.height = fit.h;
    const frameCtx = this.frame.getContext('2d', { alpha: false });
    if (!frameCtx) throw new Error('Canvas2D недоступен');
    this.frameCtx = frameCtx;

    this.image = this.frameCtx.createImageData(fit.w, fit.h);
    this.pixels = this.image.data;
    // Буфер непрозрачный: альфа выставляется один раз и больше не трогается,
    // рендер пишет только RGB.
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;

    this.viewportChanged?.(fit.w, fit.h);
  }

  /**
   * Выводит мир на экран. Сглаживание выключается здесь, а не однажды:
   * запись в `canvas.width` сбрасывает состояние контекста.
   */
  present(): void {
    this.frameCtx.putImageData(this.image, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      this.frame,
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      Math.round(this.width * this.pixelScale),
      Math.round(this.height * this.pixelScale),
    );
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
