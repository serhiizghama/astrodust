import { World, MAT, MAT_CREDIT_RATE, Simulation } from '../src/world';
import {
  VACUUM_OUTLINE,
  vacuumOutline,
  RecordingSurface,
  techTreeLayout,
  techTreeSize,
  nodeOrigin,
  nodeAtPoint,
  closeButtonRect,
  overClose,
  drawResearchOverlay,
} from '../src/render';
import type { OverlayView, OverlayNode, UiOp } from '../src/render';
import { RAMP, css } from '../src/palette';
import { Vacuum, Builder } from '../src/systems';
import {
  Player,
  NO_INPUT,
  Inventory,
  LandingModule,
  BuildingRegistry,
  SEPARATOR_KIND,
  CONVEYOR_LEFT_KIND,
  CONVEYOR_RIGHT_KIND,
  BUILD_CATALOG,
  BuildCatalogState,
} from '../src/entities';
import {
  Research,
  ResearchOverlay,
  Tuning,
  TUNING_BASE,
  TECHNOLOGIES,
  TECH_BY_ID,
  statusNote,
  TECH_NODES,
  TECH_EDGES,
  TECH_COLS,
  TECH_ROWS,
  CONTENT,
  maxTuned,
} from '../src/progress';
import type { PointerTarget } from '../src/progress';
import { TECH_TREE, UI } from '../src/config';
import {
  PLAYER,
  FIXED_DT,
  BASE_VIEW_W,
  BASE_VIEW_H,
  MAX_VIEW_W,
  MAX_VIEW_H,
  DIG,
  VACUUM,
  SEPARATOR,
  SIM_HZ,
} from '../src/config';
import { check, luna, pick, said, saysLike } from './harness';

const first = luna();

