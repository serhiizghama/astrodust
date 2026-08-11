/**
 * Растровый шрифт интерфейса: метрики, читаемость и полнота набора.
 *
 * Проверяется буфер пикселей, а не список выведенных строк: текст — часть кадра
 * теми же пикселями, что и мир, и вопрос «что нарисовано» решается только так.
 */
import { drawText, textWidth, hasGlyph, glyphChars, GLYPH_H, TEXT_SHADOW } from '../src/render';
import { RAMP } from '../src/palette';
import { BASE_VIEW_H, VACUUM } from '../src/config';
import { MATERIALS } from '../src/world';
import { BUILD_CATALOG } from '../src/entities';
import { TECHNOLOGIES } from '../src/progress';
import { check } from './harness';

const W = 96;
const H = 24;
/** Незанятый цвет фона: любой изменённый пиксель отличается от него. */
const BG = RAMP.gray[2];
const INK = RAMP.gray[9];

function blank(w = W, h = H): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  const r = (BG >> 16) & 0xff;
  const g = (BG >> 8) & 0xff;
  const b = BG & 0xff;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return px;
}

function colorAt(px: Uint8ClampedArray, w: number, x: number, y: number): number {
  const i = (y * w + x) * 4;
  return (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
}

/** Занятые пиксели: всё, что отличается от фона. */
function ink(px: Uint8ClampedArray, w: number, h: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (colorAt(px, w, x, y) !== BG) out.push({ x, y });
  }
  return out;
}

// --- Метрики ---

{
  const px = blank();
  const before = px.slice();
  drawText(px, W, H, '', 4, 4, INK);
  let same = true;
  for (let i = 0; i < px.length; i++) if (px[i] !== before[i]) same = false;
  check('Шрифт: пустая строка не меняет ни одного пикселя', same && textWidth('') === 0);
}

{
  // Ширина считается ДО отрисовки и обязана совпасть с нарисованным: по ней
  // выравнивают по правому краю и центрируют, и разойтись им нельзя.
  const cases = ['Реголит', '1234', 'Высыпать: Пульпа', 'W/S — выбор', '348/500', 'Ф'];
  const wrong: string[] = [];
  for (const s of cases) {
    const px = blank(256, H);
    drawText(px, 256, H, s, 3, 3, INK, false);
    const dots = ink(px, 256, H);
    const maxX = Math.max(...dots.map((p) => p.x));
    const minX = Math.min(...dots.map((p) => p.x));
    if (maxX - 3 + 1 !== textWidth(s) || minX < 3)
      wrong.push(`${s}: ${maxX - 2} ≠ ${textWidth(s)}`);
  }
  check(
    'Шрифт: объявленная ширина совпадает с крайним занятым пикселем',
    wrong.length === 0,
    wrong.join('; ') || `строк ${cases.length}`,
  );
}

{
  // Тот же вопрос для КАЖДОГО глифа набора: заодно ловится глиф, у которого
  // строк не семь или столбцов больше пяти, — он вылез бы за свою коробку.
  const wrong: string[] = [];
  for (const ch of glyphChars()) {
    if (ch === ' ') continue;
    const px = blank(16, H);
    drawText(px, 16, H, ch, 2, 2, INK, false);
    const dots = ink(px, 16, H);
    if (dots.length === 0) {
      wrong.push(`${ch}: пусто`);
      continue;
    }
    const maxX = Math.max(...dots.map((p) => p.x));
    const minY = Math.min(...dots.map((p) => p.y));
    const maxY = Math.max(...dots.map((p) => p.y));
    if (maxX - 2 + 1 !== textWidth(ch)) wrong.push(`${ch}: ширина`);
    if (minY < 2 || maxY >= 2 + GLYPH_H) wrong.push(`${ch}: высота`);
  }
  check(
    'Шрифт: каждый глиф укладывается в свою коробку и в свою ширину',
    wrong.length === 0,
    wrong.slice(0, 8).join('; ') || `глифов ${glyphChars().length}`,
  );
}

check(
  'Шрифт: строка текста не занимает и десятой части высоты опорного кадра',
  GLYPH_H <= BASE_VIEW_H / 10,
  `${GLYPH_H} ≤ ${BASE_VIEW_H / 10}`,
);

{
  // Ширина вычислима заранее и одинакова от вызова к вызову: браузер и система
  // на неё не влияют, потому что их никто не спрашивает.
  const s = 'Спёкшийся реголит 1234';
  const a = blank(256, H);
  const b = blank(256, H);
  drawText(a, 256, H, s, 5, 5, INK);
  drawText(b, 256, H, s, 5, 5, INK);
  let same = true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
  check(
    'Шрифт: одна и та же строка выводится одинаково и одной ширины',
    same && textWidth(s) === textWidth(s),
    `ширина ${textWidth(s)}`,
  );
}

// --- Границы буфера ---

