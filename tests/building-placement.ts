import {
  Camera,
  Renderer,
  RecordingSurface,
  MACHINE_STATE_COLORS,
  AREA_DASH_COLORS,
} from '../src/render';
import type { HudState } from '../src/render';
import type { Display } from '../src/core';
import { MAT, MAT_SOLID, Simulation, World } from '../src/world';
import { Digger, Vacuum, Builder } from '../src/systems';
import { Player, Inventory, LandingModule, BuildingRegistry } from '../src/entities';
import {
  SEPARATOR_KIND,
  CONVEYOR_KIND,
  Separator,
  OUTLET_ROW,
  OUTLET_FROM,
  OUTLET_TO,
} from '../src/entities';
import {
  PLAYER,
  FIXED_DT,
  WORLD_SEED,
  BASE_VIEW_W,
  BASE_VIEW_H,
  DIG,
  SEPARATOR,
  BUILD_MODULE,
  BUILD_AIM_DISTANCE,
} from '../src/config';
import {
  aimDirection,
  aimTarget,
  actionTarget,
  AimSourceTracker,
  ActionBarState,
  ToolMode,
} from '../src/core';
import { check, IDLE_HUD, luna, UNLOCKED } from './harness';
import { ground, count, settle } from './fixtures/world';
import { BX, BY, scene, build, feed } from './fixtures/separator';

const first = luna();
const { spawn } = first;

