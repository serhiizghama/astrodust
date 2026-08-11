/**
 * Тонирование поверхностей мира: наборы ступеней и их взаимные ограничения.
 *
 * Проверки этого набора — про ПАЛИТРУ набора, а не про кадр. Кадровые
 * (зерно не плывёт, кромка светлее толщи, свет от лавы) добавляются ниже
 * по мере появления самих эффектов.
 */
import { check, IDLE_HUD } from './harness';
import { MATERIALS, MAT, MAT_EMIT, MatterState, LUNA, World } from '../src/world';
import {
  MAT_SHADES,
  BAYER,
  DITHER_LEVELS,
  Camera,
  Renderer,
  RecordingSurface,
  Lightmap,
  LIGHT_NEUTRAL,
  SPRITE_PALETTE,
} from '../src/render';
import { Player } from '../src/entities';
import type { Display } from '../src/core';
import { RAMP } from '../src/palette';
import { SHADING, BASE_VIEW_W, BASE_VIEW_H } from '../src/config';

/** Воспринимаемая яркость. Та же формула, что у любого редактора палитр. */
function luma(color: number): number {
  return 0.299 * ((color >> 16) & 0xff) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff);
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

const bd = LUNA.backdrop;

/** Ступени интерьера пещеры: у выхода и в глубине. */
const CAVE_SHADES = [LUNA.caveColor, LUNA.caveDeepColor];

/**
 * Площадные цвета задника — те, чью площадь считают подсчётом пикселей кадра.
 * Свечение полосы и заливки слоёв покрывают в кадре десятки тысяч пикселей;
 * цвета звёзд и подсветки кромок сюда НЕ входят — они точечные акценты.
 */
const BACKDROP_AREA = [LUNA.skyColor, ...bd.layers.map((l) => l.fill)];
if (bd.milkyWay) BACKDROP_AREA.push(bd.milkyWay.glowColor);

/**
 * Цвета, которые `tests/shot.ts` ищет по ВСЕМУ кадру, а не только в небе.
 * Порода в таком цвете подмешалась бы в метрику задника на подземном снимке,
 * где неба нет вовсе.
 */
const FRAME_WIDE_COUNTED = [
  ...BACKDROP_AREA,
  ...bd.starColors,
  bd.rimWarm,
  bd.rimCold,
  ...(bd.orbiter ? [bd.orbiter.color] : []),
];

// --- Устройство таблицы ---

check(
  'Ступеней на материал — степень двойки, и shadeBits ей соответствует',
  1 << SHADING.shadeBits === SHADING.shadesPerMaterial,
  `1<<${SHADING.shadeBits} = ${1 << SHADING.shadeBits}, ступеней ${SHADING.shadesPerMaterial}`,
);

check(
  'Базовая ступень лежит внутри диапазона и оставляет место в обе стороны',
  SHADING.baseShade > 0 && SHADING.baseShade + 1 < SHADING.shadesPerMaterial,
  `базовая ${SHADING.baseShade} из ${SHADING.shadesPerMaterial}`,
);

check(
  'Матрица Байера — перестановка 0..15 без повторов',
  BAYER.length === DITHER_LEVELS && new Set(BAYER).size === DITHER_LEVELS,
  `значений ${BAYER.length}, различных ${new Set(BAYER).size}`,
);

// --- Набор каждого материала ---

{
  let ok = true;
  let detail = '';
  for (const m of MATERIALS) {
    const set = MAT_SHADES[m.id]!;
    if (set === undefined || set.length === 0 || set[0] === undefined) {
      ok = false;
      detail = `${m.name}: набор пуст`;
      break;
    }
    if (!set.includes(m.color)) {
      ok = false;
      detail = `${m.name}: базовый ${hex(m.color)} не входит в набор`;
      break;
    }
  }
  check('Набор материала непуст и содержит его базовый цвет', ok, detail);
}

{
  // Две ленты — одна поверхность с двумя направлениями переноса, и различает
  // их бегущая полоса, а не цвет корпуса. Общая базовая ступень у них
  // намеренная: разные цвета обещали бы игроку разное вещество там, где
  // вещество одно.
  const SAME_SURFACE = [MAT.CONVEYOR_LEFT, MAT.CONVEYOR_RIGHT];
  const bases = MATERIALS.filter((m) => m.id !== MAT.CONVEYOR_LEFT).map((m) => m.color);
  const dup = bases.filter((c, i) => bases.indexOf(c) !== i);
  check(
    'Базовые ступени материалов попарно различны, кроме двух направлений ленты',
    dup.length === 0,
    dup.length === 0
      ? `материалов ${bases.length}, одна поверхность на ${SAME_SURFACE.length} направления`
      : `повтор ${dup.map(hex).join(', ')}`,
  );
}

