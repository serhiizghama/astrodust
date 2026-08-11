/**
 * Запуск наборов проверок.
 *
 * `npm test` — все наборы, `npm test -- conveyor` — только совпавшие по имени.
 *
 * Порядок наборов — тот же, в котором проверки шли раньше одним файлом: мир
 * из `harness` общий и меняется ходьбой, поэтому порядок наблюдаем.
 *
 * Имена наборов совпадают с каталогами `openspec/specs/` — вопрос «чем покрыто
 * требование» решается открытием файла с тем же именем, что у спеки.
 */
import { report } from './harness';

const SUITES: Record<string, () => Promise<unknown>> = {
  architecture: () => import('./architecture'),
  'pixel-world': () => import('./pixel-world'),
  'ui-layer': () => import('./ui-layer'),
  'game-hud': () => import('./game-hud'),
  'player-movement': () => import('./player-movement'),
  'game-shell': () => import('./game-shell'),
  'material-simulation': () => import('./material-simulation'),
  'terrain-digging': () => import('./terrain-digging'),
  'player-inventory': () => import('./player-inventory'),
  'landing-module': () => import('./landing-module'),
  'building-placement': () => import('./building-placement'),
  separator: () => import('./separator'),
  conveyor: () => import('./conveyor'),
  research: () => import('./research'),
  'space-backdrop': () => import('./space-backdrop'),
  'surface-shading': () => import('./surface-shading'),
  'procedural-audio': () => import('./procedural-audio'),
};

const filter = process.argv[2] ?? '';
const selected = Object.keys(SUITES).filter((name) => name.includes(filter));

if (selected.length === 0) {
  console.error(`Нет наборов по фильтру «${filter}». Доступны: ${Object.keys(SUITES).join(', ')}`);
  process.exit(1);
}

for (const name of selected) {
  console.log(`\n=== ${name} ===`);
  await SUITES[name]!();
}

report();
