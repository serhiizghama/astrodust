import { World, MAT, MATERIALS, Simulation } from '../src/world';
import { Camera, Renderer, RecordingSurface } from '../src/render';
import type { HudState } from '../src/render';
import type { Display } from '../src/core';
import { Player } from '../src/entities';
import { Digger } from '../src/systems';
import { PLAYER, DIG, VACUUM, WORLD_SEED, BASE_VIEW_W, BASE_VIEW_H } from '../src/config';
import { check, luna, IDLE_HUD } from './harness';

const first = luna();

// --- Копание ---
{
  function rockWorld(): World {
    // Ширина с запасом от дальности копания: цель «вне досягаемости» обязана
    // лежать в мире, иначе проверка мерила бы край мира, а не дальность.
    const w = new World(256, 128, first.world.profile);
    for (let x = 0; x < 256; x++) for (let y = 40; y < 128; y++) w.set(x, y, MAT.ROCK);
    return w;
  }

  /**
   * Сплошная порода без единой пустой ячейки.
   *
   * Прежняя сцена осыпания копала у обрыва, где готовая пустота была рядом
   * и до всякой выемки: материалу было куда падать независимо от того,
   * освобождает копание объём или нет, — и дефект «превращение на месте»
   * такая проверка не ловила.
   */
  function solidRock(width: number, height: number): World {
    const w = new World(width, height, first.world.profile);
    for (let i = 0; i < w.cells.length; i++) w.cells[i] = MAT.ROCK;
    w.chunks.wakeAll();
    return w;
  }

  function countOf(w: World, material: number): number {
    let n = 0;
    for (const c of w.cells) if (c === material) n++;
    return n;
  }

  /** Средняя строка рыхлых ячеек — центр масс выработки по высоте. */
  function looseCenterY(w: World): number {
    let n = 0;
    let sum = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        if (w.get(x, y) !== MAT.REGOLITH_LOOSE) continue;
        n++;
        sum += y;
      }
    }
    return n === 0 ? -1 : sum / n;
  }

  // Выработка и выемка. Обе границы существенны: ноль выработки — потеря
  // добычи и мышь в роли ластика, равенство выработки и выемки — превращение
  // ячейка в ячейку, при котором объём не меняется и падать некуда.
  {
    const w = solidRock(128, 128);
    const excavated = Digger.applyBrush(w, 60, 60);
    const yielded = countOf(w, MAT.REGOLITH_LOOSE);
    check(
      'Копание отдаёт материал: выработка ненулевая',
      yielded > 0,
      `выработка ${yielded} при выемке ${excavated}`,
    );
    check(
      'Копание освобождает объём: выработка строго меньше выемки',
      yielded < excavated,
      `${yielded} < ${excavated}`,
    );
    check(
      'Выемка в толще породы образует пустоту',
      countOf(w, MAT.VACUUM) === excavated - yielded,
      `пустых ячеек ${countOf(w, MAT.VACUUM)}`,
    );
  }

  // Форма кисти круглая.
  {
    const w = rockWorld();
    Digger.applyBrush(w, 60, 60);
    const r = DIG.radius;
    const corner = w.get(60 + r, 60 + r); // угол квадрата вне круга
    const edge = w.get(60 + r, 60); // на окружности
    check('Кисть круглая: угол описанного квадрата не тронут', corner === MAT.ROCK);
    // Ячейка на окружности разрушена — реголитом она стала или пустотой,
    // решает хеш, и привязываться к его ответу проверка формы не должна.
    check('Кисть достаёт до края радиуса', edge !== MAT.ROCK, `на краю ${MATERIALS[edge]!.name}`);
  }

  // Гарантия ненулевой выработки на малой площади касания.
  {
    // Стена в одну ячейку: в кисть попадает семь ячеек вместо двадцати девяти,
    // и хеш даёт ноль на всех сразу с вероятностью 0.65⁷ ≈ 5%. Без запасного
    // правила на этой развёртке пустых применений одиннадцать из ста двадцати:
    // игрок бьёт по камню и остаётся ни с чем — это читается как поломка.
    let applications = 0;
    let empty = 0;
    let minYield = Infinity;
    for (let y = 4; y < 124; y++) {
      const w = new World(16, 128, first.world.profile);
      for (let wy = 0; wy < 128; wy++) w.set(8, wy, MAT.ROCK);
      if (Digger.applyBrush(w, 8, y) === 0) continue;
      applications++;
      const yielded = countOf(w, MAT.REGOLITH_LOOSE);
      if (yielded === 0) empty++;
      minYield = Math.min(minYield, yielded);
    }
    check(
      'Выработка ненулевая на любой площади касания',
      applications > 100 && empty === 0,
      `применений ${applications}, пустых ${empty}, минимум выработки ${minYield}`,
    );
  }

  // Выкопанное осыпается — внутри сплошной породы, а не у готового обрыва.
  {
    const w = solidRock(64, 96);
    Digger.applyBrush(w, 32, 40);
    const before = looseCenterY(w);
    const sim = new Simulation();
    let moves = 0;
    for (let i = 0; i < 300; i++) {
      sim.update(w, null);
      moves += sim.lastPowderMoves;
    }
    const after = looseCenterY(w);
    check(
      'Выкопанное в толще сплошной породы осыпается, а не висит на месте',
      moves > 0,
      `сдвигов ${moves}`,
    );
    check(
      'Выработка складывается на дне полости',
      after > before,
      `центр масс ${before.toFixed(2)} → ${after.toFixed(2)}`,
    );
  }

  // Проходимость прокопанного хода.
  {
    // Персонаж ведёт кисть вдоль строки и с каждым проходом поднимает прицел
    // на радиус кисти. Обе границы имеют смысл: за один проход ход в рост
    // не получается (7 ячеек выемки против роста 10) — иначе порода резалась
    // бы как масло; больше пяти — работа превращается в повинность.
    const w = solidRock(120, 96);
    const sim = new Simulation();
    let passes = 0;
    for (let p = 1; p <= 8; p++) {
      for (let x = 20; x < 100; x++) Digger.applyBrush(w, x, 60 - (p - 1) * DIG.radius);
      for (let i = 0; i < 400; i++) sim.update(w, null);
      let fits = false;
      for (let x = 30; x < 90 - PLAYER.hitboxW && !fits; x++) {
        for (let y = 20; y < 80 && !fits; y++) {
          if (!w.rectHitsSolid(x, y, PLAYER.hitboxW, PLAYER.hitboxH)) fits = true;
        }
      }
      if (fits) {
        passes = p;
        break;
      }
    }
    check(
      'Над осыпавшейся выработкой остаётся ход в рост персонажа',
      passes >= 2 && passes <= 5,
      `проходов до проходимого хода: ${passes || 'не появился за 8'}`,
    );
  }

  // Повторяемость: распределение отдающих ячеек детерминировано.
  {
    function dug(): Uint8Array {
      const w = solidRock(96, 96);
      Digger.applyBrush(w, 40, 40);
      Digger.applyBrush(w, 46, 43);
      return w.cells.slice();
    }
    const a = dug();
    const b = dug();
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    check('Одна и та же выемка дважды даёт идентичные сетки', diff === 0, `расхождений ${diff}`);
  }

  // Пустота не меняется.
  {
    const w = rockWorld();
    const before = w.cells.slice();
    Digger.applyBrush(w, 60, 10); // над породой, вокруг только вакуум
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
    check('Пустота не превращается в реголит', changed === 0, `изменено ячеек: ${changed}`);
  }

  // Рыхлый материал не копается: его уборка — работа вакуума с инвентарём.
  {
    const w = new World(64, 64, first.world.profile);
    for (let x = 0; x < 64; x++) for (let y = 30; y < 64; y++) w.set(x, y, MAT.REGOLITH_LOOSE);
    const before = w.cells.slice();
    const excavated = Digger.applyBrush(w, 32, 40);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
    check(
      'Рыхлый материал не копается и в пустоту не превращается',
      changed === 0 && excavated === 0,
      `изменено ${changed}, выемка ${excavated}`,
    );
  }

  // Дальность.
  {
    const w = rockWorld();
    const before = w.cells.slice();
    const digger = new Digger();
    const far = DIG.reach + 10; // внутри мира шириной 256
    digger.update(1, w, true, 60, 60, 60 + far, 60);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
    check(
      'Цель вне досягаемости не меняет мир ни одной ячейкой',
      changed === 0,
      `изменено: ${changed}`,
    );

    check('Достижимость: рядом — да', Digger.inReach(60, 60, 60 + DIG.reach - 2, 60));
    check('Достижимость: далеко — нет', !Digger.inReach(60, 60, 60 + DIG.reach + 2, 60));

    // Подлетел ближе — копание заработало.
    const digger2 = new Digger();
    digger2.update(1, w, true, 60 + far - 5, 60, 60 + far, 60);
    check('Цель стала достижимой после перемещения персонажа', w.get(60 + far, 60) !== MAT.ROCK);
  }

  // Темп не зависит от частоты кадров.
  {
    function dugOver(seconds: number, stepDt: number): number {
      const w = rockWorld();
      const digger = new Digger();
      const steps = Math.round(seconds / stepDt);
      let total = 0;
      // Курсор ведём по ВРЕМЕНИ, а не по номеру шага: иначе на 144 Гц он
      // проходил бы вдвое больший путь, и сравнивались бы разные маршруты,
      // а не темпы копания.
      for (let i = 0; i < steps; i++) {
        const cursorX = 20 + Math.round(i * stepDt * 60);
        total += digger.update(stepDt, w, true, 60, 60, cursorX, 60);
      }
      return total;
    }
    const at60 = dugOver(1, 1 / 60);
    const at144 = dugOver(1, 1 / 144);
    const ratio = at144 / at60;
    check(
      'Темп копания не зависит от частоты кадров',
      ratio > 0.9 && ratio < 1.1,
      `60 Гц: ${at60}, 144 Гц: ${at144}`,
    );
  }
}

