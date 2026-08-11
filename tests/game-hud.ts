/**
 * Постоянный интерфейс: раскладка панели, попадание курсора, состояние выбора
 * и кадр.
 *
 * Раскладка и попадание — чистые функции над размером буфера, поэтому
 * проверяются напрямую. Кадр интерфейса ВЕКТОРНЫЙ и в буфер не пишет, поэтому
 * проверяется журнал поверхности: что нарисовано, где и чем одно состояние
 * отличается от другого.
 */
import { Camera, Renderer, RecordingSurface, hudLayout, slotAtPoint, overBar } from '../src/render';
import type { HudState, HudLayout, UiOp, PanelStyle } from '../src/render';
import type { Display } from '../src/core';
import { ActionBarState, ToolMode } from '../src/core';
import { Player } from '../src/entities';
import {
  BASE_VIEW_W,
  BASE_VIEW_H,
  MAX_VIEW_W,
  MAX_VIEW_H,
  WORLD_SEED,
  HUD,
  UI,
} from '../src/config';
import { check, luna, IDLE_HUD, pick, said, saysLike } from './harness';

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

  // Счётчик валюты стоит в противоположном от панели углу и пересечься с ней
  // не может ни при каком буфере.
  const counterBottom = HUD.counterMargin + UI.line * 2;
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

  const ui = new RecordingSurface();
  const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED, ui);
  const camera = new Camera(first.world.width, first.world.height);
  camera.snapTo(spawn.x, spawn.y);
  const layout = hudLayout(BASE_VIEW_W, BASE_VIEW_H);

  function shoot(over: Partial<HudState> = {}, fps = 0): UiOp[] {
    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: { ...IDLE_HUD, ...over },
      fps,
    });
    return [...ui.ops];
  }

  /** Подложка слота: она одна стоит в его углу, и по ней состояния и различаются. */
  function slotStyle(ops: readonly UiOp[], i: number): PanelStyle | undefined {
    const x = layout.slotX + i * layout.slotStep;
    return pick(ops, 'panel').find((op) => op.x === x && op.y === layout.slotY)?.style;
  }

  /** Чем два вида отличаются: заливка, обводка, свечение. */
  function differences(a: PanelStyle, b: PanelStyle): number {
    let n = 0;
    if (a.fill !== b.fill || a.fillBottom !== b.fillBottom) n++;
    if (a.stroke !== b.stroke || a.strokeWidth !== b.strokeWidth) n++;
    if (a.glow !== b.glow) n++;
    return n;
  }

  const base = shoot();

  // Панель обязана быть в кадре при ВЫКЛЮЧЕННОЙ диагностике: она — состояние
  // игры, а не инструмент разработчика.
  {
    const plate = pick(base, 'panel').find((op) => op.x === layout.x && op.y === layout.y);
    const slots = Array.from({ length: layout.slots }, (_, i) => slotStyle(base, i)).filter(
      Boolean,
    );
    const keys = pick(base, 'text').filter(
      (op) => op.y < layout.slotY + layout.slotSize && op.y >= layout.slotY,
    );
    check(
      'Кадр: панель, все её слоты и подписи клавиш нарисованы при выключенной диагностике',
      plate !== undefined &&
        plate.w === layout.w &&
        plate.h === layout.h &&
        slots.length === layout.slots &&
        keys.length === layout.slots,
      `подложка ${plate ? 'есть' : 'НЕТ'}, слотов ${slots.length}, подписей ${keys.length}`,
    );

    // Значок у каждого непустого слота: панель читается боковым зрением,
    // а текст размером с ноготь не читается вовсе.
    const icons = pick(base, 'icon').filter((op) => op.y >= layout.slotY);
    check(
      'Кадр: у каждого непустого слота свой значок',
      icons.length === 3 && new Set(icons.map((op) => op.key)).size === 3,
      icons.map((op) => op.key).join(' '),
    );
  }

  // Активный, наведённый, обычный и пустой слоты различаются не менее чем
  // двумя средствами: одной заливки при беглом взгляде мало, одной обводки
  // не видно на тёмном слоте.
  {
    const ops = shoot({ activeSlot: 0, hoveredSlot: 2 });
    const active = slotStyle(ops, 0)!;
    const plain = slotStyle(ops, 1)!;
    const hover = slotStyle(ops, 2)!;
    const empty = slotStyle(ops, 5)!;
    check(
      'Кадр: активный, наведённый, обычный и пустой слоты различаются заливкой',
      new Set([active.fill, hover.fill, plain.fill, empty.fill]).size === 4,
      [active.fill, hover.fill, plain.fill, empty.fill].join(' '),
    );
    check(
      'Кадр: активный слот отличается от прочих не менее чем двумя средствами',
      differences(active, plain) >= 2 && differences(active, hover) >= 2,
      `от обычного ${differences(active, plain)}, от наведённого ${differences(active, hover)}`,
    );
    check(
      'Кадр: подсветка наведения отличается от выделения активного',
      differences(hover, active) >= 2 && differences(hover, plain) >= 1,
      `наведение против активного ${differences(hover, active)}`,
    );
  }

  // Игрок без мыши: подсветки наведения в кадре нет вовсе.
  {
    const hovered = shoot({ hoveredSlot: 4 });
    check(
      'Кадр: без мыши подсветки наведения нет, с мышью она появляется',
      JSON.stringify(slotStyle(base, 4)) !== JSON.stringify(slotStyle(hovered, 4)),
    );
  }

  // Строка инвентаря стоит НАД панелью и в неё не залезает.
  {
    const filled = shoot({ carried: [{ name: 'Пульпа', count: 138 }], used: 138 });
    const line = pick(filled, 'text').find((op) => op.text.includes('Пульпа'));
    check(
      'Кадр: строка инвентаря лежит над панелью и на неё не заходит',
      line !== undefined && line.y + UI.line <= layout.y,
      line ? `строка на y=${line.y}, панель с ${layout.y}` : 'строки нет',
    );
  }

  // Вид постройки и причина отказа — ТОЛЬКО в режиме строительства.
  {
    const building = shoot({ activeSlot: 1, buildKind: 'Сепаратор' });
    const refused = shoot({
      activeSlot: 1,
      buildKind: 'Сепаратор',
      buildIssue: 'нет опоры',
    });
    const kind = pick(building, 'text').find((op) => op.text === 'Сепаратор');
    const issue = pick(refused, 'text').find((op) => op.text === 'нет опоры');
    check(
      'Кадр: вид постройки и причина отказа появляются над панелью только в строительстве',
      kind !== undefined &&
        issue !== undefined &&
        kind.y + UI.line <= layout.y &&
        issue.y < kind.y &&
        !saysLike(base, 'Сепаратор') &&
        !saysLike(building, 'нет опоры'),
      `вид на y=${kind?.y}, отказ на y=${issue?.y}`,
    );

    // Причина отказа различима ЦВЕТОМ от остальных надписей низа кадра.
    const others = pick(refused, 'text')
      .filter((op) => op.y < layout.y && op !== issue)
      .map((op) => op.style.color);
    check(
      'Кадр: причина отказа различима цветом от остальных надписей',
      issue !== undefined && !others.includes(issue.style.color),
      issue?.style.color ?? '',
    );
  }

  // Панель не пишет в буфер мира ни пикселя: снимок мира от интерфейса
  // не зависит, и это то, ради чего слои разделены.
  {
    const before = pixels.slice();
    shoot({ activeSlot: 1, buildKind: 'Сепаратор', hoveredSlot: 3 }, 60);
    const after = pixels.slice();
    let changed = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2]
      )
        changed++;
    }
    check(
      'Кадр: интерфейс не оставляет следов в буфере мира',
      changed === 0,
      `изменившихся пикселей ${changed}`,
    );
  }

  // Надписи кадра одни и те же при одном состоянии: журнал описывает кадр,
  // а не накапливает его.
  {
    const again = shoot();
    check(
      'Кадр: журнал описывает один кадр, а не накапливает их',
      said(again).join('|') === said(base).join('|') && again.length === base.length,
      `${base.length} операций против ${again.length}`,
    );
  }
}
