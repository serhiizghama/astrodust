import { World } from './world';
import { MAT, MAT_STATE, MatterState } from './materials';
import { Digger } from './digging';
import { stampKind } from '../entities/buildings';
import type { Building, BuildingKind, BuildingRegistry } from '../entities/buildings';
import { sectionKindByHull } from '../entities/catalog';
import type { LandingModule } from '../entities/landing-module';

/** Почему место негодно. Ноль причин — годно. */
export type PlacementIssue = 'occupied' | 'unsupported' | 'funds';

/**
 * Постановка и снос зданий.
 *
 * Годность места проверяется ТРЕМЯ условиями, и все три видимы игроку
 * заранее — по контуру. Отказ, о котором узнают по тому, что ничего
 * не произошло, читается как поломка.
 *
 * Четвёртым было «область не пересекает хитбокс персонажа». Оно защищало
 * от замуровывания и умерло вместе с причиной: корпус постройки игрока его
 * больше не блокирует. Запрет, переживший свою причину, читается как
 * необъяснимый отказ — тем более при прокладке ленты, когда цель идёт
 * вплотную к персонажу.
 *
 * Сдвига к ближайшему годному месту нет и быть не должно: игрок целится
 * в одно, а здание встало бы в другое. Тот же довод, по которому недостижимая
 * цель копания не смещается к достижимой.
 */
export class Builder {
  /**
   * Левый верхний угол области под целью.
   *
   * У постройки с сеткой цель ПРИТЯГИВАЕТСЯ к клетке: секция встаёт туда, где
   * её границы выводятся из координат, — иначе снос не знал бы, что сносить,
   * а соседние секции не стыковались бы. У машины сетки нет, и она
   * центрируется на цели: контур растёт от прицела во все стороны, а не
   * свисает вбок от него.
   */
  static originFor(kind: BuildingKind, targetX: number, targetY: number): { x: number; y: number } {
    if (kind.grid > 0) {
      const g = kind.grid;
      return { x: Math.floor(targetX / g) * g, y: Math.floor(targetY / g) * g };
    }
    return { x: targetX - (kind.width >> 1), y: targetY - (kind.height >> 1) };
  }

  /**
   * Клавиатурная цель постройки по вертикали: такая, чтобы низ области встал
   * на уровень ступней персонажа.
   *
   * Нужна ровно боковому прицелу. Цель стоит на высоте ЦЕНТРА персонажа,
   * а постройка центрируется на цели, поэтому её низ уходит на половину
   * высоты ниже — у корпуса 13 это четыре ячейки под землёй, и место негодно
   * «занято». Диагональный прицел не лечит: там корпус, наоборот, повисает
   * в воздухе и негоден «нет опоры». Без поправки здание выше девяти ячеек
   * с клавиатуры не ставится вовсе.
   *
   * Здесь, а не в игровом цикле: правило проверяемо только там, где его можно
   * позвать, а «ставится ли постройка без мыши» — записанное требование.
   */
  static groundedTargetY(kind: BuildingKind, playerY: number, hitboxH: number): number {
    return playerY + hitboxH - Math.ceil(kind.height / 2);
  }

  /**
   * @returns причина отказа или `null`, если место годно
   */
  static issueAt(
    world: World,
    kind: BuildingKind,
    x: number,
    y: number,
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

    // Опора — хотя бы ОДНА твёрдая ячейка в ряду под областью, а не сплошной
    // пол: сепаратор на краю уступа стоять должен, и это лучшее для него место —
    // куча отхода уходит вниз сама.
    //
    // Проверяется, только если вид её требует. Общее правило запрещало бы ленте
    // ровно то, ради чего её ставят, — перенос вещества над пустотой.
    if (kind.needsSupport) {
      let supported = false;
      for (let dx = 0; dx < kind.width && !supported; dx++) {
        if (MAT_STATE[world.get(x + dx, y + kind.height)] === MatterState.Solid) supported = true;
      }
      if (!supported) return 'unsupported';
    }

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
  ): 'placed' | 'demolished' | 'rejected' {
    if (!Digger.inReach(playerCX, playerCY, targetX, targetY)) return 'rejected';

    const standing = registry.findAt(targetX, targetY);
    if (standing) {
      Builder.demolish(world, registry, module, standing);
      return 'demolished';
    }

    // Снос НЕ ЗАВИСИТ от выбранного в каталоге вида: цель либо попала
    // в постройку, либо нет. Сравнивать её вид с выбранным значило бы, что
    // применение по ленте другого направления делает что-то третье.
    //
    // Сносится ровно та СЕКЦИЯ, в которую попала цель, а не вся лента: игрок
    // целится в секцию, а лишился бы всей конструкции за один промах.
    // Груз, лежавший на ней, остаётся в мире — снос его не касается.
    const section = sectionKindByHull(world.get(targetX, targetY));
    if (section) {
      Builder.razeSection(world, section, targetX, targetY);
      module.refund(section.cost);
      return 'demolished';
    }

    const at = Builder.originFor(kind, targetX, targetY);
    if (Builder.issueAt(world, kind, at.x, at.y, module.credits) !== null) {
      return 'rejected';
    }

    // Списание ровно один раз и только после того, как все отказы пройдены:
    // отвергнутое применение не имеет права стоить ни кредита.
    if (!module.spend(kind.cost)) return 'rejected';

    // Секционная постройка — та же маска, тот же корпус, но без записи
    // в реестре: состояния у неё нет, и обновлять ей нечего.
    if (kind.create === null) {
      stampKind(world, kind, at.x, at.y, kind.hull);
      return 'placed';
    }

    const building = kind.create(at.x, at.y);
    building.stamp(world);
    registry.add(building);
    return 'placed';
  }

  /**
   * Убирает одну секцию, в которую попала цель.
   *
   * Границы берутся из сетки: записи о секции нигде нет, и это единственный
   * способ снести именно её, а не прямоугольник поперёк двух соседних.
   *
   * Стираются только ячейки ЭТОГО корпуса. Клетка сетки заведомо содержит
   * одну секцию целиком, но проверка материала стоит одно сравнение и делает
   * снос безвредным для всего, что могло оказаться в клетке помимо неё.
   */
  private static razeSection(
    world: World,
    kind: BuildingKind,
    targetX: number,
    targetY: number,
  ): void {
    const at = Builder.originFor(kind, targetX, targetY);
    for (let dy = 0; dy < kind.height; dy++) {
      for (let dx = 0; dx < kind.width; dx++) {
        const x = at.x + dx;
        const y = at.y + dy;
        if (world.get(x, y) === kind.hull) world.set(x, y, MAT.VACUUM);
      }
    }
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
