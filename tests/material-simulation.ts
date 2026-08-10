import { World, Simulation, reactAround, REACTIONS } from '../src/world';
import {
  MAT,
  MAT_SOLID,
  MAT_STATE,
  MAT_SLIP,
  MAT_SPREAD,
  MAT_DENSITY,
  MAT_YIELDS,
  MAT_YIELD_RATE,
  MatterState,
  MATERIALS,
} from '../src/world';
import type { Rect } from '../src/geometry';
import { Vacuum, DebugPainter } from '../src/systems';
import { Player, Inventory } from '../src/entities';
import { PLAYER, CHUNK_SIZE, DIG } from '../src/config';
import { check, luna } from './harness';
import { box, count, settle, pending, quiet } from './fixtures/world';

const first = luna();

// --- Таблица материалов ---
{
  check(
    'Спёкшийся реголит статичный (иначе обрушится весь ландшафт)',
    MAT_SOLID[MAT.REGOLITH_PACKED] === 1 && MAT_STATE[MAT.REGOLITH_PACKED] === MatterState.Solid,
  );
  check(
    'Рыхлый реголит сыпучий и при этом препятствие (по нему можно ходить)',
    MAT_STATE[MAT.REGOLITH_LOOSE] === MatterState.Powder && MAT_SOLID[MAT.REGOLITH_LOOSE] === 1,
  );
  check(
    'Свежевыкопанное отличимо по цвету от грунта',
    MATERIALS[MAT.REGOLITH_LOOSE].color !== MATERIALS[MAT.REGOLITH_PACKED].color,
  );
  check(
    'Поверхность мира выложена спёкшимся, рыхлого в свежем мире нет',
    !first.world.cells.includes(MAT.REGOLITH_LOOSE) &&
      first.world.cells.includes(MAT.REGOLITH_PACKED),
  );
  check(
    'Лёд статичный и держит персонажа',
    MAT_STATE[MAT.ICE] === MatterState.Solid && MAT_SOLID[MAT.ICE] === 1,
  );
  check(
    'Лёд легче воды: шкала плотностей остаётся физически осмысленной',
    MAT_DENSITY[MAT.ICE]! < MAT_DENSITY[MAT.WATER]!,
    `лёд ${MAT_DENSITY[MAT.ICE]}, вода ${MAT_DENSITY[MAT.WATER]}`,
  );

  // Выработка — свойство материала. Обе границы доли существенны: единица —
  // превращение ячейка в ячейку, при котором объём не меняется и двигаться
  // выработке некуда; ноль — потеря добычи, инструмент становится ластиком.
  {
    const solids = MATERIALS.filter((m) => m.state === MatterState.Solid);
    const bad = solids.filter((m) => !(m.yieldRate > 0 && m.yieldRate < 1));
    check(
      'У каждого твёрдого материала доля выработки строго между нулём и единицей',
      solids.length > 0 && bad.length === 0,
      `твёрдых ${solids.length}, вне диапазона ${bad.map((m) => m.name).join(', ') || 'нет'}`,
    );
    check(
      'Порода отдаёт рыхлый реголит, лёд — воду',
      MAT_YIELDS[MAT.ROCK] === MAT.REGOLITH_LOOSE &&
        MAT_YIELDS[MAT.ROCK_DEEP] === MAT.REGOLITH_LOOSE &&
        MAT_YIELDS[MAT.REGOLITH_PACKED] === MAT.REGOLITH_LOOSE &&
        MAT_YIELDS[MAT.ICE] === MAT.WATER,
    );
    check(
      'Доля выработки у льда выше, чем у породы',
      MAT_YIELD_RATE[MAT.ICE]! > MAT_YIELD_RATE[MAT.ROCK]!,
      `лёд ${MAT_YIELD_RATE[MAT.ICE]}, порода ${MAT_YIELD_RATE[MAT.ROCK]}`,
    );
  }

  // Различимость на глаз. Все шесть веществ попарно, а не только «свежее против
  // грунта»: лёд, вода и пар холодные все три, и различать их по одному лишь
  // оттенку синего игрок не обязан.
  {
    const visible = [
      MAT.REGOLITH_PACKED,
      MAT.REGOLITH_LOOSE,
      MAT.ICE,
      MAT.WATER,
      MAT.LAVA,
      MAT.STEAM,
    ];
    let clashes = '';
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = MATERIALS[visible[i]!]!;
        const b = MATERIALS[visible[j]!]!;
        if (a.color === b.color) clashes += `${a.name}=${b.name} `;
      }
    }
    check('Цвета шести веществ попарно различны', clashes === '', clashes);
  }

  // Копаемость определяется состоянием и признаком разрушаемости — и НИЧЕМ
  // больше. Прежде здесь стояла проверка совпадения с правилом «блокирует
  // персонажа и не рыхлый реголит»; совпадение держалось ровно до появления
  // второго сыпучего вещества, которое тоже держит персонажа. Пульпа его
  // и сломала — и это ожидаемо: правило по коллизии всегда было случайностью,
  // а не эквивалентностью, о чём и говорила прежняя формулировка.
  {
    const diggable = MATERIALS.filter((m) => m.state === MatterState.Solid && m.diggable).map(
      (m) => m.id,
    );
    check(
      'Копается статичное и разрушаемое: породы, спёкшийся реголит, лёд',
      diggable.length === 4 &&
        [MAT.ROCK, MAT.ROCK_DEEP, MAT.REGOLITH_PACKED, MAT.ICE].every((id) =>
          diggable.includes(id),
        ),
      `копаемых ${diggable.length}: ${diggable.map((id) => MATERIALS[id]!.name).join(', ')}`,
    );
    check(
      'Жидкости и газы не копаются по построению',
      ![MAT.WATER, MAT.LAVA, MAT.STEAM].some((id) => diggable.includes(id)),
    );
    check(
      'Сыпучее не копается: его уборка — это сбор в инвентарь',
      ![MAT.REGOLITH_LOOSE, MAT.PULP].some((id) => diggable.includes(id)),
    );
  }
}

