import { TECH_TREE } from '../config';
import { RAMP } from '../palette';
import { fillRect, strokeRect, blit, hLine, vLine } from './draw';
import { drawText, textWidth, LINE_H } from './font';
import { ICON_PALETTE, TECH_ICON, techIcon, POINTER, POINTER_W, POINTER_H } from './sprites/icons';

/**
 * Дерево технологий поверх кадра. Рисуется В БУФЕР теми же пикселями, что
 * и мир, — как и всё остальное в кадре. Отдельного слоя DOM быть не должно:
 * второй слой — это второй масштаб на экране, а целочисленный апскейл всего
 * кадра записан требованием оболочки.
 *
 * Подложка НЕПРОЗРАЧНАЯ: мир под оверлеем любой, и читаемость текста
 * на произвольном фоне ничем другим не обеспечивается. Поэтому же надписи
 * внутри панели идут БЕЗ тени — контраст даёт сама подложка.
 *
 * Дерево — ГРАФ, а не список: список отвечает «что можно купить сейчас»,
 * но не отвечает, что за чем стоит и куда ведёт развитие.
 *
 * Геометрия считается ОДИН РАЗ (`techTreeLayout`) и служит обоим читателям —
 * отрисовке и попаданию курсора. Две записи одной геометрии дают интерфейс,
 * который выглядит нажатым не там, где нажимается.
 *
 * Держит `tests/research.ts`.
 */

/** Состояние узла. Совпадает по смыслу с `TechStatus`, но живёт в рендере. */
export type OverlayNodeStatus = 'open' | 'available' | 'poor' | 'blocked';

/** Что технология открывает: постройку или навык. Признак ДРУГОЙ, чем состояние. */
export type OverlayNodeKind = 'unlock' | 'tune';

export interface OverlayNode {
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  /** Как пользоваться: режим, клавиша, что именно меняется. */
  readonly usage: string;
  readonly status: OverlayNodeStatus;
  readonly kind: OverlayNodeKind;
  /** Ключ значка. Неизвестный получает запасной, а не пустое место. */
  readonly icon: string;
  /** Колонка и строка в сетке дерева. Считает их раскладка графа, не рендер. */
  readonly col: number;
  readonly row: number;
  /**
   * Причина недоступности словами: «нужно ещё N ₡» или «требует: X».
   *
   * Словами, а не только цветом. Цвет отвечает «нельзя» и не отвечает
   * «почему», а причины требуют разных действий: «не хватает кредитов»
   * лечится работой, «закрыта предпосылкой» — другой покупкой.
   */
  readonly note: string;
}

/** Связь: индексы узлов в `nodes`, от предпосылки к зависящему узлу. */
export interface OverlayEdge {
  readonly from: number;
  readonly to: number;
}

export interface OverlayView {
  readonly credits: number;
  readonly nodes: readonly OverlayNode[];
  readonly edges: readonly OverlayEdge[];
  readonly selected: number;
  /** Узел под курсором, или `null`. Мыши не было — подсветки в кадре нет. */
  readonly hovered: number | null;
  /**
   * Курсор в координатах буфера кадра.
   *
   * Поля ОБЯЗАТЕЛЬНЫЕ, а не с умолчанием: подложка оверлея непрозрачна
   * и накрывает мировой прицел целиком, поэтому меню обязано рисовать курсор
   * само. Забывчивость здесь стоит ровно того, чем она уже обошлась однажды, —
   * меню без единого признака того, где мышь.
   */
  readonly pointerX: number;
  readonly pointerY: number;
}

/**
 * Подложка узла по состоянию покупки.
 *
 * Ступени разведены не менее чем на две по серой лестнице, а «куплена» уходит
 * в другой тон: соседние ступени читаются как освещение, а не как разные
 * состояния. Это то же правило, по которому построена палитра.
 */
