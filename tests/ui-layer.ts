/**
 * Слой интерфейса: типографика, подгонка строк и единый вид подложек.
 *
 * Проверяется ЖУРНАЛ поверхности, а не пиксели: слой векторный, канваса
 * в прогоне нет, и «что нарисовано, где, каким цветом и каким кеглем»
 * читается только отсюда. Внешний вид — цвет, тень, сглаживание — судится
 * снимком в браузере (`npm run shot:ui`), и заменить одно другим нельзя.
 */
import {
  Camera,
  Renderer,
  RecordingSurface,
  drawResearchOverlay,
  closeButtonRect,
  techTreeLayout,
  fitText,
  bodyText,
  smallText,
  titleText,
  hudLayout,
} from '../src/render';
import type { HudState, OverlayView, OverlayNode, TextStyle, UiOp } from '../src/render';
import type { Display } from '../src/core';
import { Player } from '../src/entities';
import { RAMP } from '../src/palette';
import { UI, BASE_VIEW_W, BASE_VIEW_H, WORLD_SEED } from '../src/config';
import { TECHNOLOGIES, TECH_NODES, TECH_EDGES, TECH_COLS, TECH_ROWS } from '../src/progress';
import { check, luna, IDLE_HUD, pick } from './harness';

const first = luna();
const { spawn } = first;

/** Все цвета набора одним списком: любой цвет интерфейса обязан быть отсюда. */
const PALETTE = new Set<number>(Object.values(RAMP).flatMap((family) => [...family]));

/** Непрозрачная составляющая цвета канваса как число палитры. */
function opaqueOf(color: string): number | null {
  const m = /^rgba\((\d+),(\d+),(\d+),/.exec(color);
  if (!m) return null;
  return (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]);
}

// --- Кадр интерфейса целиком: панель, счётчик, строки, оверлей -----------------

const ui = new RecordingSurface();

function overlayView(over: Partial<OverlayView> = {}): OverlayView {
  const nodes: OverlayNode[] = TECHNOLOGIES.map((tc, i) => ({
    name: tc.name,
    description: tc.description,
    cost: tc.cost,
    usage: tc.usage,
    status: (['open', 'available', 'poor', 'blocked'] as const)[i % 4]!,
    kind: tc.effect.kind,
    icon: tc.icon,
    col: TECH_NODES[i]!.col,
    row: TECH_NODES[i]!.row,
    note: 'нужно ещё 7 ₡',
  }));
  return {
    credits: 1234,
    nodes,
    edges: TECH_EDGES,
    selected: 0,
    hovered: 2,
    closeHovered: false,
    pointerX: 100,
    pointerY: 100,
    ...over,
  };
}

/**
 * Два кадра: постоянный интерфейс поверх мира и он же с открытым оверлеем.
 * Раздельно потому, что надпись на подложке оверлея и надпись прямо на мире
 * живут по разным правилам читаемости.
 */
const [hudFrame, frame]: UiOp[][] = (() => {
  const pixels = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
  const display = {
    pixels,
    ctx: { putImageData() {} },
    width: BASE_VIEW_W,
    height: BASE_VIEW_H,
    image: {},
    present() {},
  } as unknown as Display;

  const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED, ui);
  const camera = new Camera(first.world.width, first.world.height);
  camera.snapTo(spawn.x, spawn.y);
  const hud: HudState = {
    ...IDLE_HUD,
    activeSlot: 1,
    hoveredSlot: 2,
    carried: [{ name: 'Пульпа', count: 138 }],
    used: 138,
    credits: 1234,
    buildKind: 'Сепаратор',
    buildIssue: 'нет опоры',
  };
  renderer.render({
    camera: camera,
    player: new Player(spawn.x, spawn.y),
    crosshairX: 160,
    crosshairY: 90,
    crosshairInReach: true,
    hud: hud,
    fps: 60,
  });
  const bare = [...ui.ops];
  // Оверлей — в тот же кадр: он часть того же слоя и обязан говорить тем же
  // языком, что и панель под ним.
  drawResearchOverlay(ui, BASE_VIEW_W, BASE_VIEW_H, overlayView());
  return [bare, [...ui.ops]];
})();

// --- Типографика ---------------------------------------------------------------

{
  const scale = new Set<number>(Object.values(UI.text));
  const off = pick(frame, 'text').filter((op) => !scale.has(op.style.size));
  check(
    'Кегли берутся из шкалы: другого кегля в кадре нет',
    off.length === 0,
    off.map((op) => `${op.text}: ${op.style.size}`).join(', ') ||
      `надписей ${pick(frame, 'text').length}, ступеней ${scale.size}`,
  );

  // Шкала — не меньше трёх ступеней, и все три в ходу: иерархия текста иначе
  // не читается, а одна ступень на весь интерфейс — это лист без заголовков.
  const used = new Set(pick(frame, 'text').map((op) => op.style.size));
  check(
    'В кадре в ходу все ступени шкалы',
    scale.size >= 3 && used.size === scale.size,
    `в шкале ${scale.size}, в кадре ${used.size}`,
  );

  // Строка состояния не имеет права занимать пятую часть экрана у игры.
  check(
    'Строка текста укладывается в десятую часть высоты опорного кадра',
    UI.line <= BASE_VIEW_H / 10 && UI.text.title <= UI.line,
    `строка ${UI.line}, кадр ${BASE_VIEW_H}`,
  );
}

