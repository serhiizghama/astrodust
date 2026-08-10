import { Camera, Renderer, MACHINE_STATE_COLORS } from '../src/render';
import type { HudState } from '../src/render';
import type { Display } from '../src/core';
import { MAT, MAT_SOLID, Simulation } from '../src/world';
import { Digger, Vacuum, Builder } from '../src/systems';
import { Player, Inventory } from '../src/entities';
import {
  SEPARATOR_KIND,
  Separator,
  OUTLET_ROW,
  OUTLET_FROM,
  OUTLET_TO,
  machineSummary,
} from '../src/entities';
import {
  PLAYER,
  FIXED_DT,
  WORLD_SEED,
  BASE_VIEW_W,
  BASE_VIEW_H,
  DIG,
  SEPARATOR,
  BUILD_AIM_DISTANCE,
} from '../src/config';
import {
  aimDirection,
  aimTarget,
  actionTarget,
  AimSourceTracker,
  ToolModeState,
  ToolMode,
} from '../src/core';
import { check, IDLE_HUD, luna } from './harness';
import { ground, count, settle } from './fixtures/world';
import { BX, BY, scene, build, feed } from './fixtures/separator';

const first = luna();
const { spawn } = first;

{
  // --- Постановка ---

  {
    const { world: w, module, registry } = scene(1000);
    const before = module.credits;
    const result = build(w, registry, module);

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
      'Постановка списала стоимость ровно один раз',
      module.credits === before - SEPARATOR.cost,
      `${before} → ${module.credits} при стоимости ${SEPARATOR.cost}`,
    );

    // Сквозь корпус проходят: постройка игрока — не препятствие игроку.
    check(
      'Корпус сепаратора не держит персонажа',
      !w.isSolid(BX, BY) && MAT_SOLID[MAT.SEPARATOR_HULL] === 0,
    );
  }

  // Все три отказа: ни мир, ни счёт не меняются.
  {
    const cases: Array<[string, () => { ok: boolean; detail: string }]> = [
      [
        'занятое место',
        () => {
          const { world: w, module, registry } = scene(1000);
          w.set(BX + 5, BY + 5, MAT.ROCK);
          const before = w.cells.slice();
          const credits = module.credits;
          const r = build(w, registry, module);
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
          const { world: w, module, registry } = scene(1000);
          const before = w.cells.slice();
          const credits = module.credits;
          // Высоко над полом: под областью нет ни одной твёрдой ячейки.
          const r = build(w, registry, module, BX, 20);
          let changed = 0;
          for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
          return {
            ok: r === 'rejected' && changed === 0 && module.credits === credits,
            detail: `${r}, изменено ${changed}`,
          };
        },
      ],
      [
        'не хватает кредитов',
        () => {
          const { world: w, module, registry } = scene(SEPARATOR.cost - 1);
          const before = w.cells.slice();
          const r = build(w, registry, module);
          let changed = 0;
          for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
          return {
            ok: r === 'rejected' && changed === 0 && module.credits === SEPARATOR.cost - 1,
            detail: `${r}, изменено ${changed}, счёт ${module.credits}`,
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
    const { world: w, module, registry } = scene(1000);
    const before = w.cells.slice();
    const cx = BX + (SEPARATOR.width >> 1);
    const cy = BY + (SEPARATOR.height >> 1);
    const r = Builder.apply(w, registry, module, SEPARATOR_KIND, cx + DIG.reach + 20, cy, cx, cy);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
    check('Постройка за пределом дальности не меняет мир', r === 'rejected' && changed === 0);
  }

  // --- Снос ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const afterBuild = module.credits;
    const separator = registry.all[0] as Separator;

    // Внутри что-то лежит: снос обязан вернуть это в мир.
    feed(w, 3);
    separator.update(w, FIXED_DT);
    const stored = separator.stored;

    const cx = BX + (SEPARATOR.width >> 1);
    const cy = BY + (SEPARATOR.height >> 1);
    const r = Builder.apply(w, registry, module, SEPARATOR_KIND, cx, cy, cx, cy);

    check(
      'Применение по стоящему зданию сносит его, а не ставит второе поверх',
      r === 'demolished' && registry.count === 0,
      `результат ${r}, зданий ${registry.count}`,
    );
    check(
      'Снос вернул стоимость полностью',
      module.credits === afterBuild + SEPARATOR.cost,
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

  // --- Корпус не трогается инструментами ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
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
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
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
      const { world: w, module, registry } = scene(1000);
      build(w, registry, module);
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
    const tool = new ToolModeState();
    const seen: string[] = [tool.name];
    for (let i = 0; i < 2; i++) {
      tool.cycle();
      seen.push(tool.name);
    }
    tool.cycle();
    check(
      'Режимов три, перебираются по кругу одной клавишей и возвращаются к первому',
      seen.length === 3 &&
        new Set(seen).size === 3 &&
        tool.name === seen[0] &&
        tool.mode === ToolMode.Dig,
      seen.join(' → ') + ' → ' + tool.name,
    );

    // В режиме строительства инструмент не копает и не собирает.
    tool.cycle();
    tool.cycle();
    check(
      'Третий режим — строительство',
      tool.building && !tool.digging && !tool.collecting,
      tool.name,
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

    check(
      'Сводка по машинам различает работу, простой и забитый выход',
      (() => {
        const { world: sw, module, registry } = scene(1000);
        if (registry.count !== 0) return false;
        if (machineSummary(registry) !== '') return false;
        build(sw, registry, module);
        const s = machineSummary(registry);
        return s.includes('Сепараторы 1') && s.includes('простой');
      })(),
    );
  }

  // Высыпанная пульпа принимается так же, как упавшая, а шлак из-под машины
  // убирается тем же пылесосом — это единственный способ разблокировать выход.
  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
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
    const { world: w, module, registry } = scene(100000);
    const tool = new ToolModeState();
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
    const placedByKeys = Builder.apply(
      w,
      registry,
      module,
      SEPARATOR_KIND,
      px,
      py,
      target.x,
      target.y,
    );
    const demolishedByKeys =
      registry.count > 0 &&
      Builder.apply(w, registry, module, SEPARATOR_KIND, px, py, target.x, target.y);

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
      ctx: {
        putImageData() {},
        fillText() {},
        measureText: (s: string) => ({ width: s.length * 4.8 }),
        font: '',
        textBaseline: '',
        fillStyle: '',
      },
      width: BASE_VIEW_W,
      height: BASE_VIEW_H,
      image: {},
      present() {},
    } as unknown as Display;

    const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED);
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
      hud: hud({ ghost: { ...rect, ok: true } }),
      fps: 0,
    });
    const okPixels = countPixels(MACHINE_STATE_COLORS.working);

    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: hud({ ghost: { ...rect, ok: false } }),
      fps: 0,
    });
    const badPixels = countPixels(MACHINE_STATE_COLORS.blocked);

    const perimeter = 2 * SEPARATOR.width + 2 * (SEPARATOR.height - 2);
    check(
      'Контур будущего здания рисуется периметром и меняет цвет по годности',
      okPixels === perimeter && badPixels === perimeter,
      `годный ${okPixels}, негодный ${badPixels} при периметре ${perimeter}`,
    );

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
