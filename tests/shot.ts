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
import { generateLuna } from '../src/world/worlds/luna';
import { Camera } from '../src/render/camera';
import { Renderer } from '../src/render/renderer';
import { Player } from '../src/entities/player';
import { LandingModule } from '../src/entities/landing-module';
import { BuildingRegistry } from '../src/entities/buildings';
import { SEPARATOR_KIND } from '../src/entities/separator';
import { Builder } from '../src/world/builder';
import { Simulation } from '../src/world/simulation';
import { MAT, MATERIALS, CONVEYOR_STRIPE_COLOR } from '../src/world/materials';
import type { HudState } from '../src/render/renderer';
import {
  WORLD_SEED,
  VIEW_W,
  VIEW_H,
  VACUUM,
  MODULE,
  SEPARATOR,
  PLAYER,
  FIXED_DT,
  CONVEYOR,
  SIM_HZ,
} from '../src/config';
import type { Display } from '../src/core/display';

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
    const srcRow = (crop.y + ((y / scale) | 0)) * VIEW_W;
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

const pixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

const fakeDisplay = {
  pixels,
  ctx: {
    putImageData() {},
    fillText() {},
    // Строка состояния выравнивает счёт по правому краю и спрашивает ширину
    // надписи. Моноширинный 8px — примерно 4.8 пикселя на знак.
    measureText: (s: string) => ({ width: s.length * 4.8 }),
    font: '',
    textBaseline: '',
    fillStyle: '',
  },
  image: {},
  present() {},
} as unknown as Display;

const { world, spawn, surface, receiver } = generateLuna(WORLD_SEED);
const renderer = new Renderer(fakeDisplay, world, surface, WORLD_SEED);

const suffix = process.argv[2] ? `-${process.argv[2]}` : '';
mkdirSync('shots', { recursive: true });

const FULL: Crop = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

/**
 * Точки съёмки. Кроме общих планов — увеличенные вырезки: детали вроде диска
 * Земли и пунктира на гребне при масштабе ×3 просто не видно, а судить о них
 * по числам нельзя.
 */
const SHOTS: Array<{ name: string; camX: number; camY: number; scale?: number; crop?: Crop }> = [
  { name: 'sky', camX: 500, camY: 0 },
  { name: 'surface', camX: spawn.x, camY: spawn.y },
  // Посадочный модуль: единственное рукотворное тело в мире, и единственное
  // место, где проверяется, читается ли оно рукотворным. Камера чуть выше
  // площадки — иначе стенки уходят за нижний край.
  { name: 'module', camX: MODULE.x + MODULE.width / 2, camY: spawn.y - 20 },
  {
    name: 'zoom-module',
    camX: MODULE.x + MODULE.width / 2,
    camY: spawn.y - 20,
    scale: 6,
    // Камера у левого края мира упирается в кламп и стоит на x=0, поэтому
    // экранная колонка корпуса совпадает с мировой.
    crop: { x: 50, y: 96, w: 56, h: 56 },
  },
  { name: 'horizon', camX: 780, camY: 60 },
  { name: 'cave', camX: 700, camY: 310 },
  { name: 'zoom-earth', camX: 500, camY: 0, scale: 10, crop: { x: 226, y: 22, w: 44, h: 42 } },
  { name: 'zoom-ridge', camX: 500, camY: 0, scale: 6, crop: { x: 80, y: 74, w: 160, h: 72 } },
];

/** Считает, сколько пикселей кадра окрашены в точно заданный цвет. */
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

const bd = world.profile.backdrop;

/**
 * Строка состояния с непустым инвентарём: на снимке она всё равно не видна —
 * текст рисуется в контекст канваса ПОСЛЕ вывода буфера, а PNG кодируется
 * из буфера, — но входит в кадр наравне со всем остальным, и подсовывать
 * рендеру пустую заглушку значило бы снимать не то, что видит игрок.
 */
const hud: HudState = {
  // Режим копания — тот, с которого начинается партия. Он же оставляет прицел
  // прежним, поэтому снимки сравнимы с базовыми: расхождение будет означать
  // изменение мира или задника, а не смену формы крестика.
  mode: 'Копание',
  collecting: false,
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
  machineSummary: '',
};

for (const shot of SHOTS) {
  const camera = new Camera(world.width, world.height);
  camera.snapTo(shot.camX, shot.camY);
  // Персонаж — в центре кадра, на видимой опоре под ним, если она есть.
  const player = new Player(camera.x + VIEW_W / 2, camera.y + VIEW_H / 2);
  renderer.render(camera, player, VIEW_W / 2 + 20, VIEW_H / 2, true, hud, 0, 3);

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
  const placed = Builder.apply(world, registry, module, SEPARATOR_KIND, cx, cy, cx, cy);

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
  renderer.render(
    camera,
    player,
    VIEW_W / 2,
    VIEW_H / 2,
    true,
    {
      ...hud,
      mode: 'Строительство',
      machineSummary: machine ? `Сепараторы 1 · ${machine.state}` : '',
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
    0,
  );

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
  console.log(
    `shots/separator${suffix}.png`.padEnd(28) +
      ` постановка ${placed}, состояние ${machine?.state}, ` +
      `иридия ${countColor(MATERIALS[MAT.IRIDIUM]!.color)}, шлака ${countColor(MATERIALS[MAT.SLAG]!.color)}`,
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
  const hudBelt: HudState = { ...hud, mode: 'Строительство', buildKind: 'Конвейер ▶' };

  // Два кадра подряд: время различается ровно на один шаг переноса, поэтому
  // на верхней ленте полоса сдвинута вправо, на средней — влево.
  renderer.render(camera, player, VIEW_W / 2, VIEW_H / 2, true, hudBelt, 0, 3);
  writeFileSync(`shots/conveyor${suffix}.png`, encodePng(pixels, 3, FULL));
  const stripes = countColor(CONVEYOR_STRIPE_COLOR);
  writeFileSync(
    `shots/zoom-conveyor${suffix}.png`,
    encodePng(pixels, 6, { x: 168 - camera.x, y: 176 - camera.y, w: 64, h: 34 }),
  );

  renderer.render(
    camera,
    player,
    VIEW_W / 2,
    VIEW_H / 2,
    true,
    hudBelt,
    0,
    3 + CONVEYOR.stepsPerCell / SIM_HZ,
  );
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
