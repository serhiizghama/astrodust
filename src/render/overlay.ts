import { TECH_TREE, UI } from '../config';
import { RAMP, css } from '../palette';
import { fitText, bodyText, smallText, titleText, OVERLAY_PLATE } from './ui';
import type { TextStyle, PanelStyle, UiSurface } from './ui';
import { CREDITS_TONE, drawCredits, measureCredits } from './credits';
import { TECH_ICON, techIcon, POINTER, CLOSE, CLOSE_ICON } from './sprites/icons';
import type { TechNote } from '../progress';

/**
 * Дерево технологий поверх кадра. Рисуется в СЛОЕ ИНТЕРФЕЙСА — векторно и в
 * разрешении устройства, а не в сетке мирового кадра: это экран, где текста
 * больше всего, и рубленые буквы стоят здесь дороже всего.
 *
 * Раскладка при этом считается в ЯЧЕЙКАХ КАДРА, как и вся остальная геометрия
 * интерфейса: дерево, помещавшееся в опорный кадр, обязано помещаться в любой.
 *
 * Подложка почти непрозрачна: под ней читают текст, и мир, просвечивающий
 * сквозь неё, ложился бы на буквы узором. Поэтому же надписи внутри панели
 * идут БЕЗ ореола — контраст даёт сама подложка.
 *
 * Дерево — ГРАФ, а не список: список отвечает «что можно купить сейчас»,
 * но не отвечает, что за чем стоит и куда ведёт развитие.
 *
 * Счёт, цены и недостающая сумма набраны общим видом денег (`credits.ts`) —
 * тем же, что и счётчик в углу кадра: оверлей открыт поверх него, и второе
 * обозначение тех же денег читалось бы как вторая валюта.
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
   * Причина недоступности: нехватка с суммой или неоткрытые предпосылки.
   *
   * Значением, а не строкой: слова и обозначение суммы выбирает рендер —
   * сумма обязана быть нарисована тем же видом, что и счёт в углу кадра,
   * а из готовой строки значок валюты уже не достать.
   *
   * Называется она словами, а не только цветом: цвет отвечает «нельзя»
   * и не отвечает «почему», а причины требуют разных действий — «не хватает
   * кредитов» лечится работой, «закрыта предпосылкой» другой покупкой.
   */
  readonly note: TechNote;
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
  /** Наведён ли курсор на крестик: кнопка без отклика неотличима от рисунка. */
  readonly closeHovered: boolean;
  /**
   * Курсор в координатах буфера кадра.
   *
   * Поля ОБЯЗАТЕЛЬНЫЕ, а не с умолчанием: подложка оверлея накрывает мировой
   * прицел целиком, поэтому меню обязано рисовать курсор само. Забывчивость
   * здесь стоит ровно того, чем она уже обошлась однажды, — меню без единого
   * признака того, где мышь.
   */
  readonly pointerX: number;
  readonly pointerY: number;
}

/**
 * Заливка узла по состоянию покупки.
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
 * Обводка узла по виду эффекта. ДРУГОЕ средство, чем заливка, потому что
 * признак другой: закрытая предпосылкой постройка и закрытый предпосылкой
 * навык обязаны различаться, и различие должно выживать в любом состоянии
 * покупки.
 *
 * Ни земля, ни фиалка не совпадают с золотом счёта: обводка — не цена.
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
const EDGE_DONE = css(RAMP.gray[7]);
const EDGE_PENDING = css(RAMP.gray[4], UI.alpha.edge);

/**
 * Свечение выбора и свечение наведения — РАЗНЫМИ цветами: они бывают на разных
 * узлах сразу. Свечением, а не обводкой: цвет обводки занят видом эффекта,
 * и пометка поверх стирала бы признак типа у выбранного узла.
 */
const SELECT_GLOW = css(RAMP.gray[9], UI.alpha.glow);
const HOVER_GLOW = css(RAMP.blue[5], UI.alpha.glow);

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
/** Просвет между подписями соседних колонок. */
const LABEL_GAP = 6;

