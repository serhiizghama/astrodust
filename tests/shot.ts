/**
 * Снимок кадра в PNG без браузера.
 *
 * Запуск: npm run shot [суффикс]
 * Результат: shots/<позиция>-<суффикс>.png
 *
 * Задник — визуальная работа, и судить о ней по описанию нельзя. Браузер для
 * этого не нужен: рендер пишет в обычный буфер пикселей, который остаётся
 * закодировать в PNG. Заодно снимок воспроизводим — одна и та же камера на
 * одном и том же зерне всегда даёт один и тот же файл, поэтому сравнение
 * «до/после» показывает изменения рендера, а не разное положение персонажа.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateLuna, Simulation, MAT, MATERIALS } from '../src/world';
import {
  Camera,
  Renderer,
  CONVEYOR_STRIPE_COLOR,
  hudLayout,
  GLYPH_H,
  techTreeLayout,
  nodeOrigin,
} from '../src/render';
import { Player, LandingModule, BuildingRegistry, SEPARATOR_KIND } from '../src/entities';
import { TECHNOLOGIES, TECH_NODES, TECH_EDGES, TECH_COLS, TECH_ROWS } from '../src/progress';
import { Builder } from '../src/systems';
import type { HudState } from '../src/render';
import {
  WORLD_SEED,
  BASE_VIEW_W,
  BASE_VIEW_H,
  VACUUM,
  MODULE,
  SEPARATOR,
  PLAYER,
  FIXED_DT,
  CONVEYOR,
  SIM_HZ,
} from '../src/config';
import type { Display } from '../src/core';
import { IDLE_SLOTS } from './harness';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Кодирует область буфера в PNG с целочисленным увеличением. */
function encodePng(rgba: Uint8ClampedArray, scale: number, crop: Crop): Uint8Array {
  const sw = crop.w * scale;
  const sh = crop.h * scale;
  // Каждая строка PNG начинается байтом фильтра; используем 0 — «без фильтра».
  const raw = new Uint8Array(sh * (1 + sw * 3));
  let p = 0;
  for (let y = 0; y < sh; y++) {
    raw[p++] = 0;
    const srcRow = (crop.y + ((y / scale) | 0)) * BASE_VIEW_W;
    for (let x = 0; x < sw; x++) {
      const src = (srcRow + crop.x + ((x / scale) | 0)) * 4;
      raw[p++] = rgba[src]!;
      raw[p++] = rgba[src + 1]!;
      raw[p++] = rgba[src + 2]!;
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, sw);
  dv.setUint32(4, sh);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // цветовой тип: truecolor RGB

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

const pixels = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

const fakeDisplay = {
  pixels,
  // Контексту кадра осталась одна обязанность — вывод готового буфера на экран.
  ctx: { putImageData() {} },
  width: BASE_VIEW_W,
  height: BASE_VIEW_H,
  image: {},
  present() {},
} as unknown as Display;

const { world, spawn, surface, receiver } = generateLuna(WORLD_SEED);
const renderer = new Renderer(fakeDisplay, world, surface, WORLD_SEED);

const suffix = process.argv[2] ? `-${process.argv[2]}` : '';
mkdirSync('shots', { recursive: true });

const FULL: Crop = { x: 0, y: 0, w: BASE_VIEW_W, h: BASE_VIEW_H };

/**
 * Точки съёмки. Кроме общих планов — увеличенные вырезки: детали вроде диска
 * Земли и пунктира на гребне при масштабе ×3 просто не видно, а судить о них
 * по числам нельзя.
 */
const SHOTS: Array<{ name: string; camX: number; camY: number; scale?: number; crop?: Crop }> = [
  { name: 'sky', camX: 1000, camY: 0 },
  { name: 'surface', camX: spawn.x, camY: spawn.y },
  // Посадочный модуль: единственное рукотворное тело в мире, и единственное
  // место, где проверяется, читается ли оно рукотворным. Камера чуть выше
  // площадки — иначе стенки уходят за нижний край.
  { name: 'module', camX: MODULE.x + MODULE.width / 2, camY: spawn.y - 40 },
  {
    name: 'zoom-module',
    camX: MODULE.x + MODULE.width / 2,
    camY: spawn.y - 40,
    scale: 6,
    // Камера у левого края мира упирается в кламп и стоит на x=0, поэтому
    // экранная колонка корпуса совпадает с мировой.
    crop: { x: 100, y: 192, w: 112, h: 112 },
  },
  { name: 'horizon', camX: 1560, camY: 120 },
  { name: 'cave', camX: 1400, camY: 620 },
  // Тонирование судится глазом и только на увеличении: зерно, кромка хода
  // и дизеринг затенения при ×3 сливаются в общий тон, а вопрос «читается ли
  // это породой или помехами» решается видом отдельных пикселей.
  { name: 'zoom-cave', camX: 1400, camY: 620, scale: 8, crop: { x: 120, y: 80, w: 60, h: 50 } },
  { name: 'zoom-earth', camX: 1000, camY: 0, scale: 10, crop: { x: 452, y: 44, w: 88, h: 84 } },
  { name: 'zoom-ridge', camX: 1000, camY: 0, scale: 6, crop: { x: 160, y: 148, w: 320, h: 144 } },
];

/**
 * Считает, сколько пикселей кадра окрашены в точно заданный цвет.
 *
 * Пригодно ТОЛЬКО для задника и точечных акцентов: у них нет другого
 * представления, кроме пикселей. Количество материала так мерить нельзя —
 * см. `countMaterial`.
 */
function countColor(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === r && pixels[i + 1] === g && pixels[i + 2] === b) n++;
  }
  return n;
}

