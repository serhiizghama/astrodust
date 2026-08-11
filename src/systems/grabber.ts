import { GRAB } from '../config';
import { World, MAT, MATERIALS, MAT_PORTABLE } from '../world';
import type { Rect } from '../geometry';
import type { Grab } from '../entities';

/**
 * Захват: квадратная кисть, набирающая переносимое вещество в свой буфер
 * удержанием и выбрасывающая комок целиком по отпусканию.
 *
 * Ограничения модуля:
 *
 * 1. Что будет затронуто, считает ОДИН обход — `plan`. Его результат идёт
 *    и в подсветку, и в применение, поэтому расхождение показанного
 *    со сделанным невыразимо, а не запрещено. Второй обход заводить нельзя.
 * 2. Веток по id вещества здесь нет: что переносимо, читает таблица — та же,
 *    что у пылесоса. Вещество комка — состояние жеста, а не ветка.
 * 3. План живёт в переиспользуемом буфере: `plan` зовётся каждый шаг ради
 *    подсветки, и аллокация массива на шаг попала бы в горячий путь.
 *    Следствие: результат действителен ДО следующего вызова `plan`.
 * 4. Жест выводится из ОДНОГО `held`. Разовое «нажато в этом шаге» не годится:
 *    курсор, ушедший на панель и вернувшийся в мир при нажатой кнопке, даёт
 *    `held` без нажатия, и жест после такого возврата не возобновился бы.
 * 5. Дальности у захвата нет — не смягчена, а отсутствует. Состояния
 *    «недостижимо» не существует, и показывать его нечем.
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

/** Вещество ячейки, если его можно нести, иначе `null`. */
function portableAt(world: World, x: number, y: number): number | null {
  const m = world.get(x, y);
  return MAT_PORTABLE[m] === 1 ? m : null;
}

/** Что написать у перекрестия. Пустое имя — называть нечего. */
export interface AimLabel {
  readonly name: string;
  /** Уйдёт ли названное в буфер ЭТИМ нажатием. */
  readonly takeable: boolean;
}

/**
 * Имя вещества под перекрестием и обещание подписи.
 *
 * Живёт здесь, рядом с `planTake`, а не в сборке кадра: «возьмётся ли это
 * сейчас» — вопрос инструмента, и второй ответ на него однажды разошёлся бы
 * с первым.
 *
 * Не возьмётся не только непереносимое: пока в буфере лежит реголит, иридий
 * тоже не уйдёт в комок, а полный буфер не примет уже ничего.
 */
export function aimLabel(world: World, grab: Grab, x: number, y: number): AimLabel {
  const m = world.get(x, y);
  if (m === MAT.VACUUM) return { name: '', takeable: false };
  const fits = grab.free > 0 && (grab.material === null || grab.material === m);
  return { name: MATERIALS[m]!.name, takeable: MAT_PORTABLE[m] === 1 && fits };
}

export class Grabber {
  private takeCooldown = 0;
  /** Идёт ли жест: орган управления удерживается с прошлого шага. */
  private active = false;
  /**
   * Вещество текущего жеста. Латчится на его начале и держится до отпускания:
   * иначе квадрат, сошедший с кучи на соседнюю, менял бы вещество комка на ходу.
   */
  private type: number | null = null;

  private readonly cells = new Int16Array(GRAB.side * GRAB.side * 2);
  private count = 0;
  private action: GrabAction = 'none';

  /**
   * Что инструмент СДЕЛАЛ на прошедшем шаге, в отличие от того, что он собрался
   * сделать (`lastPlan`). Читает звук: по одному числу изменённых ячеек набор
   * от выброса не отличить, а звучат они по-разному.
   */
  private done: GrabAction = 'none';
  private doneCells = 0;

  /** Последний посчитанный план. Действителен до следующего `plan`. */
  get lastPlan(): GrabPlan {
    return { action: this.action, cells: this.cells, count: this.count };
  }

  /** Что произошло на прошедшем шаге: `none` — мир не менялся. */
  get lastAction(): GrabAction {
    return this.done;
  }

  /** Сколько ячеек затронуло произошедшее. */
  get lastCells(): number {
    return this.doneCells;
  }

  /**
   * Жест прерван снаружи — выбран другой режим инструмента.
   *
   * Без этого отпускание, случившееся в чужом режиме, дождалось бы возврата
   * в захват и вывалило бы комок в ту секунду, когда игрок сюда вернулся.
   * Буфер при этом не трогается: он переносчик, а не состояние режима.
   */
  cancel(): void {
    this.active = false;
    this.type = null;
    this.count = 0;
    this.action = 'none';
    this.done = 'none';
    this.doneCells = 0;
  }

