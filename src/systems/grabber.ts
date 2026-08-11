import { GRAB } from '../config';
import { World, MAT, MAT_PORTABLE } from '../world';
import { Digger } from './digging';
import type { Rect } from '../geometry';
import type { Grab } from '../entities';

/**
 * Захват: квадратная кисть, берущая переносимое вещество в свой буфер
 * и выбрасывающая комок целиком.
 *
 * Ограничения модуля:
 *
 * 1. Что будет затронуто, считает ОДИН обход — `plan`. Его результат идёт
 *    и в подсветку, и в применение, поэтому расхождение показанного
 *    со сделанным невыразимо, а не запрещено. Второй обход заводить нельзя.
 * 2. Веток по id вещества здесь нет: что переносимо, читает таблица —
 *    та же, что у пылесоса.
 * 3. План живёт в переиспользуемом буфере: `plan` зовётся каждый шаг ради
 *    подсветки, и аллокация массива на шаг попала бы в горячий путь.
 *    Следствие: результат действителен ДО следующего вызова `plan`.
 * 4. Решение штриха латчится на нажатии и держится до отпускания. Иначе
 *    проводка, добравшая буфер до полного, тем же удержанием вываливает его
 *    обратно.
 */

/** Что сделает применение инструмента. */
export type GrabAction = 'take' | 'drop' | 'none';

/**
 * Затрагиваемые ячейки: пары `x, y` в координатах мира, первые `count * 2`
 * элемента `cells` значимы.
 *
 * Ссылка на ЧУЖОЙ буфер, а не копия: читатель обязан использовать её до
 * следующего вызова `plan`. Между шагом и кадром это выполняется — план
 * считается в шаге и рисуется тем же кадром.
 */
export interface GrabPlan {
  readonly action: GrabAction;
  readonly cells: Int16Array;
  readonly count: number;
}

/** Смещение от центра до края квадрата. Сторона нечётная, поэтому целое. */
const HALF = (GRAB.side - 1) / 2;

