/**
 * Поверхность поверх `CanvasRenderingContext2D`.
 *
 * Перевод ячеек кадра в пиксели устройства делается ЗДЕСЬ И РУКАМИ, матрица
 * контекста остаётся единичной. Причина: матрица масштабирует толщину линии,
 * а масштабирует ли она радиус тени — зависит от реализации браузера.
 * Интерфейс, у которого тени на одной машине вдвое мягче, чем на другой, —
 * ровно та непредсказуемость, ради ухода от которой всё это и затевалось.
 *
 * Класс держится ТОНКИМ: перевод координат и вызовы контекста, без правил
 * вида. Журнал проверки описывает намерение, а не результат, и всё, что здесь
 * сложнее вызова, журналом не ловится.
 */
import { UI } from '../../config';
import { SHADOW_INK } from './skin';
import type { LineStyle, PanelStyle, TextStyle, UiIcon, UiPoint, UiSurface } from './surface';

/** То, что нужно поверхности от экрана. Структурно — им является `Display`. */
export interface ScreenTarget {
  readonly ctx: CanvasRenderingContext2D;
  /** Пикселей устройства на ячейку кадра. */
  readonly pixelScale: number;
}

export class CanvasSurface implements UiSurface {
  /** Растеризованные значки: ключ — `UiIcon.key`. */
  private readonly tiles = new Map<string, HTMLCanvasElement>();
  private s = 1;

  constructor(private readonly screen: ScreenTarget) {}

  begin(): void {
    this.s = this.screen.pixelScale;
    this.clearShadow();
    const ctx = this.screen.ctx;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  end(): void {
    this.clearShadow();
  }

  panel(x: number, y: number, w: number, h: number, style: PanelStyle): void {
    const ctx = this.screen.ctx;
    const s = this.s;
    const px = x * s;
    const py = y * s;
    const pw = w * s;
    const ph = h * s;
    if (pw <= 0 || ph <= 0) return;

    this.path(px, py, pw, ph, Math.min(style.radius * s, pw / 2, ph / 2));

    if (style.shadow) {
      ctx.shadowColor = SHADOW_INK;
      ctx.shadowBlur = UI.shadow.blur * s;
      ctx.shadowOffsetY = UI.shadow.dy * s;
    }
    if (style.fillBottom) {
      const grad = ctx.createLinearGradient(0, py, 0, py + ph);
      grad.addColorStop(0, style.fill);
      grad.addColorStop(1, style.fillBottom);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = style.fill;
    }
    ctx.fill();
    this.clearShadow();

    if (style.stroke) {
      // Свечение — на обводке: заливка со свечением заливает им же и середину,
      // и подложка светится изнутри, а не по краю.
      if (style.glow) {
        ctx.shadowColor = style.glow;
        ctx.shadowBlur = UI.glow * s;
      }
      ctx.lineWidth = (style.strokeWidth ?? UI.stroke.thin) * s;
      ctx.strokeStyle = style.stroke;
      ctx.stroke();
      this.clearShadow();
    }
  }

  text(text: string, x: number, y: number, style: TextStyle): void {
    if (text === '') return;
    const ctx = this.screen.ctx;
    const s = this.s;
    ctx.font = font(style, s);
    const w = ctx.measureText(text).width;
    const left = x * s - (style.align === 'center' ? w / 2 : style.align === 'right' ? w : 0);

    if (style.shadow) {
      ctx.shadowColor = SHADOW_INK;
      ctx.shadowBlur = UI.textShadow * s;
    }
    ctx.fillStyle = style.color;
    ctx.fillText(text, left, y * s);
    this.clearShadow();
  }

  measure(text: string, style: TextStyle): number {
    if (text === '') return 0;
    const ctx = this.screen.ctx;
    ctx.font = font(style, this.s);
    return ctx.measureText(text).width / this.s;
  }

  icon(icon: UiIcon, x: number, y: number): void {
    const ctx = this.screen.ctx;
    const s = this.s;
    const tile = this.tile(icon);
    // Округление до пикселя устройства: значок пиксельный, и полпикселя
    // размыли бы ему край при любом сглаживании.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      tile,
      0,
      0,
      icon.w,
      icon.h,
      Math.round(x * s),
      Math.round(y * s),
      Math.round(icon.w * s),
      Math.round(icon.h * s),
    );
  }

  line(points: readonly UiPoint[], style: LineStyle): void {
    if (points.length < 2) return;
    const ctx = this.screen.ctx;
    const s = this.s;
    const r = (style.radius ?? 0) * s;

    ctx.beginPath();
    ctx.moveTo(points[0]!.x * s, points[0]!.y * s);
    for (let i = 1; i < points.length - 1; i++) {
      const c = points[i]!;
      const n = points[i + 1]!;
      ctx.arcTo(c.x * s, c.y * s, n.x * s, n.y * s, r);
    }
    const last = points[points.length - 1]!;
    ctx.lineTo(last.x * s, last.y * s);

    ctx.lineWidth = style.width * s;
    ctx.strokeStyle = style.color;
    ctx.stroke();
  }

  private clearShadow(): void {
    const ctx = this.screen.ctx;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  /**
   * Скруглённый прямоугольник дугами, а не `roundRect`: тот появился в браузерах
   * позже всего остального, чем пользуется игра, и обходится он в четыре строки.
   */
  private path(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.screen.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Значок, растеризованный ОДИН раз в натуральную величину. Множитель
   * применяется при выводе, поэтому смена размера окна кэш не сбрасывает.
   */
  private tile(icon: UiIcon): HTMLCanvasElement {
    const cached = this.tiles.get(icon.key);
    if (cached) return cached;

    const tile = document.createElement('canvas');
    tile.width = icon.w;
    tile.height = icon.h;
    const ctx = tile.getContext('2d');
    if (!ctx) throw new Error('Canvas2D недоступен');
    const image = ctx.createImageData(icon.w, icon.h);
    const px = image.data;
    for (let i = 0; i < icon.data.length; i++) {
      const index = icon.data[i]!;
      if (index === 0) continue;
      const color = icon.palette[index]!;
      const at = i * 4;
      px[at] = (color >> 16) & 0xff;
      px[at + 1] = (color >> 8) & 0xff;
      px[at + 2] = color & 0xff;
      px[at + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    this.tiles.set(icon.key, tile);
    return tile;
  }
}

function font(style: TextStyle, scale: number): string {
  return `${style.weight ?? 'normal'} ${style.size * scale}px ${UI.font}`;
}