{
  const empty = new RecordingSurface();
  empty.begin();
  empty.text('', 10, 10, bodyText(RAMP.gray[9]));
  check(
    'Пустая строка ничего не рисует и ничего не занимает',
    empty.ops.length === 0 && empty.measure('', bodyText(RAMP.gray[9])) === 0,
    `операций ${empty.ops.length}`,
  );
}

// --- Ширина измеряется, а не вычисляется ---------------------------------------

{
  const surface = new RecordingSurface();
  const style = bodyText(RAMP.gray[9]);
  const text = 'Название технологии подлиннее';
  const full = surface.measure(text, style);

  const cut = fitText(surface, text, style, full / 2);
  check(
    'Строка шире отведённого места обрезается многоточием и в место укладывается',
    cut.endsWith('…') && cut.length < text.length && surface.measure(cut, style) <= full / 2,
    `«${cut}» шириной ${surface.measure(cut, style).toFixed(1)} при запасе ${(full / 2).toFixed(1)}`,
  );
  check(
    'Помещающаяся строка не трогается',
    fitText(surface, text, style, full) === text && fitText(surface, '', style, 100) === '',
  );
  check('Места нет вовсе — не рисуется ничего', fitText(surface, text, style, 0) === '');
}

{
  // Выравнивание вправо: правый край на месте при любом числе знаков.
  const surface = new RecordingSurface();
  const style: TextStyle = bodyText(RAMP.warm[4], { align: 'right' });
  surface.begin();
  surface.text('7', 100, 0, style);
  surface.text('123456', 100, 0, style);
  const [short, long] = pick(surface.ops, 'text');
  check(
    'Выравнивание вправо держит правый край при смене числа знаков',
    short !== undefined &&
      long !== undefined &&
      Math.abs(short.x + short.width - 100) < 0.001 &&
      Math.abs(long.x + long.width - 100) < 0.001 &&
      long.x < short.x,
    `${short?.x.toFixed(1)} и ${long?.x.toFixed(1)}`,
  );
}

{
  // Центрирование не зависит от метрик шрифта: на чужой машине буквы шире,
  // и надпись обязана остаться по центру, а не съехать на разницу метрик.
  const style = bodyText(RAMP.gray[9], { align: 'center' });
  const centres = [0.55, 0.8].map((advance) => {
    const surface = new RecordingSurface(advance);
    surface.begin();
    surface.text('ИССЛЕДОВАНИЯ', 320, 0, style);
    const op = pick(surface.ops, 'text')[0]!;
    return op.x + op.width / 2;
  });
  check(
    'Центрирование не зависит от метрик шрифта',
    centres.every((c) => Math.abs(c - 320) < 0.001),
    centres.map((c) => c.toFixed(2)).join(' и '),
  );
}

// --- Единый вид подложек -------------------------------------------------------

{
  const radii = new Set<number>(Object.values(UI.radius));
  const strokes = new Set<number>(Object.values(UI.stroke));
  const panels = pick(frame, 'panel');
  const offRadius = panels.filter((op) => !radii.has(op.style.radius));
  const offStroke = panels.filter(
    (op) => op.style.strokeWidth !== undefined && !strokes.has(op.style.strokeWidth),
  );
  check(
    'Все подложки берут скругление и обводку из общего набора токенов',
    panels.length > 0 && offRadius.length === 0 && offStroke.length === 0,
    `подложек ${panels.length}, вне набора: скруглений ${offRadius.length}, обводок ${offStroke.length}`,
  );

  const lines = pick(frame, 'line');
  const offWidth = lines.filter((op) => !strokes.has(op.style.width));
  check(
    'Линии берут толщину из того же набора',
    lines.length > 0 && offWidth.length === 0,
    `линий ${lines.length}, вне набора ${offWidth.length}`,
  );

  // Тень есть у КРУПНЫХ подложек — панели, оверлея, узлов: она отделяет их
  // от мира. У подложки внутри панели тени нет: тень на тени читается грязью.
  check(
    'Крупные подложки отброшены тенью',
    panels.some((op) => op.style.shadow === true),
    `с тенью ${panels.filter((op) => op.style.shadow).length} из ${panels.length}`,
  );
}

