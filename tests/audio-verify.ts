/**
 * Приёмка звука числами. Запуск: npm run verify:audio
 *
 * Поднимает headless Chromium, рендерит сцены через `OfflineAudioContext`
 * тем же графом, что играет в живой игре, и проверяет утверждения из
 * `specs/procedural-audio/spec.md`, которые раньше приходилось слушать ушами.
 *
 * Отдельно от `npm test` намеренно: тот идёт за миллисекунды и не требует
 * ничего, кроме Node. Здесь браузер, и цена секунды, а не миллисекунды.
 *
 * ЧТО ЭТИМ НЕ ПРОВЕРИТЬ: приятно ли на слух, не утомляет ли тембр, «пыль»
 * против «снега». Это вкус, и он остаётся за человеком.
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { AUDIO } from '../src/config';
import type { Measures } from './audio-scene';

// От корня проекта, а не от `import.meta.url`: этот файл сам проходит через
// esbuild и лежит в момент запуска рядом со своей мишенью, а не там, где написан.
const BUNDLE = resolve(process.cwd(), 'node_modules/.tmp/audio-scene.js');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

/** Порог «ровной тишины»: −80 дБ, ниже разрешения 16-битного звука. */
const SILENT = 1e-4;

/**
 * Порог щелчка. Разрыв волны слышен примерно с 0.05 по амплитуде; шум сам
 * по себе даёт большие скачки от выборки к выборке, поэтому щелчок ищется
 * не в шумной части, а на обрыве — по огибающей.
 */
function envDrop(m: Measures, from: number, to: number): number {
  let worst = 0;
  for (let i = Math.max(1, from); i < Math.min(m.env.length, to); i++) {
    worst = Math.max(worst, m.env[i - 1]! - m.env[i]!);
  }
  return worst;
}

/** Индекс блока огибающей по времени в секундах. */
function envAt(m: Measures, seconds: number): number {
  return Math.round((seconds / m.seconds) * m.env.length);
}

/**
 * Центр тяжести спектра.
 *
 * Проверять «долю энергии внутри полосы» бессмысленно: полоса в таблице
 * `design.md § Решение 7` — это диапазон ХОДА центральной частоты, а не
 * ширина занятого спектра. Полосовой фильтр с добротностью около единицы
 * имеет широкие юбки по построению, и половина энергии лежит снаружи
 * штатно. А вот куда смещён центр тяжести — вопрос осмысленный: именно он
 * отвечает за то, спорят дорожки за одно место или нет.
 */
function centroid(m: Measures): number {
  const binHz = m.sampleRate / ((m.spectrum.length - 1) * 2);
  let weighted = 0;
  let total = 0;
  // Логарифмический, а не линейный. Юбки полосового фильтра симметричны по
  // логарифму частоты, поэтому по линейной шкале верхняя занимает во много
  // раз больше герц, чем нижняя, и центр тяжести уезжает вверх сам собой —
  // не потому, что дорожка звучит выше, а потому, что герцев там больше.
  // Слух тоже логарифмический, так что это ещё и ближе к делу.
  for (let k = 1; k < m.spectrum.length; k++) {
    const p = m.spectrum[k]!;
    weighted += p * Math.log(k * binHz);
    total += p;
  }
  return total > 0 ? Math.exp(weighted / total) : 0;
}

/**
 * Частота, с которой пульсирует громкость: спектр модуляции огибающей.
 *
 * Пришло на смену подсчёту пиков, и не от красоты. Подсчёт пиков требует
 * паузы между ударами, чтобы не считать один за несколько, — а эта пауза
 * сама ставит потолок тому, что можно измерить. Детектор с паузой в 60 мс
 * физически не видит темпа выше 16 в секунду, то есть слеп ровно к той
 * поломке, ради которой заведён: «удары слились в треск».
 *
 * Спектр модуляции потолка не имеет и дрожания огибающей не боится.
 */
function modulationPeak(m: Measures, fromSec: number, toSec: number): number {
  const from = envAt(m, fromSec);
  const to = envAt(m, toSec);
  const n = to - from;
  const envRate = m.env.length / m.seconds;

  // Постоянная составляющая убирается: интересна пульсация, а не громкость.
  let mean = 0;
  for (let i = from; i < to; i++) mean += m.env[i]!;
  mean /= n;

  let bestHz = 0;
  let best = 0;
  for (let hz = 3; hz <= 60; hz += 0.25) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const v = (m.env[from + i]! - mean) * w;
      const a = (-2 * Math.PI * hz * i) / envRate;
      re += v * Math.cos(a);
      im += v * Math.sin(a);
    }
    const mag = Math.hypot(re, im);
    if (mag > best) {
      best = mag;
      bestHz = hz;
    }
  }
  return bestHz;
}