/**
 * Сколько ячеек материала попало в видимую камерой область.
 *
 * Считается по сетке мира, а не подсчётом пикселей цвета материала: сетка —
 * источник правды о геометрии, кадр — её изображение, и мерить надо оригинал.
 * Подсчёт по кадру вдобавок занижал бы результат молча, как только у материала
 * появится вторая ступень.
 */
function countMaterial(camera: Camera, material: number): number {
  let n = 0;
  for (let sy = 0; sy < BASE_VIEW_H; sy++) {
    for (let sx = 0; sx < BASE_VIEW_W; sx++) {
      if (world.get(camera.x + sx, camera.y + sy) === material) n++;
    }
  }
  return n;
}

const bd = world.profile.backdrop;

/**
 * Интерфейс с непустым инвентарём. Теперь он ВИДЕН на снимке: панель, счётчики
 * и строка инвентаря рисуются пикселями буфера, из которого кодируется PNG, —
 * значит, читаемость шрифта и панели судится тем же способом, что и мир.
 */
const hud: HudState = {
  // Режим копания — тот, с которого начинается партия. Он же оставляет прицел
  // прежним, поэтому снимки сравнимы с базовыми: расхождение будет означать
  // изменение мира или задника, а не смену формы крестика.
  slots: IDLE_SLOTS,
  activeSlot: 0,
  hoveredSlot: null,
  collecting: false,
  collectRadius: VACUUM.radius,
  carried: [
    { name: 'Реголит', count: 210 },
    { name: 'Пульпа', count: 138 },
  ],
  used: 348,
  capacity: VACUUM.capacity,
  selected: 'Пульпа',
  credits: 1234,
  buildKind: '',
  buildIssue: '',
  ghost: null,
  machines: [],
  overlay: null,
};

for (const shot of SHOTS) {
  const camera = new Camera(world.width, world.height);
  camera.snapTo(shot.camX, shot.camY);
  // Персонаж — в центре кадра, на видимой опоре под ним, если она есть.
  const player = new Player(camera.x + BASE_VIEW_W / 2, camera.y + BASE_VIEW_H / 2);
  renderer.render({
    camera: camera,
    player: player,
    crosshairX: BASE_VIEW_W / 2 + 20,
    crosshairY: BASE_VIEW_H / 2,
    crosshairInReach: true,
    hud: hud,
    fps: 0,
    time: 3,
  });

  const path = `shots/${shot.name}${suffix}.png`;
  writeFileSync(path, encodePng(pixels, shot.scale ?? 3, shot.crop ?? FULL));

  const stars = bd.starColors.reduce((n, c) => n + countColor(c), 0);
  const rims = countColor(bd.rimWarm) + countColor(bd.rimCold);
  const fills = bd.layers.map((l) => countColor(l.fill));
  const glow = bd.milkyWay ? countColor(bd.milkyWay.glowColor) : 0;
  console.log(
    `${path.padEnd(28)} камера=(${camera.x},${camera.y})  ` +
      `звёзд ${stars}  кромок ${rims}  свечения ${glow}  слои ${fills.join('/')}`,
  );
}