/** Состояние вместо цены: с купленной технологии денег больше не берут. */
const OPEN_LABEL = 'открыта';
/** Слова причины. Сумму к первой дописывает общий вид суммы, а не эта строка. */
const NOTE_SHORT = 'нужно ещё';
const NOTE_LOCKED = 'требует: ';

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

/** Размер сетки в ячейках по её габаритам в узлах. */
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

  const headerH = UI.line + 2;
  // Полоса сведений внизу панели: она заменила плавающую подсказку у узла,
  // поэтому место под неё отрезается от поля дерева, а не берётся поверх него.
  const footerH = TECH_TREE.infoLines * UI.line + 2;
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

/** Левый верхний угол узла в ячейках. Одна формула на отрисовку и попадание. */
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

/**
 * Кнопка закрытия: правый верхний угол панели, ряд заголовка.
 *
 * Сторона равна высоте этого ряда, поэтому кнопка ничего в раскладке не двигает
 * (см. `TECH_TREE.close`). Отсюда её берут и отрисовка, и попадание курсора:
 * вторая запись одной геометрии дала бы кнопку, нажимающуюся не там, где она
 * нарисована.
 */
export function closeButtonRect(layout: TechTreeLayout): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const size = TECH_TREE.close;
  return { x: layout.x + layout.w - PAD - size, y: layout.y + PAD, w: size, h: size };
}