function inRect(rect: Rect | null, x: number, y: number): boolean {
  if (!rect) return false;
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

export class Grabber {
  private takeCooldown = 0;
  /** Решение текущего штриха. `null` — кнопка отпущена. */
  private stroke: Exclude<GrabAction, 'none'> | null = null;

  private readonly cells = new Int16Array(GRAB.side * GRAB.side * 2);
  private count = 0;
  private action: GrabAction = 'none';

  /** Последний посчитанный план. Действителен до следующего `plan`. */
  get lastPlan(): GrabPlan {
    return { action: this.action, cells: this.cells, count: this.count };
  }

  /**
   * Что сделает применение инструмента прямо сейчас и каких ячеек это
   * коснётся.
   *
   * Решение по цели, а не по счёту нажатий: счётчик «первое берёт, второе
   * кладёт» ошибается ровно на промахе — промах тратил бы «взять», и следующее
   * нажатие клало бы комок туда, куда игрок целился, чтобы добрать.
   *
   * @param forced решение активного штриха; `null` — решать заново
   */
  plan(
    world: World,
    grab: Grab,
    playerCX: number,
    playerCY: number,
    targetX: number,
    targetY: number,
    occupant: Rect | null = null,
    forced: Exclude<GrabAction, 'none'> | null = null,
  ): GrabPlan {
    this.count = 0;
    this.action = 'none';

    // Дальность проверяется ДО решения: недостижимая цель не меняет ничего
    // и обещать подсветкой ей нечего.
    if (!Digger.inReach(playerCX, playerCY, targetX, targetY)) return this.lastPlan;

    const decided = forced ?? (this.canTake(world, grab, targetX, targetY) ? 'take' : 'drop');
    this.action = decided === 'take' ? this.planTake(world, grab, targetX, targetY) : 'drop';
    if (this.action === 'drop')
      this.action = this.planDrop(world, grab, targetX, targetY, occupant);

    return this.lastPlan;
  }

  /**
   * Применение инструмента.
   *
   * Набор идёт от УДЕРЖАНИЯ и своим интервалом, выброс — от НАЖАТИЯ и ровно
   * один раз: комок выпадает целиком, и раскладывать его порциями по кадрам
   * нечем оправдать.
   *
   * @returns сколько ячеек изменилось в мире на этом шаге
   */
  update(
    dt: number,
    world: World,
    grab: Grab,
    pressed: boolean,
    held: boolean,
    playerCX: number,
    playerCY: number,
    targetX: number,
    targetY: number,
    occupant: Rect | null = null,
  ): number {
    this.takeCooldown = Math.max(0, this.takeCooldown - dt);

    // Отпустили — штрих кончился. Решение следующего принимается заново.
    if (!held) this.stroke = null;

    if (pressed && Digger.inReach(playerCX, playerCY, targetX, targetY)) {
      this.stroke = this.canTake(world, grab, targetX, targetY) ? 'take' : 'drop';
    }

    // План считается ВСЕГДА, а не только при нажатии: его читает подсветка,
    // и она обязана показывать то же решение, что примет нажатие.
    const plan = this.plan(
      world,
      grab,
      playerCX,
      playerCY,
      targetX,
      targetY,
      occupant,
      held ? this.stroke : null,
    );

    if (this.stroke === 'take' && held && plan.action === 'take') {
      if (this.takeCooldown > 0) return 0;
      this.takeCooldown = GRAB.interval;
      return this.applyTake(world, grab, plan);
    }

    if (this.stroke === 'drop' && pressed && plan.action === 'drop') {
      return this.applyDrop(world, grab, plan);
    }

    return 0;
  }

  /** Есть ли под квадратом переносимое вещество и место, куда его положить. */
  private canTake(world: World, grab: Grab, cx: number, cy: number): boolean {
    if (grab.free <= 0) return false;
    for (let y = cy - HALF; y <= cy + HALF; y++) {
      for (let x = cx - HALF; x <= cx + HALF; x++) {
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
        if (MAT_PORTABLE[world.get(x, y)] === 1) return true;
      }
    }
    return false;
  }

  /**
   * Ячейки, которые уйдут в буфер: переносимые и влезающие по остатку места.
   * Больше, чем свободно, не набирается — вещество не имеет права исчезнуть
   * из-за нехватки места.
   */
  private planTake(world: World, grab: Grab, cx: number, cy: number): GrabAction {
    const limit = grab.free;
    for (let y = cy - HALF; y <= cy + HALF; y++) {
      for (let x = cx - HALF; x <= cx + HALF; x++) {
        if (this.count >= limit) return this.count > 0 ? 'take' : 'none';
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
        if (MAT_PORTABLE[world.get(x, y)] !== 1) continue;
        this.push(x, y);
      }
    }
    return this.count > 0 ? 'take' : 'none';
  }

  /**
   * Ячейки, которые примут комок: только ПУСТЫЕ и только вне персонажа.
   * Выброс ставит, а не разрушает и не вытесняет; хитбокс внутри твёрдого —
   * состояние, из которого нет выхода ни в одну сторону.
   */
  private planDrop(
    world: World,
    grab: Grab,
    cx: number,
    cy: number,
    occupant: Rect | null,
  ): GrabAction {
    const limit = grab.used;
    if (limit <= 0) return 'none';
    for (let y = cy - HALF; y <= cy + HALF; y++) {
      for (let x = cx - HALF; x <= cx + HALF; x++) {
        if (this.count >= limit) return 'drop';
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
        if (world.get(x, y) !== MAT.VACUUM) continue;
        if (inRect(occupant, x, y)) continue;
        this.push(x, y);
      }
    }
    return this.count > 0 ? 'drop' : 'none';
  }

  private push(x: number, y: number): void {
    this.cells[this.count * 2] = x;
    this.cells[this.count * 2 + 1] = y;
    this.count++;
  }

  /**
   * Запись через `world.set` — лежащее над взятым обязано осыпаться.
   *
   * Кладём в буфер СНАЧАЛА и стираем только на подтверждённое место: обратный
   * порядок терял бы ячейку ровно на границе ёмкости.
   */
  private applyTake(world: World, grab: Grab, plan: GrabPlan): number {
    let taken = 0;
    for (let i = 0; i < plan.count; i++) {
      const x = plan.cells[i * 2]!;
      const y = plan.cells[i * 2 + 1]!;
      const m = world.get(x, y);
      if (grab.add(m, 1) !== 1) break;
      world.set(x, y, MAT.VACUUM);
      taken++;
    }
    return taken;
  }

  /**
   * Комок раскладывается по веществам в порядке ВОЗРАСТАНИЯ id, ячейки —
   * построчно. Порядок задан, потому что от него зависит сетка: «по количеству»
   * менялся бы от ходки к ходке, и повторяемость выброса пропала бы.
   */
  private applyDrop(world: World, grab: Grab, plan: GrabPlan): number {
    const materials = grab.materials();
    let placed = 0;
    let slot = 0;

    for (const m of materials) {
      let left = grab.count(m);
      while (left > 0 && slot < plan.count) {
        const x = plan.cells[slot * 2]!;
        const y = plan.cells[slot * 2 + 1]!;
        slot++;
        if (grab.take(m, 1) !== 1) break;
        world.set(x, y, m);
        placed++;
        left--;
      }
      if (slot >= plan.count) break;
    }

    return placed;
  }
}
