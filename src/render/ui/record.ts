/**
 * Поверхность-журнал: складывает операции вместо того, чтобы рисовать.
 *
 * Существует ради проверок. Прогон идёт в Node, канваса там нет, и вопрос
 * «что нарисовано и где» решается чтением журнала. Интерфейс, проверяемый
 * только глазами на скриншоте, перестаёт проверяться на второй неделе.
 *
 * Метрика текста ДЕТЕРМИНИРОВАННАЯ и своя: измерять нечем, а раскладка должна
 * повторяться от прогона к прогону. Доля кегля на знак, а не таблица ширин, —
 * точность здесь не нужна, нужна воспроизводимость.
 */
import type { LineStyle, PanelStyle, TextStyle, UiIcon, UiPoint, UiSurface } from './surface';

export type UiOp =
  | {
      readonly kind: 'panel';
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly style: PanelStyle;
    }
  | {
      readonly kind: 'text';
      readonly text: string;
      /** Левый край надписи: выравнивание уже применено. */
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly style: TextStyle;
    }
  | {
      readonly kind: 'icon';
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    }
  | {
      readonly kind: 'line';
      readonly points: readonly UiPoint[];
      readonly style: LineStyle;
    };

/** Доля кегля на обычный знак и на пробел. */
const ADVANCE = 0.55;
const SPACE_ADVANCE = 0.28;

export class RecordingSurface implements UiSurface {
  readonly ops: UiOp[] = [];

  /** @param advance доля кегля на знак: другая метрика — другая раскладка */
  constructor(private readonly advance = ADVANCE) {}

  begin(): void {
    this.ops.length = 0;
  }

  end(): void {}

  panel(x: number, y: number, w: number, h: number, style: PanelStyle): void {
    this.ops.push({ kind: 'panel', x, y, w, h, style });
  }

  text(text: string, x: number, y: number, style: TextStyle): void {
    if (text === '') return;
    const width = this.measure(text, style);
    const left = x - (style.align === 'center' ? width / 2 : style.align === 'right' ? width : 0);
    this.ops.push({ kind: 'text', text, x: left, y, width, style });
  }

  measure(text: string, style: TextStyle): number {
    let units = 0;
    for (const ch of text) units += ch === ' ' ? SPACE_ADVANCE : this.advance;
    return units * style.size;
  }

  icon(icon: UiIcon, x: number, y: number): void {
    this.ops.push({ kind: 'icon', key: icon.key, x, y, w: icon.w, h: icon.h });
  }

  line(points: readonly UiPoint[], style: LineStyle): void {
    if (points.length < 2) return;
    this.ops.push({ kind: 'line', points: points.map((p) => ({ x: p.x, y: p.y })), style });
  }

  /** Операции одного вида — почти каждая проверка начинается с этого. */
  of<K extends UiOp['kind']>(kind: K): Extract<UiOp, { kind: K }>[] {
    return this.ops.filter((op): op is Extract<UiOp, { kind: K }> => op.kind === kind);
  }

  /** Есть ли надпись с таким текстом. */
  says(text: string): boolean {
    return this.ops.some((op) => op.kind === 'text' && op.text === text);
  }
}
