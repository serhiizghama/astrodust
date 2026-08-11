/**
 * Постоянный интерфейс поверх кадра: панель действий, счётчик валюты, строки
 * состояния внизу.
 *
 * Геометрия панели считается ОДИН РАЗ на кадр и служит обоим читателям —
 * отрисовке и попаданию курсора. Две записи одной геометрии дают интерфейс,
 * который выглядит нажатым не там, где нажимается.
 *
 * Всё рисуется через поверхность слоя интерфейса и в ЯЧЕЙКАХ КАДРА: раскладка
 * не знает ни экранного множителя, ни плотности экрана, и поэтому проверяется
 * в Node без канваса. Держит `tests/game-hud.ts`.
 */
import { HUD, UI } from '../config';
import { RAMP, css } from '../palette';
import { fitText, bodyText, smallText, BAR_PLATE } from './ui';
import type { PanelStyle, UiIcon, UiSurface } from './ui';
import {
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

/** Раскладка панели действий в ячейках кадра. */
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

const ACTION_ICONS: Record<SlotAction, UiIcon> = {
  dig: DIG_ICON,
  build: BUILD_ICON,
  collect: COLLECT_ICON,
};

/**
 * Вид слота по состоянию. Каждое состояние разведено НЕ МЕНЕЕ ЧЕМ ДВУМЯ
 * средствами из набора «заливка, обводка, свечение»: одна заливка при беглом
 * взгляде не читается, одна обводка не читается на тёмном слоте.
 */
const SLOT_PLAIN: PanelStyle = {
  fill: css(RAMP.gray[3], UI.alpha.slot),
  stroke: css(RAMP.gray[1]),
  strokeWidth: UI.stroke.thin,
  radius: UI.radius.slot,
};

/** Пустой слот темнее и обведён приглушённо: место под будущее, не инструмент. */
const SLOT_EMPTY: PanelStyle = {
  fill: css(RAMP.gray[2], UI.alpha.slot),
  stroke: css(RAMP.gray[1], UI.alpha.edge),
  strokeWidth: UI.stroke.thin,
  radius: UI.radius.slot,
};

const SLOT_HOVER: PanelStyle = {
  fill: css(RAMP.gray[5], UI.alpha.slot),
  stroke: css(RAMP.gray[7]),
  strokeWidth: UI.stroke.thin,
  radius: UI.radius.slot,
};

/** Активный: своя заливка, толстая светлая обводка и свечение вокруг неё. */
const SLOT_ACTIVE: PanelStyle = {
  fill: css(RAMP.gray[6], UI.alpha.slot),
  fillBottom: css(RAMP.gray[4], UI.alpha.slot),
  stroke: css(RAMP.gray[9]),
  strokeWidth: UI.stroke.thick,
  radius: UI.radius.slot,
  glow: css(RAMP.blue[4], UI.alpha.glow),
};

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
  ui: UiSurface,
  layout: HudLayout,
  slots: readonly HudSlot[],
  activeSlot: number,
  hoveredSlot: number | null,
): void {
  ui.panel(layout.x, layout.y, layout.w, layout.h, BAR_PLATE);

  for (let i = 0; i < layout.slots; i++) {
    const slot = slots[i];
    const action = slot?.action ?? null;
    const x = layout.slotX + i * layout.slotStep;
    const y = layout.slotY;
    const size = layout.slotSize;
    const active = i === activeSlot;
    const hovered = i === hoveredSlot;

    const style = active
      ? SLOT_ACTIVE
      : hovered
        ? SLOT_HOVER
        : action === null
          ? SLOT_EMPTY
          : SLOT_PLAIN;
    ui.panel(x, y, size, size, style);

    if (action !== null) {
      ui.icon(
        ACTION_ICONS[action],
        x + ((size - ACTION_ICON) >> 1),
        y + ((size - ACTION_ICON) >> 1) + HUD.iconDropY,
      );
    }

    // Подпись клавиши — без ореола: подложка слота своя, и контраст даёт она.
    if (slot) {
      ui.text(slot.key, x + 2, y + 1, smallText(active ? KEY_LABEL_ACTIVE : KEY_LABEL));
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
 * Число прижато к ПРАВОМУ краю: счёт растёт по ходу партии, и счётчик,
 * прыгающий по углу на каждой сотне, читается хуже неподвижного. Ореол под
 * надписью обязателен — счёт лежит прямо на мире, а мир под ним любой.
 *
 * Счётчик ОДИН: валюта в игре одна, и второй, который никогда не меняется,
 * читался бы поломкой.
 */
export function drawCredits(ui: UiSurface, viewW: number, credits: number): void {
  const value = `${credits}`;
  const style = bodyText(CREDITS_COLOR, { align: 'right', weight: 'bold', shadow: true });
  const right = viewW - HUD.counterMargin;
  ui.text(value, right, HUD.counterMargin, style);
  const width = ui.measure(value, style);
  ui.icon(COIN_ICON, right - width - HUD.counterGap - CURRENCY_ICON, HUD.counterMargin + 1);
}

/**
 * Строка, центрированная над панелью. `row` — расстояние в строках от панели
 * вверх: 0 — вплотную над ней.
 *
 * Центрирование, а не левый край кадра: строки читаются как одна группа
 * с панелью, а на узком буфере левый край увёл бы длинную строку за кадр.
 * Строка шире кадра обрезается многоточием: своей подложки у неё нет, и край
 * кадра срезал бы конец молча.
 */
export function drawBarLine(
  ui: UiSurface,
  viewW: number,
  layout: HudLayout,
  row: number,
  text: string,
  color: number,
): void {
  if (text === '') return;
  const style = bodyText(color, { align: 'center', shadow: true });
  const y = layout.y - HUD.lineGap - (row + 1) * UI.line;
  ui.text(fitText(ui, text, style, viewW - 2 * HUD.counterMargin), viewW / 2, y, style);
}