// --- Интерфейс ---
//
// Панель, счётчики и строки внизу судятся только глазом: числа не говорят
// ни о читаемости шрифта, ни о том, узнаётся ли действие по значку. Снимается
// поверх поверхности — самого светлого фона в игре: если подложка текста
// держит контраст здесь, она держит его везде.
{
  const camera = new Camera(world.width, world.height);
  camera.snapTo(spawn.x, spawn.y);
  const player = new Player(camera.x + BASE_VIEW_W / 2, camera.y + BASE_VIEW_H / 2);
  const layout = hudLayout(BASE_VIEW_W, BASE_VIEW_H);

  renderer.render({
    camera: camera,
    player: player,
    crosshairX: BASE_VIEW_W / 2 + 20,
    crosshairY: BASE_VIEW_H / 2,
    crosshairInReach: true,
    // Строительство с негодным местом: в кадре разом активный слот, наведённый
    // слот, вид постройки с ценой и причина отказа — всё, что панель показывает.
    hud: {
      ...hud,
      activeSlot: 1,
      hoveredSlot: 2,
      buildKind: SEPARATOR_KIND.name,
      buildIssue: 'нет опоры',
    },
    fps: 60,
    time: 3,
  });

  writeFileSync(`shots/hud${suffix}.png`, encodePng(pixels, 3, FULL));
  writeFileSync(
    `shots/zoom-action-bar${suffix}.png`,
    encodePng(pixels, 8, {
      x: layout.x - 2,
      y: layout.y - 26,
      w: layout.w + 4,
      h: layout.h + 28,
    }),
  );
  writeFileSync(
    `shots/zoom-counters${suffix}.png`,
    encodePng(pixels, 10, { x: BASE_VIEW_W - 64, y: 0, w: 64, h: 28 }),
  );
  console.log(
    `shots/hud${suffix}.png`.padEnd(28) +
      ` панель x=${layout.x} y=${layout.y} ${layout.w}×${layout.h}, ` +
      `слот ${layout.slotSize}, кегль ${GLYPH_H}`,
  );

  // Курсор стоит НА наведённом узле: снимок, где стрелка в стороне от того,
  // что подсвечено, показывал бы состояние, которого в игре не бывает.
  const treeLayout = techTreeLayout(BASE_VIEW_W, BASE_VIEW_H, TECH_COLS, TECH_ROWS);
  const hoveredNode = TECH_NODES[2]!;
  const hoveredAt = nodeOrigin(treeLayout, hoveredNode.col, hoveredNode.row);
  const pointer = {
    x: hoveredAt.x + (treeLayout.node >> 1),
    y: hoveredAt.y + (treeLayout.node >> 1),
  };

  // Дерево технологий — тем же шрифтом и поверх интерфейса. Своя сцена, потому
  // что регресс читаемости узлов, связей и подсказки иначе виден только в игре.
  // Наведение и выбор стоят на РАЗНЫХ узлах: их пометки обязаны различаться.
  renderer.render({
    camera: camera,
    player: player,
    crosshairX: BASE_VIEW_W / 2 + 20,
    crosshairY: BASE_VIEW_H / 2,
    crosshairInReach: true,
    hud: {
      ...hud,
      overlay: {
        credits: 1234,
        selected: 1,
        hovered: 2,
        pointerX: pointer.x,
        pointerY: pointer.y,
        edges: TECH_EDGES,
        nodes: TECHNOLOGIES.map((tech, i) => ({
          name: tech.name,
          description: tech.description,
          cost: tech.cost,
          usage: tech.usage,
          status: (['open', 'poor', 'blocked', 'available'] as const)[i % 4]!,
          kind: tech.effect.kind,
          icon: tech.icon,
          col: TECH_NODES[i]!.col,
          row: TECH_NODES[i]!.row,
          note:
            i === 1 ? `нужно ещё ${tech.cost - 1234} ₡` : i === 2 ? 'требует: Широкий раструб' : '',
        })),
      },
    },
    fps: 0,
    time: 3,
  });
  writeFileSync(`shots/research${suffix}.png`, encodePng(pixels, 3, FULL));
}

