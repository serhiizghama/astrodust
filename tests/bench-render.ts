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
import { generateLuna } from '../src/world';
import { Camera, Renderer } from '../src/render';
import type { HudState } from '../src/render';
import { Player } from '../src/entities';
import {
  WORLD_SEED,
  BASE_VIEW_W,
  BASE_VIEW_H,
  MAX_VIEW_W,
  MAX_VIEW_H,
  VACUUM,
} from '../src/config';
import type { Display } from '../src/core';

/**
 * Размер кадра — величина рантайма, поэтому замеряются оба края диапазона:
 * опорный кадр и потолок разрешения буфера. Между ними стоимость линейна
 * по площади, и промежуточные окна ничего нового не показывают.
 */
const fakeDisplay = {
  pixels: new Uint8ClampedArray(MAX_VIEW_W * MAX_VIEW_H * 4),
  ctx: {
    putImageData() {},
    fillText() {},
    // Строка состояния выравнивает счёт по правому краю и спрашивает ширину
    // надписи. Моноширинный 16px — примерно 9.6 пикселя на знак.
    measureText: (s: string) => ({ width: s.length * 9.6 }),
    font: '',
    textBaseline: '',
    fillStyle: '',
  },
  width: BASE_VIEW_W,
  height: BASE_VIEW_H,
  image: {},
  present() {},
} as unknown as Display;

const view = fakeDisplay as unknown as { width: number; height: number };
for (let i = 3; i < fakeDisplay.pixels.length; i += 4) fakeDisplay.pixels[i] = 255;

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
  collectRadius: VACUUM.radius,
  carried: [],
  used: 0,
  capacity: VACUUM.capacity,
  selected: 'Реголит',
  credits: 0,
  research: 0,
  buildKind: '',
  buildIssue: '',
  ghost: null,
  machines: [],
  machineSummary: '',
  overlay: null,
};

/** Средняя стоимость кадра в миллисекундах для заданного положения камеры. */
function measure(label: string, targetX: number, targetY: number): void {
  const camera = new Camera(world.width, world.height);
  camera.setViewport(view.width, view.height);
  camera.snapTo(targetX, targetY);

  // Прогрев: без него в замер попадает компиляция горячего цикла.
  for (let i = 0; i < 300; i++)
    renderer.render({
      camera: camera,
      player: player,
      crosshairX: 240,
      crosshairY: 135,
      crosshairInReach: true,
      hud: hud,
      fps: 0,
    });

  const frames = 3000;
  const started = performance.now();
  for (let i = 0; i < frames; i++)
    renderer.render({
      camera: camera,
      player: player,
      crosshairX: 240,
      crosshairY: 135,
      crosshairInReach: true,
      hud: hud,
      fps: 0,
    });
  const perFrame = (performance.now() - started) / frames;

  // Доля неба в кадре — по ней видно, что именно оплачивается.
  let skyPixels = 0;
  for (let sy = 0; sy < view.height; sy++) {
    for (let sx = 0; sx < view.width; sx++) {
      if (camera.y + sy < surface[camera.x + sx]!) skyPixels++;
    }
  }
  const skyShare = ((skyPixels / (view.width * view.height)) * 100).toFixed(0);

  console.log(
    `${label.padEnd(28)} ${perFrame.toFixed(3)} мс/кадр` +
      `   камера=(${camera.x},${camera.y})  неба ${skyShare}%`,
  );
}

console.log('Стоимость кадра (меньше — лучше)\n');
for (const [w, h, name] of [
  [BASE_VIEW_W, BASE_VIEW_H, 'опорный кадр'],
  [MAX_VIEW_W, MAX_VIEW_H, 'потолок буфера'],
] as const) {
  view.width = w;
  view.height = h;
  console.log(`${name} ${w}×${h}`);
  measure('  Максимум неба', 1000, 0);
  measure('  Поверхность (точка старта)', spawn.x, spawn.y);
  measure('  Лавовая трубка', 1400, 620);
  console.log('');
}
