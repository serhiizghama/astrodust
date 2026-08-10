import { generateLuna, World, MAT, MAT_STATE, MatterState, Simulation } from '../src/world';
import { Digger } from '../src/systems';
import { Player } from '../src/entities';
import { PLAYER, FIXED_DT, WORLD_SEED, DIG } from '../src/config';
import { check, FakeInput, asInput, luna } from './harness';

// --- Генерация мира ---
// `first` — общий мир прогона: наборы ходят по нему персонажем и продавливают
// рыхлое, поэтому экземпляр обязан быть один. `second` генерируется отдельно
// и только ради сверки на детерминированность.
const first = luna();
const second = generateLuna(WORLD_SEED);
let identical = first.world.cells.length === second.world.cells.length;
for (let i = 0; identical && i < first.world.cells.length; i++) {
  if (first.world.cells[i] !== second.world.cells[i]) identical = false;
}
check('Генерация детерминирована (одно зерно → одна сетка)', identical);

const { world, spawn } = first;

{
  const p = new Player(spawn.x, spawn.y);
  check(
    'Старт: хитбокс не в породе',
    !world.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH),
  );
  check(
    'Старт: под ногами опора',
    world.rectHitsSolid(p.x, p.y + PLAYER.hitboxH, PLAYER.hitboxW, 1),
    `spawn=(${p.x},${p.y})`,
  );
}

// --- Границы мира ---
check('За левым краем — твёрдо', world.isSolid(-1, 100));
check('Ниже дна мира — твёрдо', world.isSolid(100, world.height + 5));
check('Пустота не твёрдая', !world.isSolid(spawn.x, spawn.y));

// --- Связность уровня ---
{
  const p = new Player(spawn.x, spawn.y);
  const input = new FakeInput();
  input.right = true;
  let maxDepth = p.y;
  for (let i = 0; i < 1600; i++) {
    p.update(FIXED_DT, asInput(input), world);
    maxDepth = Math.max(maxDepth, p.y);
  }
  check('Спуск в лавовую трубку проходим', maxDepth > 280, `максимальная глубина y=${maxDepth}`);

  input.right = false;
  input.left = true;
  let minY = p.y;
  for (let i = 0; i < 2600; i++) {
    p.update(FIXED_DT, asInput(input), world);
    minY = Math.min(minY, p.y);
  }
  check('Возврат из пещеры на поверхность возможен', minY < 220, `поднялся до y=${minY}`);
}

