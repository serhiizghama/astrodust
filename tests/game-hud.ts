/**
 * Постоянный интерфейс: раскладка панели, попадание курсора, состояние выбора
 * и кадр.
 *
 * Раскладка и попадание — чистые функции над размером буфера, поэтому
 * проверяются напрямую. Кадр проверяется пикселями: интерфейс рисуется в буфер
 * наравне с миром, и «нарисовано ли» вопрос только к пикселям.
 */
import { Camera, Renderer, hudLayout, slotAtPoint, overBar, GLYPH_H } from '../src/render';
import type { HudState, HudLayout } from '../src/render';
import type { Display } from '../src/core';
import { ActionBarState, ToolMode } from '../src/core';
import { Player } from '../src/entities';
import { BASE_VIEW_W, BASE_VIEW_H, MAX_VIEW_W, MAX_VIEW_H, WORLD_SEED, HUD } from '../src/config';
import { check, luna, IDLE_HUD } from './harness';

const first = luna();
const { spawn } = first;

// --- Раскладка ---

{
  const layout = hudLayout(BASE_VIEW_W, BASE_VIEW_H);
  check(
    'Панель: десять слотов у нижнего края и по центру кадра',
    layout.slots === 10 &&
      layout.y + layout.h === BASE_VIEW_H - HUD.barBottom + HUD.barPad &&
      Math.abs(layout.x + layout.w / 2 - BASE_VIEW_W / 2) <= 1,
    `слотов ${layout.slots}, панель x=${layout.x} w=${layout.w}, низ ${layout.y + layout.h}`,
  );

  // Слот сохраняет размер В ПИКСЕЛЯХ при любом окне: панель, заданная долей,
  // на широком окне превратилась бы в полосу из растянутых слотов.
  const sizes = new Set<number>();
  const centered: boolean[] = [];
  for (const [w, h] of [
    [BASE_VIEW_W, BASE_VIEW_H],
    [MAX_VIEW_W, MAX_VIEW_H],
    [400, 240],
  ] as const) {
    const l = hudLayout(w, h);
    sizes.add(l.slotSize);
    centered.push(
      Math.abs(l.x + l.w / 2 - w / 2) <= 1 && l.y + l.h === h - HUD.barBottom + HUD.barPad,
    );
  }
  check(
    'Панель: размер слота не зависит от размера буфера, панель остаётся по центру',
    sizes.size === 1 && centered.every(Boolean),
    `размеров слота ${sizes.size}`,
  );

  // Счётчики валют стоят в противоположном от панели углу и пересечься с ней
  // не могут ни при каком буфере.
  const counterBottom = HUD.counterMargin + GLYPH_H * 2 + 6;
  const overlaps = [
    [BASE_VIEW_W, BASE_VIEW_H],
    [MAX_VIEW_W, MAX_VIEW_H],
    [400, 240],
  ].filter(([w, h]) => counterBottom >= hudLayout(w!, h!).y);
  check(
    'Панель: счётчики валют не пересекаются с панелью действий',
    overlaps.length === 0,
    `пересечений ${overlaps.length}`,
  );
}

// --- Попадание курсора ---