// --- Работающий сепаратор ---
//
// Строго ПОСЛЕ остальных снимков: постройка меняет мир, и любой снимок после
// неё перестал бы сравниваться с базовым. Здесь проверяется то, о чём числа
// не говорят: читается ли корпус машиной, отличим ли иридий от шлака в общей
// куче и не сливается ли зелёный корпус с золотым модулем.
{
  const module = new LandingModule(receiver);
  module.credits = 100000;
  const registry = new BuildingRegistry();
  const sim = new Simulation();

  // На выровненной площадке рядом с посадочным модулем — оба в одном кадре.
  // Правее выровненной площадки, на естественном рельефе. Верх области берётся
  // по САМОЙ ВЫСОКОЙ колонке пролёта: тогда область заведомо пуста, а опора
  // под ней есть хотя бы в одной колонке — ровно то, чего требует постановка.
  const bx = MODULE.x + MODULE.width + 6;
  let top = Number.POSITIVE_INFINITY;
  for (let dx = 0; dx < SEPARATOR.width; dx++) top = Math.min(top, surface[bx + dx]!);
  const by = top - SEPARATOR.height;
  const cx = bx + (SEPARATOR.width >> 1);
  const cy = by + (SEPARATOR.height >> 1);
  const placed = Builder.apply(world, registry, SEPARATOR_KIND, cx, cy, cx, cy);

  // Гоняем машину, подсыпая пульпу на приёмную грань.
  for (let i = 0; i < 900; i++) {
    if (i % 20 === 0) {
      for (let dx = 0; dx < SEPARATOR.width; dx++) {
        if (world.get(bx + dx, by - 1) === MAT.VACUUM) world.set(bx + dx, by - 1, MAT.PULP);
      }
    }
    sim.update(world, null);
    registry.update(world, FIXED_DT);
  }

  const camera = new Camera(world.width, world.height);
  camera.snapTo(cx, by);
  const player = new Player(bx - 14, by + SEPARATOR.height - PLAYER.hitboxH);
  const machine = registry.all[0];
  renderer.render({
    camera: camera,
    player: player,
    crosshairX: BASE_VIEW_W / 2,
    crosshairY: BASE_VIEW_H / 2,
    crosshairInReach: true,
    hud: {
      ...hud,
      activeSlot: 1,
      buildKind: SEPARATOR_KIND.name,
      machines: machine
        ? [
            {
              x: machine.x,
              y: machine.y,
              w: SEPARATOR.width,
              h: SEPARATOR.height,
              state: machine.state,
              progress: machine.progress,
            },
          ]
        : [],
    },
    fps: 0,
  });

  writeFileSync(`shots/separator${suffix}.png`, encodePng(pixels, 3, FULL));
  // Вырезка вокруг самой машины: камера у левого края мира упирается в кламп,
  // поэтому экранная колонка совпадает с мировой, и центрировать вырезку
  // на середине кадра нельзя.
  writeFileSync(
    `shots/zoom-separator${suffix}.png`,
    encodePng(pixels, 8, {
      x: bx - camera.x - 8,
      y: by - camera.y - 6,
      w: SEPARATOR.width + 16,
      h: SEPARATOR.height + 18,
    }),
  );
  // Сколько намолотило — по сетке; видно ли это глазом — по кадру. Второе
  // сведено к факту присутствия: точное число пикселей ступени ничего не
  // говорит о читаемости, а меняется от любой правки тонирования.
  const iridiumSeen = countColor(MATERIALS[MAT.IRIDIUM]!.color) > 0;
  const slagSeen = countColor(MATERIALS[MAT.SLAG]!.color) > 0;
  console.log(
    `shots/separator${suffix}.png`.padEnd(28) +
      ` постановка ${placed}, состояние ${machine?.state}, ` +
      `иридия ${countMaterial(camera, MAT.IRIDIUM)}, шлака ${countMaterial(camera, MAT.SLAG)}, ` +
      `в кадре иридий ${iridiumSeen ? 'да' : 'НЕТ'}, шлак ${slagSeen ? 'да' : 'НЕТ'}`,
  );
}

