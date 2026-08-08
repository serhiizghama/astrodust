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
import type { HudState } from '../src/render/renderer';
import { WORLD_SEED, VIEW_W, VIEW_H, VACUUM, MODULE } from '../src/config';
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

const { world, spawn, surface } = generateLuna(WORLD_SEED);
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
