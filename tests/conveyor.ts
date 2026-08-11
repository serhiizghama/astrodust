import { World, Simulation } from '../src/world';
import {
  Camera,
  Renderer,
  RecordingSurface,
  rollerOffset,
  CONVEYOR_ROLLER_COLOR,
} from '../src/render';
import type { Display } from '../src/core';
import {
  MAT,
  MAT_SOLID,
  MAT_CREDIT_RATE,
  MAT_CARRY,
  MAT_CARRY_DEPTH,
  MATERIALS,
} from '../src/world';
import type { Rect } from '../src/geometry';
import { Digger, Vacuum, Builder, BuildRun } from '../src/systems';
import {
  Player,
  Inventory,
  LandingModule,
  BuildingRegistry,
  SEPARATOR_KIND,
  Separator,
  OUTLET_FROM,
  OUTLET_TO,
  CONVEYOR_KIND,
  BUILD_CATALOG,
  BuildCatalogState,
  sectionKindByHull,
} from '../src/entities';
import {
  PLAYER,
  FIXED_DT,
  WORLD_SEED,
  BASE_VIEW_W,
  BASE_VIEW_H,
  SEPARATOR,
  CONVEYOR,
  BUILD_MODULE,
  DIG,
  SIM_HZ,
} from '../src/config';
import { check, IDLE_HUD, UNLOCKED, luna } from './harness';

const first = luna();