{
  // Ступени вне палитры быть не может: замкнутый набор — инвариант проекта.
  const palette = new Set<number>(Object.values(RAMP).flatMap((ramp) => [...ramp]));
  const stray: string[] = [];
  for (const m of MATERIALS) {
    for (const c of MAT_SHADES[m.id]!) if (!palette.has(c)) stray.push(`${m.name} ${hex(c)}`);
  }
  for (const c of CAVE_SHADES) if (!palette.has(c)) stray.push(`пещера ${hex(c)}`);
  check(
    'Каждая ступень принадлежит палитре из 46 цветов',
    stray.length === 0,
    stray.length === 0 ? `цветов в палитре ${palette.size}` : stray.join(', '),
  );
}

// --- Порода не подделывает фон ---

{
  const clash: string[] = [];
  for (const m of MATERIALS) {
    if (m.id === MAT.VACUUM) continue;
    for (const c of MAT_SHADES[m.id]!) {
      if (FRAME_WIDE_COUNTED.includes(c)) clash.push(`${m.name} ${hex(c)}`);
      if (CAVE_SHADES.includes(c)) clash.push(`${m.name} ${hex(c)} = пещера`);
    }
  }
  check(
    'Ни одна ступень материала не совпадает с задником, пещерой или спутником',
    clash.length === 0,
    clash.length === 0 ? 'совпадений нет' : clash.join(', '),
  );
}

{
  const dup = CAVE_SHADES.filter((c) => BACKDROP_AREA.includes(c));
  check(
    'Ступени пещеры не совпадают с площадными цветами задника',
    dup.length === 0,
    dup.length === 0 ? `ступеней ${CAVE_SHADES.length}` : dup.map(hex).join(', '),
  );
}

{
  const all = [...BACKDROP_AREA, ...CAVE_SHADES];
  const dup = all.filter((c, i) => all.indexOf(c) !== i);
  check(
    'Площадные наборы задника и пещеры попарно не пересекаются',
    dup.length === 0,
    dup.length === 0 ? `поверхностей ${all.length}` : dup.map(hex).join(', '),
  );
}

// --- Пустота остаётся пустотой ---

{
  // Самая светлая ступень пещеры против самой тёмной ступени вещества толщи:
  // если тонирование увело вещество ниже пещеры, пустота перестала читаться
  // пустотой.
  //
  // Толщу образуют статичные и сыпучие, а не те, кто держит персонажа: рыхлое
  // персонажа не блокирует, но заполняет кадр сплошной заливкой наравне
  // с породой. `MAT_SOLID` здесь совпадал с этим множеством случайно.
  const caveMax = Math.max(...CAVE_SHADES.map(luma));
  let solidMin = Infinity;
  let culprit = '';
  for (const m of MATERIALS) {
    if (m.state !== MatterState.Solid && m.state !== MatterState.Powder) continue;
    for (const c of MAT_SHADES[m.id]!) {
      if (luma(c) < solidMin) {
        solidMin = luma(c);
        culprit = `${m.name} ${hex(c)}`;
      }
    }
  }
  check(
    'Всякая ступень пещеры темнее всякой ступени вещества толщи',
    caveMax < solidMin,
    `пещера ${caveMax.toFixed(1)} < ${culprit} ${solidMin.toFixed(1)}`,
  );
}

{
  // Контур — это то, чем силуэт держится и в пещере, и в небе. Совпадение
  // с любой ступенью фона стирает его ровно в одном из двух мест.
  const outline = SPRITE_PALETTE[4]!;
  const hitsCave = CAVE_SHADES.includes(outline);
  const darkerThanCave = luma(outline) < Math.min(...CAVE_SHADES.map(luma));
  const lighterThanSky = luma(outline) > luma(LUNA.skyColor);
  check(
    'Тёмный контур персонажа отличим от каждой ступени пещеры и от неба',
    !hitsCave && darkerThanCave && lighterThanSky,
    `контур ${luma(outline).toFixed(1)}, пещера ${CAVE_SHADES.map((c) => luma(c).toFixed(1)).join('/')}, небо ${luma(LUNA.skyColor).toFixed(1)}`,
  );
}