const NODE_FILL: Record<OverlayNodeStatus, number> = {
  open: RAMP.green[1],
  available: RAMP.gray[6],
  poor: RAMP.gray[4],
  blocked: RAMP.gray[2],
};

/**
 * Рамка узла по виду эффекта. ДРУГОЕ средство, чем подложка, потому что
 * признак другой: закрытая предпосылкой постройка и закрытый предпосылкой
 * навык обязаны различаться, и различие должно выживать в любом состоянии
 * покупки.
 *
 * Ни земля, ни фиалка не совпадают с золотом счёта: рамка — не цена.
 */
const NODE_EDGE: Record<OverlayNodeKind, number> = {
  unlock: RAMP.earth[4],
  tune: RAMP.violet[4],
};

/**
 * Цвет подписи цены. Третье средство и третий признак — причина отказа.
 * Золото у нехватки — тот же тон, что у счёта в углу кадра, и связь
 * «не хватает ЭТОГО» читается без подписи.
 */
const COST_COLOR: Record<OverlayNodeStatus, number> = {
  open: RAMP.green[4],
  available: RAMP.gray[9],
  poor: RAMP.warm[4],
  blocked: RAMP.gray[5],
};

/** Связь из открытой предпосылки светлее: путь к далёкому узлу виден по линиям. */
const EDGE_DONE = RAMP.gray[7];
const EDGE_PENDING = RAMP.gray[4];

/** Кольцо выбора и кольцо наведения — РАЗНЫМИ цветами: они бывают на разных узлах. */
const SELECT_RING = RAMP.gray[9];
const HOVER_RING = RAMP.blue[5];

/**
 * Отступы панели от краёв кадра. Длины, а не доли: дерево читается с одного
 * расстояния независимо от того, насколько широк кадр.
 *
 * Нижний отступ ВЫВЕДЕН из низа кадра: под панелью обязаны помещаться панель
 * действий и строки над ней, иначе оверлей ложится поверх них и закрытие меню
 * оказывается единственным способом узнать, что в инвентаре.
 */
const MARGIN_X = 24;
const MARGIN_Y = 14;
const MARGIN_BOTTOM = 56;
/** Внутреннее поле панели. */
const PAD = 6;

export interface TechTreeLayout {
  /** Подложка оверлея. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Левый верхний угол узла в колонке 0, строке 0. */
  readonly originX: number;
  readonly originY: number;
  readonly node: number;
  readonly colStep: number;
  readonly rowStep: number;
  /** Свободное место под сетку. Публично ради проверки помещаемости дерева. */
  readonly fieldW: number;
  readonly fieldH: number;
}

/** Размер сетки в пикселях по её габаритам в узлах. */
export function techTreeSize(cols: number, rows: number): { w: number; h: number } {
  return {
    w: cols > 0 ? (cols - 1) * TECH_TREE.colStep + TECH_TREE.node : 0,
    // Высота считается ПО УЗЛАМ, без подписи цены под последней строкой:
    // подпись висит в просвете шага, и включать её значило бы завышать габарит
    // на пустое место.
    h: rows > 0 ? (rows - 1) * TECH_TREE.rowStep + TECH_TREE.node : 0,
  };
}

/**
 * Панель и начало сетки. Сетка ЦЕНТРИРУЕТСЯ в свободной части панели — между
 * заголовком со счётом и строкой подсказки управления.
 *
 * @param cols,rows габариты сетки в узлах: их знает раскладка графа, не рендер
 */
