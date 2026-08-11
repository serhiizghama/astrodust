/**
 * Постоянный интерфейс поверх кадра: панель действий, счётчики валют, строки
 * состояния внизу.
 *
 * Геометрия панели считается ОДИН РАЗ на кадр и служит обоим читателям —
 * отрисовке и попаданию курсора. Две записи одной геометрии дают интерфейс,
 * который выглядит нажатым не там, где нажимается.
 *
 * Всё рисуется в буфер пикселей, поэтому проверяется в Node без канваса.
 * Держит `tests/game-hud.ts`.
 */
import { HUD } from '../config';
import { RAMP } from '../palette';
import { fillRect, strokeRect, blit } from './draw';
import { drawText, textWidth, GLYPH_H, LINE_H } from './font';
import {
  ICON_PALETTE,
  ACTION_ICON,
  CURRENCY_ICON,
  DIG_ICON,
  BUILD_ICON,
  COLLECT_ICON,
  COIN_ICON,
} from './sprites/icons';

/** Что делает слот. Строка, а не режим из `core`: рендер не решает, чем копают. */
export type SlotAction = 'dig' | 'build' | 'collect';

export interface HudSlot {
  /** Подпись клавиши прямого выбора. */
  readonly key: string;
  /** `null` — слот пуст и зарезервирован. */
  readonly action: SlotAction | null;
}

/** Раскладка панели действий в пикселях кадра. */
export interface HudLayout {
  /** Подложка панели: ряд слотов плюс поля. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Левый верхний угол первого слота. */
  readonly slotX: number;
  readonly slotY: number;
  readonly slotSize: number;
  /** Шаг между слотами: размер плюс зазор. */
  readonly slotStep: number;
  readonly slots: number;
}

const ACTION_ICONS: Record<SlotAction, Uint8Array> = {
  dig: DIG_ICON,
  build: BUILD_ICON,
  collect: COLLECT_ICON,
};

/**
 * Цвета слотов. Обычный, пустой, наведённый и активный обязаны различаться
 * подложкой: рамка одна отвечает на вопрос «где курсор», но при беглом взгляде
 * не читается вовсе.
 */
const SLOT_FILL = RAMP.gray[3];
const SLOT_EMPTY_FILL = RAMP.gray[2];
const SLOT_HOVER_FILL = RAMP.gray[4];
const SLOT_ACTIVE_FILL = RAMP.gray[6];
const SLOT_EDGE = RAMP.gray[1];
const SLOT_HOVER_EDGE = RAMP.gray[7];
const SLOT_ACTIVE_EDGE = RAMP.gray[9];
const BAR_PLATE = RAMP.gray[1];
const BAR_EDGE = RAMP.gray[3];
const KEY_LABEL = RAMP.gray[7];
const KEY_LABEL_ACTIVE = RAMP.gray[9];

/** Цвет валюты. Золото — её же тон в подписях цен внутри дерева технологий. */
const CREDITS_COLOR = RAMP.warm[4];

/**
 * Раскладка панели из размера буфера кадра.
 *
 * Панель растягивается по кадру ЦЕНТРИРОВАНИЕМ, а не долей: размер буфера
 * производен от окна, и слот, заданный долей, на широком окне превратился бы
 * в растянутый прямоугольник, а на узком — в нечитаемый.
 */
export function hudLayout(viewW: number, viewH: number): HudLayout {
  const size = HUD.slotSize;
  const step = size + HUD.slotGap;
  const rowW = HUD.slots * size + (HUD.slots - 1) * HUD.slotGap;
  const slotX = Math.floor((viewW - rowW) / 2);
  const slotY = viewH - HUD.barBottom - size;
  return {
    x: slotX - HUD.barPad,
    y: slotY - HUD.barPad,
    w: rowW + 2 * HUD.barPad,
    h: size + 2 * HUD.barPad,
    slotX,
    slotY,
    slotSize: size,
    slotStep: step,
    slots: HUD.slots,
  };
}

/** Номер слота под точкой, или `null`. Зазор между слотами — «мимо». */
export function slotAtPoint(x: number, y: number, layout: HudLayout): number | null {
  if (y < layout.slotY || y >= layout.slotY + layout.slotSize) return null;
  const dx = x - layout.slotX;
  if (dx < 0) return null;
  const slot = Math.floor(dx / layout.slotStep);
  if (slot >= layout.slots) return null;
  // Остаток за размером слота — это зазор, а не слот.
  if (dx - slot * layout.slotStep >= layout.slotSize) return null;
  return slot;
}

