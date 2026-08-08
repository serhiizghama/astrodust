import { VIEW_W, VIEW_H } from '../config';

/**
 * Канвас фиксированного внутреннего разрешения с целочисленным апскейлом.
 *
 * Буфер всегда VIEW_W x VIEW_H. В окно он растягивается только целым
 * множителем — дробный масштаб размыл бы пиксель или сделал его
 * неравномерным (одни пиксели шире других).
 */
export class Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** RGBA-буфер кадра. Рендер пишет сюда, present() выводит на экран. */
  readonly image: ImageData;
  readonly pixels: Uint8ClampedArray;

  private scale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2D недоступен');
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;

    this.image = ctx.createImageData(VIEW_W, VIEW_H);
    this.pixels = this.image.data;
    // Канвас непрозрачный: альфа выставляется один раз и больше не трогается,
    // рендер пишет только RGB.
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Наибольший целый множитель, помещающийся в окно.
   * Если окно меньше внутреннего разрешения — остаётся 1, картинка обрезается,
   * но пиксель не дробится.
   */
  private resize(): void {
    const fit = Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H);
    this.scale = Math.max(1, Math.floor(fit));
    this.canvas.style.width = `${VIEW_W * this.scale}px`;
    this.canvas.style.height = `${VIEW_H * this.scale}px`;
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
