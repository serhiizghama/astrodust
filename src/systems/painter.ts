import { DIG } from '../config';
import { World, MAT, MATERIALS } from '../world';
import { Digger } from './digging';
import type { Rect } from '../geometry';

/**
 * Отладочная установка вещества под курсором.
 *
 * Это инструмент разработки, а не игровая способность. Без него жидкости и газ
 * невозможно проверить руками: генератор мира их не размещает, а перенос
 * вещества появится только вместе с инвентарём — до тех пор вода существовала
 * бы исключительно в тестах.
 *
 * Подчиняется той же дальности, что и копание: инструмент, обходящий правила
 * мира, показывает поведение, которого в игре не бывает, и такая проверка
 * ничего не подтверждает.
 */
const PALETTE = [MAT.WATER, MAT.LAVA, MAT.STEAM, MAT.REGOLITH_LOOSE, MAT.ICE] as const;

export class DebugPainter {
  private index = 0;
  private cooldown = 0;

  get material(): number {
    return PALETTE[this.index]!;
  }

  get materialName(): string {
    return MATERIALS[this.material]!.name;
  }

  cycle(): void {
    this.index = (this.index + 1) % PALETTE.length;
  }

  /** @returns сколько ячеек установлено в этом шаге */
  update(
    dt: number,
    world: World,
    enabled: boolean,
    held: boolean,
    playerCX: number,
    playerCY: number,
    targetX: number,
    targetY: number,
    occupant: Rect | null = null,
  ): number {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (!enabled || !held) return 0;
    if (this.cooldown > 0) return 0;
    if (!Digger.inReach(playerCX, playerCY, targetX, targetY)) return 0;

    this.cooldown = DIG.interval;
    return this.paint(world, targetX, targetY, occupant);
  }

  /** Кисть меньше копательной: вещество ставится точечно, а не заливкой экрана. */
  paint(world: World, centerX: number, centerY: number, occupant: Rect | null = null): number {
    const r = Math.max(1, DIG.radius - 1);
    const rSq = r * r;
    const material = this.material;
    let placed = 0;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rSq) continue;
        const x = centerX + dx;
        const y = centerY + dy;
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
        // Заполняем только пустоту: инструмент ставит вещество, а не разрушает
        // мир — для разрушения есть копание со своими правилами.
        if (world.get(x, y) !== MAT.VACUUM) continue;
        // Ячейки персонажа не трогаем. Симуляция это ограничение соблюдает,
        // а инструмент его обходил и ставил вещество внутрь хитбокса —
        // 13 твёрдых ячеек за одно нажатие, состояние, запрещённое спекой
        // движения. Остальная кисть работает как обычно.
        if (
          occupant &&
          x >= occupant.x &&
          x < occupant.x + occupant.w &&
          y >= occupant.y &&
          y < occupant.y + occupant.h
        ) {
          continue;
        }

        world.set(x, y, material);
        placed++;
      }
    }

    return placed;
  }
}