// --- Конвейеры ---
//
// Лента — вещество, а не сущность: всё её поведение задаётся полем `carry`
// в таблице материалов, а правило автомата одно и на вид груза не смотрит.
// Поэтому проверки идут по свойству переноса, а не по идентификатору ленты.
{
  const STEP = CONVEYOR.stepsPerCell;

  /** Пустой мир с полом в две нижние строки. */
  function sandbox(width = 128, height = 64): World {
    const w = new World(width, height, first.world.profile);
    for (let y = height - 2; y < height; y++) {
      for (let x = 0; x < width; x++) w.set(x, y, MAT.ROCK);
    }
    return w;
  }

  /** Кладёт ленту от x0 до x1 включительно. */
  function belt(w: World, y: number, x0: number, x1: number, material: number): void {
    for (let x = x0; x <= x1; x++) w.set(x, y, material);
  }

  function run(w: World, steps: number): Simulation {
    const sim = new Simulation();
    for (let i = 0; i < steps; i++) sim.update(w, null);
    return sim;
  }

  function count(w: World, material: number): number {
    let n = 0;
    for (const c of w.cells) if (c === material) n++;
    return n;
  }

  /** Где лежит единственная ячейка этого материала. */
  function findOne(w: World, material: number): { x: number; y: number } | null {
    for (let i = 0; i < w.cells.length; i++) {
      if (w.cells[i] === material) return { x: i % w.width, y: (i / w.width) | 0 };
    }
    return null;
  }

  const SZ = BUILD_MODULE;
  /**
   * Координаты клетки сетки секций, свободной от пола в песочнице.
   * Инвариант: кратны стороне секции — постановка выравнивает цель по сетке,
   * и с некратного угла лента ложится не туда, куда её просили.
   */
  const SECTION_X0 = 3 * BUILD_MODULE;
  const SECTION_Y = 3 * BUILD_MODULE;

  /** Ставит секцию, целясь в её левый верхний угол. */
  function lay(
    w: World,
    registry: BuildingRegistry,
    side: -1 | 1,
    x: number,
    y: number,
  ): 'placed' | 'demolished' | 'rejected' {
    return Builder.apply(w, registry, CONVEYOR_KIND, x, y, x, y, UNLOCKED, side);
  }

  /** На сколько ячеек уедет одинокий груз за столько шагов. */
  function rideDistance(beltMaterial: number, cargo: number, steps: number): number {
    const w = sandbox();
    belt(w, 40, 10, 110, beltMaterial);
    w.set(60, 39, cargo);
    run(w, steps);
    const at = findOne(w, cargo);
    return at ? at.x - 60 : NaN;
  }

  // --- Таблица ---

  // Отличаться конвейерам положено РОВНО переносом. Подпись и номер не в счёт:
  // они свои у каждого вещества. Остальное — состояние, плотность, блокировка,
  // переносимость, разрушаемость, ставка, цвет — обязано совпадать.
  {
    const left = MATERIALS[MAT.CONVEYOR_LEFT]! as unknown as Record<string, unknown>;
    const right = MATERIALS[MAT.CONVEYOR_RIGHT]! as unknown as Record<string, unknown>;
    const differing = Object.keys(left).filter(
      (k) => k !== 'id' && k !== 'name' && k !== 'carry' && left[k] !== right[k],
    );
    check(
      'Конвейеры различаются ровно переносом',
      differing.length === 0 &&
        MATERIALS[MAT.CONVEYOR_LEFT]!.carry === -1 &&
        MATERIALS[MAT.CONVEYOR_RIGHT]!.carry === 1,
      `расходятся ещё и в: ${differing.join(', ') || 'нигде'}`,
    );
  }

  {
    const carrying = MATERIALS.filter((m) => m.carry !== 0).map((m) => m.id);
    check(
      'Несущих поверхностей ровно две — оба конвейера, у всех прочих перенос нулевой',
      carrying.length === 2 &&
        carrying.includes(MAT.CONVEYOR_LEFT) &&
        carrying.includes(MAT.CONVEYOR_RIGHT),
      `несущих ${carrying.length}: ${carrying.map((id) => MATERIALS[id]!.name).join(', ')}`,
    );
    check(
      'Развёрнутый перенос совпадает с таблицей',
      MATERIALS.every((m) => MAT_CARRY[m.id] === m.carry),
    );
  }

  // Цвет у обоих ОДИН и не совпадает ни с одним другим веществом: направление
  // показывают бегущие ролики, а не оттенок — иначе игрок был бы обязан
  // запомнить, какой цвет куда везёт.
  {
    const beltColor = MATERIALS[MAT.CONVEYOR_LEFT]!.color;
    const clashes = MATERIALS.filter(
      (m) =>
        m.id !== MAT.VACUUM &&
        m.id !== MAT.CONVEYOR_LEFT &&
        m.id !== MAT.CONVEYOR_RIGHT &&
        m.color === beltColor,
    );
    check(
      'Оба конвейера окрашены одинаково, и этот цвет не занят другим веществом',
      MATERIALS[MAT.CONVEYOR_RIGHT]!.color === beltColor && clashes.length === 0,
      `совпадает с: ${clashes.map((m) => m.name).join(', ') || 'ни с чем'}`,
    );
    check(
      'Ролики — своя ступень той же лестницы, а не чей-то чужой цвет',
      CONVEYOR_ROLLER_COLOR !== beltColor &&
        !MATERIALS.some((m) => m.id !== MAT.VACUUM && m.color === CONVEYOR_ROLLER_COLOR),
    );
  }

  // --- Правило автомата ---

  {
    const right = rideDistance(MAT.CONVEYOR_RIGHT, MAT.REGOLITH_LOOSE, STEP * 8);
    const left = rideDistance(MAT.CONVEYOR_LEFT, MAT.REGOLITH_LOOSE, STEP * 8);
    check(
      'Ячейка едет в сторону переноса, а на встречной ленте — в противоположную',
      right === 8 && left === -8,
      `вправо ${right}, влево ${left}`,
    );
  }

  {
    // Правило выбирается по свойству ПОВЕРХНОСТИ, а не по списку допущенных
    // к перевозке веществ: такой список пришлось бы править каждым новым.
    const cargos = [MAT.REGOLITH_LOOSE, MAT.PULP, MAT.IRIDIUM, MAT.SLAG];
    const moved = cargos.map((c) => rideDistance(MAT.CONVEYOR_RIGHT, c, STEP * 8));
    check(
      'Реголит, пульпа, иридий и шлак едут одинаково',
      moved.every((d) => d === 8),
      cargos.map((c, i) => `${MATERIALS[c]!.name} ${moved[i]}`).join(', '),
    );
  }

  {
    // Одна-единственная ячейка ленты: диагонали вниз-вбок свободны, и без
    // правила груз скатился бы с неё, а не поехал.
    const w = sandbox();
    w.set(30, 40, MAT.CONVEYOR_RIGHT);
    w.set(30, 39, MAT.REGOLITH_LOOSE);
    run(w, 1);
    check(
      'Одиночная ячейка едет по ленте, а не сваливается по свободной диагонали',
      w.get(31, 39) === MAT.REGOLITH_LOOSE && w.get(30, 39) === MAT.VACUUM,
    );
  }

  {
    // Отказ переноса диагональ тоже не открывает. Иначе лента течёт по сторонам
    // при первом же упоре, и очередь на ней становится невозможна.
    const w = sandbox();
    w.set(30, 40, MAT.CONVEYOR_RIGHT);
    w.set(31, 39, MAT.ROCK);
    w.set(30, 39, MAT.REGOLITH_LOOSE);
    const sim = run(w, 200);
    check(
      'После отказа переноса ячейка остаётся на ленте, а не скатывается вбок',
      w.get(30, 39) === MAT.REGOLITH_LOOSE && sim.lastCellsVisited === 0,
      `обойдено на последнем шаге ${sim.lastCellsVisited}`,
    );
  }

  {
    // Столбик в полполосы едет ЦЕЛИКОМ: верхние ряды уезжают вместе с подошвой,
    // а не осыпаются с движущегося ряда назад по диагонали.
    const w = sandbox();
    const depth = MAT_CARRY_DEPTH[MAT.CONVEYOR_RIGHT]!;
    belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
    for (let k = 1; k <= depth; k++) w.set(50, 40 - k, MAT.REGOLITH_LOOSE);
    run(w, STEP);
    let moved = 0;
    for (let k = 1; k <= depth; k++) if (w.get(51, 40 - k) === MAT.REGOLITH_LOOSE) moved++;
    check(
      'Лента везёт полосу, а не ряд: столбик в полполосы уезжает целиком',
      moved === depth,
      `уехало ${moved} рядов из ${depth}`,
    );
  }

  {
    // Куча выше полосы: до верхних рядов лента не достаёт, и они подчиняются
    // обычным правилам сыпучего.
    const w = sandbox();
    const depth = MAT_CARRY_DEPTH[MAT.CONVEYOR_RIGHT]!;
    belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
    for (let k = 1; k <= depth + 1; k++) w.set(50, 40 - k, MAT.REGOLITH_LOOSE);
    run(w, STEP);
    check(
      'Выше полосы груз лентой не везётся',
      w.get(51, 40 - depth - 1) !== MAT.REGOLITH_LOOSE,
      `над полосой на (51,${40 - depth - 1}) ${MATERIALS[w.get(51, 40 - depth - 1)]!.name}`,
    );
  }

  // Упор собирает очередь, снятие упора её отпускает.
  {
    const w = sandbox();
    belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
    w.set(60, 39, MAT.ROCK);
    for (let i = 0; i < 6; i++) w.set(20 + i * 2, 39, MAT.REGOLITH_LOOSE);
    const total = count(w, MAT.REGOLITH_LOOSE);

    const sim = run(w, STEP * 60);
    let past = 0;
    let offRow = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        if (w.get(x, y) !== MAT.REGOLITH_LOOSE) continue;
        if (x > 60) past++;
        if (y !== 39) offRow++;
      }
    }
    check(
      'Упор собирает очередь: ничего не пропало, не прошло сквозь и не вытекло вбок',
      count(w, MAT.REGOLITH_LOOSE) === total && past === 0 && offRow === 0,
      `было ${total}, стало ${count(w, MAT.REGOLITH_LOOSE)}, прошло ${past}, вбок ${offRow}`,
    );
    check(
      'Вставшая гружёная лента не удерживает чанки: шаг обходит ноль ячеек',
      sim.lastCellsVisited === 0,
      `обойдено ${sim.lastCellsVisited}`,
    );

    w.set(60, 39, MAT.VACUUM);
    run(w, STEP * 60);
    let stalled = 0;
    for (let x = 0; x <= 60; x++) if (w.get(x, 39) === MAT.REGOLITH_LOOSE) stalled++;
    check(
      'Снятие упора возобновляет ход, число ячеек в очереди не изменилось',
      count(w, MAT.REGOLITH_LOOSE) === total && stalled === 0,
      `осталось позади упора ${stalled}, всего ${count(w, MAT.REGOLITH_LOOSE)}`,
    );
  }

  // Разрыв в ленте — тот же упор: отдельного правила для него в модели нет.
  // Лента набирается СЕКЦИЯМИ, и пропущена тоже целая секция.
  {
    const w = sandbox();
    const registry = new BuildingRegistry();
    // Ряд ленты кратен размеру секции: выравнивание касается обеих осей,
    // и произвольная строка притянулась бы к ближайшей клетке сетки.
    const y0 = 6 * SZ;
    const cargoRow = y0 - 1;
    const gapAt = 8 * SZ;
    for (let x = 2 * SZ; x < 13 * SZ; x += SZ) {
      if (x !== gapAt) lay(w, registry, 1, x, y0);
    }
    for (let i = 0; i < 4; i++) w.set(3 * SZ + i * 3, cargoRow, MAT.REGOLITH_LOOSE);
    const total = count(w, MAT.REGOLITH_LOOSE);

    run(w, STEP * 120);
    let past = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = gapAt + SZ; x < w.width; x++) {
        if (w.get(x, y) === MAT.REGOLITH_LOOSE) past++;
      }
    }
    check(
      'Разрыв в ленте останавливает груз',
      count(w, MAT.REGOLITH_LOOSE) === total && past === 0,
      `прошло разрыв ${past} из ${total}`,
    );

    // Достройка возобновляет ход. Свалившееся в разрыв игрок убирает пылесосом —
    // здесь оно просто снимается, — после чего секция встаёт на место
    // и следующая партия проезжает насквозь.
    for (let y = y0; y < w.height; y++) {
      for (let x = gapAt; x < gapAt + SZ; x++) {
        if (w.get(x, y) === MAT.REGOLITH_LOOSE) w.set(x, y, MAT.VACUUM);
      }
    }
    const placed = lay(w, registry, 1, gapAt, y0);
    const fresh = 3;
    for (let i = 0; i < fresh; i++) w.set(3 * SZ + i * 3, cargoRow, MAT.REGOLITH_LOOSE);

    run(w, STEP * 120);
    let through = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = gapAt + SZ; x < w.width; x++) {
        if (w.get(x, y) === MAT.REGOLITH_LOOSE) through++;
      }
    }
    check(
      'Достройка пропущенной секции возобновляет ход',
      placed === 'placed' && through === fresh,
      `поставлено ${placed}, проехало ${through} из ${fresh}`,
    );
  }

  {
    // За один шаг груз смещается не более чем на одну позицию. Проверяется
    // не по одной ячейке, а по всей строке: всякая занятая после шага позиция
    // обязана иметь занятого соседа до шага.
    const w = sandbox();
    belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
    for (let x = 20; x <= 80; x += 3) w.set(x, 39, MAT.REGOLITH_LOOSE);
    const sim = new Simulation();
    const row = (): Set<number> => {
      const s = new Set<number>();
      for (let x = 0; x < w.width; x++) if (w.get(x, 39) === MAT.REGOLITH_LOOSE) s.add(x);
      return s;
    };
    let jumps = 0;
    for (let i = 0; i < STEP * 20; i++) {
      const before = row();
      sim.update(w, null);
      for (const x of row()) {
        if (!before.has(x) && !before.has(x - 1) && !before.has(x + 1)) jumps++;
      }
    }
    check('За один шаг ни одна ячейка не уезжает дальше соседней позиции', jumps === 0, `${jumps}`);
  }

  {
    // Пропуск шага по темпу обязан удержать чанк: без этого он засыпает
    // в паузе между попытками, будить его некому, и груз застывает навсегда.
    const w = sandbox(256, 64);
    belt(w, 40, 10, 240, MAT.CONVEYOR_RIGHT);
    w.set(20, 39, MAT.REGOLITH_LOOSE);
    run(w, STEP * 200);
    const at = findOne(w, MAT.REGOLITH_LOOSE);
    check(
      'Груз едет на длинном прогоне и не застывает после первой паузы темпа',
      at !== null && at.x === 220 && at.y === 39,
      at ? `доехал до x=${at.x}` : 'потерялся',
    );
  }

  {
    const w = sandbox();
    belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
    belt(w, 30, 10, 110, MAT.CONVEYOR_LEFT);
    const sim = run(w, 300);
    check(
      'Мир с пустой лентой обходит ноль ячеек за шаг',
      sim.lastCellsVisited === 0,
      `обойдено ${sim.lastCellsVisited}`,
    );
  }

  {
    // Сохранение вещества и повторяемость — единственные проверки, которыми
    // ловится ошибка в любом из правил переноса разом.
    const cargos = [MAT.REGOLITH_LOOSE, MAT.PULP, MAT.IRIDIUM, MAT.SLAG];
    function loaded(): World {
      const w = sandbox();
      belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
      belt(w, 50, 10, 110, MAT.CONVEYOR_LEFT);
      for (let i = 0; i < 40; i++) {
        w.set(20 + i, 39, cargos[i % cargos.length]!);
        w.set(60 + i, 49, cargos[(i + 2) % cargos.length]!);
      }
      return w;
    }

    const w = loaded();
    const before = cargos.map((c) => count(w, c));
    run(w, 2000);
    const after = cargos.map((c) => count(w, c));
    check(
      'Сумма ячеек каждого материала не меняется после многих шагов на гружёной ленте',
      cargos.every((_, i) => before[i] === after[i]),
      cargos.map((c, i) => `${MATERIALS[c]!.name} ${before[i]}→${after[i]}`).join(', '),
    );

    const a = loaded();
    run(a, 500);
    const b = loaded();
    run(b, 500);
    let same = a.cells.length === b.cells.length;
    for (let i = 0; same && i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) same = false;
    check('Одинаковая последовательность шагов дважды даёт идентичные сетки', same);
  }

  {
    // Постройка, купленная за кредиты, не должна исчезать от промаха
    // по соседней породе — ни кистью, ни пылесосом. И вытесняться ей нечем:
    // статичное не раздвигается, какова бы ни была плотность груза.
    const w = sandbox();
    belt(w, 40, 40, 60, MAT.CONVEYOR_RIGHT);
    const before = count(w, MAT.CONVEYOR_RIGHT);

    const digger = new Digger();
    for (let i = 0; i < 10; i++) digger.update(1, w, true, 50, 38, 50, 40);
    const afterDig = count(w, MAT.CONVEYOR_RIGHT);

    const inventory = new Inventory();
    Vacuum.collect(w, inventory, 50, 40);

    w.set(50, 39, MAT.IRIDIUM);
    run(w, 100);

    check(
      'Конвейер не берётся кистью копания, не собирается пылесосом и не вытесняется',
      afterDig === before && count(w, MAT.CONVEYOR_RIGHT) === before && inventory.used === 0,
      `было ${before}, после копания ${afterDig}, сейчас ${count(w, MAT.CONVEYOR_RIGHT)}, в инвентаре ${inventory.used}`,
    );
  }

  // --- Каталог, постановка и снос ---

  {
    // Круг считается по ОТКРЫТЫМ видам: закрытые в переборе не встречаются
    // вовсе, и «столько раз, сколько их открыто» — это и есть полный круг.
    const state = new BuildCatalogState(UNLOCKED);
    const start = state.kind;
    const seen = new Set<string>();
    for (let i = 0; i < state.open.length; i++) {
      seen.add(state.kind.id);
      state.cycle();
    }
    check(
      'Перебор каталога по кругу возвращает к исходному виду',
      state.kind === start && seen.size === BUILD_CATALOG.length,
      `видов ${BUILD_CATALOG.length}`,
    );
    check(
      'Конвейер занимает ОДНУ строку каталога: сторона — не вид',
      BUILD_CATALOG.filter((k) => k.id.startsWith('conveyor')).length === 1 &&
        BUILD_CATALOG.includes(CONVEYOR_KIND),
      `строк конвейера ${BUILD_CATALOG.filter((k) => k.id.startsWith('conveyor')).length}`,
    );
    check(
      'Сторона живёт в паре корпусов вида, а у машины её нет',
      CONVEYOR_KIND.sideHulls !== null &&
        CONVEYOR_KIND.sideHulls[0] !== CONVEYOR_KIND.sideHulls[1] &&
        SEPARATOR_KIND.sideHulls === null,
    );
    check(
      'Названия видов о стороне не говорят: её задаёт жест',
      !BUILD_CATALOG.some((k) => k.name.includes('◀') || k.name.includes('▶')),
      BUILD_CATALOG.map((k) => k.name).join(' | '),
    );
    check(
      'Пиксельная постройка не заводит записи в реестре, машина заводит',
      CONVEYOR_KIND.create === null && SEPARATOR_KIND.create !== null,
    );
    check(
      'Опора — свойство вида: машине обязательна, ленте нет',
      SEPARATOR_KIND.needsSupport && !CONVEYOR_KIND.needsSupport,
    );
    check(
      'Секция квадратная и равна общему модулю',
      CONVEYOR_KIND.width === BUILD_MODULE && CONVEYOR_KIND.height === BUILD_MODULE,
      `${CONVEYOR_KIND.width}×${CONVEYOR_KIND.height}, модуль ${BUILD_MODULE}`,
    );
    // Оба предела названы тем, что защищают: проход персонажа и просвет под
    // выпускным окном. Прежней «половины хитбокса» больше нет — она выводилась
    // из вдвое меньшего модуля и сама по себе не защищала ничего.
    check(
      'Секция строго ниже персонажа и строго ниже просвета под окном машины',
      CONVEYOR_KIND.height < PLAYER.hitboxH && CONVEYOR_KIND.height < SEPARATOR.legs,
      `секция ${CONVEYOR_KIND.height}, персонаж ${PLAYER.hitboxH}, просвет ${SEPARATOR.legs}`,
    );
    // Полоса — половина секции: везёт лента, а не одна её строка.
    check(
      'Лента тянет полосу в половину секции, а не один ряд',
      MAT_CARRY_DEPTH[MAT.CONVEYOR_RIGHT] === CONVEYOR_KIND.height / 2 &&
        MAT_CARRY_DEPTH[MAT.CONVEYOR_LEFT] === MAT_CARRY_DEPTH[MAT.CONVEYOR_RIGHT],
      `глубина ${MAT_CARRY_DEPTH[MAT.CONVEYOR_RIGHT]}, секция ${CONVEYOR_KIND.height}`,
    );

    // Все виды стоят по ОДНОЙ сетке модуля: центрирования на прицеле нет
    // ни у кого, и соседние постройки стыкуются по построению.
    {
      const at = Builder.originFor(SEPARATOR_KIND, 100, 100);
      check(
        'Машина встаёт по сетке модуля, а не вокруг прицела',
        at.x % BUILD_MODULE === 0 && at.y % BUILD_MODULE === 0,
        `угол ${at.x},${at.y}`,
      );
      check(
        'Стороны всех видов кратны модулю',
        BUILD_CATALOG.every((k) => k.width % BUILD_MODULE === 0 && k.height % BUILD_MODULE === 0),
        BUILD_CATALOG.map((k) => `${k.id} ${k.width}×${k.height}`).join(', '),
      );
      check(
        'Ноги машины по бокам окна одинаковой ширины',
        OUTLET_FROM === SEPARATOR.width - OUTLET_TO,
        `слева ${OUTLET_FROM}, справа ${SEPARATOR.width - OUTLET_TO}`,
      );
      // Порция выходит ЦЕЛИКОМ или не выходит вовсе, и запаса здесь больше
      // нет: 10 ≤ 12 − 2. Шаг окна вниз без шага порции запирает выдачу.
      check(
        'Порция влезает в выпускное окно',
        SEPARATOR.batch <= OUTLET_TO - OUTLET_FROM - 2,
        `окно ${OUTLET_TO - OUTLET_FROM}, порция ${SEPARATOR.batch}`,
      );
    }

    // Боковой клавиатурный прицел ставит постройку на уровень ступней.
    // Без этого корпус выше девяти ячеек уходит нижним рядом под землю.
    //
    // С общей сеткой точное совпадение недостижимо: цель округляется вверх
    // до границы модуля. Округление ВВЕРХ и проверяется — здание над ступнями
    // годно, здание под ступнями отказывает «занято».
    {
      const playerY = 40;
      const y = Builder.groundedTargetY(SEPARATOR_KIND, playerY, PLAYER.hitboxH);
      const at = Builder.originFor(SEPARATOR_KIND, 100, y);
      const bottom = at.y + SEPARATOR_KIND.height - 1;
      const feet = playerY + PLAYER.hitboxH - 1;
      check(
        'Боковая клавиатурная цель не загоняет постройку под ступни',
        bottom <= feet && feet - bottom < BUILD_MODULE,
        `низ корпуса ${bottom}, ступни ${feet}`,
      );
    }
    // Единственный след секционной постройки в мире — ячейки сетки, и снос
    // спрашивает о ней сетку. Обратный поиск обязан знать оба конвейера
    // и не считать постройкой ни породу, ни корпус машины.
    check(
      'Секционная постройка узнаётся по материалу корпуса, и только она',
      sectionKindByHull(MAT.CONVEYOR_LEFT) === CONVEYOR_KIND &&
        sectionKindByHull(MAT.CONVEYOR_RIGHT) === CONVEYOR_KIND &&
        sectionKindByHull(MAT.SEPARATOR_HULL) === null &&
        sectionKindByHull(MAT.ROCK) === null,
    );
  }

  // Постройки игрока не блокируют персонажа. Это НЕ мешает веществу лежать
  // на них: `blocksPlayer` и правила движения — независимые признаки.
  {
    const passable = [MAT.CONVEYOR_LEFT, MAT.CONVEYOR_RIGHT, MAT.SEPARATOR_HULL];
    check(
      'Сквозь конвейеры и корпус машины персонаж проходит',
      passable.every((id) => MAT_SOLID[id] === 0),
      passable.map((id) => `${MATERIALS[id]!.name} ${MAT_SOLID[id]}`).join(', '),
    );
    check('Корпус модуля остаётся твёрдым: его ставил не игрок', MAT_SOLID[MAT.MODULE_HULL] === 1);

    const w = sandbox();
    belt(w, 40, 30, 60, MAT.CONVEYOR_RIGHT);
    // Площадка из корпуса машины: одиночной ячейки мало — с неё сыпучее
    // скатится по свободной диагонали, и это будет правило откоса, а не
    // проваливание сквозь корпус.
    for (let x = 44; x <= 46; x++) w.set(x, 20, MAT.SEPARATOR_HULL);
    check(
      'Корпус в сетке есть, но персонажа не держит',
      !w.isSolid(40, 40) && !w.isSolid(45, 20) && w.get(45, 20) === MAT.SEPARATOR_HULL,
    );
    w.set(45, 19, MAT.IRIDIUM);
    run(w, 60);
    check(
      'Груз лежит на проходимом корпусе и не проваливается сквозь него',
      w.get(45, 19) === MAT.IRIDIUM,
      `на (45,19) ${MATERIALS[w.get(45, 19)]!.name}`,
    );
  }

  // Груз едет по ВЕРХНЕМУ ряду секции: до остальных он не достаёт.
  {
    const w = sandbox();
    const registry = new BuildingRegistry();
    // Координаты по СЕТКЕ: круглое число само по себе на границу секции
    // не попадает, и груз оказался бы замурован внутри корпуса.
    const top = Builder.snap(32);
    const from = Builder.snap(20);
    for (let i = 0; i < 6; i++) lay(w, registry, 1, from + i * SZ, top);
    w.set(from + 3, top - 1, MAT.REGOLITH_LOOSE);
    run(w, STEP * 10);
    const at = findOne(w, MAT.REGOLITH_LOOSE);
    check(
      'Груз едет по верхнему ряду секции, а не внутри неё',
      at !== null && at.y === top - 1 && at.x === from + 3 + 10,
      at ? `(${at.x},${at.y}), ждали (${from + 13},${top - 1})` : 'потерялся',
    );
  }

  // Замуровать больше нечем: постройка ставится и поверх персонажа.
  {
    const w = sandbox();
    const registry = new BuildingRegistry();
    const occupant: Rect = { x: 20, y: 30, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
    const on = lay(w, registry, 1, occupant.x + 1, occupant.y + 1);
    check(
      'Постройка ставится поверх хитбокса персонажа и не запирает его',
      on === 'placed' && !w.rectHitsSolid(occupant.x, occupant.y, occupant.w, occupant.h),
      `${on}`,
    );
  }

  {
    const w = sandbox();
    check(
      'Лента ставится над пустотой, машина без опоры — не ставится',
      Builder.issueAt(w, CONVEYOR_KIND, 50, 20, UNLOCKED) === null &&
        Builder.issueAt(w, SEPARATOR_KIND, 50, 20, UNLOCKED) === 'unsupported',
    );
  }

  {
    const w = sandbox();
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    const registry = new BuildingRegistry();
    const sections = 8;

    let laid = 0;
    for (let i = 0; i < sections; i++) {
      const x = SECTION_X0 + i * SZ;
      if (lay(w, registry, 1, x, SECTION_Y) === 'placed') laid++;
    }
    check(
      'Лента из N секций кладётся целиком и ничего не стоит',
      laid === sections &&
        module.credits === 0 &&
        count(w, MAT.CONVEYOR_RIGHT) === sections * SZ * SZ,
      `положено ${laid}, ячеек ${count(w, MAT.CONVEYOR_RIGHT)}, на счету ${module.credits}`,
    );
    check('Реестр зданий не растёт от постановки лент', registry.count === 0, `${registry.count}`);

    // Соседние секции стыкуются без зазора и без нахлёста: между их корпусами
    // не остаётся ни одной пустой ячейки, а общее число ячеек ровно N × площадь.
    let seam = 0;
    for (let y = SECTION_Y; y < SECTION_Y + SZ; y++) {
      for (let x = SECTION_X0; x < SECTION_X0 + sections * SZ; x++) {
        if (w.get(x, y) !== MAT.CONVEYOR_RIGHT) seam++;
      }
    }
    check('Соседние секции стыкуются без зазора и без нахлёста', seam === 0, `дыр ${seam}`);

    // Лента продолжается дальше при нулевом счёте: единственное, что её
    // ограничивает, — место в мире.
    const beyond = SECTION_X0 + sections * SZ;
    const next = lay(w, registry, 1, beyond, SECTION_Y);
    check(
      'Лента продолжается при нулевом счёте: секция ничего не стоит',
      next === 'placed' && module.credits === 0 && w.get(beyond, SECTION_Y) === MAT.CONVEYOR_RIGHT,
      `${next}, на счету ${module.credits}`,
    );

    // Цель притягивается к клетке: куда именно внутри неё игрок целился,
    // на результат не влияет.
    {
      const w2 = sandbox();
      const r2 = new BuildingRegistry();
      const corners = [
        [SECTION_X0, SECTION_Y],
        [SECTION_X0 + SZ - 1, SECTION_Y],
        [SECTION_X0, SECTION_Y + SZ - 1],
        [SECTION_X0 + SZ - 1, SECTION_Y + SZ - 1],
      ];
      const results = corners.map(([tx, ty]) =>
        Builder.apply(w2, r2, CONVEYOR_KIND, tx!, ty!, tx!, ty!, UNLOCKED),
      );
      check(
        'Секция встаёт по сетке: прицел в любую точку клетки даёт одно и то же место',
        results[0] === 'placed' &&
          results.slice(1).every((r, i) => r === (i % 2 === 0 ? 'demolished' : 'placed')),
        results.join(', '),
      );
    }
  }

  {
    const w = sandbox();
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    const registry = new BuildingRegistry();
    // Три секции подряд; сносим среднюю.
    for (let i = 0; i < 3; i++) {
      lay(w, registry, -1, SECTION_X0 + i * SZ, SECTION_Y);
    }
    const mid = SECTION_X0 + SZ;
    // Груз лежит на верхнем ряду сносимой секции.
    w.set(mid + 1, SECTION_Y - 1, MAT.REGOLITH_LOOSE);

    // Вид, выбранный в каталоге, на снос не влияет: цель либо попала
    // в постройку, либо нет.
    const razed = Builder.apply(
      w,
      registry,
      SEPARATOR_KIND,
      mid + 2,
      SECTION_Y + 2,
      mid + 2,
      SECTION_Y + 2,
    );
    let midCells = 0;
    for (let y = SECTION_Y; y < SECTION_Y + SZ; y++) {
      for (let x = mid; x < mid + SZ; x++) if (w.get(x, y) !== MAT.VACUUM) midCells++;
    }
    check(
      'Снос секции ленты не трогает соседние, не роняет груз и не трогает счёт',
      razed === 'demolished' &&
        module.credits === 0 &&
        midCells === 0 &&
        w.get(SECTION_X0, SECTION_Y) === MAT.CONVEYOR_LEFT &&
        w.get(mid + SZ, SECTION_Y) === MAT.CONVEYOR_LEFT &&
        w.get(mid + 1, SECTION_Y - 1) === MAT.REGOLITH_LOOSE,
      `${razed}, счёт ${module.credits}, осталось в секции ${midCells}`,
    );

    const other = Builder.apply(
      w,
      registry,
      CONVEYOR_KIND,
      SECTION_X0 + 1,
      SECTION_Y + 1,
      SECTION_X0 + 1,
      SECTION_Y + 1,
    );
    check(
      'Применение по ленте другого направления сносит её, а не заменяет',
      other === 'demolished' && w.get(SECTION_X0, SECTION_Y) === MAT.VACUUM,
      `${other}, в ячейке ${MATERIALS[w.get(SECTION_X0, SECTION_Y)]!.name}`,
    );
  }

  // --- Кадр: бегущая полоса ---

  {
    const pixels = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
    const display = {
      pixels,
      ctx: { putImageData() {} },
      width: BASE_VIEW_W,
      height: BASE_VIEW_H,
      image: {},
      present() {},
    } as unknown as Display;

    // Ленты высотой в СЕКЦИЮ и по сетке модуля: ролики занимают середину
    // корпуса, и лента в одну строку их не показала бы вовсе.
    const BELT_RIGHT_Y = Builder.snap(100);
    const BELT_LEFT_Y = Builder.snap(120);
    const w = new World(400, 240, first.world.profile);
    const surface = new Int16Array(400);
    for (let x = 10; x < 300; x++) {
      for (let dy = 0; dy < BUILD_MODULE; dy++) {
        w.set(x, BELT_RIGHT_Y + dy, MAT.CONVEYOR_RIGHT);
        w.set(x, BELT_LEFT_Y + dy, MAT.CONVEYOR_LEFT);
      }
    }
    const renderer = new Renderer(display, w, surface, WORLD_SEED, new RecordingSurface());
    const camera = new Camera(400, 240);
    camera.snapTo(160, 120);
    // Ряд с роликами: середина секции.
    const rowRight = BELT_RIGHT_Y + CONVEYOR.rollerInset - camera.y;
    const rowLeft = BELT_LEFT_Y + CONVEYOR.rollerInset - camera.y;
    // Край секции: роликов там нет — иначе ряд сливается с соседней секцией
    // по вертикали и перестаёт читаться деталью механизма.
    const rowEdge = BELT_RIGHT_Y - camera.y;

    const rollerR = (CONVEYOR_ROLLER_COLOR >> 16) & 0xff;
    const rollerG = (CONVEYOR_ROLLER_COLOR >> 8) & 0xff;
    const rollerB = CONVEYOR_ROLLER_COLOR & 0xff;

    function pattern(row: number): boolean[] {
      const out: boolean[] = [];
      for (let sx = 0; sx < BASE_VIEW_W; sx++) {
        const i = (row * BASE_VIEW_W + sx) * 4;
        out.push(pixels[i] === rollerR && pixels[i + 1] === rollerG && pixels[i + 2] === rollerB);
      }
      return out;
    }

    const frame = (time: number): void => {
      renderer.render({
        camera: camera,
        player: new Player(160, 220),
        crosshairX: 0,
        crosshairY: 0,
        crosshairInReach: true,
        hud: IDLE_HUD,
        fps: 0,
        time: time,
      });
    };

    frame(0);
    const right0 = pattern(rowRight);
    const left0 = pattern(rowLeft);
    const bodyColor = MATERIALS[MAT.CONVEYOR_RIGHT]!.color;
    let body = 0;
    for (let sx = 20; sx < 150; sx++) {
      const i = (rowRight * BASE_VIEW_W + sx) * 4;
      if (pixels[i] === ((bodyColor >> 16) & 0xff)) body++;
    }
    const stripes = right0.slice(20, 150).filter(Boolean).length;
    check(
      'Ролики рисуются на ячейках с ненулевым переносом: есть и ролик, и корпус',
      stripes > 0 && body > 0 && stripes + body === 130,
      `ролик ${stripes}, корпус ${body} из 130`,
    );
    // Период, а не число: сколько роликов попало в окно, зависит от того,
    // где окно началось, а вот шаг повтора обязан быть ровно секцией — иначе
    // ряд разъезжается с её границами и читается узором поверх ленты.
    {
      let repeats = true;
      for (let sx = 20; sx < 150 - BUILD_MODULE; sx++) {
        if (right0[sx] !== right0[sx + BUILD_MODULE]) repeats = false;
      }
      // Доля роликов в окне — ширина ролика к периоду; расхождение не больше
      // одного ролика, потому что окно обрезает крайние с обеих сторон.
      const expected = (130 * CONVEYOR.rollerWidth) / BUILD_MODULE;
      check(
        'Ряд роликов повторяется с шагом секции',
        repeats && Math.abs(stripes - expected) <= CONVEYOR.rollerWidth,
        `повтор ${repeats}, роликов ${stripes} из 130, ждали ~${expected.toFixed(1)}`,
      );
    }
    check(
      'На краю секции роликов нет: ряд занимает середину корпуса',
      pattern(rowEdge).slice(20, 150).filter(Boolean).length === 0,
      `на краю ${pattern(rowEdge).slice(20, 150).filter(Boolean).length}`,
    );

    frame(STEP / SIM_HZ);
    const right1 = pattern(rowRight);
    const left1 = pattern(rowLeft);
    let rightOk = true;
    let leftOk = true;
    for (let sx = 20; sx < 150; sx++) {
      if (right1[sx] !== right0[sx - 1]) rightOk = false;
      if (left1[sx] !== left0[sx + 1]) leftOk = false;
    }
    check(
      'Ролики бегут в сторону переноса своей ленты, а виды окрашены одинаково',
      rightOk && leftOk,
      `вправо ${rightOk}, влево ${leftOk}`,
    );

    const steps = STEP * 9;
    check(
      'Скорость бегущих роликов совпадает со скоростью переноса',
      rollerOffset(steps / SIM_HZ) === rideDistance(MAT.CONVEYOR_RIGHT, MAT.REGOLITH_LOOSE, steps),
      `полоса ${rollerOffset(steps / SIM_HZ)}, груз ${rideDistance(MAT.CONVEYOR_RIGHT, MAT.REGOLITH_LOOSE, steps)}`,
    );
  }

  // --- Лента как связь между зданиями ---

  {
    // Лента кормит машину: приёмная грань уже описана как срабатывающая
    // на любое попадание, и нового правила поглощения не понадобилось.
    const w = sandbox(160, 96);
    const registry = new BuildingRegistry();
    // Цель — УГОЛ и по сетке модуля: центрирования на прицеле больше нет.
    const bx = Builder.snap(80);
    const by = Builder.snap(96 - 2 - SEPARATOR.height);
    Builder.apply(w, registry, SEPARATOR_KIND, bx, by, bx, by);
    belt(w, by, bx - 30, bx - 1, MAT.CONVEYOR_RIGHT);
    w.set(bx - 30, by - 1, MAT.PULP);

    const separator = registry.all[0] as Separator;
    const sim = new Simulation();
    for (let i = 0; i < STEP * 40; i++) {
      sim.update(w, null);
      registry.update(w, FIXED_DT);
    }
    check(
      'Лента доносит пульпу до приёмной грани, и та поглощает её без нового правила',
      registry.count === 1 && separator.stored === 1 && count(w, MAT.PULP) === 0,
      `в накопителе ${separator.stored}, в мире пульпы ${count(w, MAT.PULP)}`,
    );
  }

  {
    // Лента сдаёт в модуль: иридий принимается, шлак доезжает вместе с ним
    // и остаётся лежать в зоне — зона приёмник, а не мусоросжигатель.
    const w = sandbox(128, 64);
    const receiver = { x: 100, y: 59, w: 6, h: 3 };
    const module = new LandingModule(receiver);
    belt(w, 60, 20, 99, MAT.CONVEYOR_RIGHT);
    w.set(20, 59, MAT.IRIDIUM);
    w.set(22, 59, MAT.SLAG);

    const sim = new Simulation();
    let earnedAt = -1;
    for (let i = 0; i < STEP * 120; i++) {
      sim.update(w, null);
      if (module.update(w).credits > 0 && earnedAt < 0) earnedAt = i;
    }
    let slagInZone = 0;
    for (let y = receiver.y; y < receiver.y + receiver.h; y++) {
      for (let x = receiver.x; x < receiver.x + receiver.w; x++) {
        if (w.get(x, y) === MAT.SLAG) slagInZone++;
      }
    }
    check(
      'Лента доносит иридий до зоны приёмника, кредиты начисляются без действий игрока',
      module.credits === MAT_CREDIT_RATE[MAT.IRIDIUM] && count(w, MAT.IRIDIUM) === 0,
      `${module.credits} ₡ на шаге ${earnedAt}`,
    );
    check(
      'Шлак доезжает вместе с иридием и остаётся лежать в зоне приёмника',
      count(w, MAT.SLAG) === 1 && slagInZone === 1,
      `шлака в мире ${count(w, MAT.SLAG)}, в зоне ${slagInZone}`,
    );
  }

  {
    // Сквозной прогон: машина выдаёт продукт, он падает на ленту ПОД ней
    // и уезжает к приёмнику. Внутрь выпускного окна секция не помещается —
    // окно уже двух секций, и выровненный квадрат попадает туда лишь при
    // совпадении координат, — поэтому лента идёт под машиной, а машина стоит
    // на пьедестале.
    //
    //   ▓▓▓▓▓▓▓▓▓▓▓▓        пульпа на приёмной грани
    //   ▓░░░░░░░░░░▓
    //   ▓▓▓      ▓▓▓        выпускное окно
    //   ═══      ░░░        пьедестал под левой ногой, справа проход
    //   ▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶  лента идёт под машиной к приёмнику
    const w = sandbox(440, 192);
    const registry = new BuildingRegistry();
    const ZONE = { x: 372, y: 168, w: 20, h: 16 };
    const module = new LandingModule(ZONE);

    // Лента: секции по сетке, груз едет по строке над её верхним рядом.
    // Координаты МИРОВЫЕ, а не в числе секций: перегон обязан дотягиваться
    // до зоны приёмника независимо от того, чему равен модуль.
    const beltTop = Builder.snap(176);
    const cargoRow = beltTop - 1;
    const beltFrom = Builder.snap(56);
    // Последняя секция обязана упираться в упор: незакрытый хвост означает,
    // что груз сваливается с ленты, не доехав до зоны.
    const beltTo = Builder.snap(ZONE.x + ZONE.w - 1);
    for (let x = beltFrom; x <= beltTo; x += SZ) {
      lay(w, registry, 1, x, beltTop);
    }
    // Упор в конце: очередь встаёт внутри зоны приёмника, а не сыплется мимо.
    const stopX = ZONE.x + ZONE.w;
    w.set(stopX, cargoRow, MAT.ROCK);
    w.set(stopX, cargoRow - 1, MAT.ROCK);

    // Машина: её ноги кончаются на ряд ВЫШЕ строки груза, иначе продукт упёрся
    // бы в собственную ногу и никуда не поехал.
    const bx = Builder.snap(80);
    const by = Builder.snap(cargoRow - SEPARATOR.height);
    // Пьедестал ровно под левой ногой: её ширина — половина того, что осталось
    // от корпуса за вычетом выпускного окна.
    const legW = (SEPARATOR.width - SEPARATOR.window) >> 1;
    for (let dx = 0; dx < legW; dx++) w.set(bx + dx, by + SEPARATOR.height, MAT.ROCK);
    const built = Builder.apply(w, registry, SEPARATOR_KIND, bx, by, bx, by);
    for (let i = 0; i < SEPARATOR.batch; i++) w.set(bx + 3 + i, by - 1, MAT.PULP);

    const before = module.credits;
    const sim = new Simulation();
    let earnedAt = -1;
    for (let i = 0; i < STEP * 400; i++) {
      sim.update(w, null);
      registry.update(w, FIXED_DT);
      if (module.update(w).credits > 0 && earnedAt < 0) earnedAt = i;
    }
    let slagInZone = 0;
    for (let y = ZONE.y; y < ZONE.y + ZONE.h; y++) {
      for (let x = ZONE.x; x < ZONE.x + ZONE.w; x++) {
        if (w.get(x, y) === MAT.SLAG) slagInZone++;
      }
    }
    check(
      'Сквозной прогон: продукт выходит на ленту под машиной и доезжает до модуля',
      built === 'placed' &&
        module.credits - before === SEPARATOR.iridium * MAT_CREDIT_RATE[MAT.IRIDIUM]! &&
        count(w, MAT.IRIDIUM) === 0 &&
        slagInZone === SEPARATOR.batch - SEPARATOR.iridium,
      `${built}, начислено ${module.credits - before} ₡, шлака в зоне ${slagInZone}`,
    );
    // Замер: сколько занимает доставка от выпускного окна до приёмника.
    check(
      'Доставка от выпускного окна до приёмника укладывается в разумное время',
      earnedAt > 0 && earnedAt < STEP * 400,
      `${(earnedAt / SIM_HZ).toFixed(1)} с на ${beltTo - bx} ячеек ленты`,
    );
  }

  // --- Состояние жеста ---
  //
  // Клик и протяжка начинаются ОДИНАКОВО — нажатием, — а кончаются
  // противоположным: снос и укладка. Различает их движение прицела, поэтому
  // решение откладывается до отпускания, и вся эта развилка живёт здесь.
  {
    const runState = new BuildRun();
    check('Жест: пока не начат, начала нет', runState.anchor === null && !runState.stationary);

    runState.begin(SECTION_X0, SECTION_Y, false);
    check(
      'Жест: начало запомнено, и он ещё считается неподвижным',
      runState.anchor?.x === SECTION_X0 && runState.stationary,
    );

    // Сдвигом считается уход в ДРУГУЮ клетку модуля, а не любое движение
    // курсора: внутри одной клетки жест кладёт ту же секцию, и дрожание руки
    // не имеет права превратить клик в протяжку.
    runState.note(SECTION_X0 + BUILD_MODULE - 1, SECTION_Y);
    check('Жест: движение внутри клетки модуля сдвигом не считается', runState.stationary);
    runState.note(SECTION_X0 + BUILD_MODULE, SECTION_Y);
    check('Жест: уход в соседнюю клетку делает жест протяжкой', !runState.stationary);

    // Клик по уже стоящему — снос, и только он. Протяжка от той же точки —
    // наоборот, продление ленты, ради которого на неё и нажимают.
    const onEmpty = new BuildRun();
    onEmpty.begin(SECTION_X0, SECTION_Y, false);
    const onBelt = new BuildRun();
    onBelt.begin(SECTION_X0, SECTION_Y, true);
    const dragged = new BuildRun();
    dragged.begin(SECTION_X0, SECTION_Y, true);
    dragged.note(SECTION_X0 + BUILD_MODULE, SECTION_Y);
    check(
      'Жест: сносом читается только неподвижное нажатие по стоящему',
      !onEmpty.isDemolishClick && onBelt.isDemolishClick && !dragged.isDemolishClick,
      `по пустому ${onEmpty.isDemolishClick}, по ленте ${onBelt.isDemolishClick},` +
        ` протяжка по ленте ${dragged.isDemolishClick}`,
    );

    onBelt.end();
    check(
      'Жест: конец снимает и начало, и признак сноса',
      onBelt.anchor === null && !onBelt.isDemolishClick,
    );
  }

  // --- Протяжка ---
  //
  // Жест кладёт ленту непрерывной линией: перегон между машинами — это десятки
  // секций, и постановка по нажатию на секцию делает всю прокладку повторением
  // одного действия, в котором нельзя ошибиться ни в чём, кроме числа повторов.
  {
    const PCX = 200;
    /**
     * Линия от начала жеста до прицела, как её увидит и контур, и укладка.
     * Персонаж стоит В НАЧАЛЕ жеста: дальность считается от него, и отодвинутый
     * персонаж обрезал бы линию по причине, к самому жесту отношения не имеющей.
     */
    const drag = (w: World, ax: number, ay: number, tx: number, side: -1 | 1 = 1) =>
      Builder.line(w, CONVEYOR_KIND, ax, ay, tx, ax, ay, side, UNLOCKED);

    {
      const w = sandbox(512, 64);
      const line = drag(w, SECTION_X0, SECTION_Y, SECTION_X0 + 9 * SZ);
      Builder.applyLine(w, CONVEYOR_KIND, line);
      let solid = 0;
      for (let k = 0; k < 10; k++) {
        if (w.get(SECTION_X0 + k * SZ, SECTION_Y) === MAT.CONVEYOR_RIGHT) solid++;
      }
      check(
        'Протяжка кладёт перегон целиком, одним жестом и без зазоров',
        line.count === 10 && solid === 10,
        `секций ${line.count}, сплошных ${solid}`,
      );
    }

    {
      // Строка берётся из НАЧАЛА жеста: лента переносит вбок, и дрожание руки
      // не имеет права превратить ровный перегон в лесенку.
      const w = sandbox(512, 64);
      const line = drag(w, SECTION_X0, SECTION_Y, SECTION_X0 + 5 * SZ);
      check(
        'Протяжка горизонтальна: ряд не съезжает за прицелом',
        line.y === SECTION_Y,
        `ряд ${line.y}, начало ${SECTION_Y}`,
      );
    }

    {
      const w = sandbox(512, 64);
      const right = drag(w, 200, SECTION_Y, 200 + 4 * SZ);
      const left = drag(w, 200, SECTION_Y, 200 - 4 * SZ);
      check(
        'Сторона берётся из направления жеста',
        right.side === 1 && left.side === -1,
        `вправо ${right.side}, влево ${left.side}`,
      );
      // У жеста нулевой длины направления нет, и сторону называет модификатор.
      const plain = drag(w, 200, SECTION_Y, 200, 1);
      const shifted = drag(w, 200, SECTION_Y, 200, -1);
      check(
        'Жест нулевой длины берёт сторону у модификатора',
        plain.side === 1 && shifted.side === -1 && plain.count === 1,
        `без модификатора ${plain.side}, с ним ${shifted.side}`,
      );
    }

    {
      // Лента с пропуском посередине — это затор, то есть конструкция, которую
      // игрок не задумывал; а секции за камнем он не увидел бы вовсе.
      const w = sandbox(512, 64);
      const rockAt = SECTION_X0 + 3 * SZ;
      w.set(rockAt + 1, SECTION_Y + 1, MAT.ROCK);
      const line = drag(w, SECTION_X0, SECTION_Y, SECTION_X0 + 9 * SZ);
      Builder.applyLine(w, CONVEYOR_KIND, line);
      let beyond = 0;
      for (let x = rockAt; x < SECTION_X0 + 10 * SZ; x++) {
        if (w.get(x, SECTION_Y) === MAT.CONVEYOR_RIGHT) beyond++;
      }
      check(
        'Протяжка встаёт перед препятствием и за него не продолжается',
        line.count === 3 && line.issue === 'occupied' && beyond === 0,
        `секций ${line.count}, отказ ${line.issue}, за камнем ${beyond}`,
      );
    }

    {
      // Дальность руки за лентой сохраняется: длинный перегон прокладывается
      // в несколько заходов с ходьбой между ними, как копается длинный туннель.
      const w = sandbox(1024, 64);
      const line = drag(w, PCX, SECTION_Y, PCX + 200);
      const reachEnd = line.x + line.count * SZ;
      check(
        'Протяжка обрезается дальностью руки',
        line.issue === 'far' && reachEnd - PCX <= DIG.reach + SZ,
        `секций ${line.count}, отказ ${line.issue}, дотянулась до +${reachEnd - PCX}`,
      );
    }

    {
      // Разворот — тот же жест в обратную сторону. Прежний запрет опирался
      // на то, что сторона была отдельным видом каталога; с единым видом
      // требовать за ошибку в стороне полной перекладки перегона нечем.
      const w = sandbox(512, 64);
      const first = drag(w, SECTION_X0, SECTION_Y, SECTION_X0 + 5 * SZ, 1);
      Builder.applyLine(w, CONVEYOR_KIND, first);
      // Груз лежит НА ленте: перекладка корпуса до него не достаёт.
      const cargoX = SECTION_X0 + 2 * SZ;
      w.set(cargoX, SECTION_Y - 1, MAT.IRIDIUM);

      const back = drag(w, SECTION_X0 + 5 * SZ, SECTION_Y, SECTION_X0);
      Builder.applyLine(w, CONVEYOR_KIND, back);
      let flipped = 0;
      for (let k = 0; k <= 5; k++) {
        if (w.get(SECTION_X0 + k * SZ, SECTION_Y) === MAT.CONVEYOR_LEFT) flipped++;
      }
      check(
        'Протяжка поверх своей ленты разворачивает её, а не отвергает место',
        back.count === 6 && back.issue === null && flipped === 6,
        `секций ${back.count}, отказ ${back.issue}, развёрнуто ${flipped} из 6`,
      );
      check(
        'Разворот не трогает груз: он остаётся на месте и едет в новую сторону',
        w.get(cargoX, SECTION_Y - 1) === MAT.IRIDIUM && count(w, MAT.IRIDIUM) === 1,
        `иридия в мире ${count(w, MAT.IRIDIUM)}`,
      );
    }

    {
      // Повторная укладка идёт каждый шаг, пока держат кнопку. Записи-пустышки
      // обязаны пропускаться: `world.set` будит чанк, и без этого удержание
      // жеста держало бы чанки всей ленты живыми — то есть ровно то, что
      // запрещает правило «вставшая лента ничего не стоит».
      const w = sandbox(512, 64);
      const line = drag(w, SECTION_X0, SECTION_Y, SECTION_X0 + 9 * SZ);
      Builder.applyLine(w, CONVEYOR_KIND, line);
      run(w, 4);
      const before = w.chunks.activeCount();
      Builder.applyLine(w, CONVEYOR_KIND, line);
      check(
        'Повторная укладка той же линии не будит чанки',
        w.chunks.activeCount() === before,
        `активных чанков ${before} → ${w.chunks.activeCount()}`,
      );
    }
  }

  // --- Замеры ---

  {
    // Стоимость шага обязана следовать за ГРУЗОМ, а не за длиной ленты: пустая
    // лента не делает ни одной записи в мир и чанков не будит. Лента длиной
    // в экран, гружёная целиком, — первая конструкция, которая держит чанки
    // активными по замыслу игрока, и платит за это ровно она.
    function stepCost(beltLength: number, cargoAt: readonly number[]): number {
      const w = sandbox(400, 64);
      belt(w, 40, 10, 10 + beltLength - 1, MAT.CONVEYOR_RIGHT);
      for (const x of cargoAt) w.set(x, 39, MAT.REGOLITH_LOOSE);
      const sim = new Simulation();
      // Прогрев: постройка мира будит чанки один раз, и этот всплеск
      // к цене установившегося хода отношения не имеет.
      for (let i = 0; i < 20; i++) sim.update(w, null);
      let total = 0;
      for (let i = 0; i < 40; i++) {
        sim.update(w, null);
        total += sim.lastCellsVisited;
      }
      return Math.round(total / 40);
    }
    const clump = Array.from({ length: 20 }, (_, i) => 11 + i);
    const spread = Array.from({ length: 20 }, (_, i) => 11 + i * 15);
    const empty = stepCost(320, []);
    const shortBelt = stepCost(60, clump);
    const longBelt = stepCost(320, clump);
    const spreadCargo = stepCost(320, spread);
    check(
      'Стоимость шага следует за грузом, а не за длиной ленты',
      empty === 0 &&
        Math.abs(longBelt - shortBelt) <= shortBelt * 0.25 &&
        spreadCargo > longBelt * 2,
      `пустая лента ${empty}, лента 60 с грузом ${shortBelt}, лента 320 с тем же грузом ${longBelt},` +
        ` тот же груз по всей длине ${spreadCargo} ячеек за шаг`,
    );
  }

  {
    // Вечный двигатель из двух встречных лент игрок собирает нарочно.
    // Запрещать его правилом дороже, чем стерпеть: цена — считанные чанки,
    // и она не растёт.
    const w = sandbox();
    w.set(40, 40, MAT.CONVEYOR_RIGHT);
    w.set(41, 40, MAT.CONVEYOR_LEFT);
    w.set(40, 39, MAT.REGOLITH_LOOSE);
    const sim = new Simulation();
    for (let i = 0; i < 200; i++) sim.update(w, null);
    const early = w.chunks.activeCount();
    const earlyCost = sim.lastCellsVisited;
    for (let i = 0; i < 3000; i++) sim.update(w, null);
    const late = w.chunks.activeCount();
    check(
      'Вечный двигатель из встречных лент держит считанные чанки, и их число не растёт',
      early > 0 && late === early && early <= 4,
      `чанков ${early} → ${late}, ${earlyCost} ячеек за шаг`,
    );
  }

  {
    // Разделение по плотности — единственный доступный способ сортировать:
    // куча расслаивается сама, и лента, подведённая к её ПОДОШВЕ, черпает
    // преимущественно тяжёлое. Награда за понимание модели, а не гарантия:
    // когда куча выберется целиком, состав увезённого сойдётся к исходному,
    // и ценна здесь именно первая порция.
    //
    // Лента набирается НАСТОЯЩИМИ секциями по сетке — иначе замер отвечал бы
    // на вопрос о ленте, которую игрок построить не может.
    // Пол ниже верха мира не меньше чем на секцию: врезанная в него лента
    // обязана поместиться целиком, иначе замер отвечал бы на вопрос о ленте,
    // которая не встала.
    const H = 96;
    const w = new World(200, H, first.world.profile);
    // Пол кратен модулю: врезанная в него лента ложится ровно так, что её
    // верхний ряд совпадает с подошвой кучи. Строка МИРОВАЯ, а не в числе
    // секций: куча сыплется с фиксированной высоты, и пол обязан остаться
    // под ней, чему бы ни равнялся модуль.
    const floorTop = Builder.snap(80);
    for (let y = floorTop; y < H; y++) {
      for (let x = 0; x < 200; x++) w.set(x, y, MAT.ROCK);
    }

    const batch = 100;
    for (let i = 0; i < batch; i++) {
      w.set(50 + (i % 9), 40 + ((i / 9) | 0), i % 5 === 0 ? MAT.IRIDIUM : MAT.SLAG);
    }
    const sourceShare = count(w, MAT.IRIDIUM) / batch;

    const sim = new Simulation();
    let settledAt = -1;
    for (let i = 0; i < 6000 && settledAt < 0; i++) {
      sim.update(w, null);
      if (sim.lastCellsVisited === 0) settledAt = i;
    }

    // Подошва там, где она есть, а не там, где её ждали.
    let toe = w.width;
    for (let x = 0; x < w.width; x++) {
      const m = w.get(x, floorTop - 1);
      if (m === MAT.IRIDIUM || m === MAT.SLAG) {
        toe = x;
        break;
      }
    }
    // Лента врезается в пол: её верхний ряд — та самая строка, на которой
    // лежит нижний слой кучи. Клетка сетки берётся не правее подошвы, иначе
    // лента начнётся уже за кучей.
    const beltFrom = Math.floor(toe / SZ) * SZ;
    const registry = new BuildingRegistry();
    let laid = 0;
    for (let x = beltFrom; x <= 188; x += SZ) {
      for (let y = floorTop; y < floorTop + SZ; y++) {
        for (let dx = 0; dx < SZ; dx++) w.set(x + dx, y, MAT.VACUUM);
      }
      if (lay(w, registry, 1, x, floorTop) === 'placed') laid++;
    }

    const pastLine = (): { iridium: number; slag: number } => {
      let iridium = 0;
      let slag = 0;
      for (let y = 0; y < w.height; y++) {
        for (let x = 150; x < w.width; x++) {
          if (w.get(x, y) === MAT.IRIDIUM) iridium++;
          else if (w.get(x, y) === MAT.SLAG) slag++;
        }
      }
      return { iridium, slag };
    };

    let firstThirty: { iridium: number; slag: number } | null = null;
    for (let i = 0; i < 20000; i++) {
      sim.update(w, null);
      if (firstThirty) continue;
      const seen = pastLine();
      if (seen.iridium + seen.slag >= 30) firstThirty = seen;
    }
    const early = firstThirty ?? { iridium: 0, slag: 0 };
    const earlyShare = early.iridium / Math.max(1, early.iridium + early.slag);

    check(
      'Лента у подошвы улёгшейся кучи черпает преимущественно иридий, и вещество не пропадает',
      count(w, MAT.IRIDIUM) + count(w, MAT.SLAG) === batch &&
        firstThirty !== null &&
        earlyShare > sourceShare,
      `куча улеглась за ${settledAt} шагов, подошва с x=${toe};` +
        ` в первых 30 увезённых иридия ${(earlyShare * 100).toFixed(0)}%` +
        ` при ${(sourceShare * 100).toFixed(0)}% в источнике`,
    );
    // Замер: не стала ли планировка слишком грубой из-за шага сетки.
    check(
      'Лента из секций дотягивается до подошвы кучи, несмотря на шаг сетки',
      laid > 0 && beltFrom <= toe && toe - beltFrom < SZ,
      `секций ${laid}, подошва x=${toe}, лента с x=${beltFrom} — промах ${toe - beltFrom} из ${SZ}`,
    );
  }
}