// --- Исследования: валюты, дерево, профиль и оверлей ---
//
// Проверки разбиты по тому, что именно они защищают. Самая тихая ошибка здесь
// не «покупка не работает» — она видна сразу, — а «профиль разошёлся с конфигом»
// и «апгрейд нарушил инвариант подсистемы»: обе проявляются молча и обе делают
// весь остальной набор проверок проверками другой игры.
{
  /** Мир с полом в две нижние строки. */
  function ground(width = 96, height = 96): World {
    const w = new World(width, height, first.world.profile);
    for (let y = height - 2; y < height; y++) {
      for (let x = 0; x < width; x++) w.set(x, y, MAT.ROCK);
    }
    return w;
  }

  function count(w: World, material: number): number {
    let n = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) if (w.get(x, y) === material) n++;
    }
    return n;
  }

  /** Технология по идентификатору — с падением, а не с молчаливым undefined. */
  function tech(id: string) {
    const t = TECH_BY_ID.get(id);
    if (!t) throw new Error(`нет технологии ${id}`);
    return t;
  }

  /**
   * Счёт для покупок — НАСТОЯЩИЙ модуль, а не заглушка: контракт покупки
   * проверяется на том же объекте, который платит в игре.
   */
  function wallet(credits = 0): LandingModule {
    const m = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    m.credits = credits;
    return m;
  }

  /** Пустой ввод меню: поля перечислены один раз, а не в каждом вызове. */
  const NO_MENU = {
    menuUpPressed: false,
    menuDownPressed: false,
    menuLeftPressed: false,
    menuRightPressed: false,
    menuConfirmPressed: false,
    pointerPressed: false,
    menuClosePressed: false,
  };
  const menu = (over: Partial<typeof NO_MENU> = {}) => ({ ...NO_MENU, ...over });

  const CONVEYOR_TECH = 'conveyor-belt';
  const WIDE = 'wide-nozzle';
  const HEAVY = 'heavy-nozzle';
  const THRUSTERS = 'boosted-thrusters';

  // --- Таблица технологий ---

  {
    check(
      'Стартовое дерево содержит все три вида узла: открытие, параметр, зависимый',
      tech(CONVEYOR_TECH).effect.kind === 'unlock' &&
        tech(WIDE).effect.kind === 'tune' &&
        tech(HEAVY).requires.includes(WIDE),
      TECHNOLOGIES.map((t) => `${t.name} ${t.cost}`).join(', '),
    );
    check(
      'Эффект бывает ровно двух видов, третьего в таблице нет',
      TECHNOLOGIES.every((t) => t.effect.kind === 'unlock' || t.effect.kind === 'tune'),
    );
    check(
      'Цены положительны и целы: кредиты — целая валюта',
      TECHNOLOGIES.every((t) => Number.isInteger(t.cost) && t.cost > 0),
    );
    check(
      'Идентификаторы технологий различны',
      new Set(TECHNOLOGIES.map((t) => t.id)).size === TECHNOLOGIES.length,
    );
    check(
      'Каждая предпосылка ссылается на существующую технологию',
      TECHNOLOGIES.every((t) => t.requires.every((id) => TECH_BY_ID.has(id))),
    );

    // Ацикличность и достижимость проверяются ОДНИМ обходом: технология,
    // до которой обход не дошёл, либо сидит в цикле, либо зависит от того,
    // кто сидит в цикле, — и молчаливо недостижимая часть дерева хуже
    // её отсутствия.
    const reached = new Set<string>();
    for (let pass = 0; pass < TECHNOLOGIES.length; pass++) {
      for (const t of TECHNOLOGIES) {
        if (reached.has(t.id)) continue;
        if (t.requires.every((id) => reached.has(id))) reached.add(t.id);
      }
    }
    check(
      'Дерево ациклично, и каждая технология достижима конечной последовательностью покупок',
      reached.size === TECHNOLOGIES.length,
      `достижимо ${reached.size} из ${TECHNOLOGIES.length}`,
    );
  }

  // --- Профиль настроек ---

  {
    const fresh = new Research();
    check(
      'Без единой покупки профиль совпадает с конфигом значение в значение',
      fresh.tuning.isBase &&
        fresh.tuning.collectRadius === VACUUM.radius &&
        fresh.tuning.maxRiseSpeed === PLAYER.maxRiseSpeed,
      `радиус ${fresh.tuning.collectRadius} против ${VACUUM.radius}, ` +
        `предел ${fresh.tuning.maxRiseSpeed} против ${PLAYER.maxRiseSpeed}`,
    );
    check(
      'Базовые значения профиля взяты из конфига, а не выписаны заново',
      TUNING_BASE.collectRadius === VACUUM.radius &&
        TUNING_BASE.maxRiseSpeed === PLAYER.maxRiseSpeed,
    );
    check(
      'Начальное состояние: ничего не открыто',
      !fresh.has(CONTENT.CONVEYOR) && TECHNOLOGIES.every((t) => !fresh.isOpen(t.id)),
    );

    // Профили независимы: один экземпляр не глобальная переменная под другим
    // именем, и покупка в одной партии не трогает другую.
    const other = new Research();
    other.buy(WIDE, wallet(tech(WIDE).cost));
    check(
      'Профили независимы: покупка в одном состоянии не трогает другое',
      other.tuning.collectRadius !== fresh.tuning.collectRadius && fresh.tuning.isBase,
      `${other.tuning.collectRadius} против ${fresh.tuning.collectRadius}`,
    );
  }

  // --- Покупка ---

  {
    const r = new Research();
    const money = wallet(tech(CONVEYOR_TECH).cost - 1);
    const before = money.credits;
    check(
      'Покупка при нехватке кредитов отвергается целиком, счёт не меняется',
      !r.buy(CONVEYOR_TECH, money) && money.credits === before && !r.isOpen(CONVEYOR_TECH),
      `${money.credits} ₡`,
    );
    check(
      'Нехватка кредитов видна как отдельное состояние, а не как отказ по факту',
      r.status(tech(CONVEYOR_TECH), money.credits) === 'poor',
    );

    money.credits += 1;
    const paid = money.credits;
    check(
      'Покупка списывает кредиты ровно на цену и открывает технологию',
      r.buy(CONVEYOR_TECH, money) &&
        money.credits === paid - tech(CONVEYOR_TECH).cost &&
        r.isOpen(CONVEYOR_TECH),
      `${paid} → ${money.credits} ₡`,
    );

    money.credits += 10000;
    const rich = money.credits;
    check(
      'Повторная покупка ничего не списывает и ничего не меняет',
      !r.buy(CONVEYOR_TECH, money) && money.credits === rich,
      `${money.credits} ₡`,
    );
    check(
      'Купленная технология показана открытой',
      r.status(tech(CONVEYOR_TECH), money.credits) === 'open',
    );
  }

  // --- Предпосылки ---

  {
    const r = new Research();
    const money = wallet(100000);
    check(
      'Технология с неоткрытой предпосылкой не покупается при любом счёте',
      !r.buy(HEAVY, money) && money.credits === 100000 && !r.isOpen(HEAVY),
      `${money.credits} ₡`,
    );
    check(
      'Закрытая предпосылкой отличима от «не хватает кредитов» на вид',
      r.status(tech(HEAVY), money.credits) === 'blocked' &&
        r.missing(tech(HEAVY)).includes(tech(WIDE).name),
      r.missing(tech(HEAVY)).join(', '),
    );
    check(
      'После открытия предпосылки покупка проходит',
      r.buy(WIDE, money) && r.buy(HEAVY, money) && r.isOpen(HEAVY),
    );
  }

  // --- Счёт не уходит в минус ---

  {
    // Длинная последовательность сдач и покупок: счёт обязан остаться
    // неотрицательным, а покупки — не превратиться в долг.
    const w = ground();
    const zone = { x: 40, y: 40, w: 8, h: 4 };
    const r = new Research();
    const module = new LandingModule(zone);
    let negative = false;

    // Кругов с запасом на ВСЁ дерево: проверка про минус, но пройти она обязана
    // по пути, на котором покупки действительно случались.
    for (let round = 0; round < 120; round++) {
      const material = round % 3 === 0 ? MAT.IRIDIUM : round % 3 === 1 ? MAT.PULP : MAT.SLAG;
      for (let x = zone.x; x < zone.x + zone.w; x++) w.set(x, zone.y, material);
      module.update(w);

      for (const t of TECHNOLOGIES) r.buy(t.id, module);
      if (module.credits < 0) negative = true;
    }

    check(
      'Счёт не уходит в минус на длинной последовательности сдач и покупок',
      !negative && module.credits >= 0 && Number.isInteger(module.credits),
      `${module.credits} ₡`,
    );
    check(
      'Всё дерево куплено, и каждая покупка была однократной',
      TECHNOLOGIES.every((t) => r.isOpen(t.id)),
      TECHNOLOGIES.filter((t) => !r.isOpen(t.id))
        .map((t) => t.name)
        .join(', ') || 'открыто всё',
    );
    check(
      'Шлак не даёт кредитов и остаётся в мире',
      count(w, MAT.SLAG) > 0,
      `шлака в зоне ${count(w, MAT.SLAG)}`,
    );
  }

  // --- Эффект на параметр ---

  {
    const r = new Research();
    const w = ground();
    // Сплошная куча переносимого вокруг цели: сколько накрыла кисть, столько
    // и ушло в инвентарь, поэтому число собранного и есть площадь кисти.
    // Куча с запасом от предельного радиуса сбора (10): кисть обязана лечь
    // в неё целиком, иначе мерился бы край кучи, а не радиус.
    function heap(): World {
      const h = ground(96, 96);
      for (let y = 26; y < 54; y++) for (let x = 26; x < 54; x++) h.set(x, y, MAT.REGOLITH_LOOSE);
      return h;
    }
    const vac = new Vacuum(r.tuning);
    const inv = new Inventory();

    const beforeWorld = heap();
    const beforeCells = vac.updateSuck(FIXED_DT, beforeWorld, inv, true, 40, 40, 40, 40);

    const money = wallet(100000);
    r.buy(WIDE, money);
    const afterInv = new Inventory();
    const afterVac = new Vacuum(r.tuning);
    const afterWorld = heap();
    const afterCells = afterVac.updateSuck(FIXED_DT, afterWorld, afterInv, true, 40, 40, 40, 40);

    check(
      'Купленная технология параметра меняет поведение инструмента со следующего применения',
      afterCells > beforeCells && r.tuning.collectRadius === 8,
      `было ${beforeCells} ячеек за нажатие, стало ${afterCells}`,
    );

    r.buy(HEAVY, money);
    const topInv = new Inventory();
    const topVac = new Vacuum(r.tuning);
    const topWorld = heap();
    const topCells = topVac.updateSuck(FIXED_DT, topWorld, topInv, true, 40, 40, 40, 40);
    check(
      'Вторая ступень расширяет кисть дальше первой',
      topCells > afterCells && r.tuning.collectRadius === 10,
      `${beforeCells} → ${afterCells} → ${topCells} ячеек за нажатие`,
    );

    // Пылесос про исследования ничего не знает: тот же профиль, поданный
    // напрямую, даёт то же поведение.
    const plain = new Tuning();
    plain.set('collectRadius', 10);
    const plainWorld = heap();
    const plainCells = new Vacuum(plain).updateSuck(
      FIXED_DT,
      plainWorld,
      new Inventory(),
      true,
      40,
      40,
      40,
      40,
    );
    check(
      'Потребитель параметра читает профиль и не знает, откуда взялось значение',
      plainCells === topCells,
      `${plainCells} против ${topCells}`,
    );
    void w;
  }

  // --- Инварианты на предельных значениях ---

  {
    const topRise = maxTuned('maxRiseSpeed', TUNING_BASE.maxRiseSpeed);
    const topRadius = maxTuned('collectRadius', TUNING_BASE.collectRadius);

    check(
      'При всех открытых технологиях предел подъёма строго ниже импульса прыжка',
      topRise < PLAYER.jumpVelocity,
      `предел ${topRise}, импульс ${PLAYER.jumpVelocity}`,
    );
    check(
      'При всех открытых технологиях предел подъёма заметно ниже предела падения',
      topRise <= PLAYER.maxFallSpeed * 0.8,
      `подъём ${topRise}, падение ${PLAYER.maxFallSpeed}`,
    );
    check(
      'При всех открытых технологиях радиус кисти сбора много меньше полуширины кадра',
      topRadius * 8 <= BASE_VIEW_W / 2,
      `радиус ${topRadius}, полукадра ${BASE_VIEW_W / 2}`,
    );
    check(
      'Базовый радиус кисти сбора не превышает радиуса кисти копания',
      TUNING_BASE.collectRadius <= DIG.radius,
      `сбор ${TUNING_BASE.collectRadius}, копание ${DIG.radius}`,
    );
    check(
      'Технология поднимает радиус сбора выше кисти копания — в этом и награда',
      topRadius > DIG.radius,
      `сбор ${topRadius}, копание ${DIG.radius}`,
    );
    // Кольцо прицела обязано следовать за радиусом. Застывшее на базовом,
    // оно обещало бы выемку меньше настоящей ровно после того, как игрок
    // заплатил за большую.
    check(
      'Кольцо прицела растёт вместе с кистью сбора',
      vacuumOutline(TUNING_BASE.collectRadius).length === VACUUM_OUTLINE.length &&
        vacuumOutline(topRadius).length > VACUUM_OUTLINE.length,
      `базовое ${VACUUM_OUTLINE.length / 2} точек, предельное ${vacuumOutline(topRadius).length / 2}`,
    );

    // Апгрейд ранца обязан ускорять подъём — иначе покупка ничего не даёт.
    // Мир высокий намеренно: при потолке ближе базовый и апгрейженный ранец
    // упираются в него оба, разница схлопывается в ноль, и проверка проходила
    // бы или падала по не относящейся к делу причине.
    function riseIn(steps: number, tuning: Tuning): number {
      const w = new World(64, 800, first.world.profile);
      for (let x = 0; x < 64; x++) w.set(x, 780, MAT.ROCK);
      const p = new Player(30, 768, tuning);
      const held = { moveAxis: 0, jumpPressed: true, jumpHeld: true };
      const startY = p.y;
      for (let i = 0; i < steps; i++) p.update(FIXED_DT, held, w);
      return startY - p.y;
    }
    const upgraded = new Tuning();
    upgraded.set('maxRiseSpeed', topRise);
    const baseHeight = riseIn(120, new Tuning());
    const topHeight = riseIn(120, upgraded);
    check(
      'Апгрейд ранца поднимает выше за то же время',
      topHeight > baseHeight,
      `базово ${baseHeight} ячеек за 2 с, с технологией ${topHeight}`,
    );

    // Инвариант «ранец не срезает импульс прыжка» обязан держаться и НА ПРЕДЕЛЕ:
    // игра, корректная только до первой покупки, корректной не является.
    {
      const w = new World(64, 400, first.world.profile);
      for (let x = 0; x < 64; x++) w.set(x, 380, MAT.ROCK);
      const p = new Player(30, 370, upgraded);
      const idle = { moveAxis: 0, jumpPressed: false, jumpHeld: false };
      for (let i = 0; i < 10; i++) p.update(FIXED_DT, idle, w);
      const jump = { moveAxis: 0, jumpPressed: true, jumpHeld: true };
      p.update(FIXED_DT, jump, w);
      const afterJump = p.vy;
      const held = { moveAxis: 0, jumpPressed: false, jumpHeld: true };
      let thrustedWhileFast = false;
      for (let i = 0; i < 60; i++) {
        p.update(FIXED_DT, held, w);
        if (p.thrusting && p.vy < -topRise - 1) thrustedWhileFast = true;
      }
      check(
        'Апгрейд не отменяет прыжка: тяга не включается, пока подъём быстрее предела',
        afterJump <= -PLAYER.jumpVelocity + 1 && !thrustedWhileFast,
        `импульс ${afterJump.toFixed(1)}, предел ${topRise}`,
      );
    }
  }

  // --- Каталог: закрытое не показывается и не ставится ---

  {
    const r = new Research();
    const closed = new BuildCatalogState(r);

    check(
      'Каталог не пуст в начале партии: сепаратор открыт',
      closed.open.length >= 1 && closed.open.includes(SEPARATOR_KIND),
      closed.open.map((k) => k.name).join(', '),
    );
    check(
      'До покупки конвейер отсутствует в переборе каталога',
      !closed.open.includes(CONVEYOR_LEFT_KIND) && !closed.open.includes(CONVEYOR_RIGHT_KIND),
      closed.open.map((k) => k.name).join(', '),
    );

    // Полный круг перебора закрытого каталога не выносит наружу ни одного
    // закрытого вида — сколько ни жми.
    let sawClosed = false;
    for (let i = 0; i < BUILD_CATALOG.length * 3; i++) {
      closed.cycle();
      if (closed.kind === CONVEYOR_LEFT_KIND || closed.kind === CONVEYOR_RIGHT_KIND) {
        sawClosed = true;
      }
    }
    check('Закрытый вид не встречается в переборе ни на каком числе нажатий', !sawClosed);

    // И не ставится никаким способом — даже в обход каталога, прямым вызовом
    // с полным кошельком и годным местом.
    {
      const w = ground(64, 64);
      const money = wallet(10000);
      const registry = new BuildingRegistry();
      const placed = Builder.apply(w, registry, CONVEYOR_RIGHT_KIND, 30, 30, 30, 30, r);
      check(
        'Закрытый вид не ставится никаким способом',
        placed === 'rejected' &&
          count(w, MAT.CONVEYOR_RIGHT) === 0 &&
          money.credits === 10000 &&
          Builder.issueAt(w, CONVEYOR_RIGHT_KIND, 30, 30, r) === 'locked',
        `${placed}, на счету ${money.credits}`,
      );
    }

    // Покупка добавляет ОБА направления сразу и видна немедленно — тем же
    // экземпляром каталога, без перезапуска.
    r.buy(CONVEYOR_TECH, wallet(tech(CONVEYOR_TECH).cost));
    check(
      'Покупка технологии конвейера добавляет оба направления в перебор сразу',
      closed.open.includes(CONVEYOR_LEFT_KIND) &&
        closed.open.includes(CONVEYOR_RIGHT_KIND) &&
        r.has(CONTENT.CONVEYOR),
      closed.open.map((k) => k.name).join(', '),
    );
    check(
      'Оба направления открыты ОДНОЙ технологией: они ссылаются на одно содержимое',
      CONVEYOR_LEFT_KIND.unlock === CONVEYOR_RIGHT_KIND.unlock &&
        CONVEYOR_LEFT_KIND.unlock === CONTENT.CONVEYOR &&
        SEPARATOR_KIND.unlock === null,
    );
    {
      const w = ground(64, 64);
      const registry = new BuildingRegistry();
      const placed = Builder.apply(w, registry, CONVEYOR_RIGHT_KIND, 30, 30, 30, 30, r);
      check(
        'После покупки лента ставится',
        placed === 'placed' && count(w, MAT.CONVEYOR_RIGHT) > 0,
        `${placed}, ячеек ${count(w, MAT.CONVEYOR_RIGHT)}`,
      );
    }
  }

  // --- Мир не зависит от дерева ---

  {
    // Ни одна технология не правит правил автомата: одна и та же
    // последовательность шагов с открытыми технологиями и без них обязана
    // давать идентичные сетки.
    function run(): World {
      const w = new World(64, 64, first.world.profile);
      for (let x = 0; x < 64; x++) w.set(x, 62, MAT.ROCK);
      for (let y = 20; y < 30; y++) {
        for (let x = 25; x < 40; x++) w.set(x, y, y % 2 === 0 ? MAT.REGOLITH_LOOSE : MAT.WATER);
      }
      const sim = new Simulation();
      for (let i = 0; i < 400; i++) sim.update(w, null);
      return w;
    }

    const plainWorld = run();
    const opened = new Research();
    const purse = wallet(100000);
    for (const t of TECHNOLOGIES) opened.buy(t.id, purse);
    const openedWorld = run();

    let same = plainWorld.cells.length === openedWorld.cells.length;
    for (let i = 0; same && i < plainWorld.cells.length; i++) {
      if (plainWorld.cells[i] !== openedWorld.cells[i]) same = false;
    }
    check(
      'Одна последовательность шагов с открытыми технологиями и без даёт идентичные сетки',
      same && TECHNOLOGIES.every((t) => opened.isOpen(t.id)),
      `открыто ${TECHNOLOGIES.filter((t) => opened.isOpen(t.id)).length} из ${TECHNOLOGIES.length}`,
    );
  }

  // --- Раскладка дерева ---

  {
    // Колонка — САМАЯ ДЛИННАЯ цепочка предпосылок. Считается здесь заново
    // и независимо: совпадение с раскладкой означает, что правило одно,
    // а не что обе стороны ошиблись одинаково.
    const depth = new Map<string, number>();
    for (let pass = 0; pass < TECHNOLOGIES.length; pass++) {
      for (const tc of TECHNOLOGIES) {
        let d = 0;
        for (const req of tc.requires) d = Math.max(d, (depth.get(req) ?? 0) + 1);
        depth.set(tc.id, d);
      }
    }
    const wrong = TECH_NODES.filter((n) => n.col !== depth.get(n.id));
    check(
      'Колонка узла равна длине самой длинной цепочки предпосылок',
      wrong.length === 0,
      wrong.map((n) => `${n.id}: ${n.col} против ${depth.get(n.id)}`).join(', ') || 'все совпали',
    );

    check(
      'Технология без предпосылок стоит в нулевой колонке, зависящая — правее',
      TECH_NODES.every((n) => {
        const tc = TECH_BY_ID.get(n.id)!;
        return tc.requires.length === 0 ? n.col === 0 : n.col > 0;
      }),
    );

    const cells = new Set(TECH_NODES.map((n) => `${n.col}:${n.row}`));
    check(
      'Узлы не накладываются: у каждого своя клетка сетки',
      cells.size === TECH_NODES.length,
      `клеток ${cells.size} при ${TECH_NODES.length} узлах`,
    );

    // Раз колонка равна длине цепочки, КАЖДОЕ ребро идёт слева направо.
    // Направление читается из картинки, и стрелок она не требует.
    const backwards = TECH_EDGES.filter((e) => TECH_NODES[e.from]!.col >= TECH_NODES[e.to]!.col);
    check(
      'Каждое ребро соединяет узел с узлом правее него',
      backwards.length === 0 && TECH_EDGES.length > 0,
      `рёбер ${TECH_EDGES.length}, назад ${backwards.length}`,
    );
    check(
      'Рёбер ровно столько, сколько предпосылок в таблице',
      TECH_EDGES.length === TECHNOLOGIES.reduce((n, tc) => n + tc.requires.length, 0),
    );

    check(
      'Габариты сетки согласованы с узлами',
      TECH_COLS === Math.max(...TECH_NODES.map((n) => n.col)) + 1 &&
        TECH_ROWS === Math.max(...TECH_NODES.map((n) => n.row)) + 1,
      `${TECH_COLS}×${TECH_ROWS}`,
    );

    // Дерево обязано помещаться в панель ЦЕЛИКОМ: прокрутки нет, и часть,
    // о существовании которой не сказано, отвечает на вопрос «куда ведёт
    // развитие» неверно. Растущая таблица уронит эту проверку, а не обрежется
    // молча.
    {
      const layout = techTreeLayout(BASE_VIEW_W, BASE_VIEW_H, TECH_COLS, TECH_ROWS);
      const size = techTreeSize(TECH_COLS, TECH_ROWS);
      const maxCols = Math.floor((layout.fieldW - TECH_TREE.node) / TECH_TREE.colStep) + 1;
      const maxRows = Math.floor((layout.fieldH - TECH_TREE.node) / TECH_TREE.rowStep) + 1;
      check(
        'Дерево помещается в панель оверлея опорного кадра целиком',
        size.w <= layout.fieldW && size.h <= layout.fieldH,
        `${size.w}×${size.h} в поле ${layout.fieldW}×${layout.fieldH}, ` +
          `запас до ${maxCols} колонок и ${maxRows} строк`,
      );
    }
  }

  // --- Оверлей: навигация, покупка и модальность ---

  {
    const r = new Research();
    const money = wallet(100000);
    const ov = new ResearchOverlay();

    check('Оверлей закрыт в начале партии', !ov.open);
    ov.toggle();
    const openedNow = ov.open;
    ov.toggle();
    check('Одна клавиша открывает и закрывает оверлей', openedNow && !ov.open);

    // Весь цикл «открыть — дойти до узла — купить — закрыть» без единого
    // события мыши. Дерево двумерно, и одной вертикали ему мало.
    ov.toggle();
    const start = ov.selected;
    ov.handle(menu({ menuDownPressed: true }), r, money);
    const below = ov.selected;
    ov.handle(menu({ menuUpPressed: true }), r, money);
    const backUp = ov.selected;
    check(
      'Шаг вниз и вверх ходит внутри колонки и возвращается назад',
      below !== start && backUp === start,
      `${start.name} → ${below.name} → ${backUp.name}`,
    );

    ov.handle(menu({ menuRightPressed: true }), r, money);
    const right = ov.selectedIndex;
    ov.handle(menu({ menuLeftPressed: true }), r, money);
    check(
      'Шаг вправо уходит в следующую колонку, влево — возвращает',
      TECH_NODES[right]!.col === 1 && TECH_NODES[ov.selectedIndex]!.col === 0,
      `колонка ${TECH_NODES[right]!.col} → ${TECH_NODES[ov.selectedIndex]!.col}`,
    );

    // Каждый узел достижим одними клавишами: иначе «полностью с клавиатуры»
    // неправда для той части дерева, до которой не дойти.
    {
      const seen = new Set<number>();
      const walk = new ResearchOverlay();
      const queue = [walk.selectedIndex];
      seen.add(walk.selectedIndex);
      while (queue.length > 0) {
        const at = queue.pop()!;
        for (const [dx, dy] of [
          [0, -1],
          [0, 1],
          [-1, 0],
          [1, 0],
        ] as const) {
          const probe = new ResearchOverlay();
          for (let i = 0; i < at; i++) void i;
          // Перевод выбора в `at` — тем же способом, что и в игре: шагами.
          probe.move(0, 0);
          let cur = probe.selectedIndex;
          // Дойти до `at` по сетке: сперва по колонкам, затем по строкам.
          while (TECH_NODES[cur]!.col < TECH_NODES[at]!.col) {
            probe.move(1, 0);
            if (probe.selectedIndex === cur) break;
            cur = probe.selectedIndex;
          }
          while (TECH_NODES[cur]!.row < TECH_NODES[at]!.row) {
            probe.move(0, 1);
            if (probe.selectedIndex === cur) break;
            cur = probe.selectedIndex;
          }
          if (probe.selectedIndex !== at) continue;
          probe.move(dx, dy);
          const next = probe.selectedIndex;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      check(
        'Каждый узел дерева достижим одними клавишами',
        seen.size === TECHNOLOGIES.length,
        `достижимо ${seen.size} из ${TECHNOLOGIES.length}`,
      );
    }

    // Покупка подтверждением с клавиатуры.
    while (ov.selected.id !== CONVEYOR_TECH) ov.move(0, -1);
    const beforeBuy = money.credits;
    ov.handle(menu({ menuConfirmPressed: true }), r, money);
    check(
      'Подтверждение с клавиатуры покупает выбранный узел',
      r.isOpen(CONVEYOR_TECH) && money.credits === beforeBuy - tech(CONVEYOR_TECH).cost,
      `${beforeBuy} → ${money.credits} ₡`,
    );
    ov.handle(menu({ menuConfirmPressed: true }), r, money);
    check(
      'Повторное подтверждение по открытому узлу ничего не списывает',
      money.credits === beforeBuy - tech(CONVEYOR_TECH).cost,
    );

    // Мышь покупает узел ПОД КУРСОРОМ, а промах мимо узлов — ничего.
    {
      const r2 = new Research();
      const purse = wallet(100000);
      const ov2 = new ResearchOverlay();
      ov2.toggle();
      const target = TECHNOLOGIES.findIndex((tc) => tc.id === THRUSTERS);
      ov2.handle(menu({ pointerPressed: true }), r2, purse, target);
      check(
        'Нажатие по узлу покупает именно его, а не выбранный клавиатурой',
        r2.isOpen(THRUSTERS) &&
          ov2.selectedIndex === target &&
          purse.credits === 100000 - tech(THRUSTERS).cost,
        `${purse.credits} ₡, выбран ${ov2.selected.name}`,
      );

      const after = purse.credits;
      const chosen = ov2.selectedIndex;
      ov2.handle(menu({ pointerPressed: true }), r2, purse, null);
      check(
        'Нажатие мимо узлов не покупает ничего и не меняет выбор',
        purse.credits === after && ov2.selectedIndex === chosen,
        `${purse.credits} ₡`,
      );
    }

    // Выбор упирается в края дерева, а не заворачивается: перескок с края
    // на край читался бы как промах.
    for (let i = 0; i < TECHNOLOGIES.length * 2; i++)
      ov.handle(menu({ menuDownPressed: true }), r, money);
    const bottom = TECH_NODES[ov.selectedIndex]!;
    check(
      'Выбор не выходит за нижний край колонки',
      bottom.row === Math.max(...TECH_NODES.filter((n) => n.col === bottom.col).map((n) => n.row)),
      `строка ${bottom.row} в колонке ${bottom.col}`,
    );
    for (let i = 0; i < TECHNOLOGIES.length * 2; i++)
      ov.handle(menu({ menuUpPressed: true }), r, money);
    check('Выбор не уходит выше первой строки', TECH_NODES[ov.selectedIndex]!.row === 0);
    for (let i = 0; i < TECH_COLS * 2; i++) ov.handle(menu({ menuLeftPressed: true }), r, money);
    check('Выбор не уходит левее нулевой колонки', TECH_NODES[ov.selectedIndex]!.col === 0);

    ov.toggle();
    check('Оверлей закрывается той же клавишей', !ov.open);
  }

  // --- Три способа закрытия ---
  //
  // Открывают меню намеренно и один раз, а закрыть его хотят из любого
  // состояния и немедленно, в том числе не помня, чем открыли.

  {
    /**
     * Тот же стык, что и в игровом шаге: состояние меняется ДО раздачи ввода,
     * и на закрывающем шаге до `handle` дело не доходит. Проверять закрытие
     * в другом порядке значило бы проверять другое.
     */
    function closeStep(
      ov: ResearchOverlay,
      input: ReturnType<typeof menu>,
      target: PointerTarget = null,
    ): void {
      if (ov.open && ResearchOverlay.closeRequested(input, target)) ov.close();
    }

    const r = new Research();
    const money = wallet(100000);
    const ov = new ResearchOverlay();

    ov.toggle();
    closeStep(ov, menu({ menuClosePressed: true }));
    check('Escape закрывает открытый оверлей', !ov.open);

    closeStep(ov, menu({ menuClosePressed: true }));
    check('Escape не открывает закрытый оверлей', !ov.open);

    ov.toggle();
    closeStep(ov, menu({ pointerPressed: true }), 'close');
    check('Нажатие по крестику закрывает оверлей', !ov.open);

    ov.toggle();
    closeStep(ov, menu({ pointerPressed: true }), null);
    check('Нажатие мимо крестика оверлей не закрывает', ov.open);

    // Закрывающее нажатие не покупает НИЧЕГО. Счёт заведомо достаточен: иначе
    // проверка прошла бы и на пустом кошельке, ничего не проверив.
    const before = money.credits;
    const opened = TECHNOLOGIES.filter((tc) => r.isOpen(tc.id)).length;
    ov.handle(menu({ pointerPressed: true }), r, money, 'close');
    closeStep(ov, menu({ menuClosePressed: true }));
    check(
      'Закрытие не списывает кредитов и не открывает технологий',
      money.credits === before &&
        TECHNOLOGIES.filter((tc) => r.isOpen(tc.id)).length === opened &&
        !ov.open,
      `${before} → ${money.credits} ₡`,
    );
  }

  // Кнопка закрытия: одна геометрия на отрисовку и на попадание, и она лежит
  // в заголовке — там, куда сетка узлов не доходит ни при каком размере кадра.

  {
    for (const [w, h, name] of [
      [BASE_VIEW_W, BASE_VIEW_H, 'опорном'],
      [MAX_VIEW_W, MAX_VIEW_H, 'максимальном'],
    ] as const) {
      const layout = techTreeLayout(w, h, TECH_COLS, TECH_ROWS);
      const at = closeButtonRect(layout);

      const inside =
        at.x >= layout.x &&
        at.y >= layout.y &&
        at.x + at.w <= layout.x + layout.w &&
        at.y + at.h <= layout.y + layout.h;
      check(`Кнопка закрытия лежит внутри панели на ${name} кадре`, inside);

      const overlapsNode = TECH_NODES.some((n) => {
        const node = nodeOrigin(layout, n.col, n.row);
        return (
          at.x < node.x + layout.node &&
          at.x + at.w > node.x &&
          at.y < node.y + layout.node &&
          at.y + at.h > node.y
        );
      });
      check(`Кнопка закрытия не наезжает на узлы на ${name} кадре`, !overlapsNode);

      const hitsSelf = overClose(at.x + (at.w >> 1), at.y + (at.h >> 1), layout);
      const nodesFree = TECH_NODES.every((n) => {
        const node = nodeOrigin(layout, n.col, n.row);
        return !overClose(node.x + (layout.node >> 1), node.y + (layout.node >> 1), layout);
      });
      check(
        `Попадание в кнопку считается там же, где она нарисована, на ${name} кадре`,
        hitsSelf && nodesFree,
      );
    }
  }

  // --- Модальность: персонаж стоит, мир идёт ---

  {
    // Персонаж, получивший пустой ввод, не бежит и не применяет инструмент,
    // но физику проходит: на месте он остаётся только если под ним опора.
    const w = ground(96, 96);
    const p = new Player(30, 94 - PLAYER.hitboxH, new Tuning());
    for (let i = 0; i < 30; i++) p.update(FIXED_DT, NO_INPUT, w);
    const restX = p.x;
    for (let i = 0; i < 60; i++) p.update(FIXED_DT, NO_INPUT, w);
    check(
      'При открытом оверлее клавиши движения не двигают персонажа',
      p.x === restX && Math.abs(p.vx) < 0.001,
      `x=${p.x}, vx=${p.vx.toFixed(2)}`,
    );

    // Зажатая в момент открытия клавиша бега не оставляет персонажа бегущим:
    // сброс делается ТЕМ ЖЕ механизмом, что и потеря фокуса окном.
    const runner = new Player(30, 94 - PLAYER.hitboxH, new Tuning());
    const running = { moveAxis: 1, jumpPressed: false, jumpHeld: false };
    for (let i = 0; i < 30; i++) runner.update(FIXED_DT, running, w);
    const movingX = runner.x;
    for (let i = 0; i < 60; i++) runner.update(FIXED_DT, NO_INPUT, w);
    const stoppedX = runner.x;
    for (let i = 0; i < 60; i++) runner.update(FIXED_DT, NO_INPUT, w);
    check(
      'Зажатая в момент открытия клавиша бега не оставляет персонажа бегущим',
      runner.x === stoppedX && stoppedX > movingX && Math.abs(runner.vx) < 0.001,
      `бежал до x=${movingX}, встал на x=${stoppedX}`,
    );
  }

  {
    // Мир при открытом оверлее продолжает идти: машина выдаёт порции,
    // вещество оседает. Паузы в модели нет и заводить её ради меню незачем.
    const w = ground(96, 96);
    const r = new Research();
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    const registry = new BuildingRegistry();
    const bx = 40;
    const by = 94 - SEPARATOR.height;
    const cx = bx + (SEPARATOR.width >> 1);
    const cy = by + (SEPARATOR.height >> 1);
    const built = Builder.apply(w, registry, SEPARATOR_KIND, cx, cy, cx, cy, r);
    for (let i = 0; i < SEPARATOR.batch; i++) w.set(bx + 3 + i, by - 1, MAT.PULP);

    const ov = new ResearchOverlay();
    ov.toggle();
    const p = new Player(10, 94 - PLAYER.hitboxH, r.tuning);
    const sim = new Simulation();
    // Ровно те же вызовы, что делает шаг при открытом оверлее: ввода нет,
    // но симуляция и машины идут.
    for (let i = 0; i < 600; i++) {
      ov.handle(menu(), r, module);
      p.update(FIXED_DT, NO_INPUT, w);
      sim.update(w, { x: p.x, y: p.y, w: PLAYER.hitboxW, h: PLAYER.hitboxH });
      registry.update(w, FIXED_DT);
      module.update(w);
    }
    check(
      'При открытом оверлее симуляция продолжается: машина выдаёт порции, вещество оседает',
      built === 'placed' &&
        ov.open &&
        count(w, MAT.PULP) === 0 &&
        count(w, MAT.IRIDIUM) === SEPARATOR.iridium &&
        count(w, MAT.SLAG) === SEPARATOR.batch - SEPARATOR.iridium,
      `пульпы ${count(w, MAT.PULP)}, иридия ${count(w, MAT.IRIDIUM)}, шлака ${count(w, MAT.SLAG)}`,
    );
  }

  // --- Отрисовка дерева ---

  {
    /**
     * Кадр оверлея — ЖУРНАЛ поверхности слоя интерфейса: канваса в прогоне нет,
     * и «что нарисовано, где и чем» читается отсюда.
     */
    const ui = new RecordingSurface();

    /** Снапшот дерева из настоящей раскладки: своей копии геометрии здесь нет. */
    function view(over: Partial<OverlayView> = {}): OverlayView {
      const nodes: OverlayNode[] = TECHNOLOGIES.map((tc, i) => ({
        name: tc.name,
        description: tc.description,
        cost: tc.cost,
        usage: tc.usage,
        // Четыре состояния по кругу: каждое обязано попасть в кадр, иначе
        // проверка мерила бы одно.
        status: (['open', 'available', 'poor', 'blocked'] as const)[i % 4]!,
        kind: tc.effect.kind,
        icon: tc.icon,
        col: TECH_NODES[i]!.col,
        row: TECH_NODES[i]!.row,
        note: '',
      }));
      return {
        credits: 1234,
        nodes,
        edges: TECH_EDGES,
        selected: 0,
        hovered: null,
        closeHovered: false,
        // По умолчанию курсор УВЕДЁН в угол панели: кадры сравниваются между
        // собой, и стрелка посреди дерева попадала бы в каждое сравнение.
        pointerX: BASE_VIEW_W - 2,
        pointerY: BASE_VIEW_H - 2,
        ...over,
      };
    }

    function shoot(over: Partial<OverlayView> = {}): UiOp[] {
      ui.begin();
      drawResearchOverlay(ui, BASE_VIEW_W, BASE_VIEW_H, view(over));
      ui.end();
      return [...ui.ops];
    }

    const treeLayout = techTreeLayout(BASE_VIEW_W, BASE_VIEW_H, TECH_COLS, TECH_ROWS);

    /** Подложка узла: она стоит ровно в его углу, второй такой в кадре нет. */
    function nodePanel(ops: readonly UiOp[], i: number) {
      const at = nodeOrigin(treeLayout, TECH_NODES[i]!.col, TECH_NODES[i]!.row);
      return pick(ops, 'panel').find((op) => op.x === at.x && op.y === at.y);
    }

    /** Связи: у них четыре точки, у отбивки полосы сведений — две. */
    function edgeLines(ops: readonly UiOp[]) {
      return pick(ops, 'line').filter((op) => op.points.length === 4);
    }

    const base = shoot();

    // Четыре состояния покупки — четыре заливки, и каждая обязана быть
    // в кадре: иначе недоступное просто не показано.
    {
      const fills = [0, 1, 2, 3].map((i) => nodePanel(base, i)?.style.fill);
      check(
        'Все четыре состояния покупки видны в кадре разными заливками',
        fills.every(Boolean) && new Set(fills).size === 4,
        fills.join(' '),
      );
    }

    // Вид эффекта разведён ОБВОДКОЙ и выживает в любом состоянии покупки:
    // закрытая предпосылкой постройка и закрытый навык обязаны различаться.
    {
      function strokesByKind(ops: readonly UiOp[]): Map<string, Set<string>> {
        const out = new Map<string, Set<string>>();
        TECHNOLOGIES.forEach((tc, i) => {
          const stroke = nodePanel(ops, i)?.style.stroke ?? '';
          const set = out.get(tc.effect.kind) ?? new Set<string>();
          set.add(stroke);
          out.set(tc.effect.kind, set);
        });
        return out;
      }
      const now = strokesByKind(base);
      const allOpen = strokesByKind(
        shoot({ nodes: view().nodes.map((n) => ({ ...n, status: 'open' as const })) }),
      );
      const distinct = (m: Map<string, Set<string>>): boolean => {
        const kinds = [...m.values()].map((set) => [...set]);
        return kinds.every((v) => v.length === 1) && new Set(kinds.flat()).size === kinds.length;
      };
      check(
        'Постройка и навык различаются обводкой в любом состоянии покупки',
        now.size === 2 && distinct(now) && distinct(allOpen),
        [...now].map(([kind, set]) => `${kind}: ${[...set].join(',')}`).join('  '),
      );
    }

    // Причина отказа разведена ЦВЕТОМ ПОДПИСИ: «не хватает» золотом валюты,
    // «закрыто предпосылкой» — приглушённым серым.
    {
      // Подпись ищется по СВОЕМУ узлу, а не по строке: узлы одной строки стоят
      // на одном y, и поиск по нему нашёл бы соседа.
      function costColor(ops: readonly UiOp[], i: number): string | undefined {
        const at = nodeOrigin(treeLayout, TECH_NODES[i]!.col, TECH_NODES[i]!.row);
        const y = at.y + treeLayout.node + TECH_TREE.labelGap + UI.line;
        const centre = at.x + treeLayout.node / 2;
        return pick(ops, 'text').find(
          (op) => op.y === y && Math.abs(op.x + op.width / 2 - centre) < 0.001,
        )?.style.color;
      }
      const poor = costColor(base, 2);
      const blocked = costColor(base, 3);
      check(
        'Нехватка кредитов и закрытая предпосылка различаются цветом подписи',
        poor === css(RAMP.warm[4]) && blocked === css(RAMP.gray[5]),
        `нехватка ${poor}, закрыто ${blocked}`,
      );
    }

    // Цена видна у КАЖДОГО некупленного узла и без наведения: вопрос
    // «на что мне хватает» задаётся ко всему дереву сразу.
    {
      const missing = view()
        .nodes.filter((n) => n.status !== 'open')
        .filter((n) => !saysLike(base, `${n.cost} ₡`));
      const opened = view().nodes.filter((n) => n.status === 'open');
      check(
        'Цена нарисована у некупленных узлов без наведения, у купленного — «открыта»',
        missing.length === 0 && (opened.length === 0 || saysLike(base, 'открыта')),
        `без цены ${missing.length}`,
      );
    }

    // Связи: рёбра из открытой и неоткрытой предпосылки различаются на вид,
    // а поворот у них скруглён — лесенки на связи не бывает.
    {
      const edges = edgeLines(base);
      const parent = TECH_EDGES[0]!.from;
      const pending = edgeLines(
        shoot({
          nodes: view().nodes.map((n, i) => (i === parent ? { ...n, status: 'poor' as const } : n)),
        }),
      )[0];
      const done = edgeLines(
        shoot({
          nodes: view().nodes.map((n, i) => (i === parent ? { ...n, status: 'open' as const } : n)),
        }),
      )[0];
      check(
        'Связи между узлами нарисованы и идут со скруглённым поворотом',
        edges.length === TECH_EDGES.length && edges.every((op) => (op.style.radius ?? 0) > 0),
        `связей ${edges.length} из ${TECH_EDGES.length}`,
      );
      check(
        'Ребро из открытой предпосылки отличается от ребра из неоткрытой',
        pending !== undefined && done !== undefined && pending.style.color !== done.style.color,
        `${pending?.style.color} против ${done?.style.color}`,
      );
      // Ребро идёт СЛЕВА НАПРАВО: направление читается из картинки, и стрелок
      // ей не требуется.
      check(
        'Каждая связь идёт слева направо',
        edges.every((op) => op.points[3]!.x > op.points[0]!.x),
      );
    }

    // Выбор и наведение — РАЗНЫЕ пометки: они бывают на разных узлах сразу.
    {
      const both = shoot({ selected: 0, hovered: 2 });
      const selected = nodePanel(both, 0)?.style;
      const hovered = nodePanel(both, 2)?.style;
      const plain = nodePanel(both, 1)?.style;
      check(
        'Выбранный и наведённый узлы помечены, и помечены по-разному',
        selected?.glow !== undefined &&
          hovered?.glow !== undefined &&
          selected.glow !== hovered.glow &&
          plain?.glow === undefined,
        `выбор ${selected?.glow}, наведение ${hovered?.glow}`,
      );
      // Пометка не съедает признак вида эффекта: у ОДНОГО И ТОГО ЖЕ узла цвет
      // обводки одинаков и с пометкой, и без неё.
      check(
        'Пометка не подменяет обводку узла',
        selected?.stroke === nodePanel(base, 0)?.style.stroke &&
          hovered?.stroke === nodePanel(base, 2)?.style.stroke,
        `${selected?.stroke} против ${nodePanel(base, 0)?.style.stroke}`,
      );
    }

    // Полоса сведений: словами, для наведённого узла, а без наведения — для
    // выбранного. Оба источника пишут в ОДНО место: вопрос «что это и что
    // с этим делать» один, и два места для одного ответа читались бы как два
    // разных ответа.
    {
      const first = view().nodes[0]!;
      check(
        'Полоса сведений объясняет узел словами: пояснение и применение',
        saysLike(base, first.description) && saysLike(base, first.usage),
        `${said(base).length} надписей в кадре`,
      );

      const noted = shoot({ nodes: view().nodes.map((n) => ({ ...n, note: 'нужно ещё 7 ₡' })) });
      check(
        'Полоса сведений показывает причину словами, а не только цветом',
        saysLike(noted, 'нужно ещё 7 ₡') && !saysLike(base, 'нужно ещё'),
      );

      // Слова причины: недостающая СУММА, а не цена, и предпосылки поимённо.
      {
        const r2 = new Research();
        const poorAt = tech(CONVEYOR_TECH);
        const short = poorAt.cost - 100;
        check(
          'Полоса при нехватке называет недостающую сумму, а не цену',
          statusNote(poorAt, r2.status(poorAt, short), short, r2) === `нужно ещё 100 ₡`,
          statusNote(poorAt, r2.status(poorAt, short), short, r2),
        );
        const blockedAt = tech(HEAVY);
        const note = statusNote(blockedAt, r2.status(blockedAt, 100000), 100000, r2);
        check(
          'Полоса при закрытой предпосылке называет её по имени',
          note.includes(tech(WIDE).name),
          note,
        );
        const openAt = tech(CONVEYOR_TECH);
        r2.buy(CONVEYOR_TECH, wallet(openAt.cost));
        check(
          'Купленному и доступному объяснять нечего',
          statusNote(openAt, r2.status(openAt, 100000), 100000, r2) === '' &&
            statusNote(tech(WIDE), r2.status(tech(WIDE), 100000), 100000, r2) === '',
        );
      }

      const third = view().nodes[3]!;
      const hovered = shoot({ selected: 0, hovered: 3 });
      const selectedOnly = shoot({ selected: 3, hovered: null });
      check(
        'Сведения идут за наведением, а без него описывают выбранный узел',
        saysLike(hovered, third.description) && saysLike(selectedOnly, third.description),
      );

      // Полоса стоит в СВОЁМ месте и не наезжает на дерево: смена наведения
      // меняет только её строки и пометку самого узла.
      {
        const barTop = treeLayout.y + treeLayout.h - 6 - TECH_TREE.infoLines * UI.line - 3;
        const at = nodeOrigin(treeLayout, TECH_NODES[3]!.col, TECH_NODES[3]!.row);
        const near = (op: UiOp): boolean => {
          const y = op.kind === 'line' ? op.points[0]!.y : op.y;
          const x = op.kind === 'line' ? op.points[0]!.x : op.x;
          if (y >= barTop) return true;
          return (
            x >= at.x - 2 &&
            x < at.x + treeLayout.node + 2 &&
            y >= at.y - 2 &&
            y < at.y + treeLayout.node + 2
          );
        };
        const a = shoot({ selected: 0, hovered: null }).map((op) => JSON.stringify(op));
        const b = shoot({ selected: 0, hovered: 3 });
        const strayed = b.filter((op, i) => JSON.stringify(op) !== a[i] && !near(op));
        check(
          'Сведения не наезжают на дерево: наведение меняет только полосу и сам узел',
          strayed.length === 0,
          `операций вне полосы и вне узла ${strayed.length}`,
        );
      }

      // Строки полосы обязаны помещаться в её ширину: обрезанная строка
      // не читается ровно там, где нужнее всего. Обрезка — многоточием,
      // и на эталонной метрике её быть не должно.
      {
        const cut = pick(base, 'text').filter((op) => op.text.endsWith('…'));
        check(
          'Пояснение и применение помещаются в ширину полосы сведений',
          cut.length === 0,
          cut.map((op) => op.text).join(' | ') || `надписей ${said(base).length}`,
        );
      }
    }

    // Подпись узла помещается в шаг колонки, а не помещающаяся ОБРЕЗАЕТСЯ:
    // ширину задаёт системный шрифт, и уронить прогон за неё нельзя —
    // уронится он у разработчика, а наедет подпись на соседа у игрока.
    {
      const long = 'Сверхдлинное название технологии, которого не бывает';
      const ops = shoot({
        nodes: view().nodes.map((n, i) => (i === 0 ? { ...n, name: long } : n)),
      });
      const at = nodeOrigin(treeLayout, TECH_NODES[0]!.col, TECH_NODES[0]!.row);
      const label = pick(ops, 'text').find(
        (op) => op.y === at.y + treeLayout.node + TECH_TREE.labelGap,
      );
      const names = view().nodes.map((n) => n.name);
      check(
        'Название узла помещается в шаг колонки, а длинное обрезается многоточием',
        label !== undefined &&
          label.text.endsWith('…') &&
          label.width <= TECH_TREE.colStep &&
          names.every((name) => saysLike(base, name)),
        label ? `«${label.text}» шириной ${label.width.toFixed(1)}` : 'подписи нет',
      );
    }

    // Курсор меню рисуется САМ: подложка панели накрывает мировой прицел
    // целиком. Без этого меню не показывает, где мышь, вовсе.
    {
      const at = nodeOrigin(treeLayout, TECH_NODES[0]!.col, TECH_NODES[0]!.row);
      const ops = shoot({ pointerX: at.x + 40, pointerY: at.y + 40 });
      const pointer = pick(ops, 'icon').find((op) => op.key === 'pointer');
      check(
        'Курсор нарисован в меню и стоит там, где мышь',
        pointer !== undefined && pointer.x === at.x + 40 && pointer.y === at.y + 40,
        pointer ? `курсор в (${pointer.x}, ${pointer.y})` : 'курсора нет',
      );
      // Поверх ВСЕГО, включая полосу сведений: он указатель, и заслонять его
      // не имеет права ничто.
      check('Курсор нарисован последним, поверх всего остального', ops[ops.length - 1] === pointer);
    }

    // Попадание курсора считается по ТОЙ ЖЕ раскладке, что и отрисовка:
    // интерфейс, нажимающийся не там, где выглядит, получается из второй
    // записи геометрии.
    {
      const layout = techTreeLayout(BASE_VIEW_W, BASE_VIEW_H, TECH_COLS, TECH_ROWS);
      let hit = 0;
      for (let i = 0; i < TECH_NODES.length; i++) {
        const at = nodeOrigin(layout, TECH_NODES[i]!.col, TECH_NODES[i]!.row);
        const centre = nodeAtPoint(
          at.x + (layout.node >> 1),
          at.y + (layout.node >> 1),
          layout,
          TECH_NODES,
        );
        const corner = nodeAtPoint(at.x, at.y, layout, TECH_NODES);
        const past = nodeAtPoint(at.x + layout.node, at.y, layout, TECH_NODES);
        if (centre === i && corner === i && past !== i) hit++;
      }
      check(
        'Курсор попадает ровно в тот узел, который нарисован',
        hit === TECH_NODES.length,
        `попаданий ${hit} из ${TECH_NODES.length}`,
      );

      check(
        'Просвет между колонками — мимо узлов',
        nodeAtPoint(layout.originX + layout.node + 2, layout.originY + 2, layout, TECH_NODES) ===
          null,
      );
      check(
        'Точка за пределами сетки не попадает ни в один узел',
        nodeAtPoint(layout.x + 1, layout.y + 1, layout, TECH_NODES) === null,
      );
    }
  }

  // --- Замеры ---

  {
    // Путь до первой технологии: сколько порций от постановки сепаратора
    // до покупки конвейерной ленты.
    const perBatch = SEPARATOR.iridium * MAT_CREDIT_RATE[MAT.IRIDIUM]!;
    const batches = Math.ceil(tech(CONVEYOR_TECH).cost / perBatch);
    const pulpNeeded = batches * SEPARATOR.batch;
    const secondsIdeal = batches * SEPARATOR.delaySec;
    console.log(
      `ЗАМЕР  до первой технологии: ${batches} порций = ${pulpNeeded} ячеек пульпы, ` +
        `не быстрее ${secondsIdeal.toFixed(0)} с непрерывной работы`,
    );

    const total = TECHNOLOGIES.reduce((sum, t) => sum + t.cost, 0);
    const allBatches = Math.ceil(total / perBatch);
    console.log(
      `ЗАМЕР  всё дерево: ${total} ₡ = ${allBatches} порций = ` +
        `${(allBatches * SEPARATOR.batch).toLocaleString('ru')} ячеек пульпы, ` +
        `не быстрее ${(allBatches * SEPARATOR.delaySec).toFixed(0)} с`,
    );

    // Прирост от расширенной кисти: сколько ячеек за нажатие на каждой ступени.
    const cells: number[] = [];
    for (const radius of [
      TUNING_BASE.collectRadius,
      (tech(WIDE).effect as { value: number }).value,
      (tech(HEAVY).effect as { value: number }).value,
    ]) {
      const h = ground();
      for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) h.set(x, y, MAT.REGOLITH_LOOSE);
      const t = new Tuning();
      t.set('collectRadius', radius);
      cells.push(new Vacuum(t).updateSuck(FIXED_DT, h, new Inventory(), true, 40, 40, 40, 40));
    }
    console.log(
      `ЗАМЕР  кисть сбора: ${cells[0]} → ${cells[1]} → ${cells[2]} ячеек за нажатие ` +
        `(×${(cells[2]! / cells[0]!).toFixed(1)} к базовой)`,
    );

    // Высота подъёма ранца за две секунды до и после форсированных сопел.
    function riseIn(steps: number, limit: number): number {
      const w = new World(64, 400, first.world.profile);
      for (let x = 0; x < 64; x++) w.set(x, 380, MAT.ROCK);
      const t = new Tuning();
      t.set('maxRiseSpeed', limit);
      const p = new Player(30, 368, t);
      const held = { moveAxis: 0, jumpPressed: true, jumpHeld: true };
      const startY = p.y;
      for (let i = 0; i < steps; i++) p.update(FIXED_DT, held, w);
      return startY - p.y;
    }
    const boosted = (tech(THRUSTERS).effect as { value: number }).value;
    const before = riseIn(SIM_HZ * 2, TUNING_BASE.maxRiseSpeed);
    const after = riseIn(SIM_HZ * 2, boosted);
    console.log(
      `ЗАМЕР  подъём за 2 с: ${before} → ${after} ячеек ` +
        `(предел ${TUNING_BASE.maxRiseSpeed} → ${boosted})`,
    );
  }
}