// --- Конвейеры ---
//
// Тоже строго ПОСЛЕ базовых снимков: сцена вырезает в мире полость и кладёт
// в неё ленты. Числа про ленту не говорят ничего: читается ли направление
// без подсказки, видно ли разрыв, не сливается ли сталь с породой — всё это
// решается только глазом. Снимаются два кадра подряд с интервалом в один шаг
// переноса: по паре видно, куда бежит полоса.
{
  const module = new LandingModule(receiver);
  const registry = new BuildingRegistry();
  const sim = new Simulation();

  // Полость под поверхностью: ленте нужен ровный пролёт, а рельеф его не даёт.
  const left = 60;
  const right = 300;
  const top = 176;
  const bottom = 208;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) world.set(x, y, MAT.VACUUM);
  }

  // Ленты кладутся СЕКЦИЯМИ по сетке — так же, как их кладёт игрок.
  const sz = CONVEYOR.size;
  const rows = [
    { y: 204, kind: MAT.CONVEYOR_RIGHT, gapAt: -1 },
    { y: 192, kind: MAT.CONVEYOR_LEFT, gapAt: -1 },
    // Разрыв в ленте: пропущенная секция обязана читаться глазом — там,
    // где ленты нет, нет ни корпуса, ни полосы.
    { y: 180, kind: MAT.CONVEYOR_RIGHT, gapAt: 188 },
  ];
  for (const row of rows) {
    for (let sx = left + 8; sx <= right - 8; sx += sz) {
      if (sx === row.gapAt) continue;
      for (let dy = 0; dy < sz; dy++) {
        for (let dx = 0; dx < sz; dx++) world.set(sx + dx, row.y + dy, row.kind);
      }
    }
    // Груз: все четыре сыпучих вещества вперемешку — лента не сортирует.
    const cargo = [MAT.REGOLITH_LOOSE, MAT.PULP, MAT.IRIDIUM, MAT.SLAG];
    for (let i = 0; i < 24; i++) {
      world.set(left + 20 + i * 4, row.y - 1, cargo[i % cargo.length]!);
    }
  }

  for (let i = 0; i < 240; i++) {
    sim.update(world, null);
    registry.update(world, FIXED_DT);
    module.update(world);
  }

  const camera = new Camera(world.width, world.height);
  camera.snapTo((left + right) / 2, 194);
  const player = new Player(150, 204 - PLAYER.hitboxH);
  const hudBelt: HudState = { ...hud, activeSlot: 1, buildKind: 'Конвейер ▶ 32 ₡' };

  // Два кадра подряд: время различается ровно на один шаг переноса, поэтому
  // на верхней ленте полоса сдвинута вправо, на средней — влево.
  renderer.render({
    camera: camera,
    player: player,
    crosshairX: BASE_VIEW_W / 2,
    crosshairY: BASE_VIEW_H / 2,
    crosshairInReach: true,
    hud: hudBelt,
    fps: 0,
    time: 3,
  });
  writeFileSync(`shots/conveyor${suffix}.png`, encodePng(pixels, 3, FULL));
  const stripes = countColor(CONVEYOR_STRIPE_COLOR);
  writeFileSync(
    `shots/zoom-conveyor${suffix}.png`,
    encodePng(pixels, 6, { x: 168 - camera.x, y: 176 - camera.y, w: 64, h: 34 }),
  );

  renderer.render({
    camera: camera,
    player: player,
    crosshairX: BASE_VIEW_W / 2,
    crosshairY: BASE_VIEW_H / 2,
    crosshairInReach: true,
    hud: hudBelt,
    fps: 0,
    time: 3 + CONVEYOR.stepsPerCell / SIM_HZ,
  });
  writeFileSync(
    `shots/zoom-conveyor-next${suffix}.png`,
    encodePng(pixels, 6, { x: 168 - camera.x, y: 176 - camera.y, w: 64, h: 34 }),
  );
  // Вырезка вплотную к разрыву: там, где ленты нет, нет ни корпуса, ни полосы,
  // и пропуск обязан читаться как пропуск, а не как тёмный участок ленты.
  writeFileSync(
    `shots/zoom-conveyor-gap${suffix}.png`,
    encodePng(pixels, 14, { x: 176 - camera.x, y: 178 - camera.y, w: 28, h: 8 }),
  );

  console.log(
    `shots/conveyor${suffix}.png`.padEnd(28) +
      ` камера=(${camera.x},${camera.y})  полосы ${stripes}  ` +
      `лент ${rows.length}, секция ${sz}×${sz}, разрыв на x=188`,
  );
}