  /**
   * Что сделает инструмент прямо сейчас и каких ячеек это коснётся.
   *
   * Вещество набора берётся из буфера, а не из-под перекрестия, пока комок
   * не выброшен: несомое важнее того, над чем оказался квадрат.
   *
   * @param intent `drop` — считать план выброса, что бы ни лежало под
   *   квадратом; так считает шаг отпускания
   */
  plan(
    world: World,
    grab: Grab,
    targetX: number,
    targetY: number,
    occupant: Rect | null = null,
    intent: 'auto' | 'drop' = 'auto',
  ): GrabPlan {
    this.count = 0;
    this.action = 'none';

    if (intent === 'auto') {
      const type = this.active ? this.type : (grab.material ?? portableAt(world, targetX, targetY));
      if (type !== null && grab.free > 0) {
        this.action = this.planTake(world, grab, type, targetX, targetY);
      }
    }
    if (this.action === 'none')
      this.action = this.planDrop(world, grab, targetX, targetY, occupant);

    return this.lastPlan;
  }

  /**
   * Шаг жеста «зажал — набрал — перенёс — отпустил».
   *
   * Набор идёт от УДЕРЖАНИЯ и своим интервалом, выброс — от ОТПУСКАНИЯ и ровно
   * один раз: комок выпадает целиком, и раскладывать его порциями по кадрам
   * нечем оправдать.
   *
   * @param blocked жест приостановлен (курсор над интерфейсом): шаг не берёт,
   *   не кладёт и состояния жеста не трогает. Поэтому отпускание над панелью
   *   комок не роняет, а возврат курсора в мир продолжает тот же жест
   * @returns сколько ячеек изменилось в мире на этом шаге
   */
  update(
    dt: number,
    world: World,
    grab: Grab,
    held: boolean,
    blocked: boolean,
    targetX: number,
    targetY: number,
    occupant: Rect | null = null,
  ): number {
    this.takeCooldown = Math.max(0, this.takeCooldown - dt);
    // Отчёт о прошедшем шаге обнуляется В НАЧАЛЕ, а не в конце: у `update` есть
    // ранние выходы, и звук иначе услышал бы позапрошлый шаг ещё раз.
    this.done = 'none';
    this.doneCells = 0;

    if (blocked) {
      this.count = 0;
      this.action = 'none';
      return 0;
    }

    const released = this.active && !held;
    if (held && !this.active) {
      this.active = true;
      this.type = grab.material ?? portableAt(world, targetX, targetY);
    }
    if (released) this.active = false;

    // План считается ВСЕГДА, а не только при изменении мира: его читает
    // подсветка, и она обязана показывать то же, что сделает жест.
    const plan = this.plan(world, grab, targetX, targetY, occupant, released ? 'drop' : 'auto');

    if (released) {
      this.type = null;
      this.doneCells = this.applyDrop(world, grab, plan);
      // Выброс, не положивший ни ячейки, событием не считается: звук
      // подтверждает изменение мира, а не отпускание кнопки.
      if (this.doneCells > 0) this.done = 'drop';
      return this.doneCells;
    }

    if (this.active && plan.action === 'take') {
      if (this.takeCooldown > 0) return 0;
      this.takeCooldown = GRAB.interval;
      this.doneCells = this.applyTake(world, grab, plan);
      if (this.doneCells > 0) this.done = 'take';
      return this.doneCells;
    }

    return 0;
  }

  /**
   * Ячейки, которые уйдут в буфер: вещества комка и влезающие по остатку места.
   * Больше, чем свободно, не набирается — вещество не имеет права исчезнуть
   * из-за нехватки места.
   */
  private planTake(world: World, grab: Grab, type: number, cx: number, cy: number): GrabAction {
    const limit = grab.free;
    for (let y = cy - HALF; y <= cy + HALF; y++) {
      for (let x = cx - HALF; x <= cx + HALF; x++) {
        if (this.count >= limit) return this.count > 0 ? 'take' : 'none';
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
        if (world.get(x, y) !== type) continue;
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
   * Комок однороден, поэтому раскладка — один проход по ячейкам плана,
   * а порядок ячеек и есть та самая повторяемость выброса.
   */
  private applyDrop(world: World, grab: Grab, plan: GrabPlan): number {
    const m = grab.material;
    if (m === null) return 0;
    let placed = 0;
    for (let i = 0; i < plan.count; i++) {
      if (grab.take(1) !== 1) break;
      world.set(plan.cells[i * 2]!, plan.cells[i * 2 + 1]!, m);
      placed++;
    }
    return placed;
  }
}