{
  // --- Постановка ---

  {
    const { world: w, module, registry } = scene();
    const before = module.credits;
    const result = build(w, registry);

    // Корпус лёг РОВНО по маске вида: ни ячейкой больше, ни меньше.
    let wrong = 0;
    for (let dy = 0; dy < SEPARATOR.height; dy++) {
      for (let dx = 0; dx < SEPARATOR.width; dx++) {
        const expected =
          SEPARATOR_KIND.shape[dy * SEPARATOR.width + dx] === 1 ? MAT.SEPARATOR_HULL : MAT.VACUUM;
        if (w.get(BX + dx, BY + dy) !== expected) wrong++;
      }
    }
    check(
      'Годное место принимает здание, корпус лёг ровно по своей форме',
      result === 'placed' && registry.count === 1 && wrong === 0,
      `результат ${result}, расхождений ${wrong}`,
    );
    check(
      'Постановка не тронула счёт: постройка бесплатна',
      module.credits === before,
      `${before} → ${module.credits}`,
    );

    // Сквозь корпус проходят: постройка игрока — не препятствие игроку.
    check(
      'Корпус сепаратора не держит персонажа',
      !w.isSolid(BX, BY) && MAT_SOLID[MAT.SEPARATOR_HULL] === 0,
    );
  }

  // --- Постройка бесплатна ---

  {
    // Нулевой счёт не мешает: все условия годности — про место.
    {
      const { world: w, module, registry } = scene();
      module.credits = 0;
      const at = Builder.originFor(SEPARATOR_KIND, BX, BY);
      const issue = Builder.issueAt(w, SEPARATOR_KIND, at.x, at.y, UNLOCKED);
      const r = build(w, registry);
      check(
        'При нулевом счёте место годно и постройка появляется',
        issue === null && r === 'placed' && registry.count === 1 && module.credits === 0,
        `отказ ${issue}, результат ${r}, счёт ${module.credits}`,
      );
    }

    // Открытый вид ставится сколько угодно раз: технология открывает
    // возможность, а не экземпляр. Мир взят с запасом по ширине — иначе
    // проверка мерила бы его край, а не отсутствие ограничения.
    {
      const size = BUILD_MODULE;
      const sections = 60;
      const w = ground(sections * size + 4 * size, 96);
      const registry = new BuildingRegistry();
      const money = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
      let laid = 0;
      for (let i = 0; i < sections; i++) {
        const x = 2 * size + i * size;
        const r = Builder.apply(w, registry, CONVEYOR_KIND, x, 4 * size, x, 4 * size, UNLOCKED);
        if (r === 'placed') laid++;
      }
      check(
        'Число поставленных секций ничем не ограничено, а счёт не тронут',
        laid === sections && money.credits === 0,
        `поставлено ${laid} из ${sections}, счёт ${money.credits}`,
      );
    }

    // Перестановка свободна: сносим и ставим заново — счёт тот же.
    {
      const { world: w, module, registry } = scene();
      module.credits = 500;
      build(w, registry);
      const afterPlace = module.credits;
      while (registry.count > 0) Builder.demolish(w, registry, registry.all[0]!);
      const afterRaze = module.credits;
      build(w, registry, BX + 40);
      check(
        'Перестановка не стоит ничего: счёт до и после совпадает',
        afterPlace === 500 && afterRaze === 500 && module.credits === 500,
        `${afterPlace} → ${afterRaze} → ${module.credits}`,
      );
    }
  }

  // Все три отказа: ни мир, ни счёт не меняются.
  {
    const cases: Array<[string, () => { ok: boolean; detail: string }]> = [
      [
        'занятое место',
        () => {
          const { world: w, module, registry } = scene();
          w.set(BX + 5, BY + 5, MAT.ROCK);
          const before = w.cells.slice();
          const credits = module.credits;
          const r = build(w, registry);
          let changed = 0;
          for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
          return {
            ok: r === 'rejected' && changed === 0 && module.credits === credits,
            detail: `${r}, изменено ${changed}, счёт ${credits} → ${module.credits}`,
          };
        },
      ],
      [
        'нет опоры',
        () => {
          const { world: w, module, registry } = scene();
          const before = w.cells.slice();
          const credits = module.credits;
          // Высоко над полом: под областью нет ни одной твёрдой ячейки.
          const r = build(w, registry, BX, 20);
          let changed = 0;
          for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
          return {
            ok: r === 'rejected' && changed === 0 && module.credits === credits,
            detail: `${r}, изменено ${changed}`,
          };
        },
      ],
    ];
    for (const [name, run] of cases) {
      const { ok, detail } = run();
      check(`Отказ «${name}» не меняет ни мир, ни счёт`, ok, detail);
    }
  }

  // Недостижимое место не меняет мир.
  {
    const { world: w, registry } = scene();
    const before = w.cells.slice();
    const cx = BX + (SEPARATOR.width >> 1);
    const cy = BY + (SEPARATOR.height >> 1);
    const r = Builder.apply(w, registry, SEPARATOR_KIND, cx + DIG.reach + 20, cy, cx, cy);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
    check('Постройка за пределом дальности не меняет мир', r === 'rejected' && changed === 0);
  }

  // --- Снос ---

  {
    const { world: w, module, registry } = scene();
    build(w, registry);
    const afterBuild = module.credits;
    const separator = registry.all[0] as Separator;

    // Внутри что-то лежит: снос обязан вернуть это в мир.
    feed(w, 3);
    separator.update(w, FIXED_DT);
    const stored = separator.stored;

    const cx = BX + (SEPARATOR.width >> 1);
    const cy = BY + (SEPARATOR.height >> 1);
    const r = Builder.apply(w, registry, SEPARATOR_KIND, cx, cy, cx, cy);

    check(
      'Применение по стоящему зданию сносит его, а не ставит второе поверх',
      r === 'demolished' && registry.count === 0,
      `результат ${r}, зданий ${registry.count}`,
    );
    check(
      'Снос не тронул счёт: возвращать нечего',
      module.credits === afterBuild,
      `${afterBuild} → ${module.credits}`,
    );
    check(
      'Корпус снесённого здания стал пустотой, а не породой',
      count(w, MAT.SEPARATOR_HULL) === 0,
      `корпуса осталось ${count(w, MAT.SEPARATOR_HULL)}`,
    );
    check(
      'Накопленное вернулось в мир и не пропало',
      stored === 3 && count(w, MAT.PULP) === 3,
      `было в машине ${stored}, в мире ${count(w, MAT.PULP)}`,
    );
  }

  // --- Областной снос ---
  //
  // Рамка — форма УЖЕ описанного сноса, а не второй механизм: правила для каждой
  // найденной постройки те же, меняется только их число за жест.

  {
    /**
     * Сцена под рамку: машина и лента из секций рядом с ней, всё в пределах
     * руки персонажа, стоящего в середине.
     */
    function factory(): {
      world: World;
      registry: BuildingRegistry;
      px: number;
      py: number;
      beltY: number;
      beltFrom: number;
      sections: number;
    } {
      const { world: w, registry } = scene();
      build(w, registry);
      // Лента идёт вбок от машины, по её верхней строке: под машиной места нет
      // — там пол сцены, а рамке нужны обе постройки в пределах одной руки.
      const beltY = BY;
      const beltFrom = BX + SEPARATOR.width;
      const sections = 4;
      for (let i = 0; i < sections; i++) {
        const x = beltFrom + i * BUILD_MODULE;
        Builder.apply(w, registry, CONVEYOR_KIND, x, beltY, x, beltY, UNLOCKED, 1);
      }
      // Персонаж — посередине между машиной и лентой: рука достаёт до обеих.
      return {
        world: w,
        registry,
        px: BX + (SEPARATOR.width >> 1),
        py: (BY + beltY) >> 1,
        beltY,
        beltFrom,
        sections,
      };
    }

    /** Рамка вокруг всей фабрики: от угла машины до конца ленты. */
    function whole(f: ReturnType<typeof factory>): ReturnType<typeof Builder.areaPreview> {
      return Builder.areaPreview(
        f.px,
        f.py,
        BX,
        BY,
        f.beltFrom + (f.sections - 1) * BUILD_MODULE,
        f.beltY,
      );
    }

    {
      const f = factory();
      const hullsBefore = count(f.world, MAT.CONVEYOR_RIGHT);
      const razed = Builder.razeArea(f.world, f.registry, whole(f));
      check(
        'Область сносит всё построенное внутри за один жест',
        razed === 1 + f.sections &&
          f.registry.count === 0 &&
          count(f.world, MAT.SEPARATOR_HULL) === 0 &&
          count(f.world, MAT.CONVEYOR_RIGHT) === 0,
        `снесено ${razed}, зданий ${f.registry.count}, корпуса ${count(f.world, MAT.SEPARATOR_HULL)}, ленты ${hullsBefore} → ${count(f.world, MAT.CONVEYOR_RIGHT)}`,
      );
    }

    // Порода, груз и корпус посадочного модуля рамкой не задеваются: это снос,
    // а не второй инструмент копания.
    {
      const f = factory();
      // Порода — пол сцены, груз — реголит на ленте, корпус модуля — рядом.
      f.world.set(f.beltFrom + 1, f.beltY - 1, MAT.REGOLITH_LOOSE);
      f.world.set(f.beltFrom + 2, f.beltY - 1, MAT.REGOLITH_LOOSE);
      for (let dx = 0; dx < BUILD_MODULE; dx++) {
        f.world.set(f.beltFrom + dx, f.beltY - 2, MAT.MODULE_HULL);
      }
      const rock = count(f.world, MAT.ROCK);
      Builder.razeArea(f.world, f.registry, whole(f));
      check(
        'Порода, груз и корпус модуля рамкой не задеты',
        count(f.world, MAT.ROCK) === rock &&
          count(f.world, MAT.REGOLITH_LOOSE) === 2 &&
          count(f.world, MAT.MODULE_HULL) === BUILD_MODULE,
        `породы ${rock} → ${count(f.world, MAT.ROCK)}, груза ${count(f.world, MAT.REGOLITH_LOOSE)}, модуля ${count(f.world, MAT.MODULE_HULL)}`,
      );
    }

    // Вид каталога на область не влияет: внутри рамки оказывается что попало,
    // и сверять каждое найденное с выбранным значило бы, что один жест убирает
    // разное в зависимости от того, что игрок собирался строить.
    {
      const f = factory();
      const razed = Builder.razeArea(f.world, f.registry, whole(f));
      check(
        'Рамка сносит и машину, и ленту разом — выбранный вид ни при чём',
        razed === 1 + f.sections && f.registry.count === 0,
        `снесено ${razed}`,
      );
    }

    // Постройка, задетая краем, сносится ЦЕЛИКОМ: половина здания в сетке —
    // это обломок, которого игрок не заказывал.
    {
      const f = factory();
      const corner = Builder.areaPreview(
        f.px,
        f.py,
        BX + SEPARATOR.width - 1,
        BY + SEPARATOR.height - 1,
        BX + SEPARATOR.width - 1,
        BY + SEPARATOR.height - 1,
      );
      const razed = Builder.razeArea(f.world, f.registry, corner);
      check(
        'Задетая краем рамки машина исчезает целиком',
        razed === 1 && f.registry.count === 0 && count(f.world, MAT.SEPARATOR_HULL) === 0,
        `снесено ${razed}, корпуса осталось ${count(f.world, MAT.SEPARATOR_HULL)}`,
      );
    }

    // Накопленное возвращается и из области: правила самого сноса те же.
    {
      const f = factory();
      feed(f.world, 3);
      (f.registry.all[0] as Separator).update(f.world, FIXED_DT);
      const stored = (f.registry.all[0] as Separator).stored;
      Builder.razeArea(f.world, f.registry, whole(f));
      check(
        'Накопленное возвращается в мир и при областном сносе',
        stored === 3 && count(f.world, MAT.PULP) === 3,
        `было в машине ${stored}, в мире ${count(f.world, MAT.PULP)}`,
      );
    }

    // Пустая рамка — не отказ: обвести чистое место не за что наказывать.
    {
      const f = factory();
      // Чистый воздух над машиной: рамка обводит место, где ничего не стоит.
      const air = BY - BUILD_MODULE * 2;
      const empty = Builder.areaPreview(f.px, f.py, BX, air, BX + BUILD_MODULE, air);
      const cells = f.world.cells.slice();
      const razed = Builder.razeArea(f.world, f.registry, empty);
      let changed = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i] !== f.world.cells[i]) changed++;
      check(
        'Пустая рамка ничего не меняет и отказом не считается',
        razed === 0 && changed === 0 && f.registry.count === 1,
        `снесено ${razed}, ячеек изменилось ${changed}`,
      );
    }

    // Рамка обрезается дальностью руки — той же, что у копания и постановки.
    {
      const f = factory();
      const far = Builder.areaPreview(f.px, f.py, f.px, f.py, f.px + DIG.reach * 4, f.py);
      const corner = { x: far.x + far.w - 1, y: far.y + far.h - 1 };
      check(
        'Рамка не выходит за дальность руки',
        far.w > 0 &&
          far.w < DIG.reach * 4 &&
          Digger.inReach(f.px, f.py, corner.x, corner.y) &&
          !Digger.inReach(f.px, f.py, corner.x + BUILD_MODULE, corner.y),
        `ширина ${far.w}, дальний угол (${corner.x},${corner.y}) при дальности ${DIG.reach}`,
      );

      // За пределом дальности ничего не сносится: секция, до которой рука
      // не достаёт, остаётся стоять.
      const outX = Builder.snap(f.px + DIG.reach + BUILD_MODULE * 2);
      Builder.apply(f.world, f.registry, CONVEYOR_KIND, outX, f.beltY, outX, f.beltY, UNLOCKED, 1);
      const wide = Builder.areaPreview(f.px, f.py, f.px, f.beltY, outX, f.beltY);
      Builder.razeArea(f.world, f.registry, wide);
      check(
        'За пределом дальности рамка ничего не сносит',
        f.world.get(outX, f.beltY) === MAT.CONVEYOR_RIGHT,
        `в дальней секции ${f.world.get(outX, f.beltY)}`,
      );
    }
  }

  // --- Корпус не трогается инструментами ---

  {
    const { world: w, registry } = scene();
    build(w, registry);
    const hullBefore = count(w, MAT.SEPARATOR_HULL);

    const excavated = Digger.applyBrush(w, BX, BY);
    const inv = new Inventory();
    const collected = Vacuum.collect(w, inv, BX, BY);

    check(
      'Корпус сепаратора не копается и не собирается',
      excavated === 0 &&
        collected === 0 &&
        inv.used === 0 &&
        count(w, MAT.SEPARATOR_HULL) === hullBefore,
      `выемка ${excavated}, собрано ${collected}, корпуса ${hullBefore} → ${count(w, MAT.SEPARATOR_HULL)}`,
    );

    // И не вытесняется даже самым плотным веществом мира.
    w.set(BX, BY - 1, MAT.IRIDIUM);
    settle(w, 500);
    check(
      'Корпус не вытесняется даже иридием',
      count(w, MAT.SEPARATOR_HULL) === hullBefore && w.get(BX, BY) === MAT.SEPARATOR_HULL,
    );
  }

  // --- Стоимость и детерминированность ---

  {
    const { world: w, registry } = scene();
    build(w, registry);
    const sim = new Simulation();
    let visited = -1;
    for (let i = 0; i < 2000; i++) {
      sim.update(w, null);
      registry.update(w, FIXED_DT);
      if (sim.lastCellsVisited === 0) {
        // Ещё несколько шагов: простаивающая машина не имеет права
        // разбудить мир обратно.
        for (let k = 0; k < 20; k++) {
          sim.update(w, null);
          registry.update(w, FIXED_DT);
        }
        visited = sim.lastCellsVisited;
        break;
      }
    }
    check(
      'Мир со стоящим без дела сепаратором обходит ноль ячеек за шаг',
      visited === 0,
      visited < 0 ? 'мир не улёгся за 2000 шагов' : `обойдено ${visited}`,
    );
  }

  {
    function run(): Uint8Array {
      const { world: w, registry } = scene();
      build(w, registry);
      const sim = new Simulation();
      let fed = 0;
      for (let i = 0; i < 1200; i++) {
        if (i % 60 === 0 && fed < 40) fed += feed(w, 5);
        sim.update(w, null);
        registry.update(w, FIXED_DT);
      }
      return w.cells.slice();
    }
    const a = run();
    const b = run();
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    check(
      'Одинаковая последовательность шагов с одинаковым набором зданий даёт идентичные сетки',
      diff === 0,
      `расхождений ${diff}`,
    );
  }

  // --- Режимы и кадр ---

  {
    const tool = new ActionBarState();
    // ОТКРЫТЫХ режимов, а не всех: сбор закрыт до покупки пылесоса, и перебор
    // его не посещает.
    const open = tool.slots.filter((_, i) => tool.available(i)).length;
    const seen: number[] = [tool.mode];
    for (let i = 0; i < open - 1; i++) {
      tool.cycle();
      seen.push(tool.mode);
    }
    tool.cycle();
    check(
      'Открытые режимы перебираются по кругу одной клавишей и возвращаются к первому',
      seen.length === open &&
        new Set(seen).size === open &&
        tool.mode === seen[0] &&
        tool.mode === ToolMode.Dig,
      seen.join(' → ') + ' → ' + tool.mode,
    );

    // В режиме строительства инструмент не копает и не собирает. Номер слота
    // берётся из раскладки: порядок правится в одном месте.
    tool.select(tool.slots.findIndex((e) => e?.mode === ToolMode.Build));
    check(
      'Слот строительства выбирается напрямую',
      tool.building && !tool.digging && !tool.collecting,
      `слот ${tool.activeSlot}`,
    );

    const w = ground();
    for (let y = 40; y < 46; y++) for (let x = 40; x < 46; x++) w.set(x, y, MAT.ROCK);
    const digger = new Digger();
    const vac = new Vacuum();
    const inv = new Inventory();
    const rockBefore = count(w, MAT.ROCK);
    digger.update(FIXED_DT, w, true && tool.digging, 43, 43, 43, 43);
    vac.updateSuck(FIXED_DT, w, inv, true && tool.collecting, 43, 43, 43, 43);
    check(
      'В режиме строительства не копается и не собирается',
      count(w, MAT.ROCK) === rockBefore && inv.used === 0,
      `породы ${rockBefore} → ${count(w, MAT.ROCK)}, инвентарь ${inv.used}`,
    );
  }

  // Высыпанная пульпа принимается так же, как упавшая, а шлак из-под машины
  // убирается тем же пылесосом — это единственный способ разблокировать выход.
  {
    const { world: w, registry } = scene();
    build(w, registry);
    const separator = registry.all[0] as Separator;

    const inv = new Inventory();
    // Больше, чем кисть кладёт над приёмной гранью: кисть заполняется сверху
    // вниз, и малой порции до самой грани не хватает.
    inv.add(MAT.PULP, 40);
    while (inv.selected !== MAT.PULP) inv.cycleSelected();
    Vacuum.dump(w, inv, BX + 2, BY - 1);
    const onFace = (() => {
      let n = 0;
      for (let dx = 0; dx < SEPARATOR.width; dx++) if (w.get(BX + dx, BY - 1) === MAT.PULP) n++;
      return n;
    })();
    separator.update(w, FIXED_DT);
    let leftOnFace = 0;
    for (let dx = 0; dx < SEPARATOR.width; dx++)
      if (w.get(BX + dx, BY - 1) === MAT.PULP) leftOnFace++;
    check(
      'Высыпанная на приёмную грань пульпа поглощается так же, как упавшая',
      onFace > 0 && leftOnFace === 0 && separator.drain().length === onFace,
      `на грань легло ${onFace}, осталось ${leftOnFace}, в машине ${separator.drain().length}`,
    );

    // Шлак под окном забирается сбором, и выход освобождается.
    const outletY = BY + OUTLET_ROW;
    for (let dx = OUTLET_FROM; dx < OUTLET_TO; dx++) w.set(BX + dx, outletY, MAT.SLAG);
    const bag = new Inventory();
    const taken = Vacuum.collect(w, bag, BX + (SEPARATOR.width >> 1), outletY);
    check(
      'Шлак убирается пылесосом и освобождает выход машины',
      taken > 0 && bag.count(MAT.SLAG) === taken,
      `собрано ${taken}`,
    );
  }

  // Постройка и снос без единого события мыши.
  //
  // Клавиатурная цель постройки обязана быть ДАЛЬШЕ копательной: здание
  // центрируется на цели, а место негодно, если область накрывает персонажа.
  // При общей дистанции шесть пересечение возникало в любом направлении,
  // то есть построить с клавиатуры было нельзя вовсе. Проверяются все восемь.
  {
    const { world: w, registry } = scene();
    const tool = new ActionBarState();
    while (!tool.building) tool.cycle();
    check('Режим строительства выбирается той же клавишей', tool.building);

    // Персонаж стоит на полу мира: пол ровный, поэтому годность зависит только
    // от направления прицела.
    const px = 48;
    const py = w.height - 2 - Math.ceil(PLAYER.hitboxH / 2);

    const dirs: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    // Прежний инвариант — «область не накрывает персонажа ни в одном
    // из восьми направлений» — умер вместе со своей причиной: постройки игрока
    // его не блокируют, и проверка пересечения с хитбоксом убрана. Осталось
    // то, что от расстояния зависит по-прежнему: цель обязана быть достижима,
    // иначе «жму, и ничего не происходит» возвращается другим путём.
    let unreachable = 0;
    for (const [ax, ay] of dirs) {
      const dir = aimDirection(ax, ay, 1);
      const target = aimTarget(px, py, dir.x, dir.y, BUILD_AIM_DISTANCE);
      if (!Digger.inReach(px, py, target.x, target.y)) unreachable++;
    }
    check(
      'Клавиатурная цель постройки достижима во всех восьми направлениях',
      unreachable === 0,
      `недостижимых ${unreachable} из ${dirs.length}`,
    );

    // Полный круг: поставить и снести, ни разу не тронув мышь.
    const dir = aimDirection(1, 0, 1);
    const target = aimTarget(px, py, dir.x, dir.y, BUILD_AIM_DISTANCE);
    // Боковой прицел ставит корпус на уровень ступней: центрированная на поясе
    // цель загнала бы низ здания под землю.
    target.y = Builder.groundedTargetY(SEPARATOR_KIND, py - (PLAYER.hitboxH >> 1), PLAYER.hitboxH);
    const placedByKeys = Builder.apply(w, registry, SEPARATOR_KIND, px, py, target.x, target.y);
    const demolishedByKeys =
      registry.count > 0 && Builder.apply(w, registry, SEPARATOR_KIND, px, py, target.x, target.y);

    check(
      'Постройка и снос проходятся без мыши',
      placedByKeys === 'placed' && demolishedByKeys === 'demolished' && registry.count === 0,
      `постановка ${placedByKeys}, снос ${demolishedByKeys}`,
    );
  }

  // Контур и постановка обязаны говорить об ОДНОЙ точке.
  //
  // У кистей цель выбирает удерживаемый орган управления. Постройке этого
  // правила мало: контур показывается ДО нажатия, когда удерживаемого органа
  // нет вовсе, — и цель вставала бы у персонажа, а нажатие ставило бы здание
  // под курсором. Поэтому цель постройки следует за АКТИВНЫМ ИСТОЧНИКОМ
  // прицела. Проверяется композиция ровно из тех же вызовов, что в главном цикле.
  {
    const aim = new AimSourceTracker();
    const cursorX = 200;
    const cursorY = 90;
    const px = 48;
    const py = 100;
    const dir = aimDirection(1, 0, 1);

    const byKeys = actionTarget(
      aim.source === 'mouse',
      cursorX,
      cursorY,
      px,
      py,
      dir.x,
      dir.y,
      BUILD_AIM_DISTANCE,
    );
    aim.note('mouse', false);
    const byMouse = actionTarget(
      aim.source === 'mouse',
      cursorX,
      cursorY,
      px,
      py,
      dir.x,
      dir.y,
      BUILD_AIM_DISTANCE,
    );

    check(
      'Цель постройки следует за источником прицела, а не за удержанием кнопки',
      byKeys.x === px + BUILD_AIM_DISTANCE && byMouse.x === cursorX && byMouse.y === cursorY,
      `с клавиатуры (${byKeys.x},${byKeys.y}), мышью (${byMouse.x},${byMouse.y})`,
    );

    // Прежнее правило дало бы при ненажатой кнопке клавиатурную цель даже
    // мышиному игроку — то есть контур в одном месте, здание в другом.
    const oldRule = actionTarget(false, cursorX, cursorY, px, py, dir.x, dir.y, BUILD_AIM_DISTANCE);
    check(
      'Прежнее правило «по удержанию» разводило контур и постановку',
      oldRule.x !== byMouse.x,
      `по удержанию (${oldRule.x},${oldRule.y}) против курсора (${byMouse.x},${byMouse.y})`,
    );
  }

  // Контур будущего здания и состояние машины действительно попадают в кадр.
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

    const renderer = new Renderer(
      display,
      first.world,
      first.surface,
      WORLD_SEED,
      new RecordingSurface(),
    );
    const camera = new Camera(first.world.width, first.world.height);
    camera.snapTo(spawn.x, spawn.y);

    function countPixels(color: number): number {
      const r = (color >> 16) & 0xff;
      const g = (color >> 8) & 0xff;
      const b = color & 0xff;
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === r && pixels[i + 1] === g && pixels[i + 2] === b) n++;
      }
      return n;
    }

    const rect = { x: camera.x + 40, y: camera.y + 40, w: SEPARATOR.width, h: SEPARATOR.height };
    const hud = (over: Partial<HudState>): HudState => ({ ...IDLE_HUD, ...over });

    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: hud({ ghost: { ...rect, ok: true, side: 0, area: false } }),
      fps: 0,
    });
    const okPixels = countPixels(MACHINE_STATE_COLORS.working);

    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: hud({ ghost: { ...rect, ok: false, side: 0, area: false } }),
      fps: 0,
    });
    const badPixels = countPixels(MACHINE_STATE_COLORS.blocked);

    const perimeter = 2 * SEPARATOR.width + 2 * (SEPARATOR.height - 2);
    check(
      'Контур будущего здания рисуется периметром и меняет цвет по годности',
      okPixels === perimeter && badPixels === perimeter,
      `годный ${okPixels}, негодный ${badPixels} при периметре ${perimeter}`,
    );

    // Рамка области отличима от контура постройки НЕ размером: она штриховая,
    // и оба её цвета — с лестницы отказа.
    {
      renderer.render({
        camera: camera,
        player: new Player(spawn.x, spawn.y),
        crosshairX: 160,
        crosshairY: 90,
        crosshairInReach: true,
        hud: hud({ ghost: { ...rect, ok: false, side: 0, area: true } }),
        fps: 0,
      });
      // Считаем по ВЕРХНЕЙ стороне рамки, а не по кадру: тёмная ступень
      // лестницы встречается в мире и сама по себе, и подсчёт по всему кадру
      // мерил бы породу, а не контур.
      const sx = rect.x - camera.x;
      const sy = rect.y - camera.y;
      let bright = 0;
      let dark = 0;
      for (let dx = 0; dx < rect.w; dx++) {
        const i = (sy * BASE_VIEW_W + sx + dx) * 4;
        const c = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
        if (c === AREA_DASH_COLORS[0]) bright++;
        else if (c === AREA_DASH_COLORS[1]) dark++;
      }
      check(
        'Рамка области рисуется штрихом, а не сплошным периметром',
        bright + dark === rect.w && bright === dark,
        `по верхней стороне светлых ${bright}, тёмных ${dark} из ${rect.w}`,
      );

      // Различимость на любом фоне: худший фон — ровно между двумя цветами
      // штриха, и даже там перепад до ближайшего из них велик.
      const lum = (c: number): number =>
        0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff);
      const a = lum(AREA_DASH_COLORS[0]);
      const b = lum(AREA_DASH_COLORS[1]);
      const worst = Math.abs(a - b) / 2;
      check(
        'Штрих различим на любом фоне: цвета разнесены по яркости',
        worst >= 50,
        `яркости ${a.toFixed(0)} и ${b.toFixed(0)}, худший перепад ${worst.toFixed(0)} из 255`,
      );
    }

    // Состояние машины видно НА САМОЙ машине, а не только в строке состояния.
    const machine = { ...rect, progress: 0.5 } as const;
    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: hud({ machines: [{ ...machine, state: 'working' }] }),
      fps: 0,
    });
    const working = countPixels(MACHINE_STATE_COLORS.working);
    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: hud({ machines: [{ ...machine, state: 'blocked' }] }),
      fps: 0,
    });
    const blocked = countPixels(MACHINE_STATE_COLORS.blocked);
    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: hud({ machines: [{ ...machine, state: 'idle' }] }),
      fps: 0,
    });
    const idle = countPixels(MACHINE_STATE_COLORS.idle);

    check(
      'Работа, простой и забитый выход различаются на самой машине',
      working === Math.round(SEPARATOR.width * 0.5) &&
        blocked === SEPARATOR.width &&
        idle === SEPARATOR.width,
      `работа ${working}, забит ${blocked}, простой ${idle}`,
    );
  }
}
