/**
 * Поверхность рисования интерфейса: единственный способ что-либо нарисовать
 * в слое интерфейса.
 *
 * Координаты и длины — В ЯЧЕЙКАХ КАДРА, тех же, в которых измеряется мир.
 * Перевод в пиксели устройства делает реализация: раскладка не знает ни
 * экранного множителя, ни плотности экрана, и поэтому одинакова везде.
 *
 * Реализаций две: канвас (браузер) и журнал (проверки без браузера). Всё, что
 * интерфейс рисует, проходит через этот интерфейс целиком — иначе журнал
 * перестаёт описывать кадр, а проверки перестают что-либо значить.
 *
 * Ширина строки НЕ вычисляется, а измеряется: шрифт системный, и на разных
 * машинах одна и та же надпись занимает разную ширину.
 */

export type FontWeight = 'normal' | 'bold';
/** Выравнивание относительно точки `x`. */
export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  /** Кегль в ячейках кадра. Берётся из шкалы `UI.text`. */
  readonly size: number;
  readonly color: string;
  readonly weight?: FontWeight;
  readonly align?: TextAlign;
  /**
   * Мягкий ореол под буквами. Нужен надписи, лежащей ПРЯМО НА МИРЕ: мир под
   * ней бывает любым, и без ореола она исчезает на светлом или на тёмном.
   * Надписи на собственной подложке ореол не нужен — контраст даёт подложка.
   */
  readonly shadow?: boolean;
}

export interface PanelStyle {
  readonly fill: string;
  /** Нижний цвет вертикального градиента. Нет — заливка ровная. */
  readonly fillBottom?: string;
  readonly stroke?: string;
  /** Толщина обводки в ячейках. Берётся из `UI.stroke`. */
  readonly strokeWidth?: number;
  /** Скругление в ячейках. Берётся из `UI.radius`. */
  readonly radius: number;
  /** Мягкая падающая тень: отделяет подложку от того, что под ней. */
  readonly shadow?: boolean;
  /** Свечение вокруг подложки. Работает вместе с обводкой, а не вместо неё. */
  readonly glow?: string;
}

export interface LineStyle {
  readonly color: string;
  /** Толщина в ячейках. */
  readonly width: number;
  /** Скругление поворота. */
  readonly radius?: number;
}

export interface UiPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Значок — пиксельный спрайт, а не вектор: значки часть языка игры, а не
 * типографики. Выводятся один к одному в ячейки кадра и вместе с миром
 * растягиваются целым множителем.
 */
export interface UiIcon {
  /** Ключ: им значок опознаётся в кэше растеризации и в журнале проверки. */
  readonly key: string;
  readonly data: Uint8Array;
  readonly w: number;
  readonly h: number;
  /** Индекс 0 прозрачен всегда — соглашение формата спрайта. */
  readonly palette: readonly number[];
}

export interface UiSurface {
  /** Начало кадра интерфейса: сброс состояния и текущего множителя. */
  begin(): void;
  /** Конец кадра интерфейса. */
  end(): void;
  /** Подложка: скруглённый прямоугольник с заливкой, обводкой и тенью. */
  panel(x: number, y: number, w: number, h: number, style: PanelStyle): void;
  /** Надпись. `y` — верх строки, `x` — точка выравнивания. */
  text(text: string, x: number, y: number, style: TextStyle): void;
  /** Ширина надписи в ячейках кадра. */
  measure(text: string, style: TextStyle): number;
  /** Значок в натуральную величину: ячейка кадра на пиксель спрайта. */
  icon(icon: UiIcon, x: number, y: number): void;
  /** Ломаная со скруглёнными поворотами. */
  line(points: readonly UiPoint[], style: LineStyle): void;
}

const ELLIPSIS = '…';

/**
 * Строка, подогнанная под отведённую ширину: целиком или обрезанная
 * многоточием.
 *
 * Обрезка, а не проверка длины: длину задаёт чужой шрифт, и уронить прогон
 * за неё нельзя — уронится он на машине разработчика, а наедет подпись
 * на соседа на машине игрока.
 */
export function fitText(ui: UiSurface, text: string, style: TextStyle, maxWidth: number): string {
  if (text === '' || maxWidth <= 0) return '';
  if (ui.measure(text, style) <= maxWidth) return text;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ui.measure(text.slice(0, mid) + ELLIPSIS, style) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return ui.measure(ELLIPSIS, style) <= maxWidth ? ELLIPSIS : '';
  return text.slice(0, lo).trimEnd() + ELLIPSIS;
}
