import { TECHNOLOGIES, TECH_BY_ID } from './technologies';

/**
 * Раскладка дерева технологий — КОЛОНКА И СТРОКА, а не пиксели.
 *
 * ```
 *   колонка 0        колонка 1
 *   ┌────────┐
 *   │ лента  │  строка 0
 *   └────────┘
 *   ┌────────┐       ┌────────┐
 *   │ раструб│──────▶│  тяга  │  строка 1
 *   └────────┘       └────────┘
 *   ┌────────┐
 *   │ сопла  │  строка 2
 *   └────────┘
 * ```
 *
 * Считается ИЗ ГРАФА, а не задаётся в таблице. Координаты руками отменили бы
 * записанное требование «новая технология — строка таблицы», а главное — могут
 * противоречить предпосылкам МОЛЧА: ребро, идущее справа налево, не выглядит
 * ошибкой ни для компилятора, ни для проверок.
 *
 * Здесь нет ни одного числа в пикселях: колонка и строка — свойство графа,
 * а не кадра. Переводит их в координаты рендер, ходит по ним оверлей, и
 * разложить одно и то же дважды нельзя по построению.
 *
 * Держит `tests/research.ts`.
 */

export interface TechNode {
  readonly id: string;
  /** Длина самой длинной цепочки предпосылок до узла. */
  readonly col: number;
  /** Порядковый номер среди узлов той же колонки, по порядку таблицы. */
  readonly row: number;
}

/** Ребро графа: индексы в `TECHNOLOGIES`, от предпосылки к зависящему узлу. */
export interface TechEdge {
  readonly from: number;
  readonly to: number;
}

/**
 * Глубина узла: 0 без предпосылок, иначе на единицу больше самой глубокой
 * из них. САМАЯ ДЛИННАЯ цепочка, а не любая: узел обязан стоять правее КАЖДОЙ
 * своей предпосылки, иначе ребро пойдёт справа налево.
 *
 * Обход с памятью на посчитанное. Ацикличность держит отдельная проверка;
 * защита от зацикливания здесь — `seen`: цикл дал бы бесконечную рекурсию
 * ещё до того, как проверка успела бы о нём сообщить.
 */
function depthOf(id: string, memo: Map<string, number>, seen: Set<string>): number {
  const known = memo.get(id);
  if (known !== undefined) return known;
  if (seen.has(id)) return 0;
  seen.add(id);

  const tech = TECH_BY_ID.get(id);
  let depth = 0;
  if (tech) {
    for (const req of tech.requires) {
      const d = depthOf(req, memo, seen) + 1;
      if (d > depth) depth = d;
    }
  }

  seen.delete(id);
  memo.set(id, depth);
  return depth;
}

function buildNodes(): readonly TechNode[] {
  const memo = new Map<string, number>();
  const seen = new Set<string>();
  const filled: number[] = [];

  return TECHNOLOGIES.map((tech) => {
    const col = depthOf(tech.id, memo, seen);
    const row = filled[col] ?? 0;
    filled[col] = row + 1;
    return { id: tech.id, col, row };
  });
}

/** Узел на каждую технологию, по индексу в `TECHNOLOGIES`. */
export const TECH_NODES: readonly TechNode[] = buildNodes();

/** Индекс технологии по идентификатору. Нужен рёбрам: они ссылаются номерами. */
const INDEX_BY_ID = new Map(TECHNOLOGIES.map((t, i) => [t.id, i]));

function buildEdges(): readonly TechEdge[] {
  const edges: TechEdge[] = [];
  for (let to = 0; to < TECHNOLOGIES.length; to++) {
    for (const req of TECHNOLOGIES[to]!.requires) {
      const from = INDEX_BY_ID.get(req);
      if (from !== undefined) edges.push({ from, to });
    }
  }
  return edges;
}

export const TECH_EDGES: readonly TechEdge[] = buildEdges();

/** Габариты сетки в узлах. Рендер считает по ним размер дерева в пикселях. */
export const TECH_COLS = TECH_NODES.reduce((n, node) => Math.max(n, node.col + 1), 0);
export const TECH_ROWS = TECH_NODES.reduce((n, node) => Math.max(n, node.row + 1), 0);

/**
 * Переход выбора на соседний узел.
 *
 * По вертикали — соседняя строка той же колонки. По горизонтали — узел
 * соседней колонки с ближайшей строкой; при равном расстоянии выигрывает
 * меньшая строка, иначе переход зависел бы от порядка перебора.
 *
 * Упирается в край, а не заворачивается: заворачивание в графе читается
 * как промах, а не как навигация. Пустая соседняя колонка невозможна —
 * колонка `n > 0` существует только потому, что в ней стоит узел с цепочкой
 * длины `n`, а значит в колонке `n-1` стоит его предпосылка.
 *
 * @returns индекс нового выбранного узла; тот же самый, если идти некуда
 */
export function stepTo(index: number, dx: number, dy: number): number {
  const from = TECH_NODES[index];
  if (!from) return index;

  if (dy !== 0) {
    const row = from.row + Math.sign(dy);
    const at = TECH_NODES.findIndex((n) => n.col === from.col && n.row === row);
    return at < 0 ? index : at;
  }

  if (dx !== 0) {
    const col = from.col + Math.sign(dx);
    let best = index;
    let bestDist = Infinity;
    for (let i = 0; i < TECH_NODES.length; i++) {
      const n = TECH_NODES[i]!;
      if (n.col !== col) continue;
      const dist = Math.abs(n.row - from.row);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  return index;
}
