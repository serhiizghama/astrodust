/**
 * Снимок ИНТЕРФЕЙСА в браузере. Запуск: npm run shot:ui [суффикс]
 * Результат: shots/ui-*.png и стоимость кадра числами.
 *
 * Отдельно от `npm run shot` намеренно: тот снимает мир из буфера пикселей
 * и браузера не требует вовсе. Слой интерфейса векторный — цвета, сглаживания,
 * теней и скруглений вне браузера не существует, и судить о них можно только
 * так. Заодно здесь же меряется цена кадра: тени размывают, и стоить это
 * должно столько, сколько видно в числах, а не «примерно ничего».
 *
 * ЧТО ЭТИМ НЕ ПРОВЕРИТЬ: красиво ли. Это остаётся за человеком — снимки
 * для того и кладутся в `shots/`.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fitFrame } from '../src/core';
import { hudLayout } from '../src/render';

const PORT = 5199;
const VIEWPORT = { width: 1280, height: 720 };

const suffix = process.argv[2] ? `-${process.argv[2]}` : '';
/**
 * Плотность экрана снимка: слой интерфейса обязан рисоваться в ней, а не
 * в сетке кадра. Задаётся вторым доводом — дробная плотность ведёт себя иначе
 * целой, и посмотреть на неё нужно глазами: `npm run shot:ui -- dpr15 1.5`.
 */
const RATIO = Number(process.argv[3] ?? 2);
mkdirSync('shots', { recursive: true });

const fit = fitFrame(VIEWPORT.width, VIEWPORT.height);
const layout = hudLayout(fit.w, fit.h);
/** Ячейки кадра в CSS-пиксели страницы. */
const css = (cells: number): number => cells * fit.scale;

const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: RATIO });
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#game');
// Партия должна успеть встать на ноги: первые кадры уходят на генерацию мира
// и догон карты освещения, и снимок с них показал бы не игру, а её запуск.
await page.waitForTimeout(1500);

/** Средняя и худшая длительность кадра за отрезок. */
async function frameCost(frames = 120): Promise<{ mean: number; worst: number }> {
  return page.evaluate(async (count: number) => {
    const deltas: number[] = [];
    let previous = performance.now();
    await new Promise<void>((done) => {
      const tick = (): void => {
        const now = performance.now();
        deltas.push(now - previous);
        previous = now;
        if (deltas.length >= count) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Первый замер выброшен: в него попадает пауза до начала измерения.
    const kept = deltas.slice(1);
    return {
      mean: kept.reduce((a, b) => a + b, 0) / kept.length,
      worst: Math.max(...kept),
    };
  }, frames);
}

console.log(
  `окно ${VIEWPORT.width}×${VIEWPORT.height}, плотность ×${RATIO} → ` +
    `буфер мира ${fit.w}×${fit.h}, множитель ×${fit.scale}, ` +
    `пикселей устройства на ячейку ${fit.scale * RATIO}`,
);

// --- Панель поверх светлой поверхности ----------------------------------------
//
// Светлый реголит — самый светлый фон в игре: если подложка и ореол текста
// держат контраст здесь, они держат его везде.
{
  // Строительство: разом активный слот, вид постройки и — при негодном месте —
  // причина отказа. Наведение мышью на соседний слот: подсветка обязана
  // отличаться от выделения.
  //
  // Стройка на ТРЕТЬЕМ слоте, а наводимся на второй: четвёртый занят закрытым
  // сбором, а закрытость сильнее наведения — подсветки на нём не увидеть,
  // и снимок перестал бы показывать то, ради чего сделан.
  await page.keyboard.press('Digit3');
  await page.mouse.move(css(layout.slotX + layout.slotStep + 9), css(layout.slotY + 9));
  await page.waitForTimeout(300);

  await page.screenshot({ path: `shots/ui-hud${suffix}.png` });
  await page.screenshot({
    path: `shots/ui-action-bar${suffix}.png`,
    clip: {
      x: css(layout.x) - 8,
      y: css(layout.y) - css(28),
      width: css(layout.w) + 16,
      height: css(layout.h) + css(30),
    },
  });
  await page.screenshot({
    path: `shots/ui-counter${suffix}.png`,
    clip: { x: css(fit.w - 70), y: 0, width: css(70), height: css(24) },
  });

  const world = await frameCost();
  console.log(
    `shots/ui-hud${suffix}.png`.padEnd(30) +
      ` панель ${layout.w}×${layout.h} ячеек в (${layout.x}, ${layout.y}), ` +
      `кадр ${world.mean.toFixed(2)} мс в среднем, худший ${world.worst.toFixed(2)} мс`,
  );
}

// --- Дерево технологий --------------------------------------------------------
{
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(300);
  // Курсор — на узле: снимок, где стрелка в стороне от подсвеченного,
  // показывал бы состояние, которого в игре не бывает.
  await page.mouse.move(css(fit.w / 2), css(fit.h / 2));
  await page.waitForTimeout(200);

  await page.screenshot({ path: `shots/ui-research${suffix}.png` });

  const overlay = await frameCost();
  console.log(
    `shots/ui-research${suffix}.png`.padEnd(30) +
      ` кадр с открытым деревом ${overlay.mean.toFixed(2)} мс в среднем, ` +
      `худший ${overlay.worst.toFixed(2)} мс`,
  );
  await page.keyboard.press('KeyT');
}

// --- Интерфейс над тёмной пещерой ---------------------------------------------
//
// Второй фон, противоположный первому: подложка и ореол обязаны держать
// читаемость и на нём. Персонаж закапывается вниз собственной кистью.
{
  await page.keyboard.press('Digit1');
  await page.keyboard.down('KeyS');
  await page.keyboard.down('Space');
  await page.waitForTimeout(4000);
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyS');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `shots/ui-dark${suffix}.png` });
  console.log(`shots/ui-dark${suffix}.png`.padEnd(30) + ` интерфейс поверх тёмной породы`);
}

await browser.close();
await server.close();