// --- Лёд и вода ---
{
  /** Сплошная толща одного вещества без единой пустой ячейки. */
  function slabOf(material: number, width = 96, height = 96): World {
    const w = new World(width, height, first.world.profile);
    for (let i = 0; i < w.cells.length; i++) w.cells[i] = material;
    w.chunks.wakeAll();
    return w;
  }
  function countOf(w: World, material: number): number {
    let n = 0;
    for (const c of w.cells) if (c === material) n++;
    return n;
  }
  /** Прогоняет шаги, пока мир не уляжется. -1, если не улёгся за предел. */
  function settle(w: World, limit: number): number {
    const sim = new Simulation();
    for (let i = 0; i < limit; i++) {
      sim.update(w, null);
      if (sim.lastCellsVisited === 0) return i + 1;
    }
    return -1;
  }

  // Копание льда даёт воду — и не даёт реголита. Ветки по идентификатору
  // вещества в копании нет: и продукт, и доля читаются из таблицы материалов.
  {
    const w = slabOf(MAT.ICE);
    const excavated = Digger.applyBrush(w, 48, 48);
    const water = countOf(w, MAT.WATER);
    const loose = countOf(w, MAT.REGOLITH_LOOSE);
    const empty = countOf(w, MAT.VACUUM);
    check(
      'Копание льда отдаёт воду и ни одной ячейки реголита',
      water > 0 && loose === 0,
      `вода ${water}, реголит ${loose}, выемка ${excavated}`,
    );
    check(
      'Копание льда оставляет пустоту: выемка не залита водой целиком',
      empty > 0 && water + empty === excavated,
      `вода ${water}, пустота ${empty}, выемка ${excavated}`,
    );
  }

  // Смешанная кисть отдаёт оба вещества за одно применение, без разделения
  // на проходы: правило применяется к каждой ячейке по её собственному материалу.
  {
    const w = slabOf(MAT.ROCK);
    for (let y = 0; y < w.height; y++) {
      for (let x = 48; x < w.width; x++) w.cells[y * w.width + x] = MAT.ICE;
    }
    Digger.applyBrush(w, 48, 48);
    const water = countOf(w, MAT.WATER);
    const loose = countOf(w, MAT.REGOLITH_LOOSE);
    check(
      'Кисть по границе породы и льда отдаёт и реголит, и воду',
      water > 0 && loose > 0,
      `вода ${water}, реголит ${loose}`,
    );
  }

  // Льда нужно копать меньше: с одинаковой выемки воды получается больше,
  // чем реголита. Разные доли — то, чем добыча воды отличается на ощупь.
  {
    const ice = slabOf(MAT.ICE);
    const rock = slabOf(MAT.ROCK);
    const iceDug = Digger.applyBrush(ice, 48, 48);
    const rockDug = Digger.applyBrush(rock, 48, 48);
    const water = countOf(ice, MAT.WATER);
    const loose = countOf(rock, MAT.REGOLITH_LOOSE);
    check(
      'С одинаковой выемки льда воды больше, чем реголита с породы',
      iceDug === rockDug && water > loose,
      `выемка ${iceDug}/${rockDug}, вода ${water}, реголит ${loose}`,
    );
  }

  // Запасное правило ненулевой выработки отдаёт продукт ПЕРВОЙ разрушенной
  // ячейки. Без этого кисть по краю ледяной линзы вернула бы игроку реголит —
  // вещество, которого во льду нет.
  {
    let applications = 0;
    let empty = 0;
    let loose = 0;
    for (let y = 4; y < 92; y++) {
      const w = new World(16, 96, first.world.profile);
      for (let wy = 0; wy < 96; wy++) w.set(8, wy, MAT.ICE);
      if (Digger.applyBrush(w, 8, y) === 0) continue;
      applications++;
      if (countOf(w, MAT.WATER) === 0) empty++;
      loose += countOf(w, MAT.REGOLITH_LOOSE);
    }
    check(
      'На малой площади касания льда запасное правило отдаёт воду, а не реголит',
      applications > 50 && empty === 0 && loose === 0,
      `применений ${applications}, без воды ${empty}, реголита ${loose}`,
    );
  }

  // Повторяемость: распределение отдающих ячеек детерминировано и на льду.
  {
    function dug(): Uint8Array {
      const w = slabOf(MAT.ICE);
      Digger.applyBrush(w, 40, 40);
      Digger.applyBrush(w, 46, 43);
      return w.cells.slice();
    }
    const a = dug();
    const b = dug();
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    check(
      'Одна и та же выемка по льду дважды даёт идентичные сетки',
      diff === 0,
      `расхождений ${diff}`,
    );
  }

  // Вода подчиняется правилам жидкости с первого же шага: отдельного правила
  // для «свежей» воды нет и быть не должно.
  {
    const w = slabOf(MAT.ICE, 96, 96);
    for (let x = 30; x <= 66; x++) Digger.applyBrush(w, x, 40);
    const water = countOf(w, MAT.WATER);

    let sumBefore = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) if (w.get(x, y) === MAT.WATER) sumBefore += y;
    }

    const steps = settle(w, 4000);

    let sumAfter = 0;
    let floating = 0;
    let topMin = Infinity;
    let topMax = -Infinity;
    for (let x = 0; x < w.width; x++) {
      let top = -1;
      for (let y = 0; y < w.height; y++) {
        if (w.get(x, y) !== MAT.WATER) continue;
        if (top < 0) top = y;
        sumAfter += y;
        if (w.get(x, y + 1) === MAT.VACUUM) floating++;
      }
      if (top < 0) continue;
      topMin = Math.min(topMin, top);
      topMax = Math.max(topMax, top);
    }

    check(
      'Вода из выкопанной полости улегается за конечное число шагов',
      steps > 0,
      `шагов до покоя: ${steps < 0 ? 'не улеглась за 4000' : steps}`,
    );
    check(
      'Вода стекает на дно полости, а не висит на местах выкопанных ячеек',
      sumAfter > sumBefore && floating === 0,
      `центр масс ${(sumBefore / water).toFixed(2)} → ${(sumAfter / water).toFixed(2)}, висит ${floating}`,
    );
    check(
      'Уровень выровнялся: перепад свободной поверхности не больше ячейки',
      topMax - topMin <= 1,
      `верх воды ${topMin}…${topMax}`,
    );
    check(
      'Вода никуда не делась: количество жидких ячеек сохранилось',
      countOf(w, MAT.WATER) === water && w.liquidCells === water,
      `${water} → ${countOf(w, MAT.WATER)}, счётчик ${w.liquidCells}`,
    );

    // Кисть по объёму воды: копают твёрдое, жидкость остаётся нетронутой.
    // Цель ищется так, чтобы в круг кисти не попало НИ ОДНОЙ твёрдой ячейки —
    // иначе проверка мерила бы копание льда по краю лужи, а не отношение
    // инструмента к воде.
    {
      const r = DIG.radius;
      let cx = -1;
      let cy = -1;
      for (let y = r; y < w.height - r && cy < 0; y++) {
        for (let x = r; x < w.width - r; x++) {
          if (w.get(x, y) !== MAT.WATER) continue;
          let clean = true;
          for (let dy = -r; dy <= r && clean; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (dx * dx + dy * dy > r * r) continue;
              if (MAT_STATE[w.get(x + dx, y + dy)] === MatterState.Solid) clean = false;
            }
          }
          if (!clean) continue;
          cx = x;
          cy = y;
          break;
        }
      }
      const before = w.cells.slice();
      const excavated = Digger.applyBrush(w, cx, cy);
      let changed = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
      check(
        'Кисть по объёму воды не трогает ни одной ячейки: вода не копается',
        cy > 0 && excavated === 0 && changed === 0,
        `цель (${cx},${cy}), выемка ${excavated}, изменено ${changed}`,
      );
    }

    // Реголит, обрушенный в добытую воду, не тонет в ней, а РЕАГИРУЕТ: пара
    // «реголит рядом с водой» превращается в две ячейки пульпы. Проверяется
    // на воде, добытой копанием льда, а не налитой руками, — цепочка целиком:
    // лёд → вода → пульпа.
    {
      const waterBefore = countOf(w, MAT.WATER);
      const cellsBefore = waterBefore + countOf(w, MAT.REGOLITH_LOOSE) + countOf(w, MAT.PULP);
      let dropped = 0;
      for (let x = 40; x < 56 && dropped < 16; x++) {
        for (let y = 0; y < w.height; y++) {
          if (w.get(x, y) !== MAT.VACUUM) continue;
          if (w.get(x, y + 1) !== MAT.VACUUM && w.get(x, y + 1) !== MAT.WATER) break;
          w.set(x, y, MAT.REGOLITH_LOOSE);
          dropped++;
          break;
        }
      }
      const steps = settle(w, 4000);
      const pulp = countOf(w, MAT.PULP);
      const cellsAfter = countOf(w, MAT.WATER) + countOf(w, MAT.REGOLITH_LOOSE) + pulp;

      // Ни одной несработавшей пары: чанк не имеет права заснуть, оставив
      // реголит лежать на воде навсегда. Это самый вероятный дефект реакций,
      // и проявляется он не сразу, а «иногда не превращается».
      let touching = 0;
      for (let y = 0; y < w.height; y++) {
        for (let x = 0; x < w.width; x++) {
          if (w.get(x, y) !== MAT.REGOLITH_LOOSE) continue;
          if (
            w.get(x, y - 1) === MAT.WATER ||
            w.get(x, y + 1) === MAT.WATER ||
            w.get(x - 1, y) === MAT.WATER ||
            w.get(x + 1, y) === MAT.WATER
          ) {
            touching++;
          }
        }
      }

      check(
        'Реголит, упавший в добытую воду, становится пульпой',
        dropped > 0 && pulp > 0,
        `сброшено ${dropped}, пульпы ${pulp}, улеглось на шаге ${steps}`,
      );
      check(
        'После покоя не осталось ни одной пары «реголит рядом с водой»',
        steps > 0 && touching === 0,
        `таких пар ${touching}, улеглось на шаге ${steps}`,
      );
      check(
        'Реакция сохранила количество ячеек: 1 + 1 дало 2',
        cellsAfter === cellsBefore + dropped,
        `${cellsBefore} + ${dropped} = ${cellsBefore + dropped}, стало ${cellsAfter}`,
      );
    }
  }

  // --- Залежи в сгенерированном мире ---
  {
    const w = first.world;
    let ice = 0;
    for (const c of w.cells) if (c === MAT.ICE) ice++;

    // Связные компоненты льда: залежь — тело, а не рассыпанные поодиночке ячейки.
    const seen = new Uint8Array(w.cells.length);
    const stack: number[] = [];
    let largest = 0;
    let singles = 0;
    let deposits = 0;
    for (let i = 0; i < w.cells.length; i++) {
      if (w.cells[i] !== MAT.ICE || seen[i]) continue;
      let n = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length > 0) {
        const j = stack.pop()!;
        n++;
        const x = j % w.width;
        const y = (j / w.width) | 0;
        const neighbours = [
          x > 0 ? j - 1 : -1,
          x < w.width - 1 ? j + 1 : -1,
          y > 0 ? j - w.width : -1,
          y < w.height - 1 ? j + w.width : -1,
        ];
        for (const k of neighbours) {
          if (k < 0 || seen[k] === 1 || w.cells[k] !== MAT.ICE) continue;
          seen[k] = 1;
          stack.push(k);
        }
      }
      deposits++;
      largest = Math.max(largest, n);
      if (n === 1) singles++;
    }

    check(
      'В сгенерированном мире есть лёд, собранный в залежи',
      ice > 0 && largest >= 100 && singles === 0,
      `ячеек ${ice}, залежей ${deposits}, крупнейшая ${largest}, одиночных ${singles}`,
    );
    check(
      'В нетронутом мире нет ни одной жидкой ячейки',
      w.liquidCells === 0 && !w.cells.includes(MAT.WATER) && !w.cells.includes(MAT.LAVA),
      `счётчик жидкого ${w.liquidCells}`,
    );

    // Залежь выходит в объём лавовой трубки: докопаться до неё можно с уже
    // существующего маршрута, а не наугад через всю толщу.
    let atTube = 0;
    for (let y = 260; y < 360; y++) {
      for (let x = 470; x <= 930; x++) {
        if (w.get(x, y) !== MAT.ICE) continue;
        if (
          w.get(x - 1, y) === MAT.VACUUM ||
          w.get(x + 1, y) === MAT.VACUUM ||
          w.get(x, y - 1) === MAT.VACUUM ||
          w.get(x, y + 1) === MAT.VACUUM
        ) {
          atTube++;
        }
      }
    }
    check(
      'Хотя бы одна ячейка льда граничит с пустотой лавовой трубки',
      atTube > 0,
      `таких ячеек ${atTube}`,
    );

    // Лёд не висит в пустоте: залежь — включение в толще, а не парящая глыба.
    let floating = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        if (w.get(x, y) !== MAT.ICE) continue;
        const supported =
          MAT_STATE[w.get(x - 1, y)] === MatterState.Solid ||
          MAT_STATE[w.get(x + 1, y)] === MatterState.Solid ||
          MAT_STATE[w.get(x, y - 1)] === MatterState.Solid ||
          MAT_STATE[w.get(x, y + 1)] === MatterState.Solid;
        if (!supported) floating++;
      }
    }
    check('Лёд не висит в пустоте', floating === 0, `висящих ячеек ${floating}`);

    // Точка старта вне льда: спавн обязан остаться на нетронутой поверхности.
    let iceAtSpawn = 0;
    for (let x = spawn.x; x < spawn.x + PLAYER.hitboxW; x++) {
      for (let y = spawn.y; y <= spawn.y + PLAYER.hitboxH; y++) {
        if (w.get(x, y) === MAT.ICE) iceAtSpawn++;
      }
    }
    check('Точка старта не во льду', iceAtSpawn === 0, `ячеек льда в спавне ${iceAtSpawn}`);
  }
}

