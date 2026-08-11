import { BUILD_MODULE } from '../config';
import { World, MAT, MAT_STATE, MatterState } from '../world';
import { Digger } from './digging';
import { stampKind, sectionKindByHull, isKindOpen, hullForSide } from '../entities';
import type { Building, BuildingKind, BuildingRegistry } from '../entities';
import { NO_UNLOCKS } from '../progress';
import type { ContentUnlocks } from '../progress';

/** Сторона переноса: -1 — влево, +1 — вправо. */
export type BuildSide = -1 | 1;

/**
 * Почему постановка невозможна. Ноль причин — годно.
 *
 * `locked` стоит особняком от двух остальных: те — про место, эта — про сам
 * вид, и лечится она не шагом в сторону, а покупкой в оверлее исследований.
 *
 * Причины «не хватает кредитов» здесь нет: постройка бесплатна.
 */
export type PlacementIssue = 'occupied' | 'unsupported' | 'locked';

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

/**
 * Линия секций, которую положит текущий жест. Одна и та же для контура
 * и для укладки: рамка, обещающая не то, что даст отпускание, — это тот же
 * отказ, о котором узнают по результату.
 */
export interface BuildLine {
  /** Выровненный ряд. Берётся из начала жеста и по ходу не меняется. */
  readonly y: number;
  /** Левый край линии целиком. */
  readonly x: number;
  /** Сколько секций встанет. Ноль — ни одной. */
  readonly count: number;
  readonly side: BuildSide;
  /** Почему линия оборвалась или пуста. `null` — дошла до цели. */
  readonly issue: PlacementIssue | 'far' | null;
}

/**
 * Точка, с которой начат жест протяжки, в координатах МИРА.
 *
 * Живёт здесь, а не во вводе: ввод о мире не знает и знать не должен — он
 * сообщает только, что применение началось и что оно длится. Где именно —
 * помнит тот, кто ставит.
 *
 * Отдельного «жест прерван» нет: сброс ввода снимает удержание, и `end()`
 * зовётся тем же кодом, что и при отпускании.
 */
export class BuildRun {
  private start: { x: number; y: number } | null = null;
  private moved = false;
  private onExisting = false;

  /**
   * @param onExisting стояло ли что-то под началом жеста. Запоминается
   * ИМЕННО ЗДЕСЬ, до первой укладки: после неё под началом стоит своя секция
   * в любом случае, и отличить клик по ленте от клика по пустому месту уже
   * нечем — а различаются они противоположными действиями, сносом и
   * постановкой.
   */
  begin(x: number, y: number, onExisting: boolean): void {
    this.start = { x, y };
    this.moved = false;
    this.onExisting = onExisting;
  }

  /**
   * Отметить текущее положение прицела. Сдвигом считается уход в ДРУГУЮ клетку
   * модуля, а не любое движение курсора: внутри одной клетки жест кладёт ту же
   * секцию, и дрожание руки не имеет права превратить клик в протяжку.
   */
  note(x: number, y: number): void {
    if (this.start === null || this.moved) return;
    if (Builder.snap(x) !== Builder.snap(this.start.x)) this.moved = true;
    else if (Builder.snap(y) !== Builder.snap(this.start.y)) this.moved = true;
  }

  end(): void {
    this.start = null;
    this.moved = false;
    this.onExisting = false;
  }

  get anchor(): { x: number; y: number } | null {
    return this.start;
  }

  /** Жест идёт, но прицел ни разу не покинул клетку начала — то есть это клик. */
  get stationary(): boolean {
    return this.start !== null && !this.moved;
  }

  /**
   * Клик по уже стоящему: жест начат на постройке и никуда не повёл.
   *
   * Это СНОС, и только он: протяжка от той же точки — наоборот, продление
   * ленты, ради которого на неё и нажимают. Различает их движение прицела,
   * поэтому решение откладывается до отпускания.
   */
  get isDemolishClick(): boolean {
    return this.stationary && this.onExisting;
  }
}

export class Builder {
  /**
   * Левый верхний угол области под целью: цель ПРИТЯГИВАЕТСЯ к клетке общего
   * модуля, одинаково для машины и для секции.
   *
   * Центрирования на прицеле нет ни у кого. Оно требовало нечётных сторон ради
   * симметрии рамки вокруг точки, а с общей сеткой центра у рамки нет: видно,
   * какие именно клетки будут заняты. Притяжка при этом НЕ сдвиг к ближайшему
   * годному — она определяет, о каком месте вообще идёт речь, а годность
   * считается уже для него.
   */
  static originFor(kind: BuildingKind, targetX: number, targetY: number): { x: number; y: number } {
    void kind;
    return { x: Builder.snap(targetX), y: Builder.snap(targetY) };
  }

  /** Ближайшая граница модуля не правее координаты. */
  static snap(v: number): number {
    return Math.floor(v / BUILD_MODULE) * BUILD_MODULE;
  }