/**
 * Порог слитности слуха: примерно с 20 Гц отдельные события перестают
 * различаться и становятся тембром. Число про слух, а не про настройку,
 * поэтому оно здесь, а не в `config.ts`: подняв потолок темпа в конфиге,
 * этот предел не подвинешь — в том и смысл.
 */
const FUSION_HZ = 20;

const browser = await chromium.launch();
const page = await browser.newPage();
// Пустая страница: игра здесь не нужна, нужен только её звуковой граф.
await page.setContent('<!doctype html><title>audio</title>');
await page.addScriptTag({ path: BUNDLE });

page.on('pageerror', (e) => {
  console.error('ОШИБКА В СТРАНИЦЕ:', e.message);
  failures++;
});

async function render(scene: string): Promise<Measures> {
  return page.evaluate(
    (name) =>
      (window as unknown as { AudioScene: { run(n: string): Promise<Measures> } }).AudioScene.run(
        name,
      ),
    scene,
  );
}

// --- Покой мира ---
{
  const m = await render('silence');
  check(
    'Покой: улёгшийся мир и неподвижный персонаж дают полную тишину',
    m.peak < SILENT,
    `пик ${m.peak.toExponential(2)}`,
  );
}

// --- Копание ---
{
  const m = await render('digNear');
  check('Копание: звук есть', m.peak > 0.01, `пик ${m.peak.toFixed(3)}`);

  // Кисть применяется 30 раз в секунду, но удары обязаны остаться
  // различимыми — не чаще потолка в 12 в секунду.
  // Ровный поток той же средней выработки: помол там пульсировать не может,
  // поэтому вся модуляция огибающей — чистые акценты и ничего больше.
  const steady = await render('digSteady');
  const strikeHz = modulationPeak(steady, 0.5, 2.5);

  check(
    'Копание: акценты идут заявленным темпом',
    Math.abs(strikeHz - AUDIO.dig.strikeHz) <= 1.5,
    `${strikeHz.toFixed(2)} Гц при потолке ${AUDIO.dig.strikeHz}`,
  );

  // Абсолютный якорь: проверка обязана падать, если потолок темпа поднимут
  // выше слышимого предела. Сравнение с самой настройкой такого не ловит —
  // планка уехала бы вместе с ней.
  check(
    'Копание: удары различимы, а не слились в треск',
    strikeHz < FUSION_HZ,
    `${strikeHz.toFixed(2)} Гц против порога слитности ${FUSION_HZ} Гц ` +
      `при 30 применениях кисти/с`,
  );

  // Не утверждение, а показание: помол следует темпу выработки, а кисть
  // работает через шаг, поэтому небольшая рябь на 30 Гц в него заложена.
  console.log(
    `      · рябь помола на реальном темпе кисти: ${modulationPeak(m, 0.5, 2.5).toFixed(1)} Гц`,
  );

  check(
    'Копание: соседние акценты не одна и та же волна',
    m.strikeSimilarity !== undefined && m.strikeSimilarity < 0.9,
    `схожесть ${m.strikeSimilarity?.toFixed(3)}`,
  );

  const c = centroid(m);
  check(
    'Копание: центр тяжести спектра в своей полосе 400 Гц – 4 кГц',
    c >= 400 && c <= 4000,
    `${c.toFixed(0)} Гц`,
  );
}

{
  const m = await render('digEmpty');
  check(
    'Копание: кисть в пустоте не звучит ударом по породе',
    m.peak < SILENT,
    `пик ${m.peak.toExponential(2)}`,
  );
}

{
  const m = await render('digFar');
  check(
    'Вакуум: копание за радиусом контактной слышимости не слышно',
    m.peak < SILENT,
    `пик ${m.peak.toExponential(2)}`,
  );
}

