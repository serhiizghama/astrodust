import { VACUUM } from '../config';
import { World, MAT, MAT_PORTABLE } from '../world';
import { Digger } from './digging';
import { Tuning, TUNING_BASE } from '../progress';
import type { Rect } from '../geometry';
import type { Inventory } from '../entities';

/**
 * Перенос вещества между миром и персонажем: сбор забирает переносимое
 * в инвентарь, высыпание возвращает обратно. Обе кисти подчиняются дальности
 * и темпу копания — действия на соседних кнопках не должны различаться
 * без причины.
 *
 * Веток по id вещества здесь нет: что переносимо, читает таблица.
 *
 * Радиус читается ИЗ ПРОФИЛЯ, а не из конфига: апгрейд обязан быть строкой
 * таблицы технологий. Откуда в профиле значение, пылесос не знает.
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
   * в инвентаре по единице на ячейку.
   *
   * Инвариант: сколько стёрто, столько прибавлено. Кончилось место — обход
   * прекращается, остаток лежит в мире нетронутым: вещество не имеет права
   * исчезнуть из-за нехватки места.
   *
   * Запись через `world.set` — лежащее над собранным обязано осыпаться.
   * Радиус АРГУМЕНТ, а не константа: иначе апгрейд обошёл бы статический вызов.
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
   * Круглая кисть высыпания: вещество ложится ТОЛЬКО в пустоту — высыпание
   * ставит, а не разрушает и не вытесняет.
   *
   * Ячейки персонажа не трогаются: иначе хитбокс оказывается внутри твёрдого,
   * а из этого состояния нет выхода ни в одну сторону.
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