  /**
   * Клавиатурная цель по вертикали: низ области встаёт на уровень ступней.
   * Нужна боковому прицелу — цель стоит на высоте ЦЕНТРА персонажа, и без
   * поправки низ высокого корпуса уходит под землю («занято»). Без неё
   * постройка выше девяти ячеек с клавиатуры не ставится вовсе.
   *
   * Возвращает УЖЕ ВЫРОВНЕННОЕ значение — флор от него в `originFor` даёт
   * тождество, и угол по-прежнему считается в одном месте.
   *
   * Округление ВНИЗ, то есть корпус встаёт не ниже ступней. Вверх ошибаться
   * можно: просвет меньше модуля опоре не мешает, и место остаётся годным.
   * Вниз — нельзя: корпус уходит в грунт и отказывает «занято», а игрок видит
   * под контуром чистый воздух.
   */
  static groundedTargetY(kind: BuildingKind, playerY: number, hitboxH: number): number {
    return Builder.snap(playerY + hitboxH - kind.height);
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
    const issue = Builder.issueAt(world, kind, at.x, at.y, unlocks);
    return {
      x: at.x,
      y: at.y,
      w: kind.width,
      h: kind.height,
      ok: !far && issue === null,
      issue: far ? 'far' : issue,
    };
  }

  /**
   * Линия секций от начала жеста до прицела.
   *
   * Считается целиком здесь, чтобы контур и укладка не могли разойтись:
   * обе зовут эту функцию, и «докуда встанет» отвечает одно место.
   *
   * Стоимость — не больше `DIG.reach / BUILD_MODULE` секций за вызов; на фоне
   * полумиллиона ячеек мира это шум, поэтому линия пересчитывается каждый шаг,
   * а не кэшируется.
   */
  static line(
    world: World,
    kind: BuildingKind,
    anchorX: number,
    anchorY: number,
    targetX: number,
    playerCX: number,
    playerCY: number,
    modifierSide: BuildSide,
    unlocks: ContentUnlocks = NO_UNLOCKS,
  ): BuildLine {
    // Ряд — из НАЧАЛА жеста: лента переносит вбок, а строка, ползущая
    // за прицелом, превращала бы ровный перегон в лесенку.
    const row = Builder.snap(anchorY);
    const from = Builder.snap(anchorX);
    const to = Builder.snap(targetX);
    // Сторона — из жеста; у жеста нулевой длины её взять неоткуда, и тогда
    // отвечает модификатор.
    const side: BuildSide = to === from ? modifierSide : to > from ? 1 : -1;

    if (!isKindOpen(kind, unlocks)) {
      return { y: row, x: from, count: 0, side, issue: 'locked' };
    }

    const span = Math.abs(to - from) / BUILD_MODULE;
    let count = 0;
    let issue: PlacementIssue | 'far' | null = null;
    for (let k = 0; k <= span; k++) {
      const x = from + k * side * BUILD_MODULE;
      if (!Digger.inReach(playerCX, playerCY, x, row)) {
        issue = 'far';
        break;
      }
      const state = Builder.sectionState(world, kind, x, row);
      // Своя же секция на пути жеста — не «занято»: игрок ведёт по ней
      // намеренно, и укладка перекладывает ей сторону.
      if (state === 'blocked') {
        issue = 'occupied';
        break;
      }
      count++;
    }

    const left = side > 0 ? from : from - (count - 1) * BUILD_MODULE;
    return { y: row, x: count > 0 ? left : from, count, side, issue };
  }

  /**
   * Укладывает посчитанную линию.
   *
   * Записи-пустышки пропускаются: `world.set` будит чанк, а линия
   * перекладывается каждый шаг, пока держат кнопку. Без этой проверки
   * удержание жеста держало бы чанки всей ленты живыми — то есть ровно то,
   * что запрещено правилом «вставшая лента ничего не стоит».
   */
  static applyLine(world: World, kind: BuildingKind, line: BuildLine): number {
    const hull = hullForSide(kind, line.side);
    for (let k = 0; k < line.count; k++) {
      const x = line.x + k * BUILD_MODULE;
      for (let dy = 0; dy < kind.height; dy++) {
        for (let dx = 0; dx < kind.width; dx++) {
          if (world.get(x + dx, line.y + dy) !== hull) world.set(x + dx, line.y + dy, hull);
        }
      }
    }
    return line.count;
  }

  /**
   * Что стоит в клетке модуля: пусто, своя секция или чужое.
   *
   * «Своя» — любой из корпусов ЭТОГО вида: у ленты их два, и участок,
   * идущий в другую сторону, обязан читаться своим, иначе разворот протяжкой
   * упирался бы в «занято».
   */
  static sectionState(
    world: World,
    kind: BuildingKind,
    x: number,
    y: number,
  ): 'free' | 'own' | 'blocked' {
    const hulls = kind.sideHulls ?? [kind.hull];
    let free = true;
    let own = true;
    for (let dy = 0; dy < kind.height; dy++) {
      for (let dx = 0; dx < kind.width; dx++) {
        const m = world.get(x + dx, y + dy);
        if (m !== MAT.VACUUM) free = false;
        if (!hulls.includes(m)) own = false;
        if (!free && !own) return 'blocked';
      }
    }
    return free ? 'free' : 'own';
  }

