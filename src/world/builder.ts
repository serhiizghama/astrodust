import { World } from './world';
import { MAT, MAT_STATE, MatterState } from './materials';
import { Digger } from './digging';
import type { Occupant } from './simulation';
import type { Building, BuildingKind, BuildingRegistry } from '../entities/buildings';
import type { LandingModule } from '../entities/landing-module';

/** Почему место негодно. Ноль причин — годно. */
export type PlacementIssue = 'occupied' | 'unsupported' | 'player' | 'funds';

/**
 * Постановка и снос зданий.
 *
 * Годность места проверяется ЧЕТЫРЬМЯ условиями, и все четыре видимы игроку
 * заранее — по контуру. Отказ, о котором узнают по тому, что ничего
 * не произошло, читается как поломка.
 *
 * Сдвига к ближайшему годному месту нет и быть не должно: игрок целится
 * в одно, а здание встало бы в другое. Тот же довод, по которому недостижимая
 * цель копания не смещается к достижимой.
 */
export class Builder {
  /**
   * Левый верхний угол области под целью.
   *
   * Здание центрируется на цели: контур растёт от прицела во все стороны,
   * а не свисает вбок от него.
   */
  static originFor(kind: BuildingKind, targetX: number, targetY: number): { x: number; y: number } {
    return { x: targetX - (kind.width >> 1), y: targetY - (kind.height >> 1) };
  }

  /**
   * @returns причина отказа или `null`, если место годно
   */
  static issueAt(
    world: World,
    kind: BuildingKind,
    x: number,
    y: number,
    occupant: Occupant | null,
    credits: number,
  ): PlacementIssue | null {
    if (credits < kind.cost) return 'funds';

    // Вся область пуста. Проверяется ОБЛАСТЬ, а не только ячейки корпуса:
    // внутренняя камера, набитая реголитом, замуровала бы вещество внутри
    // здания без всякой возможности его достать.
    for (let dy = 0; dy < kind.height; dy++) {
      for (let dx = 0; dx < kind.width; dx++) {
        if (world.get(x + dx, y + dy) !== MAT.VACUUM) return 'occupied';
      }
    }

    if (occupant) {
      const overlaps =
        x < occupant.x + occupant.w &&
        x + kind.width > occupant.x &&
        y < occupant.y + occupant.h &&
        y + kind.height > occupant.y;
      if (overlaps) return 'player';
    }

    // Опора — хотя бы ОДНА твёрдая ячейка в ряду под областью, а не сплошной
    // пол: сепаратор на краю уступа стоять должен, и это лучшее для него место —
    // куча отхода уходит вниз сама.
    let supported = false;
    for (let dx = 0; dx < kind.width && !supported; dx++) {
      if (MAT_STATE[world.get(x + dx, y + kind.height)] === MatterState.Solid) supported = true;
    }
    if (!supported) return 'unsupported';

    return null;
  }

  /**
   * Применение инструмента в режиме строительства.
   *
   * Отдельного действия сноса нет: цель либо внутри стоящего здания, либо нет,
   * и неоднозначности здесь не возникает. Четвёртое действие на новой клавише
   * стало бы началом раскладки, которая растёт вместе с числом зданий.
   *
   * Срабатывает на НАЖАТИЕ, а не на удержание. Постановка — разовое действие:
   * при удержании темпом кисти игрок ставил бы и сносил одно и то же здание
   * тридцать раз в секунду.
   *
   * @returns что произошло
   */
  static apply(
    world: World,
    registry: BuildingRegistry,
    module: LandingModule,
    kind: BuildingKind,
    playerCX: number,
    playerCY: number,
    targetX: number,
    targetY: number,
    occupant: Occupant | null,
  ): 'placed' | 'demolished' | 'rejected' {
    if (!Digger.inReach(playerCX, playerCY, targetX, targetY)) return 'rejected';

    const standing = registry.findAt(targetX, targetY);
    if (standing) {
      Builder.demolish(world, registry, module, standing);
      return 'demolished';
    }

    const at = Builder.originFor(kind, targetX, targetY);
    if (Builder.issueAt(world, kind, at.x, at.y, occupant, module.credits) !== null) {
      return 'rejected';
    }

    // Списание ровно один раз и только после того, как все отказы пройдены:
    // отвергнутое применение не имеет права стоить ни кредита.
    if (!module.spend(kind.cost)) return 'rejected';

    const building = kind.create(at.x, at.y);
    building.stamp(world);
    registry.add(building);
    return 'placed';
  }

  /**
   * Снос: корпус в пустоту, стоимость обратно, содержимое — в мир.
   *
   * Полный возврат обязателен. Здание покупается вслепую: до постановки
   * не видно, как окно ляжет в рельеф и куда пойдёт куча, а первая ошибка
   * размещения не должна стоить кредитов — иначе игрок перестанет
   * экспериментировать, а размещение здесь и есть игра.
   */
  static demolish(
    world: World,
    registry: BuildingRegistry,
    module: LandingModule,
    building: Building,
  ): void {
    const contents = building.drain();
    building.clear(world);
    registry.remove(building);
    module.refund(building.kind.cost);
    Builder.spill(world, building, contents);
  }

  /**
   * Возвращает содержимое в освободившиеся ячейки — снизу вверх, чтобы
   * вещество не повисло над пустотой на месте камеры.
   *
   * Область здания заведомо вместительнее накопителя, поэтому терять нечего;
   * но если бы вдруг не хватило, потеря была бы молчаливой — отсюда счётчик
   * и явный остаток.
   */
  private static spill(world: World, building: Building, contents: number[]): void {
    if (contents.length === 0) return;
    const { width, height } = building.kind;
    let i = 0;
    for (let dy = height - 1; dy >= 0 && i < contents.length; dy--) {
      for (let dx = 0; dx < width && i < contents.length; dx++) {
        const x = building.x + dx;
        const y = building.y + dy;
        if (world.get(x, y) !== MAT.VACUUM) continue;
        world.set(x, y, contents[i]!);
        i++;
      }
    }
  }
}