// --- Плоские по построению ---

{
  // Лента и полоса считаются в кадре пиксель в пиксель: «штрих плюс корпус
  // равен пролёту» в tests/conveyor.ts перестанет сходиться, как только
  // у ленты появится второй цвет.
  const flat = [MAT.CONVEYOR_LEFT, MAT.CONVEYOR_RIGHT, MAT.IRIDIUM, MAT.SLAG];
  const bad = flat.filter((id) => MAT_SHADES[id]!.length !== 1);
  check(
    'Конвейер, иридий и шлак остаются плоскими — их считают в кадре',
    bad.length === 0,
    bad.length === 0
      ? 'по одной ступени у каждого'
      : bad.map((id) => `${MATERIALS[id]!.name} ${MAT_SHADES[id]!.length}`).join(', '),
  );
}

{
  const stripe = RAMP.gray[7];
  const clash: string[] = [];
  for (const m of MATERIALS) {
    if (MAT_SHADES[m.id]!.includes(stripe)) clash.push(m.name);
  }
  check(
    'Цвет бегущей полосы не занят ни одной ступенью ни одного материала',
    clash.length === 0,
    clash.length === 0 ? hex(stripe) : clash.join(', '),
  );
}

// --- Кадр ---
//
// Отсюда и ниже проверяется не палитра, а то, что рендер из неё делает.
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

  // Мир заметно шире опорного кадра: иначе камера упирается в кламп с обоих
  // краёв, сдвинуть её нечем, и проверка «текстура не плывёт» мерила бы кламп.
  const W = 1024;
  const H = 800;
  /** Поверхность на y=40, ниже — сплошная толща. Пустоты вырезаются точечно. */
  const SURFACE_Y = 40;

  function sandbox(): { world: World; surface: Int16Array } {
    const world = new World(W, H, LUNA);
    const surface = new Int16Array(W).fill(SURFACE_Y);
    for (let y = SURFACE_Y; y < H; y++) {
      for (let x = 0; x < W; x++) world.set(x, y, MAT.ROCK);
    }
    return { world, surface };
  }

  /**
   * Кадр вместе с положением камеры.
   *
   * Камеру возвращаем намеренно: `snapTo` наводит камеру НА точку и упирается
   * в кламп по краям мира, поэтому её угол не равен переданным координатам.
   * Считать экранную позицию от аргумента — молчаливо промахнуться мимо
   * проверяемой ячейки.
   */
  interface Shot {
    px: Uint8ClampedArray;
    camX: number;
    camY: number;
  }

  function frameOf(world: World, surface: Int16Array, cx: number, cy: number): Shot {
    const renderer = new Renderer(display, world, surface, 1, new RecordingSurface());
    const camera = new Camera(W, H);
    camera.snapTo(cx, cy);
    renderer.render({
      camera: camera,
      // Персонаж и прицел уводятся за кадр: проверяется порода, а не спрайт.
      player: new Player(-50, -50),
      crosshairX: -50,
      crosshairY: -50,
      crosshairInReach: false,
      hud: IDLE_HUD,
      fps: 0,
      time: 0,
    });
    return { px: pixels.slice(), camX: camera.x, camY: camera.y };
  }

  /** Цвет пикселя кадра по экранным координатам. */
  const at = (buf: Uint8ClampedArray, sx: number, sy: number): number => {
    const i = (sy * BASE_VIEW_W + sx) * 4;
    return (buf[i]! << 16) | (buf[i + 1]! << 8) | buf[i + 2]!;
  };

  /** Цвет пикселя по МИРОВЫМ координатам — с поправкой на угол камеры. */
  const atWorld = (s: Shot, wx: number, wy: number): number => at(s.px, wx - s.camX, wy - s.camY);

  // Кадр воспроизводим: без этого ни одна проверка ниже ничего не значит.
  {
    const { world, surface } = sandbox();
    const a = frameOf(world, surface, 120, 120).px;
    const b = frameOf(world, surface, 120, 120).px;
    let same = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    check('Один и тот же мир при одной камере даёт побайтово одинаковый кадр', same);
  }

  // Зерно привязано к миру, а не к экрану: сдвиг камеры туда-обратно обязан
  // вернуть ту же картинку, а сдвиг на ячейку — сдвинуть её ровно на пиксель.
  {
    const { world, surface } = sandbox();
    const home = frameOf(world, surface, 120, 120);
    frameOf(world, surface, 137, 131);
    const back = frameOf(world, surface, 120, 120);
    let same = true;
    for (let i = 0; i < home.px.length; i++) {
      if (home.px[i] !== back.px[i]) {
        same = false;
        break;
      }
    }
    check('Текстура не плывёт: возврат камеры возвращает тот же кадр', same);

    // Наводка в середине хода камеры: у края обе упёрлись бы в кламп
    // и оказались бы одной и той же точкой.
    const still = frameOf(world, surface, 500, 200);
    const moved = frameOf(world, surface, 501, 200);
    const dx = moved.camX - still.camX;
    let shifted = 0;
    let checked = 0;
    // Полоса заведомо в породе: от поверхности вниз, без края кадра.
    for (let wy = SURFACE_Y + 20; wy < SURFACE_Y + 80; wy++) {
      for (let wx = still.camX + 10; wx < still.camX + BASE_VIEW_W - 10 - dx; wx++) {
        checked++;
        if (atWorld(moved, wx, wy) === atWorld(still, wx, wy)) shifted++;
      }
    }
    check(
      'Одна и та же ячейка мира выведена той же ступенью при сдвинутой камере',
      dx > 0 && shifted === checked,
      `сдвиг камеры ${dx}, совпало ${shifted} из ${checked}`,
    );
  }

  // Кромка светлее толщи, и копание проявляет её немедленно.
  {
    const { world, surface } = sandbox();
    const before = frameOf(world, surface, 200, 250);
    const was = atWorld(before, 200, 250);

    // Вырезаем полость прямо над проверяемой ячейкой.
    for (let y = 240; y < 250; y++) world.set(200, y, MAT.VACUUM);
    const after = frameOf(world, surface, 200, 250);
    const now = atWorld(after, 200, 250);

    check(
      'Копание немедленно проявляет светлую кромку на стенке',
      luma(now) > luma(was),
      `было ${hex(was)} (${luma(was).toFixed(1)}), стало ${hex(now)} (${luma(now).toFixed(1)})`,
    );
  }

  // Ячейка, открытая с двух сторон, светлее ячейки в нетронутой толще.
  {
    const { world, surface } = sandbox();
    // Узкая перемычка: столбец породы между двумя полостями.
    for (let y = 200; y < 220; y++) {
      world.set(150, y, MAT.VACUUM);
      world.set(152, y, MAT.VACUUM);
    }
    const s = frameOf(world, surface, 200, 210);
    const bridge = atWorld(s, 151, 210);
    const bulk = atWorld(s, 250, 210);
    check(
      'Открытая с двух сторон перемычка светлее нетронутой толщи',
      luma(bridge) > luma(bulk),
      `перемычка ${hex(bridge)} (${luma(bridge).toFixed(1)}), толща ${hex(bulk)} (${luma(bulk).toFixed(1)})`,
    );
  }

  // Базовая ступень доминирует: иначе порода читается шумом, а не породой.
  // Проверяется НА ГЛУБИНЕ — там, где затемнение работает в полную силу
  // и где сдвиг ступени целиком отнял бы у базовой доминанту.
  {
    const { world, surface } = sandbox();
    const s = frameOf(world, surface, 200, 350);
    const base = MATERIALS[MAT.ROCK]!.color;
    let baseN = 0;
    let total = 0;
    for (let sy = 20; sy < BASE_VIEW_H - 20; sy++) {
      for (let sx = 20; sx < BASE_VIEW_W - 20; sx++) {
        total++;
        if (at(s.px, sx, sy) === base) baseN++;
      }
    }
    check(
      'Базовая ступень занимает больше половины пикселей сплошной породы на глубине',
      baseN * 2 > total,
      `базовых ${baseN} из ${total} (${((100 * baseN) / total).toFixed(1)}%)`,
    );
  }

  // Дальний конец полости темнее выхода: это навигация в мире без карты.
  {
    const { world, surface } = sandbox();
    // Вертикальная шахта от поверхности вниз — один её конец открыт наружу.
    for (let y = SURFACE_Y; y < 380; y++) {
      for (let x = 198; x <= 202; x++) world.set(x, y, MAT.VACUUM);
    }
    const near = frameOf(world, surface, 200, SURFACE_Y + 30);
    const far = frameOf(world, surface, 200, 340);
    const nearDark = countDeep(near, 200, SURFACE_Y + 4, SURFACE_Y + 60);
    const farDark = countDeep(far, 200, 300, 356);
    check(
      'В глубине шахты тёмной ступени больше, чем у выхода',
      farDark > nearDark,
      `у выхода ${nearDark}, в глубине ${farDark} из 56`,
    );
  }

  /** Сколько пикселей тёмной ступени пещеры в колонке мира на отрезке глубин. */
  function countDeep(s: Shot, wx: number, from: number, to: number): number {
    let n = 0;
    for (let wy = from; wy < to; wy++) {
      if (atWorld(s, wx, wy) === LUNA.caveDeepColor) n++;
    }
    return n;
  }
}