// --- Осыпание ---
{
  const m = await render('dustSwell');
  const quiet = m.env[envAt(m, 0.15)]!;
  const loud = m.env[envAt(m, 1.5)]!;
  check(
    'Осыпание: текстура нарастает вместе с числом движущихся ячеек',
    loud > quiet * 3,
    `${quiet.toFixed(4)} → ${loud.toFixed(4)}`,
  );

  // Движение обрывается на 2.0 с. Экспоненциальный спад обязан увести звук
  // в тишину без разрыва волны.
  const drop = envDrop(m, envAt(m, 1.98), envAt(m, 2.3));
  check(
    'Осыпание: обрыв движения не даёт щелчка',
    drop < 0.02,
    `наибольшая ступенька огибающей ${drop.toFixed(4)}`,
  );

  const tail = m.env[envAt(m, 2.9)]!;
  check(
    'Осыпание: улёгшийся мир сходит к тишине',
    tail < SILENT * 20,
    `хвост ${tail.toExponential(2)}`,
  );

  // Допуск на юбки: сцена загоняет интенсивность в предел, а значит и срез
  // фильтра стоит ровно на верхней границе полосы. Центр тяжести при этом
  // может лежать только ОКОЛО неё, но никак не ниже, — требовать строгого
  // попадания внутрь было бы требованием невозможного.
  const skirt = 1.15;
  const c = centroid(m);
  check(
    'Осыпание: центр тяжести спектра в своей полосе 2–7 кГц',
    c >= AUDIO.dust.hzQuiet / skirt && c <= AUDIO.dust.hzLoud * skirt,
    `${c.toFixed(0)} Гц при срезе на пределе ${AUDIO.dust.hzLoud} Гц`,
  );
}

{
  const m = await render('dustFar');
  check(
    'Вакуум: осыпание дальше 96 пикселей не слышно вообще',
    m.peak < SILENT,
    `пик ${m.peak.toExponential(2)}`,
  );
}

// --- Панорама ---
{
  const right = await render('panRight');
  const left = await render('panLeft');
  check(
    'Панорама: источник справа громче в правом канале',
    right.rmsR > right.rmsL * 1.5,
    `L ${right.rmsL.toFixed(4)} / R ${right.rmsR.toFixed(4)}`,
  );
  check(
    'Панорама: источник слева громче в левом канале',
    left.rmsL > left.rmsR * 1.5,
    `L ${left.rmsL.toFixed(4)} / R ${left.rmsR.toFixed(4)}`,
  );
  check(
    'Панорама: картина зеркальна — перекос одинаков по величине',
    Math.abs(right.rmsR / right.rmsL - left.rmsL / left.rmsR) < 0.2,
    `${(right.rmsR / right.rmsL).toFixed(2)} против ${(left.rmsL / left.rmsR).toFixed(2)}`,
  );
}

// --- Одновременное звучание ---
{
  const both = await render('bothMax');
  check('Все дорожки на пределе: клиппинга нет', both.peak <= 1, `пик ${both.peak.toFixed(3)}`);

  const dig = await render('bothSoloDig');
  const dust = await render('bothSoloDust');
  check(
    'Дорожка слушается в одиночку: с выключенными соседями звучит только она',
    dig.peak > 0.01 && dust.peak > 0.01,
    `dig ${dig.peak.toFixed(3)}, dust ${dust.peak.toFixed(3)}`,
  );

  // Маскировки нет ровно тогда, когда центры тяжести дорожек разнесены.
  // Сравниваются солированные рендеры ОДНОЙ И ТОЙ ЖЕ сцены — разница
  // остаётся за дорожками, а не за тем, что в мире происходит.
  const digC = centroid(dig);
  const dustC = centroid(dust);
  check(
    'Копание поверх осыпания: дорожки не спорят за одно место в спектре',
    dustC > digC * 1.5,
    `копание ${digC.toFixed(0)} Гц, пыль ${dustC.toFixed(0)} Гц`,
  );
}

// --- Отключение звука ---
{
  const m = await render('muteMidCollapse');
  const after = m.env[envAt(m, 1.5)]!;
  check(
    'Отключение по M: звук пропадает',
    after < SILENT,
    `через полсекунды после нажатия ${after.toExponential(2)}`,
  );

  const drop = envDrop(m, envAt(m, 0.98), envAt(m, 1.2));
  check(
    'Отключение по M: без щелчка',
    drop < 0.02,
    `наибольшая ступенька огибающей ${drop.toFixed(4)}`,
  );
}

await browser.close();

console.log(failures === 0 ? '\nЗВУК ПРИНЯТ ЧИСЛАМИ' : `\nПРОВАЛЕНО: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