// --- Клеточный автомат ---
{
  /** Пустой мир с полом по нижней строке. */
  function sandbox(w = 96, h = 96): World {
    const world = new World(w, h, first.world.profile);
    for (let x = 0; x < w; x++) world.set(x, h - 1, MAT.ROCK);
    return world;
  }
  /** Прогоняет N шагов и возвращает симуляцию (для чтения счётчиков). */
  function run(world: World, steps: number, occupant: Rect | null = null): Simulation {
    const sim = new Simulation();
    for (let i = 0; i < steps; i++) sim.update(world, occupant);
    return sim;
  }

  // Падение.
  {
    const w = sandbox();
    w.set(20, 10, MAT.REGOLITH_LOOSE);
    const sim = new Simulation();
    sim.update(w, null);
    check(
      'Падение: ячейка сместилась ровно на одну позицию вниз',
      w.get(20, 11) === MAT.REGOLITH_LOOSE && w.get(20, 10) === MAT.VACUUM,
    );
    run(w, 200);
    check('Падение: материал улёгся на пол', w.get(20, 94) === MAT.REGOLITH_LOOSE, 'y=94');
  }

  // Опора останавливает падение. Одиночный блок не годится: с него материал
  // скатится по свободной диагонали — это правило откоса, не отсутствие опоры.
  {
    const w = sandbox();
    for (let x = 28; x <= 32; x++) w.set(x, 50, MAT.ROCK);
    w.set(30, 49, MAT.REGOLITH_LOOSE);
    run(w, 10);
    check('Опора останавливает падение', w.get(30, 49) === MAT.REGOLITH_LOOSE);
  }

  // Дно мира держит.
  {
    const w = new World(48, 48, first.world.profile);
    w.set(10, 47, MAT.REGOLITH_LOOSE); // нижняя строка
    run(w, 20);
    check('Дно мира держит: материал не покинул сетку', w.get(10, 47) === MAT.REGOLITH_LOOSE);
  }

  // Столб не схлопывается за один шаг.
  {
    const w = sandbox();
    for (let i = 0; i < 10; i++) w.set(40, 20 + i, MAT.REGOLITH_LOOSE);
    const sim = new Simulation();
    sim.update(w, null);
    let count = 0;
    for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) count++;
    check(
      'Столб из 10 ячеек за один шаг сместился на одну и сохранил высоту',
      count === 10 && w.get(40, 21) === MAT.REGOLITH_LOOSE && w.get(40, 20) === MAT.VACUUM,
      `ячеек=${count}`,
    );
  }

  // Диагональное скатывание.
  {
    const w = sandbox();
    w.set(50, 60, MAT.ROCK);
    w.set(50, 59, MAT.REGOLITH_LOOSE);
    run(w, 40);
    check(
      'Скатывание: материал ушёл с вершины уступа вбок',
      w.get(50, 59) === MAT.VACUUM,
      `в (50,59): ${w.get(50, 59)}`,
    );
  }

  // Обе диагонали заняты — покой.
  {
    const w = sandbox();
    for (const x of [49, 50, 51]) w.set(x, 60, MAT.ROCK);
    w.set(49, 59, MAT.ROCK);
    w.set(51, 59, MAT.ROCK);
    w.set(50, 59, MAT.REGOLITH_LOOSE);
    run(w, 20);
    check(
      'Обе диагонали заняты — материал остаётся на месте',
      w.get(50, 59) === MAT.REGOLITH_LOOSE,
    );
  }

  // Симметрия кучи.
  {
    const w = sandbox();
    const src = 48;
    const sim = new Simulation();
    for (let i = 0; i < 600; i++) {
      if (i % 2 === 0 && w.get(src, 10) === MAT.VACUUM) w.set(src, 10, MAT.REGOLITH_LOOSE);
      sim.update(w, null);
    }
    let left = 0;
    let right = 0;
    for (let y = 0; y < 95; y++) {
      for (let x = 0; x < 96; x++) {
        if (w.get(x, y) !== MAT.REGOLITH_LOOSE) continue;
        if (x < src) left++;
        else if (x > src) right++;
      }
    }
    const total = left + right;
    const skew = total > 0 ? Math.abs(left - right) / total : 0;
    check(
      'Куча растёт приблизительно симметрично',
      total > 30 && skew < 0.35,
      `слева ${left}, справа ${right}, перекос ${(skew * 100).toFixed(0)}%`,
    );
  }

  // Детерминированность.
  {
    function scenario(): Uint8Array {
      const w = sandbox();
      const sim = new Simulation();
      for (let i = 0; i < 300; i++) {
        if (i % 3 === 0) w.set(40 + (i % 7), 8, MAT.REGOLITH_LOOSE);
        sim.update(w, null);
      }
      return w.cells.slice();
    }
    const a = scenario();
    const b = scenario();
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check('Детерминированность: два одинаковых прогона дают идентичные сетки', same);
  }

  // Засыпание чанков.
  {
    const w = sandbox();
    w.set(20, 10, MAT.REGOLITH_LOOSE);
    const sim = new Simulation();
    for (let i = 0; i < 400; i++) sim.update(w, null);
    check(
      'Улёгшийся мир не стоит ничего: ноль обойдённых ячеек за шаг',
      sim.lastCellsVisited === 0,
      `обойдено ${sim.lastCellsVisited}`,
    );

    // Изменение будит область заново.
    w.set(20, 10, MAT.REGOLITH_LOOSE);
    sim.update(w, null);
    check(
      'Изменение ячейки будит область',
      sim.lastCellsVisited > 0,
      `обойдено ${sim.lastCellsVisited}`,
    );
  }

  // Движение через границу чанка.
  {
    const w = sandbox(96, 128);
    const border = CHUNK_SIZE; // ровно на шве между чанками
    w.set(20, border - 2, MAT.REGOLITH_LOOSE);
    run(w, 300);
    check(
      'Падение продолжается через границу чанка, а не встаёт на шве',
      w.get(20, 126) === MAT.REGOLITH_LOOSE,
      `остановился на y=${(() => {
        for (let y = 0; y < 128; y++) if (w.get(20, y) === MAT.REGOLITH_LOOSE) return y;
        return -1;
      })()}`,
    );
  }

  // Стоимость зависит от активности, а не от размера мира.
  {
    const big = new World(1024, 512, first.world.profile);
    // Пол кладём через setRaw — как это делает генератор мира. Обычный set
    // разбудил бы всю нижнюю полосу чанков, и замер потерял бы смысл.
    for (let x = 0; x < 1024; x++) big.setRaw(x, 511, MAT.ROCK);
    big.set(500, 100, MAT.REGOLITH_LOOSE);
    const sim = new Simulation();
    sim.update(big, null);
    check(
      'Шаг обходит активную область, а не весь мир',
      sim.lastCellsVisited > 0 && sim.lastCellsVisited < 5000,
      `обойдено ${sim.lastCellsVisited} из ${1024 * 512}`,
    );
  }

  // Персонаж — препятствие. Ставим его в колодец: без стенок материал просто
  // обтечёт персонажа по диагоналям, и проверять будет нечего.
  {
    const w = sandbox();
    const occ: Rect = { x: 40, y: 50, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
    for (let y = 20; y < 95; y++) {
      w.set(39, y, MAT.ROCK);
      w.set(46, y, MAT.ROCK);
    }
    for (let i = 0; i < 6; i++) w.set(40 + i, 25, MAT.REGOLITH_LOOSE);
    // Экземпляр симуляции один на обе фазы: пробуждение при уходе персонажа
    // опирается на его предыдущее положение, и с новым экземпляром оно теряется.
    const sim = new Simulation();
    for (let i = 0; i < 200; i++) sim.update(w, occ);

    let insidePlayer = 0;
    for (let y = occ.y; y < occ.y + occ.h; y++) {
      for (let x = occ.x; x < occ.x + occ.w; x++) {
        if (w.get(x, y) === MAT.REGOLITH_LOOSE) insidePlayer++;
      }
    }
    check(
      'Сыпучее не проходит сквозь персонажа',
      insidePlayer === 0,
      `внутри хитбокса: ${insidePlayer}`,
    );

    const lowest = (): number => {
      let best = -1;
      for (let y = 0; y < 96; y++) {
        for (let x = 40; x < 46; x++) if (w.get(x, y) === MAT.REGOLITH_LOOSE) best = y;
      }
      return best;
    };
    const heldY = lowest();
    check(
      'Материал задержан персонажем выше его хитбокса',
      heldY >= 0 && heldY < occ.y,
      `нижняя ячейка y=${heldY}`,
    );

    for (let i = 0; i < 400; i++) sim.update(w, null);
    check(
      'Персонаж отошёл — материал возобновил падение',
      lowest() > heldY,
      `${heldY} → ${lowest()}`,
    );
  }

  // Жидкость персонажа обтекает, а не упирается в него.
  //
  // Запрет на вход в хитбокс верен для сыпучего и вреден для жидкости: шесть
  // ячеек ширины перекрывали поток целиком и работали плотиной. Замер тогда:
  // тот же поток без персонажа расходился 163/117 по сторонам, с персонажем —
  // 280 слева и НОЛЬ справа.
  {
    function pour(occupant: Rect | null): { left: number; right: number } {
      const w = sandbox(160, 96);
      for (let x = 1; x < 159; x++) for (let y = 88; y < 95; y++) w.set(x, y, MAT.ROCK);
      for (let y = 60; y < 88; y++) for (let x = 10; x < 50; x++) w.set(x, y, MAT.WATER);
      run(w, 2000, occupant);
      let left = 0;
      let right = 0;
      for (let y = 0; y < 96; y++) {
        for (let x = 0; x < 160; x++) {
          if (w.get(x, y) !== MAT.WATER) continue;
          if (x < 80) left++;
          else right++;
        }
      }
      return { left, right };
    }
    const free = pour(null);
    const blocked = pour({ x: 78, y: 78, w: PLAYER.hitboxW, h: PLAYER.hitboxH });
    check(
      'Жидкость течёт сквозь персонажа, а не копится перед ним',
      blocked.right > free.right * 0.5,
      `без персонажа ${free.left}/${free.right}, с персонажем ${blocked.left}/${blocked.right}`,
    );
  }
}