/** Попал ли курсор в кнопку закрытия. */
export function overClose(x: number, y: number, layout: TechTreeLayout): boolean {
  const at = closeButtonRect(layout);
  return x >= at.x && x < at.x + at.w && y >= at.y && y < at.y + at.h;
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
 * @param ui поверхность слоя интерфейса — та же, на которой нарисована панель
 * @param viewW,viewH размер кадра: панель растянута по нему, а не по константе
 */
export function drawResearchOverlay(
  ui: UiSurface,
  viewW: number,
  viewH: number,
  view: OverlayView,
): void {
  const { cols, rows } = gridOf(view.nodes);
  const layout = techTreeLayout(viewW, viewH, cols, rows);

  ui.panel(layout.x, layout.y, layout.w, layout.h, OVERLAY_PLATE);

  const left = layout.x + PAD;

  ui.text('ИССЛЕДОВАНИЯ', left, layout.y + PAD, titleText(RAMP.gray[9]));
  drawCloseButton(ui, layout, view.closeHovered);
  // Счёт — общим видом суммы, тем же, что и счётчик в углу кадра: оверлей
  // открыт ПОВЕРХ него, оба видны разом, и второе обозначение одних и тех же
  // денег игрок читал бы как вторую валюту. Без счёта рядом цена узла
  // не отвечает на вопрос «могу ли я это купить».
  //
  // Правый край счёта — левый край кнопки с просветом: заголовок делят двое,
  // и счёт, отсчитанный от края панели, лежал бы под крестиком.
  drawCredits(
    ui,
    view.credits,
    closeButtonRect(layout).x - TECH_TREE.closeGap,
    layout.y + PAD,
    titleText(CREDITS_TONE, { align: 'right' }),
  );

  drawEdges(ui, layout, view);
  drawNodes(ui, layout, view);

  // Полоса сведений — в СВОЁМ месте внизу панели, а не коробкой у узла.
  // Плавающая коробка закрывала соседние узлы и висела над деревом постоянно:
  // без мыши источником для неё был выбранный узел, и «временная» подсказка
  // оказывалась включённой всегда.
  //
  // Источник — наведённый узел, иначе выбранный: и мышь, и стрелки отвечают
  // на один вопрос и обязаны писать в одно место.
  drawInfoBar(ui, layout, view.nodes[view.hovered ?? view.selected]);

  // Курсор — САМЫМ последним, поверх подсказки: он указатель, и заслонять его
  // не имеет права ничто. Мировой прицел сюда не доживает — подложка панели
  // накрывает его целиком.
  //
  // Остриё стрелки совпадает с точкой попадания: рисунок висит вправо-вниз
  // от неё, как и положено курсору, — иначе он указывал бы мимо того узла,
  // который считает `nodeAtPoint`.
  ui.icon(POINTER, Math.round(view.pointerX), Math.round(view.pointerY));
}

/**
 * Крестик закрытия. Наведение — тем же голубым свечением, что и у узлов:
 * «мышь здесь» в меню означает одно и то же, где бы курсор ни стоял.
 */
function drawCloseButton(ui: UiSurface, layout: TechTreeLayout, hovered: boolean): void {
  const at = closeButtonRect(layout);
  ui.panel(at.x, at.y, at.w, at.h, {
    fill: css(RAMP.gray[hovered ? 4 : 2]),
    stroke: css(RAMP.gray[5]),
    strokeWidth: hovered ? UI.stroke.thick : UI.stroke.thin,
    radius: UI.radius.slot,
    ...(hovered ? { glow: HOVER_GLOW } : {}),
  });
  ui.icon(CLOSE, at.x + ((at.w - CLOSE_ICON) >> 1), at.y + ((at.h - CLOSE_ICON) >> 1));
}

/**
 * Связи коленом: от правого края предпосылки до середины просвета, по вертикали
 * до строки цели, и до её левого края. Поворот СКРУГЛЁН, линия сглажена —
 * лесенки на ней не бывает ни при каком размере окна.
 *
 * Рисуются ДО узлов: колено, прошедшее через чужой узел, окажется под ним,
 * а не поверх.
 */
function drawEdges(ui: UiSurface, layout: TechTreeLayout, view: OverlayView): void {
  const half = layout.node / 2;
  for (const edge of view.edges) {
    const from = view.nodes[edge.from];
    const to = view.nodes[edge.to];
    if (!from || !to) continue;

    const a = nodeOrigin(layout, from.col, from.row);
    const b = nodeOrigin(layout, to.col, to.row);
    const x0 = a.x + layout.node;
    const y0 = a.y + half;
    const x1 = b.x;
    const y1 = b.y + half;
    const mid = (x0 + x1) / 2;

    ui.line(
      [
        { x: x0, y: y0 },
        { x: mid, y: y0 },
        { x: mid, y: y1 },
        { x: x1, y: y1 },
      ],
      {
        color: from.status === 'open' ? EDGE_DONE : EDGE_PENDING,
        width: UI.stroke.thin,
        radius: UI.radius.node,
      },
    );
  }
}

/**
 * Вид узла: заливка — состояние покупки, обводка — вид эффекта, свечение —
 * выбор или наведение. Три средства на три независимых признака.
 */
function nodeStyle(node: OverlayNode, selected: boolean, hovered: boolean): PanelStyle {
  const glow = hovered ? HOVER_GLOW : selected ? SELECT_GLOW : undefined;
  return {
    fill: css(NODE_FILL[node.status]),
    stroke: css(NODE_EDGE[node.kind]),
    strokeWidth: glow ? UI.stroke.thick : UI.stroke.thin,
    radius: UI.radius.node,
    shadow: true,
    ...(glow ? { glow } : {}),
  };
}

function drawNodes(ui: UiSurface, layout: TechTreeLayout, view: OverlayView): void {
  const size = layout.node;
  for (let i = 0; i < view.nodes.length; i++) {
    const node = view.nodes[i]!;
    const at = nodeOrigin(layout, node.col, node.row);

    ui.panel(at.x, at.y, size, size, nodeStyle(node, i === view.selected, i === view.hovered));
    ui.icon(
      techIcon(node.icon),
      at.x + ((size - TECH_ICON) >> 1),
      at.y + ((size - TECH_ICON) >> 1),
    );

    // Название и цена — у КАЖДОГО узла и без наведения. Значок отвечает «что
    // это» намёком, название — словами, цена — «на что мне хватает»; последний
    // вопрос задаётся ко всему дереву сразу, а не к одному узлу.
    //
    // Подпись ШИРЕ узла и центрирована по нему, но в шаг колонки обязана
    // помещаться: не поместившаяся обрезается многоточием. Ширину задаёт
    // системный шрифт, и заранее она не известна.
    const center = at.x + size / 2;
    const room = layout.colStep - LABEL_GAP;

    const nameStyle = bodyText(i === view.selected ? RAMP.gray[9] : RAMP.gray[7], {
      align: 'center',
    });
    ui.text(
      fitText(ui, node.name, nameStyle, room),
      center,
      at.y + size + TECH_TREE.labelGap,
      nameStyle,
    );

    // «Открыта» — состояние, а не сумма: денег с купленной технологии больше
    // не берут, и значок валюты рядом с этим словом обещал бы трату.
    const costStyle = smallText(COST_COLOR[node.status], { align: 'center' });
    const costY = at.y + size + TECH_TREE.labelGap + UI.line;
    if (node.status === 'open') {
      ui.text(fitText(ui, OPEN_LABEL, costStyle, room), center, costY, costStyle);
    } else {
      drawCredits(ui, node.cost, center, costY, costStyle);
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
function drawInfoBar(ui: UiSurface, layout: TechTreeLayout, node: OverlayNode | undefined): void {
  const left = layout.x + PAD;
  const right = layout.x + layout.w - PAD;
  const top = layout.y + layout.h - PAD - TECH_TREE.infoLines * UI.line;
  const room = right - left;

  // Отбивка сверху: без неё подписи нижнего ряда узлов сливаются со сведениями.
  ui.line(
    [
      { x: left, y: top - 3 },
      { x: right, y: top - 3 },
    ],
    { color: css(RAMP.gray[3]), width: UI.stroke.thin },
  );

  if (node) {
    ui.text(node.name, left, top, bodyText(RAMP.gray[9], { weight: 'bold' }));
    const costStyle = bodyText(COST_COLOR[node.status], { align: 'right' });
    if (node.status === 'open') ui.text(OPEN_LABEL, right, top, costStyle);
    else drawCredits(ui, node.cost, right, top, costStyle);

    const description = bodyText(RAMP.gray[7]);
    ui.text(fitText(ui, node.description, description, room), left, top + UI.line, description);

    // Применение — то, ради чего полоса и заведена: «что это» отвечает
    // название на узле, «что с этим делать» не отвечает ничто другое.
    const usage = bodyText(RAMP.gray[6]);
    ui.text(fitText(ui, node.usage, usage, room), left, top + 2 * UI.line, usage);

    drawNote(ui, node, left, top + 3 * UI.line, room);
  }

  // Названы только КЛАВИАТУРНЫЕ способы закрытия: крестик виден сам, и подпись
  // к видимой кнопке — это место, отнятое у сведений об узле.
  const hint = smallText(RAMP.gray[5]);
  ui.text(
    fitText(ui, 'WASD — выбор   Space — купить   T или Esc — закрыть', hint, room),
    left,
    top + 4 * UI.line,
    hint,
  );
}

/**
 * Причина недоступности: слова из рендера и сумма общим видом.
 *
 * Обрезается СЛОВО, а не сумма: сумма — то, ради чего строка и написана,
 * и «нужно ещё …» без числа не отвечает ни на что. Просвет между ними —
 * измеренный пробел этого же кегля, а не своя константа.
 */
function drawNote(ui: UiSurface, node: OverlayNode, left: number, y: number, room: number): void {
  const style: TextStyle = bodyText(COST_COLOR[node.status]);
  if (node.note.kind === 'short') {
    const sum = measureCredits(ui, node.note.amount, style);
    const gap = ui.measure(' ', style);
    const words = fitText(ui, NOTE_SHORT, style, room - sum - gap);
    ui.text(words, left, y, style);
    drawCredits(ui, node.note.amount, left + ui.measure(words, style) + gap, y, style);
  } else if (node.note.kind === 'locked') {
    ui.text(fitText(ui, NOTE_LOCKED + node.note.missing.join(', '), style, room), left, y, style);
  }
}