// --- Вид прицела ---
//
// Прицел рисуется в буфер МИРА, поэтому проверяются пиксели, а не журнал
// интерфейса. След прицела снимается разностью двух кадров: `crosshairX/Y`
// не влияют ни на что, кроме него, поэтому всё, что изменилось в окне вокруг
// цели при уводе прицела в сторону, — и есть прицел целиком.
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
  camera.snapTo(first.spawn.x, first.spawn.y);
  const player = new Player(first.spawn.x, first.spawn.y);

  function shoot(x: number, y: number, inReach: boolean, hud: HudState): Uint8ClampedArray {
    renderer.render({
      camera,
      player,
      crosshairX: x,
      crosshairY: y,
      crosshairInReach: inReach,
      hud,
      fps: 0,
    });
    return pixels.slice();
  }

  // Окно вдвое шире самого длинного луча: кольцо радиусом с кисть копания
  // (6 ячеек) влезало в него целиком, поэтому его отсутствие проверяемо.
  const WINDOW = 12;
  const AWAY = 60;
  const AT_X = 320;
  const AT_Y = 60;

  /** Смещения пикселей, которые прицел добавил в кадр. */
  function footprint(inReach: boolean, hud: HudState): Set<string> {
    const here = shoot(AT_X, AT_Y, inReach, hud);
    const gone = shoot(AT_X + AWAY, AT_Y, inReach, hud);
    const marks = new Set<string>();
    for (let dy = -WINDOW; dy <= WINDOW; dy++) {
      for (let dx = -WINDOW; dx <= WINDOW; dx++) {
        const i = ((AT_Y + dy) * BASE_VIEW_W + (AT_X + dx)) * 4;
        if (here[i] !== gone[i] || here[i + 1] !== gone[i + 1] || here[i + 2] !== gone[i + 2]) {
          marks.add(`${dx},${dy}`);
        }
      }
    }
    return marks;
  }

  const digging: HudState = { ...IDLE_HUD, collecting: false };
  const collecting: HudState = {
    ...IDLE_HUD,
    collecting: true,
    hasVacuum: true,
    collectRadius: VACUUM.radius,
  };

  const arms = new Set<string>();
  for (const d of [-3, -2, 2, 3]) {
    arms.add(`${d},0`);
    arms.add(`0,${d}`);
  }
  const same = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every((k) => b.has(k));

  const reachable = footprint(true, digging);
  const far = footprint(false, digging);

  check(
    'Достижимая цель: прицел — лучи и закрашенный центр',
    same(reachable, new Set([...arms, '0,0'])),
    `${reachable.size} пикселей вместо ${arms.size + 1}`,
  );
  check(
    'Недостижимая цель: центр пуст, лучи на месте',
    same(far, arms),
    `${far.size} пикселей вместо ${arms.size}`,
  );
  check(
    'Прицел не обводит площадь: за лучами в окне ничего не нарисовано',
    [...reachable].every((k) => {
      const [dx, dy] = k.split(',').map(Number) as [number, number];
      return (dx === 0 || dy === 0) && Math.abs(dx) <= 3 && Math.abs(dy) <= 3;
    }),
    `самый дальний пиксель ${Math.max(...[...reachable].map((k) => Math.max(...k.split(',').map((n) => Math.abs(Number(n))))))}`,
  );
  check(
    'Режим инструмента не меняет фигуру прицела',
    same(footprint(true, collecting), reachable),
    `сбор ${footprint(true, collecting).size}, копание ${reachable.size}`,
  );
}
