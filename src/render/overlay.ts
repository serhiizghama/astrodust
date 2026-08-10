import { VIEW_W, VIEW_H } from '../config';
import { RAMP, css } from '../palette';

/**
 * Оверлей исследований поверх кадра. Рисуется ТЕМ ЖЕ контекстом канваса, что
 * и строка состояния, после `display.present()`. Отдельного слоя DOM быть
 * не должно: второй слой — это второй масштаб на экране, а целочисленный
 * апскейл всего кадра записан требованием оболочки.
 *
 * Подложка НЕПРОЗРАЧНАЯ: мир под оверлеем любой, и читаемость текста
 * на произвольном фоне ничем другим не обеспечивается.
 *
 * Дерево — СПИСКОМ, а не графом: раскладка графа это отдельная работа ради
 * того же ответа. Предпосылка пишется текстом в строке.
 */

/** Состояние строки. Совпадает по смыслу с `TechStatus`, но живёт в рендере. */
export type OverlayRowStatus = 'open' | 'available' | 'poor' | 'blocked';

export interface OverlayRow {
  readonly name: string;
  readonly cost: number;
  readonly status: OverlayRowStatus;
  /**
   * Причина недоступности словами: «нужно ещё N» или «требует: X».
   *
   * Словами, а не только цветом. Четыре состояния обязаны различаться на вид,
   * но цвет один отвечает лишь «нельзя»; «не хватает очков» лечится работой,
   * «закрыта предпосылкой» — другой покупкой, и какой именно — из цвета
   * не следует никак.
   */
  readonly note: string;
}

export interface OverlayView {
  readonly points: number;
  readonly rows: readonly OverlayRow[];
  readonly selected: number;
}

/**
 * Цвет строки по состоянию.
 *
 * Доступная — самая светлая в кадре: она единственная, с которой игрок может
 * что-то сделать прямо сейчас. Открытая уходит в зелень готового, «не хватает
 * очков» — в золото валюты (то же золото, что у счёта: связь читается без
 * подписи), закрытая предпосылкой — в приглушённый серый.
 */
const ROW_COLORS: Record<OverlayRowStatus, number> = {
  open: RAMP.green[3],
  available: RAMP.gray[9],
  poor: RAMP.warm[4],
  blocked: RAMP.gray[5],
};

const PANEL = {
  x: 24,
  y: 20,
  w: VIEW_W - 48,
  h: VIEW_H - 44,
  /** Высота строки списка. Кегль 8, поэтому 10 оставляет просвет в две. */
  lineH: 10,
} as const;

/**
 * @param ctx контекст кадра — тот же, которым рисуется строка состояния
 */
export function drawResearchOverlay(ctx: CanvasRenderingContext2D, view: OverlayView): void {
  ctx.fillStyle = css(RAMP.gray[1]);
  ctx.fillRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);
  ctx.strokeStyle = css(RAMP.gray[4]);
  // Полупиксельное смещение: без него рамка ложится между пикселями буфера
  // и размазывается на два — на кадре 320×180 это видно.
  ctx.lineWidth = 1;
  ctx.strokeRect(PANEL.x + 0.5, PANEL.y + 0.5, PANEL.w - 1, PANEL.h - 1);

  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';

  const left = PANEL.x + 5;
  const right = PANEL.x + PANEL.w - 5;
  let y = PANEL.y + 4;

  ctx.fillStyle = css(RAMP.gray[9]);
  ctx.fillText('ИССЛЕДОВАНИЯ', left, y);
  // Очки — тем же цветом, что и в строке состояния (`blue[5]`): одна валюта —
  // один цвет, где бы её ни показывали. Холодная бирюза против золота кредитов
  // разводит две валюты тоном, а не яркостью, поэтому «сколько денег»
  // и «сколько очков» не приходится читать по подписи.
  const points = `${view.points} ✦`;
  ctx.fillStyle = css(RAMP.blue[5]);
  ctx.fillText(points, right - ctx.measureText(points).width, y);

  y += PANEL.lineH + 2;

  view.rows.forEach((row, i) => {
    const color = ROW_COLORS[row.status];

    // Выбранная строка отмечена и подложкой, и указателем: одной подложки мало
    // на «открытой» строке, где текст и так приглушён, а одного указателя —
    // при беглом взгляде.
    if (i === view.selected) {
      ctx.fillStyle = css(RAMP.gray[3]);
      ctx.fillRect(PANEL.x + 1, y - 1, PANEL.w - 2, PANEL.lineH);
    }

    ctx.fillStyle = css(color);
    ctx.fillText(`${i === view.selected ? '▸' : ' '} ${row.name}`, left, y);

    const tail = row.status === 'open' ? 'открыта' : `${row.cost} ✦`;
    ctx.fillText(tail, right - ctx.measureText(tail).width, y);

    y += PANEL.lineH;

    if (row.note) {
      ctx.fillStyle = css(RAMP.gray[6]);
      ctx.fillText(`    ${row.note}`, left, y);
      y += PANEL.lineH;
    }
  });

  ctx.fillStyle = css(RAMP.gray[6]);
  ctx.fillText('W/S — выбор   Space — купить   T — закрыть', left, PANEL.y + PANEL.h - 11);
}
