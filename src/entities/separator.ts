import { SEPARATOR } from '../config';
import { World } from '../world/world';
import { MAT } from '../world/materials';
import { Building, BuildingRegistry } from './buildings';
import type { BuildingKind, MachineState } from './buildings';

/**
 * Маска корпуса: короб на ногах с выпускным окном между ними.
 *
 * Считается один раз из размеров конфига, а не выписана таблицей: три
 * независимых описания одной формы — контур, постановка, снос — разошлись бы
 * на первой же правке размера.
 */
function separatorShape(): Uint8Array {
  const { width, height, legs, window: windowW, wall } = SEPARATOR;
  const shape = new Uint8Array(width * height);
  const legTop = height - legs;
  const windowFrom = (width - windowW) >> 1;
  const windowTo = windowFrom + windowW;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let solid: boolean;
      if (y === 0) {
        // Приёмная грань — сплошная: сверху в камеру ничего не проваливается,
        // пульпа поглощается тем, что лежит НА грани.
        solid = true;
      } else if (y < legTop) {
        solid = x < wall || x >= width - wall;
      } else {
        // Ноги: корпус по краям, окно посередине.
        solid = x < windowFrom || x >= windowTo;
      }
      shape[y * width + x] = solid ? 1 : 0;
    }
  }
  return shape;
}

export const SEPARATOR_SHAPE = separatorShape();
/** Колонки выпускного окна относительно левого края здания. */
export const OUTLET_FROM = (SEPARATOR.width - SEPARATOR.window) >> 1;
export const OUTLET_TO = OUTLET_FROM + SEPARATOR.window;
/** Ряд выдачи — ВЕРХ окна: под ним остаётся просвет высотой в ноги минус один. */
export const OUTLET_ROW = SEPARATOR.height - SEPARATOR.legs;

/**
 * Сепаратор: принимает пульпу сверху, перерабатывает порциями с задержкой,
 * выдаёт снизу иридий и шлак.
 *
 * Количество ячеек сохраняется на КАЖДОМ пути: N ячеек пульпы дают одну ячейку
 * иридия и N−1 ячеек шлака, забитый выход держит порцию внутри, снос возвращает
 * всё, что не успело переработаться. Это единственная проверка, которой ловится
 * ошибка в любом из правил, и машина не имеет права её ломать.
 */
export class Separator extends Building {
  /** Сырьё, ещё не отправленное в порцию. */
  private buffer = 0;
  /** Остаток задержки. Больше нуля — порция в работе. */
  private timer = 0;
  /** Порция готова, но выйти ей некуда. */
  private pending = false;

  get state(): MachineState {
    if (this.pending) return 'blocked';
    return this.timer > 0 ? 'working' : 'idle';
  }

  get progress(): number {
    if (this.pending) return 1;
    if (this.timer <= 0) return 0;
    return 1 - this.timer / SEPARATOR.delaySec;
  }

  /** Только для проверок и строки состояния. */
  get stored(): number {
    return this.buffer;
  }

  update(world: World, dt: number): void {
    this.absorb(world);

    // Готовая порция пробует выйти первой: пока она внутри, следующая
    // не начинается — иначе забитая машина копила бы порции в никуда.
    if (this.pending) {
      if (!this.emit(world)) return;
      this.pending = false;
    }

    if (this.timer > 0) {
      // Игровым временем, а не числом кадров: на 144 Гц темп обязан быть тем же,
      // что на 60.
      this.timer -= dt;
      if (this.timer > 0) return;
      this.timer = 0;
      this.pending = true;
      if (this.emit(world)) this.pending = false;
      return;
    }

    // Неполная порция ждёт: переработка остатка нарушила бы состав выхода.
    if (this.buffer < SEPARATOR.batch) return;
    this.buffer -= SEPARATOR.batch;
    this.timer = SEPARATOR.delaySec;
  }

  /**
   * Приёмная грань — ряд НАД верхней гранью корпуса.
   *
   * Снаружи, а не внутри камеры: правило «поглощается то, что лежит на грани»
   * повторяет уже работающую зону приёмника модуля, и падать в дырку сверху
   * пульпа не обязана — её насыпают или она скатывается по склону.
   *
   * Поглощается ТОЛЬКО пульпа. Реголит, шлак или иридий на грани остаются
   * и забивают вход: машина, всасывающая что угодно, не требует сортировки,
   * и весь смысл цепочки исчезает.
   *
   * Простаивающая машина здесь только ЧИТАЕТ. Записи — и вместе с ними
   * пробуждения чанков — происходят ровно тогда, когда что-то поглощено.
   */
  private absorb(world: World): void {
    const limit = SEPARATOR.batch * SEPARATOR.bufferBatches;
    const faceY = this.y - 1;
    for (let dx = 0; dx < SEPARATOR.width; dx++) {
      if (this.buffer >= limit) return;
      const x = this.x + dx;
      if (world.get(x, faceY) !== MAT.PULP) continue;
      world.set(x, faceY, MAT.VACUUM);
      this.buffer++;
    }
  }

