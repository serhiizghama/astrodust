import { VACUUM } from '../config';
import { World, MAT, MAT_PORTABLE } from '../world';
import { Digger } from './digging';
import { Tuning, TUNING_BASE } from '../progress';
import type { Rect } from '../geometry';
import type { Inventory } from '../entities';

/**
 * Перенос вещества между миром и персонажем.
 *
 * Две кисти на одном инструменте: сбор забирает переносимое из мира в
 * инвентарь, высыпание возвращает выбранное обратно. Обе подчиняются той же
 * дальности и тому же ограничению темпа, что и копание, — иначе действия,
 * живущие на соседних кнопках, вели бы себя по-разному без причины.
 *
 * Веток по идентификатору вещества здесь нет и быть не должно: что переносимо,
 * читается из таблицы материалов. Новое переносимое вещество обязано быть
 * строкой таблицы, а не правкой этого файла.
 *
 * Радиус кисти читается ИЗ ПРОФИЛЯ, а не из конфига: он настраиваемый параметр,
 * и апгрейд обязан быть строкой таблицы технологий, а не правкой всех мест,
 * где радиус читается. Откуда в профиле взялось значение, пылесос не знает
 * и знать не должен — исследования для него не существуют.
 */
export class Vacuum {
  private suckCooldown = 0;
  private dumpCooldown = 0;

  constructor(private readonly tuning: Tuning = new Tuning()) {}

  /**
   * Сбор в инвентарь.
   *
   * @returns сколько ячеек ушло в инвентарь на этом шаге
   */
  updateSuck(
    dt: number,
    world: World,
    inventory: Inventory,
    held: boolean,
    playerCX: number,
    playerCY: number,
    targetX: number,
    targetY: number,
  ): number {
    this.suckCooldown = Math.max(0, this.suckCooldown - dt);
    if (!held) return 0;
    if (this.suckCooldown > 0) return 0;
    // Недостижимая цель не меняет НИ мир, НИ инвентарь — то же правило, что
    // и у копания: игрок целится в одно, собиралось бы другое.
    if (!Digger.inReach(playerCX, playerCY, targetX, targetY)) return 0;

    this.suckCooldown = VACUUM.interval;
    return Vacuum.collect(world, inventory, targetX, targetY, this.tuning.collectRadius);
  }

  /**
   * Высыпание из инвентаря.
   *
   * @returns сколько ячеек размещено в мире на этом шаге
   */
  updateDump(
    dt: number,
    world: World,
    inventory: Inventory,
    held: boolean,
    playerCX: number,
    playerCY: number,
    targetX: number,
    targetY: number,
    occupant: Rect | null = null,
  ): number {
    this.dumpCooldown = Math.max(0, this.dumpCooldown - dt);
    if (!held) return 0;
    if (this.dumpCooldown > 0) return 0;
    if (!Digger.inReach(playerCX, playerCY, targetX, targetY)) return 0;

    this.dumpCooldown = VACUUM.interval;
    return Vacuum.dump(world, inventory, targetX, targetY, occupant, this.tuning.collectRadius);
  }

  /**
   * Круглая кисть сбора: переносимые ячейки исчезают из мира и появляются
   * в инвентаре по одной единице на ячейку.
   *
   * Сохранение вещества буквальное: сколько ячеек стёрто, столько единиц
   * прибавлено. Как только место кончилось, обход прекращается, и оставшиеся
   * ячейки остаются в мире нетронутыми — вещество не имеет права исчезнуть
   * из-за нехватки места.
   *
   * Запись идёт через `world.set`, поэтому окрестность просыпается, как от
   * любого другого изменения: лежащее над собранным обязано осыпаться.
   *
   * Радиус — АРГУМЕНТ, а не константа: он живёт в профиле настроек, и брать
   * его здесь напрямую означало бы, что апгрейд кисти обходит статический
   * вызов стороной. Умолчание равно базовому значению профиля и существует
   * ради вызовов, которым апгрейды не интересны.
   *
   * @returns сколько ячеек собрано
   */
  static collect(
    world: World,
    inventory: Inventory,
    centerX: number,
    centerY: number,
    radius: number = TUNING_BASE.collectRadius,
  ): number {
    const r = radius;
    const rSq = r * r;
    let collected = 0;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rSq) continue; // круг, а не квадрат
        if (inventory.free <= 0) return collected;

        const x = centerX + dx;
        const y = centerY + dy;
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;

        const m = world.get(x, y);
        if (MAT_PORTABLE[m] !== 1) continue;

        // Кладём СНАЧАЛА и стираем только на подтверждённое место. Обратный
        // порядок терял бы ячейку ровно на границе ёмкости.
        if (inventory.add(m, 1) !== 1) return collected;
        world.set(x, y, MAT.VACUUM);
        collected++;
      }
    }

    return collected;
  }

  /**
   * Круглая кисть высыпания: выбранное вещество ложится в пустые ячейки.
   *
   * Заполняется ТОЛЬКО пустота. Высыпание ставит вещество, а не разрушает мир
   * и не вытесняет то, что там лежит: для разрушения есть копание со своими
   * правилами.
   *
   * Ячейки персонажа не трогаются. Иначе хитбокс оказывается внутри твёрдых
   * ячеек — состояние, запрещённое способностью движения, из которого нет
   * выхода ни в одну сторону.
   *
   * @returns сколько ячеек размещено
   */
  static dump(
    world: World,
    inventory: Inventory,
    centerX: number,
    centerY: number,
    occupant: Rect | null = null,
    radius: number = TUNING_BASE.collectRadius,
  ): number {
    const r = radius;
    const rSq = r * r;
    const material = inventory.selected;
    let placed = 0;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rSq) continue;
        if (inventory.count(material) <= 0) return placed;

        const x = centerX + dx;
        const y = centerY + dy;
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
        if (world.get(x, y) !== MAT.VACUUM) continue;
        if (
          occupant &&
          x >= occupant.x &&
          x < occupant.x + occupant.w &&
          y >= occupant.y &&
          y < occupant.y + occupant.h
        ) {
          continue;
        }

        if (inventory.take(material, 1) !== 1) return placed;
        world.set(x, y, material);
        placed++;
      }
    }

    return placed;
  }
}
