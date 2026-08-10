/**
 * Границы подсистем — проверкой, а не внимательностью.
 *
 * Раскладка по слоям существует затем, чтобы на вопрос «что прочитать для этой
 * задачи» был ограниченный ответ. Держится она ровно до первого импорта не в ту
 * сторону, а такой импорт компилятору безразличен: TypeScript одинаково рад
 * и слоистому графу, и клубку.
 *
 * Разбор — регулярным выражением по строкам `import`: файлы форматирует
 * Prettier, форма импортов однородна, и полноценный парсер тут не окупается.
 * Линтера в проекте нет намеренно — это дев-зависимость с плагинами ради
 * проверки на полсотни строк, а проверка падает в том же прогоне, что и всё
 * остальное.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { check } from './harness';

const SRC = resolve(process.cwd(), 'src');

/**
 * Уровень слоя: импортировать разрешено только СТРОГО ВНИЗ, на больший номер.
 *
 * Строго, а не «не выше»: два модуля одного уровня, ссылающиеся друг на друга,
 * — это и есть тот клубок, ради которого проверка написана.
 */
const LEVEL: Record<string, number> = {
  '': -1, // main.ts и всё, что лежит прямо в src/ (кроме листьев)
  app: 0,
  render: 1,
  core: 2,
  systems: 3,
  entities: 4,
  progress: 5,
  audio: 5,
  world: 6,
};

/** Листы: ни одного импорта, их читают все. */
const LEAVES = ['config.ts', 'palette.ts', 'geometry.ts'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC);

/** Подсистема файла: первый каталог под `src/`, либо '' для корня. */
function subsystemOf(file: string): string {
  const rel = relative(SRC, file);
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0]! : '';
}

/** Разрешает относительный путь импорта в файл `src/**`, либо null. */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
    if (files.includes(cand)) return cand;
  }
  return null;
}

interface Edge {
  from: string;
  to: string;
  spec: string;
}

const edges: Edge[] = [];
const importsOf = new Map<string, string[]>();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const specs = [...src.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)';/gm)].map(
    (m) => m[1]!,
  );
  const targets: string[] = [];
  for (const spec of specs) {
    const to = resolveImport(file, spec);
    if (to === null) continue;
    edges.push({ from: file, to, spec });
    targets.push(to);
  }
  importsOf.set(file, targets);
}

const short = (f: string) => relative(SRC, f);

// --- Листы ни от чего не зависят ---------------------------------------------
{
  const bad: string[] = [];
  for (const leaf of LEAVES) {
    const p = join(SRC, leaf);
    const deps = importsOf.get(p) ?? [];
    if (deps.length > 0) bad.push(`${leaf} → ${deps.map(short).join(', ')}`);
  }
  check(
    'Листы (config, palette, geometry) не импортируют ничего',
    bad.length === 0,
    bad.join('; ') || `проверено ${LEAVES.length}`,
  );
}

// --- Импорт из чужой подсистемы только через её index.ts ----------------------
{
  const bad: string[] = [];
  for (const e of edges) {
    const from = subsystemOf(e.from);
    const to = subsystemOf(e.to);
    if (to === '' || from === to) continue;
    if (!e.to.endsWith('/index.ts')) bad.push(`${short(e.from)} → ${e.spec}`);
  }
  check(
    'Из чужой подсистемы импортируется только её index.ts',
    bad.length === 0,
    bad.slice(0, 5).join('; ') || `рёбер между подсистемами ${edges.length}`,
  );
}

// --- Направление слоёв --------------------------------------------------------
{
  const bad: string[] = [];
  for (const e of edges) {
    const from = subsystemOf(e.from);
    const to = subsystemOf(e.to);
    if (from === to) continue;
    if (LEAVES.includes(relative(SRC, e.to))) continue;
    const a = LEVEL[from];
    const b = LEVEL[to];
    if (a === undefined || b === undefined) continue;
    if (a >= b) bad.push(`${short(e.from)} (${from}:${a}) → ${short(e.to)} (${to}:${b})`);
  }
  check(
    'Слой импортирует только слои ниже себя',
    bad.length === 0,
    bad.slice(0, 5).join('; ') || 'нарушений нет',
  );
}

// --- Мир ничего не знает о том, кто в нём живёт --------------------------------
{
  const bad = edges
    .filter((e) => subsystemOf(e.from) === 'world' && subsystemOf(e.to) !== 'world')
    .filter((e) => !LEAVES.includes(relative(SRC, e.to)))
    .map((e) => `${short(e.from)} → ${e.spec}`);
  check(
    'world/ не зависит ни от сущностей, ни от прогресса, ни от рендера',
    bad.length === 0,
    bad.join('; ') || 'чисто',
  );
}

// --- Граф ацикличен -----------------------------------------------------------
{
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(files.map((f) => [f, WHITE]));
  let cycle = '';

  function visit(node: string, path: string[]): void {
    if (cycle) return;
    color.set(node, GRAY);
    for (const next of importsOf.get(node) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        const at = path.indexOf(next);
        cycle = [...path.slice(at === -1 ? path.length - 1 : at), next].map(short).join(' → ');
        return;
      }
      if (c === WHITE) visit(next, [...path, next]);
      if (cycle) return;
    }
    color.set(node, BLACK);
  }

  for (const f of files) if (color.get(f) === WHITE) visit(f, [f]);

  check(
    'Граф импортов ацикличен',
    cycle === '',
    cycle || `модулей ${files.length}, рёбер ${edges.length}`,
  );
}