  static issueAt(
    world: World,
    kind: BuildingKind,
    x: number,
    y: number,
    unlocks: ContentUnlocks = NO_UNLOCKS,
  ): PlacementIssue | null {
    // Первым, до всего остального: закрытый вид не ставится НИКАКИМ способом,
    // и ни деньги, ни удачное место этого не меняют. Умолчание — состояние
    // начала партии: забывчивость даёт отказ, а не тихое разрешение.
    if (!isKindOpen(kind, unlocks)) return 'locked';

    // Вся область пуста. Проверяется ОБЛАСТЬ, а не только ячейки корпуса:
    // внутренняя камера, набитая реголитом, замуровала бы вещество внутри
    // здания без всякой возможности его достать.
    for (let dy = 0; dy < kind.height; dy++) {
      for (let dx = 0; dx < kind.width; dx++) {
        if (world.get(x + dx, y + dy) !== MAT.VACUUM) return 'occupied';
      }
    }

    // Опора — хотя бы ОДНА твёрдая ячейка под областью, а не сплошной пол:
    // сепаратор на краю уступа стоять должен, и это лучшее для него место —
    // куча отхода уходит вниз сама.
    //
    // Ищется в полосе глубиной в МОДУЛЬ, а не в одном ряду под областью.
    // Здание стоит по сетке модуля, а поверхность мира на неё не ложится:
    // требование касаться грунта вплотную означало бы, что машина ставится
    // только там, где рельеф случайно кратен модулю, то есть в среднем на одной
    // клетке из четырёх. Просвет меньше модуля — это разрешение сетки,
    // а не «здание висит в воздухе», от которого правило и защищает.
    //
    // Проверяется, только если вид её требует. Общее правило запрещало бы ленте
    // ровно то, ради чего её ставят, — перенос вещества над пустотой.
    if (kind.needsSupport) {
      let supported = false;
      for (let dy = 0; dy < BUILD_MODULE && !supported; dy++) {
        for (let dx = 0; dx < kind.width && !supported; dx++) {
          if (MAT_STATE[world.get(x + dx, y + kind.height + dy)] === MatterState.Solid) {
            supported = true;
          }
        }
      }
      if (!supported) return 'unsupported';
    }

    return null;
  }

  /**
   * Разовое применение в точке: поставить или снести.
   *
   * У машины это всё применение целиком и срабатывает на НАЖАТИЕ — при
   * удержании игрок ставил бы и сносил одно здание тридцать раз в секунду.
   *
   * Из жеста протяжки сюда доходит только СНОС, и только на отпускании жеста,
   * не сдвинувшегося с места: снос на нажатии означал бы, что нельзя нажать
   * на ленту, чтобы её продлить, — первый же шаг жеста её бы и убрал.
   *
   * @param side сторона для секционной постройки; у вида без сторон не значит
   * ничего
   * @returns что произошло
   */
  static apply(
    world: World,
    registry: BuildingRegistry,
    kind: BuildingKind,
    playerCX: number,
    playerCY: number,
    targetX: number,
    targetY: number,
    unlocks: ContentUnlocks = NO_UNLOCKS,
    side: BuildSide = 1,
  ): 'placed' | 'demolished' | 'rejected' {
    if (!Digger.inReach(playerCX, playerCY, targetX, targetY)) return 'rejected';

    const standing = registry.findAt(targetX, targetY);
    if (standing) {
      Builder.demolish(world, registry, standing);
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
      return 'demolished';
    }

    const at = Builder.originFor(kind, targetX, targetY);
    if (Builder.issueAt(world, kind, at.x, at.y, unlocks) !== null) {
      return 'rejected';
    }

    // Секционная постройка — та же маска, тот же корпус, но без записи
    // в реестре: состояния у неё нет, и обновлять ей нечего.
    if (kind.create === null) {
      stampKind(world, kind, at.x, at.y, hullForSide(kind, side));
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
   * Стираются ячейки ЛЮБОГО корпуса этого вида, а не только стороны
   * по умолчанию: у ленты корпусов два, и снос, знающий один, оставлял бы
   * половину лент неразрушимыми. Клетка сетки заведомо содержит одну секцию
   * целиком, но проверка материала стоит одно сравнение и делает снос
   * безвредным для всего, что могло оказаться в клетке помимо неё.
   */
  private static razeSection(
    world: World,
    kind: BuildingKind,
    targetX: number,
    targetY: number,
  ): void {
    const at = Builder.originFor(kind, targetX, targetY);
    const hulls = kind.sideHulls ?? [kind.hull];
    for (let dy = 0; dy < kind.height; dy++) {
      for (let dx = 0; dx < kind.width; dx++) {
        const x = at.x + dx;
        const y = at.y + dy;
        if (hulls.includes(world.get(x, y))) world.set(x, y, MAT.VACUUM);
      }
    }
  }

  /**
   * Снос: корпус в пустоту, содержимое — в мир. Счёта не касается: постановка
   * ничего не списала, и возвращать нечего. Перестановка свободна — ровно
   * затем постройка и бесплатна.
   */
  static demolish(world: World, registry: BuildingRegistry, building: Building): void {
    const contents = building.drain();
    building.clear(world);
    registry.remove(building);
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