export function techTreeLayout(
  viewW: number,
  viewH: number,
  cols: number,
  rows: number,
): TechTreeLayout {
  const x = MARGIN_X;
  const y = MARGIN_Y;
  const w = viewW - 2 * MARGIN_X;
  const h = viewH - MARGIN_BOTTOM;

  const headerH = LINE_H + 2;
  // Полоса сведений внизу панели: она заменила плавающую подсказку у узла,
  // поэтому место под неё отрезается от поля дерева, а не берётся поверх него.
  const footerH = TECH_TREE.infoLines * LINE_H + 2;
  const size = techTreeSize(cols, rows);
  const fieldX = x + PAD;
  const fieldY = y + PAD + headerH;
  const fieldW = w - 2 * PAD;
  const fieldH = h - 2 * PAD - headerH - footerH;

  return {
    x,
    y,
    w,
    h,
    originX: fieldX + Math.max(0, (fieldW - size.w) >> 1),
    originY: fieldY + Math.max(0, (fieldH - size.h) >> 1),
    node: TECH_TREE.node,
    colStep: TECH_TREE.colStep,
    rowStep: TECH_TREE.rowStep,
    fieldW,
    fieldH,
  };
}

/** Левый верхний угол узла в пикселях. Одна формула на отрисовку и попадание. */
export function nodeOrigin(
  layout: TechTreeLayout,
  col: number,
  row: number,
): { x: number; y: number } {
  return {
    x: layout.originX + col * layout.colStep,
    y: layout.originY + row * layout.rowStep,
  };
}

/**
 * Номер узла под точкой, или `null`. Просвет между узлами — «мимо»: нажатие
 * туда не покупает ничего, иначе промах тратит счёт.
 */
export function nodeAtPoint(
  x: number,
  y: number,
  layout: TechTreeLayout,
  nodes: readonly { readonly col: number; readonly row: number }[],
): number | null {
  for (let i = 0; i < nodes.length; i++) {
    const at = nodeOrigin(layout, nodes[i]!.col, nodes[i]!.row);
    if (x >= at.x && x < at.x + layout.node && y >= at.y && y < at.y + layout.node) return i;
  }
  return null;
}

/** Габариты сетки узлов по самому снапшоту: рендер не знает таблицы технологий. */
export function gridOf(nodes: readonly { readonly col: number; readonly row: number }[]): {
  cols: number;
  rows: number;
} {
  let cols = 0;
  let rows = 0;
  for (const n of nodes) {
    if (n.col + 1 > cols) cols = n.col + 1;
    if (n.row + 1 > rows) rows = n.row + 1;
  }
  return { cols, rows };
}

/**
 * @param px буфер кадра — тот же, в который нарисован мир
 * @param viewW,viewH размер кадра: панель растянута по нему, а не по константе
 */
export function drawResearchOverlay(
  px: Uint8ClampedArray,
  viewW: number,
  viewH: number,
  view: OverlayView,
): void {
  const { cols, rows } = gridOf(view.nodes);
  const layout = techTreeLayout(viewW, viewH, cols, rows);

  fillRect(px, viewW, viewH, layout.x, layout.y, layout.w, layout.h, RAMP.gray[1]);
  strokeRect(px, viewW, viewH, layout.x, layout.y, layout.w, layout.h, RAMP.gray[4]);

  const left = layout.x + PAD;
  const right = layout.x + layout.w - PAD;

  drawText(px, viewW, viewH, 'ИССЛЕДОВАНИЯ', left, layout.y + PAD, RAMP.gray[9], false);
  // Счёт — тем же золотом, что и счётчик в углу кадра: одна валюта — один
  // цвет, где бы её ни показывали. Без счёта рядом цена узла не отвечает
  // на вопрос «могу ли я это купить».
  const credits = `${view.credits} ₡`;
  drawText(
    px,
    viewW,
    viewH,
    credits,
    right - textWidth(credits),
    layout.y + PAD,
    RAMP.warm[4],
    false,
  );

  drawEdges(px, viewW, viewH, layout, view);
  drawNodes(px, viewW, viewH, layout, view);

  // Полоса сведений — в СВОЁМ месте внизу панели, а не коробкой у узла.
  // Плавающая коробка закрывала соседние узлы и висела над деревом постоянно:
  // без мыши источником для неё был выбранный узел, и «временная» подсказка
  // оказывалась включённой всегда.
  //
  // Источник — наведённый узел, иначе выбранный: и мышь, и стрелки отвечают
  // на один вопрос и обязаны писать в одно место.
  drawInfoBar(px, viewW, viewH, layout, view.nodes[view.hovered ?? view.selected]);

  // Курсор — САМЫМ последним, поверх подсказки: он указатель, и заслонять его
  // не имеет права ничто. Мировой прицел сюда не доживает — подложка панели
  // непрозрачна и накрывает его целиком.
  drawPointer(px, viewW, viewH, view.pointerX, view.pointerY);
}