// --- Агрегатные состояния и вытеснение ---
{
  function box(w = 96, h = 96): World {
    const world = new World(w, h, first.world.profile);
    for (let x = 0; x < w; x++) world.set(x, h - 1, MAT.ROCK);
    return world;
  }
  function run(world: World, steps: number, sim = new Simulation()): Simulation {
    for (let i = 0; i < steps; i++) sim.update(world, null);
    return sim;
  }
  function count(world: World, material: number): number {
    let n = 0;
    for (const c of world.cells) if (c === material) n++;
    return n;
  }
  /** Ширина занятой веществом полосы. */
  function spreadWidth(world: World, material: number): number {
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (world.get(x, y) !== material) continue;
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
    return max < min ? 0 : max - min + 1;
  }

  // Статичное не двигается.
  {
    const w = box();
    w.set(40, 20, MAT.ROCK);
    w.set(41, 20, MAT.REGOLITH_PACKED);
    run(w, 100);
    check(
      'Статичное вещество неподвижно над пустотой',
      w.get(40, 20) === MAT.ROCK && w.get(41, 20) === MAT.REGOLITH_PACKED,
    );
  }

  // Газ поднимается.
  {
    const w = box();
    w.set(40, 60, MAT.STEAM);
    const sim = new Simulation();
    sim.update(w, null);
    check(
      'Газ поднимается на одну позицию за шаг',
      w.get(40, 59) === MAT.STEAM && w.get(40, 60) === MAT.VACUUM,
    );
  }

  // Столб газа не всплывает целиком за один шаг.
  {
    const w = box();
    for (let i = 0; i < 10; i++) w.set(40, 50 + i, MAT.STEAM);
    const sim = new Simulation();
    sim.update(w, null);
    check(
      'Столб газа за один шаг смещается на одну позицию и сохраняет высоту',
      count(w, MAT.STEAM) === 10 && w.get(40, 49) === MAT.STEAM && w.get(40, 59) === MAT.VACUUM,
      `ячеек=${count(w, MAT.STEAM)}`,
    );
  }

  // Вытеснение по плотности: пульпа (150) тонет в воде (100).
  //
  // Сыпучее здесь ПУЛЬПА, а не рыхлый реголит, и это вынужденно: реголит
  // с водой реагирует, пара в контакте не доживает до конца прогона, и мерить
  // вытеснение было бы нечем. Плотности у обоих одинаковые (150), так что
  // проверяется ровно то же правило. Заодно это и есть требуемое «пульпа тонет
  // в воде»: свежая пульпа не имеет права всплыть над водой, из которой
  // только что получилась.
  {
    const w = box();
    for (let y = 80; y < 94; y++) for (let x = 30; x < 50; x++) w.set(x, y, MAT.WATER);
    w.set(40, 70, MAT.PULP);
    run(w, 300);
    let pulpY = -1;
    for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.PULP) pulpY = y;
    check('Плотное тонет в менее плотном', pulpY >= 90, `пульпа осела на y=${pulpY}`);
    check(
      'Вода при этом не исчезла',
      count(w, MAT.WATER) === 14 * 20,
      `воды ${count(w, MAT.WATER)}`,
    );
    check(
      'Пульпа тонет в воде и не всплывает над ней',
      pulpY >= 90 && w.get(40, pulpY - 1) === MAT.WATER,
      `пульпа y=${pulpY}, над ней ${MATERIALS[w.get(40, pulpY - 1)]!.name}`,
    );
  }

  // Обратное не происходит: вода не проходит сквозь плотное сыпучее.
  //
  // Считается не прямоугольник под слоем, а «есть ли над водой сыпучее».
  // Прямоугольник ловил не то: куча с отвесными боками оседает в пологий холм
  // шире исходной, вода стекает по его СКЛОНАМ и попадает в окно замера,
  // ни разу не пройдя сквозь вещество.
  //
  // Сыпучее — пульпа: реголит под водой стал бы пульпой за первые же шаги,
  // и проверка молча измеряла бы пустое множество вместо правила плотности.
  {
    const w = box();
    for (let x = 20; x < 60; x++) for (let y = 80; y < 94; y++) w.set(x, y, MAT.PULP);
    for (let x = 20; x < 60; x++) w.set(x, 79, MAT.WATER);
    run(w, 200);
    let waterUnderPowder = 0;
    for (let y = 1; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        if (w.get(x, y) === MAT.WATER && w.get(x, y - 1) === MAT.PULP) waterUnderPowder++;
      }
    }
    check(
      'Менее плотное не тонет в более плотном',
      waterUnderPowder === 0,
      `воды под сыпучим: ${waterUnderPowder}`,
    );
  }

  // Статичное не раздвигается никакой плотностью.
  {
    const w = box();
    for (let x = 30; x < 50; x++) w.set(x, 60, MAT.ROCK);
    for (let x = 30; x < 50; x++) w.set(x, 59, MAT.LAVA); // плотность 250 < породы 400
    run(w, 200);
    let lavaBelow = 0;
    for (let y = 61; y < 96; y++) {
      for (let x = 30; x < 50; x++) if (w.get(x, y) === MAT.LAVA) lavaBelow++;
    }
    check('Статичное не раздвигается независимо от плотности', lavaBelow === 0);
  }

  // Сохранение вещества над смесью. Пара нереагирующая: сохранение при
  // ВЫТЕСНЕНИИ и сохранение при РЕАКЦИИ — разные утверждения, и мерить их
  // одним прогоном значит не проверить ни одно из них. Реакция проверяется
  // отдельно, своим счётом ячеек.
  {
    const w = box();
    for (let y = 70; y < 90; y++) for (let x = 30; x < 50; x++) w.set(x, y, MAT.WATER);
    for (let x = 30; x < 50; x++) for (let y = 60; y < 65; y++) w.set(x, y, MAT.PULP);
    const waterBefore = count(w, MAT.WATER);
    const pulpBefore = count(w, MAT.PULP);
    run(w, 500);
    check(
      'Вещество не исчезает при вытеснении',
      count(w, MAT.WATER) === waterBefore && count(w, MAT.PULP) === pulpBefore,
      `вода ${waterBefore}→${count(w, MAT.WATER)}, пульпа ${pulpBefore}→${count(w, MAT.PULP)}`,
    );
  }

  // Вода выравнивается в углублении.
  {
    const w = box();
    for (let y = 80; y < 96; y++) {
      w.set(30, y, MAT.ROCK);
      w.set(65, y, MAT.ROCK);
    }
    for (let x = 30; x <= 65; x++) w.set(x, 90, MAT.ROCK);
    // Наливаем ПО ХОДУ симуляции: заливка одних и тех же трёх ячеек до старта
    // дала бы всего три ячейки воды, а не объём.
    const sim = new Simulation();
    for (let i = 0; i < 600; i++) {
      if (i < 200) w.set(46 + (i % 3), 60, MAT.WATER);
      sim.update(w, null);
    }
    // Уровень: верхняя строка с водой у левого и правого края чаши.
    const topAt = (x: number): number => {
      for (let y = 0; y < 96; y++) if (w.get(x, y) === MAT.WATER) return y;
      return -1;
    };
    const left = topAt(33);
    const right = topAt(62);
    check(
      'Вода выравнивает уровень в углублении',
      left > 0 && right > 0 && Math.abs(left - right) <= 2,
      `слева y=${left}, справа y=${right}`,
    );
  }

  // Вязкость — это ТЕМП, а не конечная форма.
  //
  // Прежняя проверка требовала, чтобы лава «оставалась кучей». Требование было
  // ошибочным: жидкость, держащая устойчивый конус, — это сыпучее. Замер тогда
  // показал, что силуэт кучи лавы совпадал с силуэтом кучи рыхлого реголита
  // ячейка в ячейку — ширина 27, высота 10, склон 45°.
  {
    function pourWidth(material: number, steps: number): number {
      const w = box(200, 96);
      const sim = new Simulation();
      for (let i = 0; i < steps; i++) {
        if (i < 120 && w.get(100, 40) === MAT.VACUUM) w.set(100, 40, material);
        sim.update(w, null);
      }
      return spreadWidth(w, material);
    }
    const water = pourWidth(MAT.WATER, 300);
    const lava = pourWidth(MAT.LAVA, 300);
    check(
      'Вязкая жидкость расходится медленнее текучей',
      lava < water * 0.7,
      `за 300 шагов: вода ${water}, лава ${lava}`,
    );

    // …но в итоге всё-таки выравнивается, а не остаётся конусом.
    const w = box(200, 96);
    for (let y = 40; y < 60; y++) for (let x = 96; x < 104; x++) w.set(x, y, MAT.LAVA);
    run(w, 20000);
    let top = 96;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 200; x++) {
        if (w.get(x, y) !== MAT.LAVA) continue;
        if (y < top) top = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    const slope = (94 - top) / ((maxX - minX + 1) / 2);
    check(
      'Вязкая жидкость в итоге выравнивается, а не остаётся конусом',
      slope < 0.25,
      `склон ${slope.toFixed(2)} при 1.00 = 45°, ширина ${maxX - minX + 1}, высота ${94 - top}`,
    );
  }

  // Силуэт жидкости не совпадает с силуэтом сыпучего.
  {
    function silhouette(material: number): string {
      const w = box(200, 96);
      for (let y = 40; y < 60; y++) for (let x = 96; x < 104; x++) w.set(x, y, material);
      run(w, 2000);
      let s = '';
      for (let i = 0; i < w.cells.length; i++) s += w.cells[i] === material ? '#' : '.';
      return s;
    }
    check(
      'Куча жидкости не совпадает с кучей сыпучего',
      silhouette(MAT.LAVA) !== silhouette(MAT.REGOLITH_LOOSE),
    );
  }

  // Гидростатический напор: сообщающиеся сосуды.
  {
    const w = box(64, 96);
    for (let y = 0; y < 96; y++) {
      w.set(0, y, MAT.ROCK);
      w.set(63, y, MAT.ROCK);
    }
    // Перемычка от потолка до y=80, снизу канал.
    for (let y = 1; y <= 80; y++) w.set(32, y, MAT.ROCK);
    for (let y = 48; y < 95; y++) for (let x = 1; x < 32; x++) w.set(x, y, MAT.WATER);
    const before = count(w, MAT.WATER);
    run(w, 4000);
    const topAt = (x: number): number => {
      for (let y = 0; y < 96; y++) if (w.get(x, y) === MAT.WATER) return y;
      return -1;
    };
    const left = topAt(16);
    const right = topAt(48);
    check(
      'Сообщающиеся сосуды выравниваются',
      left > 0 && right > 0 && Math.abs(left - right) <= 3,
      `слева y=${left}, справа y=${right}, перепад ${Math.abs(left - right)}`,
    );
    check(
      'Подъём под напором не создаёт и не уничтожает вещество',
      count(w, MAT.WATER) === before,
      `${before} → ${count(w, MAT.WATER)}`,
    );
  }

  // Жидкость не поднимается выше своего уровня.
  {
    const w = box();
    for (let y = 20; y < 95; y++) w.set(60, y, MAT.ROCK);
    for (let y = 80; y < 95; y++) for (let x = 30; x < 60; x++) w.set(x, y, MAT.WATER);
    run(w, 3000);
    let highest = 96;
    for (let y = 0; y < 96; y++) {
      for (let x = 1; x < 60; x++) if (w.get(x, y) === MAT.WATER && y < highest) highest = y;
    }
    let past = 0;
    for (let y = 0; y < 96; y++) {
      for (let x = 61; x < 96; x++) if (w.get(x, y) === MAT.WATER) past++;
    }
    check(
      'Жидкость не карабкается по стене выше своего уровня',
      highest >= 80,
      `самая высокая ячейка y=${highest}, налито от y=80`,
    );
    check('Жидкость не проходит сквозь стену', past === 0, `за стеной ${past}`);
  }

  // Подъём не быстрее одной строки за шаг.
  {
    const w = box(64, 96);
    for (let y = 0; y < 96; y++) {
      w.set(0, y, MAT.ROCK);
      w.set(63, y, MAT.ROCK);
    }
    for (let y = 1; y <= 80; y++) w.set(32, y, MAT.ROCK);
    for (let y = 48; y < 95; y++) for (let x = 1; x < 32; x++) w.set(x, y, MAT.WATER);
    // Наблюдаем правое колено ВЫШЕ канала: попасть туда вода может только
    // подъёмом. По столбцам мерить нельзя — боковое растекание переносит воду
    // на пять ячеек за шаг, и верх столбца скачет без всякого подъёма.
    const armTop = (): number => {
      for (let y = 0; y <= 80; y++) {
        for (let x = 33; x < 63; x++) if (w.get(x, y) === MAT.WATER) return y;
      }
      return 81;
    };
    const sim = new Simulation();
    let worst = 0;
    let prev = armTop();
    for (let i = 0; i < 2000; i++) {
      sim.update(w, null);
      const now = armTop();
      if (now < prev) worst = Math.max(worst, prev - now);
      prev = now;
    }
    check('Подъём не быстрее одной строки за шаг', worst <= 1, `максимум ${worst} строк за шаг`);
  }

  // Улёгшаяся жидкость засыпает — так же, как улёгшееся сыпучее.
  {
    function idleAfter(build: (w: World) => void, steps: number): number {
      const w = box(128, 96);
      for (let y = 0; y < 96; y++) {
        w.set(0, y, MAT.ROCK);
        w.set(127, y, MAT.ROCK);
      }
      build(w);
      const sim = run(w, steps);
      let visited = 0;
      for (let i = 0; i < 5; i++) {
        sim.update(w, null);
        visited += sim.lastCellsVisited;
      }
      return visited;
    }
    const bowl = idleAfter((w) => {
      for (let y = 70; y < 95; y++) {
        w.set(30, y, MAT.ROCK);
        w.set(97, y, MAT.ROCK);
      }
      for (let y = 70; y < 90; y++) for (let x = 50; x < 70; x++) w.set(x, y, MAT.WATER);
    }, 6000);
    const flat = idleAfter((w) => {
      for (let y = 70; y < 90; y++) for (let x = 50; x < 70; x++) w.set(x, y, MAT.WATER);
    }, 6000);
    const lava = idleAfter((w) => {
      for (let y = 70; y < 90; y++) for (let x = 50; x < 70; x++) w.set(x, y, MAT.LAVA);
    }, 20000);
    check('Улёгшийся водоём в чаше ничего не стоит', bowl === 0, `обойдено ${bowl}`);
    check('Улёгшаяся лужа на ровном полу ничего не стоит', flat === 0, `обойдено ${flat}`);
    check('Улёгшийся расплав ничего не стоит', lava === 0, `обойдено ${lava}`);
  }

  // Поверхность улёгшегося водоёма не мерцает.
  {
    const w = box(128, 96);
    for (let y = 0; y < 96; y++) {
      w.set(0, y, MAT.ROCK);
      w.set(127, y, MAT.ROCK);
    }
    for (let y = 70; y < 95; y++) {
      w.set(30, y, MAT.ROCK);
      w.set(97, y, MAT.ROCK);
    }
    for (let y = 70; y < 90; y++) for (let x = 50; x < 70; x++) w.set(x, y, MAT.WATER);
    const sim = run(w, 6000);
    const before = w.cells.slice();
    for (let i = 0; i < 10; i++) sim.update(w, null);
    let moved = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) moved++;
    check('Поверхность улёгшегося водоёма не мерцает', moved === 0, `изменилось ячеек ${moved}`);
  }

  // Симметрия растекания. Обход строки в одну сторону давал воде перекос 93%:
  // ячейка, сместившаяся вбок по ходу обхода, обрабатывалась повторно и уезжала
  // дальше своей растекаемости. Лечится чередованием направления обхода.
  {
    const w = box(200, 96);
    const src = 100;
    const sim = new Simulation();
    for (let i = 0; i < 600; i++) {
      if (i < 200) w.set(src, 10, MAT.WATER);
      sim.update(w, null);
    }
    let left = 0;
    let right = 0;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 200; x++) {
        if (w.get(x, y) !== MAT.WATER) continue;
        if (x < src) left++;
        else if (x > src) right++;
      }
    }
    const skew = Math.abs(left - right) / (left + right);
    check(
      'Жидкость растекается без систематического сноса в сторону',
      left + right > 50 && skew < 0.25,
      `слева ${left}, справа ${right}, перекос ${(skew * 100).toFixed(0)}%`,
    );
  }

  // Осыпаемость влияет на форму кучи.
  {
    check(
      'Осыпаемость — свойство материала и участвует в правилах',
      MAT_SLIP[MAT.REGOLITH_LOOSE]! > 0 && MAT_SLIP[MAT.REGOLITH_LOOSE]! <= 1,
      `slip=${MAT_SLIP[MAT.REGOLITH_LOOSE]}`,
    );
    check(
      'Растекаемость отличает воду от лавы',
      MAT_SPREAD[MAT.WATER]! > MAT_SPREAD[MAT.LAVA]!,
      `вода ${MAT_SPREAD[MAT.WATER]}, лава ${MAT_SPREAD[MAT.LAVA]}`,
    );
  }

  // Рассеивание газа.
  {
    const w = box();
    for (let x = 30; x < 60; x++) for (let y = 10; y < 20; y++) w.set(x, y, MAT.STEAM);
    const before = count(w, MAT.STEAM);
    const sim = new Simulation();
    sim.update(w, null);
    const afterOne = count(w, MAT.STEAM);
    check('Рассеивание не мгновенное', afterOne > before * 0.9, `${before} → ${afterOne}`);
    for (let i = 0; i < 4000; i++) sim.update(w, null);
    check(
      'Газ рассеивается со временем',
      count(w, MAT.STEAM) < before * 0.2,
      `осталось ${count(w, MAT.STEAM)}`,
    );
  }

  // Детерминированность с жидкостями и газом.
  {
    function scenario(): Uint8Array {
      const w = box();
      // Перемычка с каналом снизу: без неё подъём под напором в прогон
      // не попадает, и повторяемость проверяется не для всех правил.
      for (let y = 40; y <= 80; y++) w.set(64, y, MAT.ROCK);
      const sim = new Simulation();
      for (let i = 0; i < 400; i++) {
        if (i % 4 === 0) w.set(40 + (i % 9), 20, MAT.WATER);
        if (i % 7 === 0) w.set(50 + (i % 5), 70, MAT.STEAM);
        if (i % 5 === 0) w.set(30 + (i % 6), 25, MAT.REGOLITH_LOOSE);
        if (i % 11 === 0) w.set(70 + (i % 7), 20, MAT.LAVA);
        sim.update(w, null);
      }
      return w.cells.slice();
    }
    const a = scenario();
    const b = scenario();
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check('Детерминированность при жидкостях и газах', same);
  }

  // Жидкость не держит персонажа, но держит вещество.
  {
    check('Вода персонажа не блокирует', MAT_SOLID[MAT.WATER] === 0);
    check('Пар персонажа не блокирует', MAT_SOLID[MAT.STEAM] === 0);
    check('Рыхлый реголит персонажа блокирует', MAT_SOLID[MAT.REGOLITH_LOOSE] === 1);

    const w = box();
    for (let y = 70; y < 94; y++) for (let x = 30; x < 50; x++) w.set(x, y, MAT.WATER);
    w.set(40, 60, MAT.REGOLITH_LOOSE);
    const sim = new Simulation();
    sim.update(w, null);
    // Одна ячейка за шаг: сквозь воду вещество не проваливается мгновенно.
    check(
      'Вещество тонет в воде по одной ячейке за шаг, а не проваливается насквозь',
      w.get(40, 61) === MAT.REGOLITH_LOOSE,
      `оказался на y=${(() => {
        for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) return y;
        return -1;
      })()}`,
    );

    const p = new Player(40, 72);
    check(
      'Персонаж не опирается на воду',
      !w.rectHitsSolid(p.x, p.y + PLAYER.hitboxH, PLAYER.hitboxW, 1),
    );
  }

  // Отладочная установка подчиняется дальности и ставит только в пустоту.
  {
    const w = box();
    const painter = new DebugPainter();
    check(
      'Отладка: выбранное вещество названо',
      painter.materialName.length > 0,
      painter.materialName,
    );

    const beforeName = painter.materialName;
    painter.cycle();
    check(
      'Отладка: переключение меняет вещество',
      painter.materialName !== beforeName,
      `${beforeName} → ${painter.materialName}`,
    );

    const snapshot = w.cells.slice();
    painter.update(1, w, true, true, 40, 40, 40 + DIG.reach + 20, 40);
    let changed = 0;
    for (let i = 0; i < snapshot.length; i++) if (snapshot[i] !== w.cells[i]) changed++;
    check('Отладка: цель вне дальности мир не меняет', changed === 0, `изменено ${changed}`);

    const placed = painter.update(1, w, true, true, 40, 40, 42, 40);
    check('Отладка: в пределах дальности вещество ставится', placed > 0, `поставлено ${placed}`);

    const w2 = box();
    const painter2 = new DebugPainter();
    const snap2 = w2.cells.slice();
    painter2.update(1, w2, false, true, 40, 40, 42, 40);
    let changed2 = 0;
    for (let i = 0; i < snap2.length; i++) if (snap2[i] !== w2.cells[i]) changed2++;
    check('Отладка: без диагностики мир не меняется', changed2 === 0);

    // Установка в себя. Инструмент заливал вакуум, не спрашивая про хитбокс,
    // и одним нажатием ставил 13 твёрдых ячеек ВНУТРЬ персонажа — состояние,
    // запрещённое спекой движения.
    const w3 = box();
    const painter3 = new DebugPainter();
    const occ = { x: 40, y: 40, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
    const cx = occ.x + occ.w / 2;
    const cy = occ.y + occ.h / 2;
    // Целимся в край хитбокса: кисть радиуса 2 тогда наполовину внутри
    // персонажа, наполовину снаружи — видно и запрет, и что остальное работает.
    const put = painter3.update(1, w3, true, true, cx, cy, occ.x + occ.w - 1, Math.round(cy), occ);
    let inside = 0;
    for (let y = occ.y; y < occ.y + occ.h; y++) {
      for (let x = occ.x; x < occ.x + occ.w; x++) if (w3.get(x, y) !== MAT.VACUUM) inside++;
    }
    check('Отладка: установка в себя не заполняет хитбокс', inside === 0, `внутри ${inside}`);
    check('Отладка: остальная кисть при этом работает', put > 0, `поставлено ${put}`);
  }
}

