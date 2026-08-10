import { World, MAT, MAT_STATE, MatterState } from '../world';
import { Digger } from './digging';
import { stampKind, sectionKindByHull, isKindOpen } from '../entities';
import type { Building, BuildingKind, BuildingRegistry, LandingModule } from '../entities';
import { NO_UNLOCKS } from '../progress';
import type { ContentUnlocks } from '../progress';

/**
 * Почему постановка невозможна. Ноль причин — годно.
 *
 * `locked` стоит особняком от прочих трёх: те — про место, эта — про сам вид,
 * и лечится она не шагом в сторону, а покупкой в оверлее исследований.
 */
export type PlacementIssue = 'occupied' | 'unsupported' | 'funds' | 'locked';

/**
 * Постановка и снос зданий.
 *
 * Инвариант: все условия годности видимы игроку заранее — по контуру. Отказ,
 * о котором узнают по тому, что ничего не произошло, читается поломкой.
 *
 * Сдвига к ближайшему годному месту нет и быть не должно: игрок целится
 * в одно, а здание встало бы в другое.
 */
/**
 * Что случится под целью: контур будущей постройки и причина отказа.
 *
 * Здесь, а не в шаге игры: контур и постановка обязаны говорить об одном и том
 * же — иначе рамка обещает одно, а нажатие делает другое. Пока правило было
 * разорвано между строителем и циклом, разойтись они могли на любой правке.
 *
 * Контур показывает ДЕЙСТВИЕ, а не выбор: над стоящей постройкой это её снос,
 * и обводить её прямоугольником выбранной машины значило бы соврать.
 */
export interface BuildPreview {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly ok: boolean;
  /** Почему негодно. `null` — годно, `'far'` — вне досягаемости. */
  readonly issue: PlacementIssue | 'far' | null;
}

export class Builder {
  /**
   * Левый верхний угол области под целью. У постройки с сеткой цель
   * ПРИТЯГИВАЕТСЯ к клетке: иначе снос не знает, что сносить, а соседние
   * секции не стыкуются. Машина центрируется на цели.
   */
  static originFor(kind: BuildingKind, targetX: number, targetY: number): { x: number; y: number } {
    if (kind.grid > 0) {
      const g = kind.grid;
      return { x: Math.floor(targetX / g) * g, y: Math.floor(targetY / g) * g };
    }
    return { x: targetX - (kind.width >> 1), y: targetY - (kind.height >> 1) };
  }

  /**
   * Клавиатурная цель по вертикали: низ области встаёт на уровень ступней.
   * Нужна боковому прицелу — цель стоит на высоте ЦЕНТРА персонажа, и без
   * поправки низ корпуса 13 уходит на четыре ячейки под землю («занято»).
   * Без неё здание выше девяти ячеек с клавиатуры не ставится вовсе.
   */
  static groundedTargetY(kind: BuildingKind, playerY: number, hitboxH: number): number {
    return playerY + hitboxH - Math.ceil(kind.height / 2);
  }

  /**
   * @returns причина отказа или `null`, если место годно
   */
  /** Контур и годность под целью. Снос читается тем же вызовом, что постановка. */
  static preview(
    world: World,
    buildings: BuildingRegistry,
    kind: BuildingKind,
    playerCenterX: number,
    playerCenterY: number,
    targetX: number,
    targetY: number,
    credits: number,
    unlocks: ContentUnlocks = NO_UNLOCKS,
  ): BuildPreview {
    const standing = buildings.findAt(targetX, targetY);
    if (standing) {
      return {
        x: standing.x,
        y: standing.y,
        w: standing.kind.width,
        h: standing.kind.height,
        ok: true,
        issue: null,
      };
    }

    // Ячейка секционной постройки под целью означает снос — так же, как запись
    // реестра. Границы выводятся из сетки, поэтому контур сноса совпадает
    // с тем, что исчезнет.
    const section = sectionKindByHull(world.get(targetX, targetY));
    if (section) {
      const hit = Builder.originFor(section, targetX, targetY);
      return { x: hit.x, y: hit.y, w: section.width, h: section.height, ok: true, issue: null };
    }

    // Дальность считается по цели ПОСТРОЙКИ, а не по курсору: с клавиатуры цель
    // берётся от персонажа, и курсор к ней отношения не имеет.
    const at = Builder.originFor(kind, targetX, targetY);
    const far = !Digger.inReach(playerCenterX, playerCenterY, targetX, targetY);
    const issue = Builder.issueAt(world, kind, at.x, at.y, credits, unlocks);
    return {
      x: at.x,
      y: at.y,
      w: kind.width,
      h: kind.height,
      ok: !far && issue === null,
      issue: far ? 'far' : issue,
    };
  }

  static issueAt(
    world: World,
    kind: BuildingKind,
    x: number,
    y: number,
    credits: number,
    unlocks: ContentUnlocks = NO_UNLOCKS,
  ): PlacementIssue | null {
    // Первым, до всего остального: закрытый вид не ставится НИКАКИМ способом,
    // и ни деньги, ни удачное место этого не меняют. Умолчание — состояние
    // начала партии: забывчивость даёт отказ, а не тихое разрешение.
    if (!isKindOpen(kind, unlocks)) return 'locked';

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
   * Применение инструмента в режиме строительства. Отдельного действия сноса
   * нет: цель либо внутри стоящего здания, либо нет. Срабатывает на НАЖАТИЕ —
   * при удержании игрок ставил бы и сносил одно здание тридцать раз в секунду.
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
    unlocks: ContentUnlocks = NO_UNLOCKS,
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
    if (Builder.issueAt(world, kind, at.x, at.y, module.credits, unlocks) !== null) {
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
   * Снос: корпус в пустоту, стоимость обратно, содержимое — в мир. Возврат
   * полный: здание покупается вслепую, и ошибка размещения не должна стоить
   * кредитов — иначе игрок перестанет экспериментировать.
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