/**
 * Лежит ли точка на панели целиком — включая поля подложки и зазоры.
 *
 * Отдельно от `slotAtPoint`, потому что вопросы разные: подсветить нужно слот,
 * а не пропустить к миру — всю панель. Клик в зазор между слотами не должен
 * копать дыру под панелью только потому, что промахнулся мимо слота.
 */
export function overBar(x: number, y: number, layout: HudLayout): boolean {
  return x >= layout.x && x < layout.x + layout.w && y >= layout.y && y < layout.y + layout.h;
}

/** Панель действий: подложка, слоты, подписи клавиш, значки, выделения. */
export function drawActionBar(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  layout: HudLayout,
  slots: readonly HudSlot[],
  activeSlot: number,
  hoveredSlot: number | null,
): void {
  fillRect(px, w, h, layout.x, layout.y, layout.w, layout.h, BAR_PLATE);
  strokeRect(px, w, h, layout.x, layout.y, layout.w, layout.h, BAR_EDGE);

  for (let i = 0; i < layout.slots; i++) {
    const slot = slots[i];
    const action = slot?.action ?? null;
    const x = layout.slotX + i * layout.slotStep;
    const y = layout.slotY;
    const size = layout.slotSize;
    const active = i === activeSlot;
    const hovered = i === hoveredSlot;

    const fill = active
      ? SLOT_ACTIVE_FILL
      : hovered
        ? SLOT_HOVER_FILL
        : action === null
          ? SLOT_EMPTY_FILL
          : SLOT_FILL;
    fillRect(px, w, h, x, y, size, size, fill);
    strokeRect(
      px,
      w,
      h,
      x,
      y,
      size,
      size,
      active ? SLOT_ACTIVE_EDGE : hovered ? SLOT_HOVER_EDGE : SLOT_EDGE,
    );

    if (action !== null) {
      blit(
        px,
        w,
        h,
        ACTION_ICONS[action],
        ACTION_ICON,
        ACTION_ICON,
        x + ((size - ACTION_ICON) >> 1),
        y + ((size - ACTION_ICON) >> 1) + HUD.iconDropY,
        ICON_PALETTE,
      );
    }

    // Подпись клавиши — без подложки: фон слота непрозрачен и контраст даёт он.
    if (slot) {
      drawText(px, w, h, slot.key, x + 2, y + 1, active ? KEY_LABEL_ACTIVE : KEY_LABEL, false);
    }
  }
}

/**
 * Счётчик кредитов в правом верхнем углу: значок и число.
 *
 * Угол свой — верхний левый занят диагностикой, нижний край панелью. Значок
 * вместо знака валюты: в углу число стоит без предложения, и форма читается
 * быстрее символа размером с букву.
 *
 * Счётчик ОДИН: валюта в игре одна, и второй, который никогда не меняется,
 * читался бы поломкой.
 */
export function drawCredits(px: Uint8ClampedArray, w: number, h: number, credits: number): void {
  const value = `${credits}`;
  const textW = textWidth(value);
  const total = CURRENCY_ICON + HUD.counterGap + textW;
  const x = w - HUD.counterMargin - total;
  const y = HUD.counterMargin;
  blit(px, w, h, COIN_ICON, CURRENCY_ICON, CURRENCY_ICON, x, y, ICON_PALETTE);
  drawText(px, w, h, value, x + CURRENCY_ICON + HUD.counterGap, y, CREDITS_COLOR);
}

/**
 * Строка, центрированная над панелью. `row` — расстояние в строках от панели
 * вверх: 0 — вплотную над ней.
 *
 * Центрирование, а не левый край кадра: строки читаются как одна группа
 * с панелью, а на узком буфере левый край увёл бы длинную строку за кадр.
 */
export function drawBarLine(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  layout: HudLayout,
  row: number,
  text: string,
  color: number,
): void {
  if (text === '') return;
  const x = Math.max(1, Math.round((w - textWidth(text)) / 2));
  const y = layout.y - HUD.lineGap - GLYPH_H - row * LINE_H;
  drawText(px, w, h, text, x, y, color);
}