{
  // Цвет интерфейса — цвет набора с прозрачностью. Записанный руками
  // `rgba(...)` теряет связь с лестницей, и перекраска палитры его не достаёт.
  const colors = [
    ...pick(frame, 'text').map((op) => op.style.color),
    ...pick(frame, 'panel').flatMap((op) => [
      op.style.fill,
      op.style.fillBottom,
      op.style.stroke,
      op.style.glow,
    ]),
    ...pick(frame, 'line').map((op) => op.style.color),
  ].filter((c): c is string => c !== undefined);
  const foreign = colors.filter((c) => {
    const opaque = opaqueOf(c);
    return opaque === null || !PALETTE.has(opaque);
  });
  check(
    'Каждый цвет интерфейса выведен из палитры, а отличие — только прозрачность',
    colors.length > 0 && foreign.length === 0,
    foreign.slice(0, 3).join(' ') || `цветов ${colors.length}`,
  );
}

{
  // Ореол под текстом — у надписей ПРЯМО НА МИРЕ, и его нет у надписей
  // на собственной подложке: контраст там даёт она.
  const layout = hudLayout(BASE_VIEW_W, BASE_VIEW_H);
  // Надписи поверх мира: счётчик в углу, строки над панелью, диагностика.
  const overWorld = pick(hudFrame, 'text').filter(
    (op) => op.y < layout.slotY || op.y >= layout.slotY + layout.slotSize,
  );
  const insideBar = pick(hudFrame, 'text').filter(
    (op) => op.y >= layout.slotY && op.y < layout.slotY + layout.slotSize,
  );
  check(
    'Надпись на мире идёт с ореолом, надпись на подложке — без него',
    overWorld.length > 0 &&
      overWorld.every((op) => op.style.shadow === true) &&
      insideBar.length > 0 &&
      insideBar.every((op) => !op.style.shadow),
    `на мире ${overWorld.length}, на подложке ${insideBar.length}`,
  );
}

// --- Крестик закрытия ----------------------------------------------------------

{
  const at = closeButtonRect(techTreeLayout(BASE_VIEW_W, BASE_VIEW_H, TECH_COLS, TECH_ROWS));

  check(
    'Крестик нарисован в заголовке оверлея',
    pick(frame, 'icon').some((op) => op.key === 'close') &&
      pick(frame, 'panel').some((op) => op.x === at.x && op.y === at.y),
  );

  // Счёт кредитов делит ряд заголовка с кнопкой. Правый край счёта считается
  // по ИЗМЕРЕННОЙ ширине: шрифт системный, и число, влезающее здесь, на другой
  // машине наехало бы на крестик.
  const credits = pick(frame, 'text').find((op) => op.text.includes('₡') && op.y < at.y + at.h);
  check(
    'Счёт кредитов не наезжает на кнопку закрытия',
    credits !== undefined && credits.x + credits.width <= at.x,
    credits
      ? `правый край ${(credits.x + credits.width).toFixed(1)} при кнопке с ${at.x}`
      : 'счёта в заголовке нет',
  );

  // Наведение обязано быть ВИДНО: кнопка, не отвечающая на курсор, неотличима
  // от рисунка.
  const button = (view: OverlayView) => {
    const surface = new RecordingSurface();
    surface.begin();
    drawResearchOverlay(surface, BASE_VIEW_W, BASE_VIEW_H, view);
    surface.end();
    return pick(surface.ops, 'panel').find((op) => op.x === at.x && op.y === at.y);
  };
  const idle = button(overlayView());
  const hot = button(overlayView({ closeHovered: true }));
  check(
    'Наведение на крестик меняет его вид',
    idle !== undefined && hot !== undefined && JSON.stringify(idle) !== JSON.stringify(hot),
  );
}

// --- Воспроизводимость ---------------------------------------------------------

{
  const style = bodyText(RAMP.gray[9]);
  const a = new RecordingSurface();
  const b = new RecordingSurface();
  for (const surface of [a, b]) {
    surface.begin();
    surface.text('Раскладка', 10, 20, style);
    surface.text('одна и та же', 10, 30, bodyText(RAMP.gray[7], { align: 'center' }));
  }
  check(
    'Одинаковые метрики дают совпадающую раскладку',
    JSON.stringify(a.ops) === JSON.stringify(b.ops),
  );

  // Разные метрики дают разную раскладку — иначе первая проверка ничего
  // не значит: она прошла бы и на метрике, которая всегда возвращает ноль.
  const wide = new RecordingSurface(0.9);
  wide.begin();
  wide.text('Раскладка', 10, 20, style);
  check(
    'Другие метрики дают другую ширину',
    pick(wide.ops, 'text')[0]!.width > pick(a.ops, 'text')[0]!.width,
  );

  // Стили заголовка, основного текста и мелкого различаются кеглем — иначе
  // шкала есть только на словах.
  const sizes = [smallText(RAMP.gray[9]), bodyText(RAMP.gray[9]), titleText(RAMP.gray[9])].map(
    (s) => s.size,
  );
  check(
    'Ступени шкалы идут по возрастанию и не совпадают',
    sizes[0]! < sizes[1]! && sizes[1]! < sizes[2]!,
    sizes.join(' < '),
  );
}