// --- Разнородность толщи ---
//
// Однородный массив выглядит заливкой независимо от того, как он затенён:
// тонирование добавляет зерно в пределах одного вещества, а крупный рисунок
// даёт только сама порода. Всё проверяемое здесь — свойство МИРА: слой
// и вкрапление видны в коллизии, имеют свою выработку и выкапываются.
{
  const cells = world.cells;
  const W = world.width;
  const H = world.height;

  /** Верхняя ячейка глубинной породы в колонке; -1 — её в колонке нет. */
  function deepTop(x: number): number {
    for (let y = 0; y < H; y++) if (cells[y * W + x] === MAT.ROCK_DEEP) return y;
    return -1;
  }

  {
    const tops: number[] = [];
    for (let x = 0; x < W; x += 8) {
      const t = deepTop(x);
      if (t >= 0) tops.push(t);
    }
    const min = Math.min(...tops);
    const max = Math.max(...tops);
    check(
      'Граница глубинной породы идёт волной, а не прямой',
      max - min > 8,
      `разброс высот ${max - min} при ${tops.length} колонках`,
    );
  }

  {
    // Вкрапление — глубинная порода, окружённая обычной. Ищем ячейки
    // ROCK_DEEP заведомо ВЫШЕ основной границы: там они могут быть только
    // валунами, а не сплошным нижним слоем.
    let inclusions = 0;
    const tops: number[] = [];
    for (let x = 0; x < W; x += 8) {
      const t = deepTop(x);
      if (t >= 0) tops.push(t);
    }
    const deepest = Math.max(...tops);
    for (let y = 200; y < deepest - 40; y++) {
      for (let x = 0; x < W; x++) {
        if (cells[y * W + x] !== MAT.ROCK_DEEP) continue;
        if (cells[y * W + x - 1] === MAT.ROCK || cells[y * W + x + 1] === MAT.ROCK) inclusions++;
      }
    }
    check(
      'В толще обычной породы есть вкрапления глубинной',
      inclusions > 0,
      `граничных ячеек вкраплений ${inclusions}`,
    );
  }

  {
    // Полоса вдоль границы содержит обе породы вперемешку. Ровный стык дал бы
    // в каждой строке ровно одну породу; размытие — обе в одной строке.
    let mixedRows = 0;
    for (let x = 0; x < W; x += 37) {
      const t = deepTop(x);
      if (t < 0) continue;
      let rock = 0;
      let deep = 0;
      for (let y = t; y < t + 10 && y < H; y++) {
        const m = cells[y * W + x];
        if (m === MAT.ROCK) rock++;
        else if (m === MAT.ROCK_DEEP) deep++;
      }
      if (rock > 0 && deep > 0) mixedRows++;
    }
    check(
      'Граница двух пород размыта в самом мире, а не проведена ровно',
      mixedRows > 0,
      `колонок со смешанной полосой ${mixedRows}`,
    );
  }

  {
    // Размытие не съедает слой пыли. Проверяется отсутствие ПОРОДЫ наверху,
    // а не наличие пыли: на поверхности законно встречаются корпус модуля
    // и пустота прорезанных проходов, и требовать пыль везде значило бы
    // падать на них, а не на том, что проверяется.
    let bare = 0;
    for (let x = 0; x < W; x++) {
      const m = cells[first.surface[x]! * W + x];
      if (m === MAT.ROCK || m === MAT.ROCK_DEEP) bare++;
    }
    check(
      'Размытие не пробило слой пыли: породы на поверхности нет',
      bare === 0,
      `колонок с породой наверху ${bare} из ${W}`,
    );
  }
}