/**
 * Курсор меню — стрелка, а не крестик мира.
 *
 * Другая форма намеренно: крестик означает «инструмент ударит сюда», а в меню
 * инструмент не применяется вовсе. Одинаковая форма обещала бы действие,
 * которого нет.
 *
 * Своя палитра: самый светлый тон на самом тёмном контуре — курсор обязан
 * читаться и на подложке панели, и на светлой подложке доступного узла,
 * и поверх подсказки.
 */
const POINTER_PALETTE = [RAMP.gray[0], RAMP.gray[9], RAMP.gray[0]];

function drawPointer(
  px: Uint8ClampedArray,
  viewW: number,
  viewH: number,
  x: number,
  y: number,
): void {
  // Остриё стрелки совпадает с точкой попадания: рисунок висит вправо-вниз
  // от неё, как и положено курсору, — иначе он указывал бы мимо того узла,
  // который считает `nodeAtPoint`.
  blit(
    px,
    viewW,
    viewH,
    POINTER,
    POINTER_W,
    POINTER_H,
    Math.round(x),
    Math.round(y),
    POINTER_PALETTE,
  );
}

/**
 * Связи коленом: от правого края предпосылки до середины просвета, по вертикали
 * до строки цели, и до её левого края. Диагональ дала бы лесенку, которую нечем
 * сгладить, — сглаживание в проекте запрещено целиком.
 *
 * Рисуются ДО узлов: колено, прошедшее через чужой узел, окажется под ним,
 * а не поверх.
 */
function drawEdges(
  px: Uint8ClampedArray,
  viewW: number,
  viewH: number,
  layout: TechTreeLayout,
  view: OverlayView,
): void {
  const half = layout.node >> 1;
  for (const edge of view.edges) {
    const from = view.nodes[edge.from];
    const to = view.nodes[edge.to];
    if (!from || !to) continue;

    const a = nodeOrigin(layout, from.col, from.row);
    const b = nodeOrigin(layout, to.col, to.row);
    const x0 = a.x + layout.node;
    const y0 = a.y + half;
    const x1 = b.x - 1;
    const y1 = b.y + half;
    const mid = (x0 + x1) >> 1;

    const color = from.status === 'open' ? EDGE_DONE : EDGE_PENDING;
    hLine(px, viewW, viewH, x0, mid, y0, color);
    vLine(px, viewW, viewH, mid, y0, y1, color);
    hLine(px, viewW, viewH, mid, x1, y1, color);
  }
}

