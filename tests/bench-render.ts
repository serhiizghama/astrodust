/**
 * Замер стоимости кадра без браузера.
 *
 * Запуск: npm run bench
 *
 * Зачем не счётчик FPS в игре: цикл висит на requestAnimationFrame и упирается
 * в вертикальную синхронизацию. На мониторе 60 Гц и «дорогой», и «дешёвый»
 * рендер одинаково покажут 60 FPS, и сравнение до/после ничего не докажет.
 * Здесь кадр вызывается в цикле без синхронизации, поэтому видно реальную
 * стоимость в миллисекундах.
 *
 * Display подменяется заглушкой: рендеру от него нужен только буфер пикселей,
 * а вывод на канвас к стоимости расчёта отношения не имеет.
 */
import { generateLuna } from '../src/world/worlds/luna';
import { Camera } from '../src/render/camera';
import { Renderer } from '../src/render/renderer';
import type { HudState } from '../src/render/renderer';
import { Player } from '../src/entities/player';
import { WORLD_SEED, VIEW_W, VIEW_H, VACUUM } from '../src/config';
import type { Display } from '../src/core/display';

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
const player = new Player(spawn.x, spawn.y);

/**
 * Строка состояния в начале партии. Замер меряет проход по миру, а не текст,
 * но рисуется она всегда — значит, и в замер обязана входить.
 */
const hud: HudState = {
  mode: 'Копание',
  collecting: false,
  carried: [],
  used: 0,
  capacity: VACUUM.capacity,
  selected: 'Реголит',
  credits: 0,
};

/** Средняя стоимость кадра в миллисекундах для заданного положения камеры. */
function measure(label: string, targetX: number, targetY: number): void {
  const camera = new Camera(world.width, world.height);
  camera.snapTo(targetX, targetY);

  // Прогрев: без него в замер попадает компиляция горячего цикла.
  for (let i = 0; i < 300; i++) renderer.render(camera, player, 240, 135, true, hud, 0);

  const frames = 3000;
  const started = performance.now();
  for (let i = 0; i < frames; i++) renderer.render(camera, player, 240, 135, true, hud, 0);
  const perFrame = (performance.now() - started) / frames;

  // Доля неба в кадре — по ней видно, что именно оплачивается.
  let skyPixels = 0;
  for (let sy = 0; sy < VIEW_H; sy++) {
    for (let sx = 0; sx < VIEW_W; sx++) {
      if (camera.y + sy < surface[camera.x + sx]!) skyPixels++;
    }
  }
  const skyShare = ((skyPixels / (VIEW_W * VIEW_H)) * 100).toFixed(0);

  console.log(
    `${label.padEnd(28)} ${perFrame.toFixed(3)} мс/кадр` +
      `   камера=(${camera.x},${camera.y})  неба ${skyShare}%`,
  );
}

console.log('Стоимость кадра (меньше — лучше)\n');
measure('Максимум неба', 500, 0);
measure('Поверхность (точка старта)', spawn.x, spawn.y);
measure('Лавовая трубка', 700, 310);