// --- Карта освещённости ---
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

  const W = 256;
  const H = 256;

  /** Мир из сплошной породы; поверхность считается по верхней строке. */
  function solidWorld(): { world: World; surface: Int16Array } {
    const world = new World(W, H, LUNA);
    const surface = new Int16Array(W).fill(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) world.setRaw(x, y, MAT.ROCK);
    }
    return { world, surface };
  }

  function litLevel(world: World): Uint8Array {
    const map = new Lightmap(world);
    map.rebuildAll();
    return map.level.slice();
  }

  // Светимость — данные: карта читает таблицу веществ, а не имена материалов.
  {
    check(
      'Лава светится, порода — нет',
      MAT_EMIT[MAT.LAVA]! > 0 && MAT_EMIT[MAT.ROCK] === 0,
      `лава ${MAT_EMIT[MAT.LAVA]}, порода ${MAT_EMIT[MAT.ROCK]}`,
    );
  }

  // Свет выходит за границу источника и убывает с расстоянием.
  {
    const { world } = solidWorld();
    for (let y = 120; y < 136; y++) {
      for (let x = 120; x < 136; x++) world.setRaw(x, y, MAT.LAVA);
    }
    const level = litLevel(world);
    const cols = Math.ceil(W / SHADING.lightScale);
    const at = (wx: number, wy: number): number =>
      level[((wy / SHADING.lightScale) | 0) * cols + ((wx / SHADING.lightScale) | 0)]!;

    // Точки взяты долями окна карты (радиус 3 ячейки карты, то есть
    // `lightRadius * lightScale` ячеек мира): у самого кармана, у края окна
    // и заведомо за ним. В ячейках мира их держать нельзя — сторона ячейки
    // карты соразмерна кадру и меняется вместе с ним.
    const halo = SHADING.lightRadius * SHADING.lightScale;
    const near = at(128, 120 - halo / 3);
    const mid = at(128, 120 - halo);
    const far = at(128, 120 - 5 * halo);
    check(
      'Свет выходит за границу источника',
      near > LIGHT_NEUTRAL,
      `у кармана ${near}, нейтраль ${LIGHT_NEUTRAL}`,
    );
    check(
      'Свет убывает с расстоянием и вдали сходит на нет',
      near > mid && mid >= far && far === LIGHT_NEUTRAL,
      `${near} → ${mid} → ${far}`,
    );
  }

  // Освещённость — функция состояния мира, а не его истории.
  {
    const dug = solidWorld().world;
    for (let y = 120; y < 136; y++) {
      for (let x = 120; x < 136; x++) dug.set(x, y, MAT.LAVA);
    }
    const born = solidWorld().world;
    for (let y = 120; y < 136; y++) {
      for (let x = 120; x < 136; x++) born.setRaw(x, y, MAT.LAVA);
    }
    const a = litLevel(dug);
    const b = litLevel(born);
    let same = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    check('Карта одинакова, получен ли карман копанием или генерацией', same);
  }

  // Неизменный мир не пересчитывается, изменённый — пересчитывается.
  {
    const { world } = solidWorld();
    const map = new Lightmap(world);
    map.rebuildAll();
    check('При неизменном мире пересчёта нет', map.update() === 0);

    world.set(64, 64, MAT.LAVA);
    check('Изменение ячейки будит пересчёт', map.update() > 0);
  }

  // Потолок: крупное разрушение растягивается на несколько кадров.
  {
    const { world } = solidWorld();
    const map = new Lightmap(world);
    map.rebuildAll();
    // Область много больше выемки копания: весь мир.
    for (let y = 0; y < H; y += 8) {
      for (let x = 0; x < W; x += 8) world.set(x, y, MAT.VACUUM);
    }
    const first = map.update();
    check(
      'Пересчёт за кадр не превышает потолка',
      first === SHADING.lightChunksPerFrame,
      `за кадр ${first}, потолок ${SHADING.lightChunksPerFrame}`,
    );
    let frames = 1;
    while (map.update() > 0 && frames < 1000) frames++;
    check(
      'Остаток переносится на следующие кадры и догоняет',
      frames > 1 && map.update() === 0,
      `кадров на догон ${frames}`,
    );
  }

  // Порода у лавы светлее такой же породы вдали — уже в КАДРЕ, не в карте.
  {
    const { world, surface } = solidWorld();
    for (let y = 120; y < 136; y++) {
      for (let x = 120; x < 136; x++) world.setRaw(x, y, MAT.LAVA);
    }
    const renderer = new Renderer(display, world, surface, 1, new RecordingSurface());
    const camera = new Camera(W, H);
    camera.snapTo(128, 128);
    renderer.render({
      camera: camera,
      player: new Player(-50, -50),
      crosshairX: -50,
      crosshairY: -50,
      crosshairInReach: false,
      hud: IDLE_HUD,
      fps: 0,
      time: 0,
    });
    const light = MAT_SHADES[MAT.ROCK]![MAT_SHADES[MAT.ROCK]!.length - 1]!;
    const count = (wx0: number, wx1: number, wy0: number, wy1: number): number => {
      let n = 0;
      for (let wy = wy0; wy < wy1; wy++) {
        for (let wx = wx0; wx < wx1; wx++) {
          const i = ((wy - camera.y) * BASE_VIEW_W + (wx - camera.x)) * 4;
          const c = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
          if (c === light) n++;
        }
      }
      return n;
    };
    // Полосы одинаковой площади: вплотную над карманом и в стороне от него.
    const nearLava = count(120, 136, 110, 118);
    const away = count(120, 136, 60, 68);
    check(
      'Порода у лавы светлее такой же породы вдали',
      nearLava > away,
      `у лавы светлых ${nearLava}, вдали ${away}`,
    );
  }
}

