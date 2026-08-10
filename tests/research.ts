import { World, MAT, MAT_RESEARCH_RATE, Simulation } from '../src/world';
import { VACUUM_OUTLINE, vacuumOutline } from '../src/render';
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
  CONTENT,
  maxTuned,
} from '../src/progress';
import { PLAYER, FIXED_DT, VIEW_W, DIG, VACUUM, SEPARATOR, SIM_HZ } from '../src/config';
import { check, luna } from './harness';

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
      'Стоимости положительны и целы: очки — целая валюта',
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
      'Начальное состояние: очков ноль, ничего не открыто',
      fresh.points === 0 && !fresh.has(CONTENT.CONVEYOR),
    );

    // Профили независимы: один экземпляр не глобальная переменная под другим
    // именем, и покупка в одной партии не трогает другую.
    const other = new Research();
    other.earn(100);
    other.buy(WIDE);
    check(
      'Профили независимы: покупка в одном состоянии не трогает другое',
      other.tuning.collectRadius !== fresh.tuning.collectRadius && fresh.tuning.isBase,
      `${other.tuning.collectRadius} против ${fresh.tuning.collectRadius}`,
    );
  }

  // --- Покупка ---

  {
    const r = new Research();
    r.earn(tech(CONVEYOR_TECH).cost - 1);
    const before = r.points;
    check(
      'Покупка при нехватке очков отвергается целиком, счётчик не меняется',
      !r.buy(CONVEYOR_TECH) && r.points === before && !r.isOpen(CONVEYOR_TECH),
      `${r.points} ✦`,
    );
    check(
      'Нехватка очков видна как отдельное состояние, а не как отказ по факту',
      r.status(tech(CONVEYOR_TECH)) === 'poor',
    );

    r.earn(1);
    const paid = r.points;
    check(
      'Покупка списывает очки ровно на стоимость и открывает технологию',
      r.buy(CONVEYOR_TECH) &&
        r.points === paid - tech(CONVEYOR_TECH).cost &&
        r.isOpen(CONVEYOR_TECH),
      `${paid} → ${r.points} ✦`,
    );

    r.earn(100);
    const rich = r.points;
    check(
      'Повторная покупка ничего не списывает и ничего не меняет',
      !r.buy(CONVEYOR_TECH) && r.points === rich,
      `${r.points} ✦`,
    );
    check('Купленная технология показана открытой', r.status(tech(CONVEYOR_TECH)) === 'open');
  }

  // --- Предпосылки ---

  {
    const r = new Research();
    r.earn(10000);
    check(
      'Технология с неоткрытой предпосылкой не покупается при любом количестве очков',
      !r.buy(HEAVY) && r.points === 10000 && !r.isOpen(HEAVY),
      `${r.points} ✦`,
    );
    check(
      'Закрытая предпосылкой отличима от «не хватает очков» на вид',
      r.status(tech(HEAVY)) === 'blocked' && r.missing(tech(HEAVY)).includes(tech(WIDE).name),
      r.missing(tech(HEAVY)).join(', '),
    );
    check(
      'После открытия предпосылки покупка проходит',
      r.buy(WIDE) && r.buy(HEAVY) && r.isOpen(HEAVY),
    );
  }

  // --- Счётчики не уходят в минус ---

  {
    // Длинная последовательность сдач и покупок: обе валюты обязаны остаться
    // неотрицательными, а покупки — не превратиться в долг.
    const w = ground();
    const zone = { x: 40, y: 40, w: 8, h: 4 };
    const r = new Research();
    const module = new LandingModule(zone, r);
    let negative = false;
    let converted = false;

    for (let round = 0; round < 60; round++) {
      const material = round % 3 === 0 ? MAT.IRIDIUM : round % 3 === 1 ? MAT.PULP : MAT.SLAG;
      for (let x = zone.x; x < zone.x + zone.w; x++) w.set(x, zone.y, material);
      const creditsBefore = module.credits;
      const pointsBefore = r.points;
      const paid = module.update(w);

      // Ни одна валюта не превращается в другую: сдача материала с нулевой
      // ставкой второй валюты эту вторую не трогает вовсе.
      if (paid.credits > 0 && r.points !== pointsBefore) converted = true;
      if (paid.research > 0 && module.credits !== creditsBefore) converted = true;

      for (const t of TECHNOLOGIES) r.buy(t.id);
      if (module.credits < 0 || r.points < 0) negative = true;
    }

    check(
      'Ни один счётчик не уходит в минус на длинной последовательности сдач и покупок',
      !negative && module.credits >= 0 && r.points >= 0,
      `${module.credits} ₡, ${r.points} ✦`,
    );
    check('Валюты не конвертируются друг в друга', !converted);
    check(
      'Шлак не даёт ни одной валюты и остаётся в мире',
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
    function heap(): World {
      const h = ground();
      for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) h.set(x, y, MAT.REGOLITH_LOOSE);
      return h;
    }
    const vac = new Vacuum(r.tuning);
    const inv = new Inventory();

    const beforeWorld = heap();
    const beforeCells = vac.updateSuck(FIXED_DT, beforeWorld, inv, true, 40, 40, 40, 40);

    r.earn(1000);
    r.buy(WIDE);
    const afterInv = new Inventory();
    const afterVac = new Vacuum(r.tuning);
    const afterWorld = heap();
    const afterCells = afterVac.updateSuck(FIXED_DT, afterWorld, afterInv, true, 40, 40, 40, 40);

    check(
      'Купленная технология параметра меняет поведение инструмента со следующего применения',
      afterCells > beforeCells && r.tuning.collectRadius === 4,
      `было ${beforeCells} ячеек за нажатие, стало ${afterCells}`,
    );

    r.buy(HEAVY);
    const topInv = new Inventory();
    const topVac = new Vacuum(r.tuning);
    const topWorld = heap();
    const topCells = topVac.updateSuck(FIXED_DT, topWorld, topInv, true, 40, 40, 40, 40);
    check(
      'Вторая ступень расширяет кисть дальше первой',
      topCells > afterCells && r.tuning.collectRadius === 5,
      `${beforeCells} → ${afterCells} → ${topCells} ячеек за нажатие`,
    );

    // Пылесос про исследования ничего не знает: тот же профиль, поданный
    // напрямую, даёт то же поведение.
    const plain = new Tuning();
    plain.set('collectRadius', 5);
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
      topRadius * 8 <= VIEW_W / 2,
      `радиус ${topRadius}, полукадра ${VIEW_W / 2}`,
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
      const w = new World(64, 400, first.world.profile);
      for (let x = 0; x < 64; x++) w.set(x, 380, MAT.ROCK);
      const p = new Player(30, 368, tuning);
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
      const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 }, r);
      module.credits = 10000;
      const registry = new BuildingRegistry();
      const placed = Builder.apply(w, registry, module, CONVEYOR_RIGHT_KIND, 30, 30, 30, 30, r);
      check(
        'Закрытый вид не ставится никаким способом и не стоит ни кредита',
        placed === 'rejected' &&
          count(w, MAT.CONVEYOR_RIGHT) === 0 &&
          module.credits === 10000 &&
          Builder.issueAt(w, CONVEYOR_RIGHT_KIND, 30, 30, 10000, r) === 'locked',
        `${placed}, на счету ${module.credits}`,
      );
    }

    // Покупка добавляет ОБА направления сразу и видна немедленно — тем же
    // экземпляром каталога, без перезапуска.
    r.earn(tech(CONVEYOR_TECH).cost);
    r.buy(CONVEYOR_TECH);
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
      const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 }, r);
      module.credits = 10000;
      const registry = new BuildingRegistry();
      const placed = Builder.apply(w, registry, module, CONVEYOR_RIGHT_KIND, 30, 30, 30, 30, r);
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
    opened.earn(10000);
    for (const t of TECHNOLOGIES) opened.buy(t.id);
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

  // --- Оверлей: навигация, покупка и модальность ---

  {
    const r = new Research();
    r.earn(1000);
    const ov = new ResearchOverlay();

    check('Оверлей закрыт в начале партии', !ov.open);
    ov.toggle();
    const openedNow = ov.open;
    ov.toggle();
    check('Одна клавиша открывает и закрывает оверлей', openedNow && !ov.open);

    // Весь цикл «открыть — выбрать — купить — закрыть» без единого события мыши.
    ov.toggle();
    const first0 = ov.selected;
    ov.handle({ menuUpPressed: false, menuDownPressed: true, toolPressed: false }, r);
    const second = ov.selected;
    ov.handle({ menuUpPressed: true, menuDownPressed: false, toolPressed: false }, r);
    const backToFirst = ov.selected;
    check(
      'Навигация по списку идёт с клавиатуры и возвращается назад',
      second !== first0 && backToFirst === first0,
      `${first0.name} → ${second.name} → ${backToFirst.name}`,
    );

    const pointsBefore = r.points;
    ov.handle({ menuUpPressed: false, menuDownPressed: false, toolPressed: true }, r);
    check(
      'Применение инструмента покупает выбранную строку',
      r.isOpen(first0.id) && r.points === pointsBefore - first0.cost,
      `${pointsBefore} → ${r.points} ✦`,
    );
    ov.handle({ menuUpPressed: false, menuDownPressed: false, toolPressed: true }, r);
    check(
      'Повторное нажатие по открытой строке ничего не списывает',
      r.points === pointsBefore - first0.cost,
    );

    // Выбор упирается в края списка, а не заворачивается: перескок с конца
    // в начало читался бы как промах.
    for (let i = 0; i < TECHNOLOGIES.length * 2; i++) {
      ov.handle({ menuUpPressed: false, menuDownPressed: true, toolPressed: false }, r);
    }
    check(
      'Выбор не выходит за границы списка',
      ov.selectedIndex === TECHNOLOGIES.length - 1,
      `${ov.selectedIndex} из ${TECHNOLOGIES.length - 1}`,
    );
    for (let i = 0; i < TECHNOLOGIES.length * 2; i++) {
      ov.handle({ menuUpPressed: true, menuDownPressed: false, toolPressed: false }, r);
    }
    check('Выбор не уходит выше первой строки', ov.selectedIndex === 0);
    ov.toggle();
    check('Оверлей закрывается той же клавишей', !ov.open);
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
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 }, r);
    module.credits = 10000;
    const registry = new BuildingRegistry();
    const bx = 40;
    const by = 94 - SEPARATOR.height;
    const cx = bx + (SEPARATOR.width >> 1);
    const cy = by + (SEPARATOR.height >> 1);
    const built = Builder.apply(w, registry, module, SEPARATOR_KIND, cx, cy, cx, cy, r);
    for (let i = 0; i < SEPARATOR.batch; i++) w.set(bx + 3 + i, by - 1, MAT.PULP);

    const ov = new ResearchOverlay();
    ov.toggle();
    const p = new Player(10, 94 - PLAYER.hitboxH, r.tuning);
    const sim = new Simulation();
    // Ровно те же вызовы, что делает шаг при открытом оверлее: ввода нет,
    // но симуляция и машины идут.
    for (let i = 0; i < 600; i++) {
      ov.handle({ menuUpPressed: false, menuDownPressed: false, toolPressed: false }, r);
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
        count(w, MAT.IRIDIUM) === 1 &&
        count(w, MAT.SLAG) === SEPARATOR.batch - 1,
      `пульпы ${count(w, MAT.PULP)}, иридия ${count(w, MAT.IRIDIUM)}, шлака ${count(w, MAT.SLAG)}`,
    );
  }

  // --- Замеры ---

  {
    // Путь до первой технологии: сколько порций от постановки сепаратора
    // до покупки конвейерной ленты.
    const perBatch = MAT_RESEARCH_RATE[MAT.IRIDIUM]!;
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
      `ЗАМЕР  всё дерево: ${total} ✦ = ${allBatches} порций = ` +
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
