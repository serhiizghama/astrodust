import { World } from './world';
import { MAT, MATERIALS } from './materials';

/**
 * Реакции веществ: пара соприкасающихся ячеек превращается в пару продуктов.
 *
 * Слой ПОВЕРХ автомата, а не ветка внутри: новая реакция — строка таблицы ниже.
 *
 * Инвариант 1: соприкосновение — соседство ПО СТОРОНЕ. Диагональ контактом
 * не является: реакция через угол двух стенок выглядела бы просачиванием.
 *
 * Инвариант 2: пара на входе даёт пару на выходе. «Вещество не исчезает»
 * держится во всей модели, и реакция не имеет права это нарушить.
 */
export interface Reaction {
  readonly a: number;
  readonly b: number;
  readonly toA: number;
  readonly toB: number;
}

export const REACTIONS: readonly Reaction[] = [
  /** Рыхлый реголит + вода = две ячейки пульпы. То, ради чего вода — ресурс. */
  { a: MAT.REGOLITH_LOOSE, b: MAT.WATER, toA: MAT.PULP, toB: MAT.PULP },
];

const size = MATERIALS.length;

/**
 * Таблица переходов по паре идентификаторов. Плоские массивы, а не поиск
 * по списку: проверка идёт на каждое успешное перемещение ячейки. Пара
 * пишется в обе стороны — порядок соседей заранее неизвестен.
 *
 * Ноль значит «реакции нет»: пустота продуктом быть не может по построению.
 */
const PRODUCT_A = new Uint8Array(size * size);
const PRODUCT_B = new Uint8Array(size * size);

/**
 * Участвует ли вещество хоть в одной реакции. Ранний отказ одним обращением
 * к массиву: большинство перемещений делают нереагирующие вещества, и платить
 * за них обходом четырёх соседей нельзя.
 */
export const MAT_REACTIVE = new Uint8Array(size);

for (const r of REACTIONS) {
  PRODUCT_A[r.a * size + r.b] = r.toA;
  PRODUCT_B[r.a * size + r.b] = r.toB;
  PRODUCT_A[r.b * size + r.a] = r.toB;
  PRODUCT_B[r.b * size + r.a] = r.toA;
  MAT_REACTIVE[r.a] = 1;
  MAT_REACTIVE[r.b] = 1;
}

/**
 * Применяет первую подошедшую реакцию с соседом по стороне.
 *
 * Инвариант: порядок обхода фиксирован (вверх, вниз, влево, вправо) — иначе
 * исход зависел бы от того, сколько соседей подошло. Больше одной реакции
 * за вызов не бывает: ячейка, ставшая продуктом, исходной уже не существует.
 *
 * Продукты пишутся через `world.set`, а не напрямую: их окрестность обязана
 * проснуться, иначе продукт не двинется до следующего чужого пробуждения.
 *
 * @returns сработала ли реакция
 */
export function reactAround(world: World, x: number, y: number): boolean {
  const m = world.get(x, y);
  if (MAT_REACTIVE[m] !== 1) return false;

  const row = m * size;
  // Явно, а не циклом по массиву смещений: обход четырёх направлений не стоит
  // аллокации на каждое перемещение ячейки.
  if (tryPair(world, row, x, y, x, y - 1)) return true;
  if (tryPair(world, row, x, y, x, y + 1)) return true;
  if (tryPair(world, row, x, y, x - 1, y)) return true;
  return tryPair(world, row, x, y, x + 1, y);
}

function tryPair(world: World, row: number, x: number, y: number, nx: number, ny: number): boolean {
  // За пределами сетки `get` отдаёт породу — она не реагирует, и проверка
  // границ не нужна.
  const n = world.get(nx, ny);
  const a = PRODUCT_A[row + n]!;
  if (a === 0) return false;

  world.set(x, y, a);
  world.set(nx, ny, PRODUCT_B[row + n]!);
  return true;
}