{
  const layout: HudLayout = hudLayout(BASE_VIEW_W, BASE_VIEW_H);
  const centerOf = (i: number): { x: number; y: number } => ({
    x: layout.slotX + i * layout.slotStep + (layout.slotSize >> 1),
    y: layout.slotY + (layout.slotSize >> 1),
  });

  let wrong = 0;
  for (let i = 0; i < layout.slots; i++) {
    const p = centerOf(i);
    if (slotAtPoint(p.x, p.y, layout) !== i) wrong++;
  }
  check('Панель: точка внутри слота даёт его номер', wrong === 0, `промахов ${wrong}`);

  // Зазор между слотами — «мимо»: слоты обязаны читаться раздельно, и клик
  // ровно между ними не должен молча доставаться соседу.
  const gapX = layout.slotX + layout.slotSize;
  check(
    'Панель: зазор между слотами и область вне панели дают «мимо»',
    slotAtPoint(gapX, layout.slotY + 2, layout) === null &&
      slotAtPoint(layout.slotX - 1, layout.slotY + 2, layout) === null &&
      slotAtPoint(layout.slotX + layout.slots * layout.slotStep, layout.slotY + 2, layout) ===
        null &&
      slotAtPoint(centerOf(3).x, layout.slotY - 1, layout) === null &&
      slotAtPoint(centerOf(3).x, layout.slotY + layout.slotSize, layout) === null,
  );

  // Мир не трогаем над ВСЕЙ панелью, а не только над слотом: промах в зазор
  // не должен копать дыру под ней.
  check(
    'Панель: признак «над панелью» покрывает и зазоры, и поля подложки',
    overBar(gapX, layout.slotY + 2, layout) &&
      overBar(layout.x, layout.y, layout) &&
      !overBar(layout.x - 1, layout.y, layout) &&
      !overBar(layout.x + layout.w, layout.y, layout) &&
      !overBar(centerOf(0).x, layout.y - 1, layout),
  );
}

// --- Состояние выбора ---

{
  const bar = new ActionBarState();
  check(
    'Слоты: копание, строительство, сбор — остальные пусты',
    bar.slots.length === HUD.slots &&
      bar.slots[0] === ToolMode.Dig &&
      bar.slots[1] === ToolMode.Build &&
      bar.slots[2] === ToolMode.Collect &&
      bar.slots.slice(3).every((s) => s === null),
    bar.slots.map((s) => (s === null ? '·' : s)).join(''),
  );

  // Прямой выбор — за ОДНО нажатие: перебор до третьего слота потребовал бы двух.
  bar.select(2);
  check('Слоты: прямой выбор за одно нажатие', bar.collecting && bar.activeSlot === 2);

  // Пустой слот активным не становится: инструмент, который «ничего не делает»,
  // неотличим от поломки.
  bar.select(7);
  check(
    'Слоты: пустой слот не становится активным',
    bar.collecting && bar.activeSlot === 2,
    `слот ${bar.activeSlot}`,
  );
  bar.select(-1);
  bar.select(HUD.slots);
  check('Слоты: номер за пределами ряда ничего не меняет', bar.activeSlot === 2);

  // Перебор идёт только по непустым и возвращается к началу.
  const filled = bar.slots.filter((s) => s !== null).length;
  bar.select(0);
  const visited: number[] = [];
  for (let i = 0; i < filled; i++) {
    bar.cycle();
    visited.push(bar.activeSlot);
  }
  check(
    'Слоты: перебор обходит пустые и возвращается к началу',
    bar.activeSlot === 0 &&
      visited.length === filled &&
      visited.every((s) => bar.slots[s] !== null),
    visited.join(' → '),
  );
}

// --- Кадр ---