{
  // Вывод за краем кадра обязан пропасть, а не завернуться на соседнюю строку
  // и не уйти за массив: раскладка считается от размера буфера, который меняется
  // вместе с окном, и промах на краю неизбежен.
  const w = 40;
  const h = 12;
  const px = blank(w, h);
  const tail = 8;
  const padded = new Uint8ClampedArray((w * h + tail) * 4);
  padded.set(px);
  padded.fill(17, w * h * 4);

  drawText(padded, w, h, 'ШИРОКО', w - 3, h - 4, INK);
  drawText(padded, w, h, 'ШИРОКО', -6, 2, INK);

  let tailIntact = true;
  for (let i = w * h * 4; i < padded.length; i++) if (padded[i] !== 17) tailIntact = false;

  // Заворота нет: справа текст обрезан, слева — тоже, и середина строки 2
  // остаётся фоном.
  const wrapped = colorAt(padded, w, w - 1, 3) !== BG && colorAt(padded, w, 0, 4) !== BG;

  check(
    'Шрифт: вывод за краем кадра не пишет ни за буфер, ни на соседнюю строку',
    tailIntact && !wrapped,
    `хвост цел ${tailIntact}, заворот ${wrapped}`,
  );
}

// --- Читаемость поверх произвольного фона ---

{
  // Подложка в один пиксель по диагонали: мир под надписью бывает любым —
  // светлый реголит, чёрная пещера, полосатая лента, — и текст без подложки
  // на одном из них исчезает.
  const px = blank(256, H);
  drawText(px, 256, H, 'Иридий 210', 4, 4, INK);

  const isInk = (x: number, y: number): boolean => colorAt(px, 256, x, y) === INK;
  let unbacked = 0;
  for (const p of ink(px, 256, H)) {
    if (!isInk(p.x, p.y)) continue;
    // Пиксель, у которого сосед по диагонали не занят самой буквой, обязан
    // нести тень: именно она и держит силуэт надписи на любом фоне.
    if (isInk(p.x + 1, p.y + 1)) continue;
    if (colorAt(px, 256, p.x + 1, p.y + 1) !== TEXT_SHADOW) unbacked++;
  }
  check('Шрифт: у каждой буквы есть подложка по диагонали', unbacked === 0, `без тени ${unbacked}`);

  // Промежуточных оттенков не бывает: в кадре ровно фон, цвет буквы и цвет тени.
  const RAMP_SET = new Set(Object.values(RAMP).flat() as number[]);
  const seen = new Set(ink(px, 256, H).map((p) => colorAt(px, 256, p.x, p.y)));
  const outside = [...seen].filter((c) => !RAMP_SET.has(c));
  check(
    'Шрифт: каждый пиксель буквы и тени — цвет палитры, промежуточных нет',
    outside.length === 0 && seen.size === 2 && RAMP_SET.has(TEXT_SHADOW),
    `цветов ${seen.size}, вне палитры ${outside.length}`,
  );
}

// --- Неизвестный символ ---

{
  const missing = '☃';
  check('Шрифт: неизвестный символ в наборе действительно отсутствует', !hasGlyph(missing));

  const px = blank(64, H);
  drawText(px, 64, H, missing, 2, 2, INK, false);
  check(
    'Шрифт: неизвестный символ даёт видимый заполнитель, а не пропуск',
    ink(px, 64, H).length > 0 && textWidth(missing) > 0,
    `ширина ${textWidth(missing)}`,
  );

  // Хвост строки не сдвигается: заполнитель занимает ровно свою объявленную
  // ширину, и всё, что идёт после него, стоит там же, где стояло бы у глифа.
  const head = `А${missing}`;
  const at = textWidth(head) + 1;
  const whole = blank(64, H);
  drawText(whole, 64, H, `${head}Б`, 2, 2, INK, false);
  const tailOnly = blank(64, H);
  drawText(tailOnly, 64, H, 'Б', 2 + at, 2, INK, false);

  let shifted = false;
  for (let y = 0; y < H; y++) {
    for (let x = 2 + at; x < 64; x++) {
      if (colorAt(whole, 64, x, y) !== colorAt(tailOnly, 64, x, y)) shifted = true;
    }
  }
  check('Шрифт: хвост строки за заполнителем не сдвигается', !shifted);
}

// --- Полнота набора относительно текстов игры ---

{
  // Собирается ИЗ ИГРОВЫХ ДАННЫХ, а не из списка в проверке: новое название
  // вещества иначе принесёт дыру в надписи, и обнаружится она на скриншоте.
  const texts: string[] = [];
  for (const m of MATERIALS) if (m) texts.push(m.name);
  for (const k of BUILD_CATALOG) texts.push(k.name);
  for (const t of TECHNOLOGIES) texts.push(t.name, t.description, `нужно ещё ${t.cost} ₡`);

  // Статические надписи интерфейса — списком: в данных их нет, они живут
  // в самом рендере и в сборке снапшота.
  texts.push(
    'ИССЛЕДОВАНИЯ',
    'открыта',
    'W/S — выбор   Space — купить   T — закрыть',
    '▸ ',
    'требует: ',
    'пусто',
    `348/${VACUUM.capacity}   Высыпать: Пульпа`,
    '60 FPS',
    'Q/E: ',
    'слишком далеко',
    'не хватает 15 ₡',
    'место занято',
    'нет опоры',
    'не открыто',
    '0123456789',
  );

  const chars = new Set<string>();
  for (const s of texts) for (const ch of s) chars.add(ch);
  const gaps = [...chars].filter((ch) => !hasGlyph(ch));
  check(
    'Шрифт: у каждого символа игровых текстов есть глиф',
    gaps.length === 0,
    gaps.length > 0 ? `нет глифов: ${gaps.join(' ')}` : `символов ${chars.size}`,
  );
}