  /**
   * Выдача в верхний ряд выпускного окна.
   *
   * Именно в ВЕРХНИЙ: под ним остаётся просвет высотой в ноги, и выданное
   * успевает выйти и растечься, а не запирает окно немедленно.
   *
   * Иридий кладётся в середину свободных ячеек — единственная ценная ячейка
   * порции выходит из середины машины, а не всегда из угла. Дальше оба
   * подчиняются обычным правилам сыпучего: отдельного поведения
   * у свежевыданного вещества нет.
   *
   * @returns удалось ли выдать порцию целиком
   */
  private emit(world: World): boolean {
    const y = this.y + OUTLET_ROW;
    const free: number[] = [];
    for (let dx = OUTLET_FROM; dx < OUTLET_TO; dx++) {
      const x = this.x + dx;
      if (world.get(x, y) === MAT.VACUUM) free.push(x);
    }
    // Порция выходит целиком или не выходит вовсе: частичная выдача разошлась бы
    // с составом и потеряла бы разницу между «выдано» и «осталось внутри».
    if (free.length < SEPARATOR.batch) return false;

    const iridiumAt = free[free.length >> 1]!;
    let slag = SEPARATOR.batch - 1;
    world.set(iridiumAt, y, MAT.IRIDIUM);
    for (const x of free) {
      if (x === iridiumAt || slag === 0) continue;
      world.set(x, y, MAT.SLAG);
      slag--;
    }
    return true;
  }

  /**
   * Сырьё возвращается пульпой, готовая порция — уже продуктом.
   *
   * Порция, у которой задержка отсчитана, переработана: вернуть её пульпой
   * значило бы откатить работу, которую машина уже сделала. Порция в работе,
   * наоборот, ещё сырьё. В обоих случаях сходится число ячеек — это и есть
   * инвариант, который снос обязан удержать.
   */
  drain(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.buffer; i++) out.push(MAT.PULP);
    if (this.timer > 0) for (let i = 0; i < SEPARATOR.batch; i++) out.push(MAT.PULP);
    if (this.pending) {
      out.push(MAT.IRIDIUM);
      for (let i = 1; i < SEPARATOR.batch; i++) out.push(MAT.SLAG);
    }
    return out;
  }
}

export const SEPARATOR_KIND: BuildingKind = {
  id: 'separator',
  name: 'Сепаратор',
  width: SEPARATOR.width,
  height: SEPARATOR.height,
  cost: SEPARATOR.cost,
  hull: MAT.SEPARATOR_HULL,
  shape: SEPARATOR_SHAPE,
  // Сетки нет: машина центрируется на цели. Выравнивание нужно там, где
  // границы постройки приходится выводить из координат, — у машины они
  // записаны в реестре.
  grid: 0,
  // Машина без опоры читается как ошибка рендера — в отличие от ленты, которой
  // висеть над пустотой положено.
  needsSupport: true,
  // Открыт с начала партии, и закрыть его технологией нельзя по двум причинам
  // сразу: каталог, пустой до первой покупки, читается как поломка, а сепаратор
  // к тому же единственный источник очков — закрыв его, мы закрыли бы
  // единственный путь к самим технологиям.
  unlock: null,
  create: (x, y) => new Separator(SEPARATOR_KIND, x, y),
};

/** Сводка по машинам для строки состояния. */
export function machineSummary(registry: BuildingRegistry): string {
  if (registry.count === 0) return '';
  let working = 0;
  let blocked = 0;
  for (const b of registry.all) {
    if (b.state === 'working') working++;
    else if (b.state === 'blocked') blocked++;
  }
  const idle = registry.count - working - blocked;
  const parts = [`Сепараторы ${registry.count}`];
  if (working > 0) parts.push(`работа ${working}`);
  if (idle > 0) parts.push(`простой ${idle}`);
  if (blocked > 0) parts.push(`выход забит ${blocked}`);
  return parts.join(' · ');
}