function drawNodes(
  px: Uint8ClampedArray,
  viewW: number,
  viewH: number,
  layout: TechTreeLayout,
  view: OverlayView,
): void {
  const size = layout.node;
  for (let i = 0; i < view.nodes.length; i++) {
    const node = view.nodes[i]!;
    const at = nodeOrigin(layout, node.col, node.row);

    fillRect(px, viewW, viewH, at.x, at.y, size, size, NODE_FILL[node.status]);
    strokeRect(px, viewW, viewH, at.x, at.y, size, size, NODE_EDGE[node.kind]);
    blit(
      px,
      viewW,
      viewH,
      techIcon(node.icon),
      TECH_ICON,
      TECH_ICON,
      at.x + ((size - TECH_ICON) >> 1),
      at.y + ((size - TECH_ICON) >> 1),
      ICON_PALETTE,
    );

    // Название и цена — у КАЖДОГО узла и без наведения. Значок отвечает «что
    // это» намёком, название — словами, цена — «на что мне хватает»; последний
    // вопрос задаётся ко всему дереву сразу, а не к одному узлу.
    //
    // Подпись ШИРЕ узла и центрирована по нему: шаг колонки выведен из самого
    // длинного имени таблицы, поэтому подписи соседей не сходятся.
    const label = node.name;
    drawText(
      px,
      viewW,
      viewH,
      label,
      at.x + ((size - textWidth(label)) >> 1),
      at.y + size + TECH_TREE.labelGap,
      i === view.selected ? RAMP.gray[9] : RAMP.gray[7],
      false,
    );

    const cost = node.status === 'open' ? 'открыта' : `${node.cost} ₡`;
    drawText(
      px,
      viewW,
      viewH,
      cost,
      at.x + ((size - textWidth(cost)) >> 1),
      at.y + size + TECH_TREE.labelGap + LINE_H,
      COST_COLOR[node.status],
      false,
    );

    // Кольца СНАРУЖИ узла: рамка внутри занята видом эффекта, и выделение
    // поверх неё стирало бы признак типа у выбранного узла.
    if (i === view.selected) {
      strokeRect(px, viewW, viewH, at.x - 2, at.y - 2, size + 4, size + 4, SELECT_RING);
    }
    if (i === view.hovered) {
      strokeRect(px, viewW, viewH, at.x - 1, at.y - 1, size + 2, size + 2, HOVER_RING);
    }
  }
}

/**
 * Полоса сведений внизу панели: всё, что не помещается на узел.
 *
 * Место ПОСТОЯННОЕ, а не у узла: коробка, всплывающая рядом с ним, закрывает
 * соседей и связи — то есть ровно то, ради чего дерево и рисуется графом.
 * Здесь же она никому не мешает и не прыгает по кадру вместе с выбором.
 *
 * Пишут в неё и мышь, и стрелки: вопрос «что это и что с этим делать» один,
 * и два разных места для одного ответа игрок читал бы как два разных ответа.
 *
 * Строка управления — часть полосы: она стоит на её последней строке, и место
 * под неё отведено тем же расчётом.
 */
function drawInfoBar(
  px: Uint8ClampedArray,
  viewW: number,
  viewH: number,
  layout: TechTreeLayout,
  node: OverlayNode | undefined,
): void {
  const left = layout.x + PAD;
  const right = layout.x + layout.w - PAD;
  const top = layout.y + layout.h - PAD - TECH_TREE.infoLines * LINE_H;

  // Отбивка сверху: без неё подписи нижнего ряда узлов сливаются со сведениями.
  hLine(px, viewW, viewH, left, right - 1, top - 3, RAMP.gray[3]);

  if (node) {
    drawText(px, viewW, viewH, node.name, left, top, RAMP.gray[9], false);
    const cost = node.status === 'open' ? 'открыта' : `${node.cost} ₡`;
    drawText(px, viewW, viewH, cost, right - textWidth(cost), top, COST_COLOR[node.status], false);
    drawText(px, viewW, viewH, node.description, left, top + LINE_H, RAMP.gray[7], false);
    // Применение — то, ради чего полоса и заведена: «что это» отвечает
    // название на узле, «что с этим делать» не отвечает ничто другое.
    drawText(px, viewW, viewH, node.usage, left, top + 2 * LINE_H, RAMP.gray[6], false);
    if (node.note) {
      drawText(px, viewW, viewH, node.note, left, top + 3 * LINE_H, COST_COLOR[node.status], false);
    }
  }

  drawText(
    px,
    viewW,
    viewH,
    'WASD — выбор   Space — купить   T — закрыть',
    left,
    top + 4 * LINE_H,
    RAMP.gray[5],
    false,
  );
}