{
  const pixels = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
  const display = {
    pixels,
    ctx: { putImageData() {} },
    width: BASE_VIEW_W,
    height: BASE_VIEW_H,
    image: {},
    present() {},
  } as unknown as Display;

  const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED);
  const camera = new Camera(first.world.width, first.world.height);
  camera.snapTo(spawn.x, spawn.y);
  const layout = hudLayout(BASE_VIEW_W, BASE_VIEW_H);

  function shoot(over: Partial<HudState> = {}, fps = 0): Uint8ClampedArray {
    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: { ...IDLE_HUD, ...over },
      fps,
    });
    return pixels.slice();
  }

  function colorAt(buf: Uint8ClampedArray, x: number, y: number): number {
    const i = (y * BASE_VIEW_W + x) * 4;
    return (buf[i]! << 16) | (buf[i + 1]! << 8) | buf[i + 2]!;
  }

  /** Цвет середины слота — по нему различаются обычный, активный и наведённый. */
  function slotFill(buf: Uint8ClampedArray, i: number): number {
    return colorAt(
      buf,
      layout.slotX + i * layout.slotStep + (layout.slotSize >> 1),
      // Верхняя половина слота: ниже центра стоит значок.
      layout.slotY + 2,
    );
  }

  // Панель обязана быть в кадре при ВЫКЛЮЧЕННОЙ диагностике: она — состояние
  // игры, а не инструмент разработчика.
  const base = shoot();
  {
    const worldRow = layout.y - 1;
    let painted = 0;
    for (let x = layout.x; x < layout.x + layout.w; x++) {
      if (colorAt(base, x, layout.slotY + 2) !== colorAt(base, x, worldRow)) painted++;
    }
    check(
      'Кадр: панель нарисована при выключенной диагностике',
      painted > layout.w / 2,
      `отличается от мира ${painted} из ${layout.w}`,
    );
  }

  // Активный, наведённый и обычный слоты различаются подложкой — одной рамки
  // при беглом взгляде мало.
  {
    const hovered = shoot({ activeSlot: 0, hoveredSlot: 2 });
    const active = slotFill(hovered, 0);
    const hover = slotFill(hovered, 2);
    const plain = slotFill(hovered, 1);
    const empty = slotFill(hovered, 5);
    check(
      'Кадр: активный, наведённый, обычный и пустой слоты различаются подложкой',
      new Set([active, hover, plain, empty]).size === 4,
      [active, hover, plain, empty].map((c) => c.toString(16)).join(' '),
    );

    // Рамка тоже своя: активный слот выделен и подложкой, и рамкой.
    const edgeActive = colorAt(hovered, layout.slotX, layout.slotY);
    const edgePlain = colorAt(hovered, layout.slotX + layout.slotStep, layout.slotY);
    check('Кадр: рамка активного слота отличается от обычной', edgeActive !== edgePlain);
  }

  // Игрок без мыши: подсветки наведения в кадре нет вовсе.
  {
    const hovered = shoot({ hoveredSlot: 4 });
    check(
      'Кадр: без мыши подсветки наведения нет, с мышью она появляется',
      slotFill(base, 4) !== slotFill(hovered, 4),
    );
  }

  // Строка инвентаря стоит НАД панелью и в неё не залезает.
  {
    const filled = shoot({ carried: [{ name: 'Пульпа', count: 138 }], used: 138 });
    let changed = 0;
    let inside = 0;
    for (let y = 0; y < BASE_VIEW_H; y++) {
      for (let x = 0; x < BASE_VIEW_W; x++) {
        if (colorAt(base, x, y) === colorAt(filled, x, y)) continue;
        changed++;
        if (y >= layout.y) inside++;
      }
    }
    check(
      'Кадр: строка инвентаря лежит над панелью и на неё не заходит',
      changed > 0 && inside === 0,
      `изменилось ${changed}, внутри панели ${inside}`,
    );
  }

  // Вид постройки и причина отказа — ТОЛЬКО в режиме строительства.
  {
    const building = shoot({ activeSlot: 1, buildKind: 'Сепаратор 120 ₡' });
    const refused = shoot({
      activeSlot: 1,
      buildKind: 'Сепаратор 120 ₡',
      buildIssue: 'нет опоры',
    });
    let kindDrawn = 0;
    let issueDrawn = 0;
    const top = layout.y - HUD.lineGap - GLYPH_H;
    for (let y = 0; y < BASE_VIEW_H; y++) {
      for (let x = 0; x < BASE_VIEW_W; x++) {
        if (colorAt(base, x, y) !== colorAt(building, x, y) && y < top) kindDrawn++;
        if (colorAt(building, x, y) !== colorAt(refused, x, y) && y < top) issueDrawn++;
      }
    }
    check(
      'Кадр: вид постройки и причина отказа появляются над панелью только в строительстве',
      kindDrawn > 0 && issueDrawn > 0,
      `вид ${kindDrawn}, отказ ${issueDrawn}`,
    );
  }
}