// --- Свет достаёт и до пустоты ---
//
// Расплав, освещающий породу вокруг, но не воздух над собой, читается
// подсветкой камня, а не источником.
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

  const W = 256;
  const H = 256;
  const world = new World(W, H, LUNA);
  const surface = new Int16Array(W).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) world.setRaw(x, y, MAT.ROCK);
  }
  // Две одинаковые горизонтальные полости на одной глубине. Под левой — лава,
  // под правой ничего: глубина у них общая, и различить их может только свет.
  for (let x = 30; x < 70; x++) {
    for (let y = 150; y < 158; y++) world.setRaw(x, y, MAT.VACUUM);
    for (let y = 158; y < 164; y++) world.setRaw(x, y, MAT.LAVA);
  }
  for (let x = 160; x < 200; x++) {
    for (let y = 150; y < 158; y++) world.setRaw(x, y, MAT.VACUUM);
  }

  const renderer = new Renderer(display, world, surface, 1, new RecordingSurface());
  const camera = new Camera(W, H);
  camera.snapTo(128, 154);
  renderer.render({
    camera: camera,
    player: new Player(-50, -50),
    crosshairX: -50,
    crosshairY: -50,
    crosshairInReach: false,
    hud: IDLE_HUD,
    fps: 0,
    time: 0,
  });

  const countDark = (x0: number, x1: number): number => {
    let n = 0;
    for (let wy = 150; wy < 158; wy++) {
      for (let wx = x0; wx < x1; wx++) {
        const i = ((wy - camera.y) * BASE_VIEW_W + (wx - camera.x)) * 4;
        const c = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
        if (c === LUNA.caveDeepColor) n++;
      }
    }
    return n;
  };

  const lit = countDark(30, 70);
  const unlit = countDark(160, 200);
  check(
    'Пустота у светящегося вещества светлее пустоты той же глубины вдали',
    lit < unlit,
    `у лавы тёмных ${lit}, вдали ${unlit} из 320`,
  );
}