{
  // --- Реакции ---

  {
    check(
      'Реакция реголита с водой описана таблицей',
      REACTIONS.some(
        (r) =>
          ((r.a === MAT.REGOLITH_LOOSE && r.b === MAT.WATER) ||
            (r.a === MAT.WATER && r.b === MAT.REGOLITH_LOOSE)) &&
          r.toA === MAT.PULP &&
          r.toB === MAT.PULP,
      ),
    );

    // Соседство по стороне — все четыре направления, а не одно.
    for (const [dx, dy, name] of [
      [0, -1, 'сверху'],
      [0, 1, 'снизу'],
      [-1, 0, 'слева'],
      [1, 0, 'справа'],
    ] as const) {
      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(40 + dx, 40 + dy, MAT.WATER);
      const fired = reactAround(w, 40, 40);
      check(
        `Реголит и вода ${name} дают две ячейки пульпы`,
        fired && w.get(40, 40) === MAT.PULP && w.get(40 + dx, 40 + dy) === MAT.PULP,
        `${MATERIALS[w.get(40, 40)]!.name} / ${MATERIALS[w.get(40 + dx, 40 + dy)]!.name}`,
      );
    }

    // Диагональ контактом не считается: две ячейки, разделённые углом двух
    // стенок, физически не касаются.
    {
      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(41, 41, MAT.WATER);
      w.set(41, 40, MAT.ROCK);
      w.set(40, 41, MAT.ROCK);
      const fired = reactAround(w, 40, 40);
      check(
        'Диагональ контактом не считается',
        !fired && w.get(40, 40) === MAT.REGOLITH_LOOSE && w.get(41, 41) === MAT.WATER,
      );
    }

    // Проверка, не нашедшая пары, не будит ни одного чанка. Именно это отличает
    // «реакция пользуется чужими пробуждениями» от «реакция держит мир живым».
    {
      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(41, 40, MAT.REGOLITH_LOOSE);
      quiet(w);
      const before = pending(w);
      const fired = reactAround(w, 40, 40);
      check(
        'Несработавшая проверка не будит ни одного чанка',
        !fired && before === 0 && pending(w) === 0,
        `было ${before}, стало ${pending(w)}`,
      );
    }

    // Сработавшая — будит, и это не то же самое: она изменила мир, а продукт
    // обязан подчиняться своим правилам движения с первого же шага.
    {
      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(40, 41, MAT.WATER);
      quiet(w);
      reactAround(w, 40, 40);
      check(
        'Сработавшая реакция будит окрестность продукта',
        pending(w) > 0,
        `чанков ${pending(w)}`,
      );
    }

    // Высыпанное вещество реагирует — даже когда двигаться ему НЕКУДА.
    //
    // Карман шириной в ячейку с породой снизу и по диагоналям: реголит, попавший
    // сюда высыпанием, не сделает ни одного перемещения, а вода рядом не сможет
    // войти в него по плотности. Пара, привязанная к перемещению, осталась бы
    // несработавшей навсегда — чанк засыпает, и будить его некому. Это и есть
    // причина, по которой реакция спрашивается на обходе, а не только на сдвиге.
    {
      const w = box();
      // Сплошная порода на всю область кисти: свободна ровно одна ячейка,
      // поэтому высыпание попадает именно в карман, а не куда придётся.
      for (let y = 35; y <= 45; y++) for (let x = 34; x <= 47; x++) w.set(x, y, MAT.ROCK);
      w.set(40, 40, MAT.VACUUM);
      w.set(41, 40, MAT.WATER);

      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 1);
      const placed = Vacuum.dump(w, inv, 40, 40);
      const settledAt = settle(w, 2000);

      check(
        'Высыпанный в тупик реголит всё равно реагирует с водой рядом',
        placed === 1 && w.get(40, 40) === MAT.PULP && w.get(41, 40) === MAT.PULP && settledAt > 0,
        `размещено ${placed}, в кармане ${MATERIALS[w.get(40, 40)]!.name}, ` +
          `рядом ${MATERIALS[w.get(41, 40)]!.name}, покой на шаге ${settledAt}`,
      );
    }

    // Сохранение количества ячеек и повторяемость на смеси.
    {
      function mix(): World {
        const w = box();
        for (let y = 70; y < 90; y++) for (let x = 30; x < 60; x++) w.set(x, y, MAT.WATER);
        for (let y = 50; y < 60; y++) for (let x = 35; x < 55; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
        return w;
      }
      const w = mix();
      const before = count(w, MAT.WATER) + count(w, MAT.REGOLITH_LOOSE) + count(w, MAT.PULP);
      const steps = settle(w, 8000);
      const after = count(w, MAT.WATER) + count(w, MAT.REGOLITH_LOOSE) + count(w, MAT.PULP);
      check(
        'Реакция сохраняет количество ячеек на смеси',
        after === before,
        `${before} → ${after}, пульпы ${count(w, MAT.PULP)}, улеглось на шаге ${steps}`,
      );
      check(
        'Улёгшийся после реакций мир обходит ноль ячеек',
        steps > 0,
        steps < 0 ? 'не улёгся за 8000 шагов' : `улеглось на шаге ${steps}`,
      );

      const a = mix();
      settle(a, 8000);
      let diff = 0;
      for (let i = 0; i < a.cells.length; i++) if (a.cells[i] !== w.cells[i]) diff++;
      check('Одна и та же смесь дважды даёт идентичные сетки', diff === 0, `расхождений ${diff}`);
    }

    // Пульпа держит склон круче сухого реголита при одинаковом объёме.
    {
      function pile(material: number, cells: number): { width: number; height: number } {
        const w = box(200, 96);
        const sim = new Simulation();
        let poured = 0;
        for (let i = 0; i < 8000; i++) {
          if (poured < cells && w.get(100, 40) === MAT.VACUUM) {
            w.set(100, 40, material);
            poured++;
          }
          sim.update(w, null);
          if (poured >= cells && sim.lastCellsVisited === 0) break;
        }
        let top = 96;
        let minX = Infinity;
        let maxX = -Infinity;
        for (let y = 0; y < 95; y++) {
          for (let x = 0; x < 200; x++) {
            if (w.get(x, y) !== material) continue;
            if (y < top) top = y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
        return { width: maxX - minX + 1, height: 94 - top + 1 };
      }
      const dry = pile(MAT.REGOLITH_LOOSE, 300);
      const wet = pile(MAT.PULP, 300);
      check(
        'Пульпа держит склон круче сухого реголита при одинаковом объёме',
        wet.height > dry.height && wet.width < dry.width,
        `реголит ${dry.width}×${dry.height}, пульпа ${wet.width}×${wet.height}`,
      );
    }
  }
}
