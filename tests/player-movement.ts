import { World, MAT, Simulation } from '../src/world';
import { Digger } from '../src/systems';
import { Player } from '../src/entities';
import { PLAYER, FIXED_DT } from '../src/config';
import { check, FakeInput, asInput, luna } from './harness';

const first = luna();
const { world, spawn } = first;

// --- Ходьба ---
{
  const p = new Player(spawn.x, spawn.y);
  const input = new FakeInput();
  input.right = true;
  let embedded = false;
  for (let i = 0; i < 600; i++) {
    p.update(FIXED_DT, asInput(input), world);
    if (world.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH)) embedded = true;
  }
  check('Ходьба: персонаж сместился вправо', p.x > spawn.x + 100, `x: ${spawn.x} → ${p.x}`);
  check('Ходьба: ни разу не оказался внутри породы', !embedded);
}

// --- Прыжок ---
function measureJump(holdSteps: number): number {
  const p = new Player(spawn.x, spawn.y);
  const input = new FakeInput();
  for (let i = 0; i < 30; i++) p.update(FIXED_DT, asInput(input), world);
  const startY = p.y;
  input.jumpDown = true;
  input.jumpIsHeld = true;
  let minY = p.y;
  for (let i = 0; i < 200; i++) {
    p.update(FIXED_DT, asInput(input), world);
    input.jumpDown = false;
    if (i >= holdSteps) input.jumpIsHeld = false;
    minY = Math.min(minY, p.y);
  }
  return startY - minY;
}
// Фиксированной «высоты прыжка» больше не существует: клавиша делит работу
// с ранцем, и высота непрерывно зависит от длительности удержания. Поэтому
// проверяем импульс напрямую, минимальный хоп и монотонность.
{
  const p = new Player(spawn.x, spawn.y);
  const input = new FakeInput();
  for (let i = 0; i < 30; i++) p.update(FIXED_DT, asInput(input), world);
  input.jumpDown = true;
  input.jumpIsHeld = true;
  p.update(FIXED_DT, asInput(input), world);
  check(
    'Прыжок: импульс равен jumpVelocity и сильнее предела ранца',
    Math.abs(p.vy + PLAYER.jumpVelocity) < 1 && PLAYER.jumpVelocity > PLAYER.maxRiseSpeed,
    `vy=${p.vy.toFixed(1)}, предел ранца ${PLAYER.maxRiseSpeed}`,
  );
}

const hop = measureJump(0);
check('Минимальный хоп при тапе ≈ два роста', hop >= 12 && hop <= 28, `${hop} ячеек`);

const heights = [0, 3, 8, 20, 60].map(measureJump);
const monotone = heights.every((h, i) => i === 0 || h > heights[i - 1]);
check('Высота растёт монотонно с длительностью удержания', monotone, heights.join(' < '));

// --- Реактивный ранец ---
{
  /** Ровная площадка с большим запасом высоты над ней. */
  // Потолок мира-стенда выше хода ранца за отведённые шаги: упёршись в него,
  // персонаж встал бы, и проверка предела скорости мерила бы потолок.
  function flatWorld(): World {
    const w = new World(200, 800, world.profile);
    for (let x = 0; x < 200; x++) for (let y = 700; y < 800; y++) w.set(x, y, MAT.ROCK);
    return w;
  }
  const groundY = 700 - PLAYER.hitboxH;
  const thrustAccel = world.profile.gravity * PLAYER.thrustGravityMultiplier;
  check(
    'Тяга считается от гравитации мира, а не константой',
    thrustAccel === world.profile.gravity * 2 && thrustAccel > world.profile.gravity,
    `${thrustAccel} px/с² при гравитации ${world.profile.gravity}`,
  );

  // Подъём и удержание высоты.
  {
    const w = flatWorld();
    const p = new Player(60, groundY);
    const input = new FakeInput();
    for (let i = 0; i < 10; i++) p.update(FIXED_DT, asInput(input), w);
    const startY = p.y;
    input.jumpDown = true;
    input.jumpIsHeld = true;
    for (let i = 0; i < 90; i++) {
      p.update(FIXED_DT, asInput(input), w);
      input.jumpDown = false;
    }
    check('Ранец: персонаж поднялся', p.y < startY - 60, `${startY} → ${p.y}`);
    check(
      'Ранец: скорость подъёма держится на пределе',
      Math.abs(p.vy + PLAYER.maxRiseSpeed) < 1,
      `vy=${p.vy.toFixed(1)}, предел ${PLAYER.maxRiseSpeed}`,
    );
  }

  // Ранец не срезает импульс прыжка.
  {
    const w = flatWorld();
    const p = new Player(60, groundY);
    const input = new FakeInput();
    for (let i = 0; i < 10; i++) p.update(FIXED_DT, asInput(input), w);
    input.jumpDown = true;
    input.jumpIsHeld = true;
    p.update(FIXED_DT, asInput(input), w); // прыжок: vy = -150
    input.jumpDown = false;

    let thrustedWhileFast = false;
    let vyWhenThrustBegan = 0;
    for (let i = 0; i < 60; i++) {
      p.update(FIXED_DT, asInput(input), w);
      if (p.thrusting) {
        if (!vyWhenThrustBegan) vyWhenThrustBegan = p.vy;
        if (p.vy < -PLAYER.maxRiseSpeed - 1) thrustedWhileFast = true;
      }
    }
    check('Ранец не срезает импульс прыжка', !thrustedWhileFast);
    check(
      'Тяга включается на пределе подъёма, а не раньше',
      Math.abs(vyWhenThrustBegan + PLAYER.maxRiseSpeed) < 2,
      `vy при включении = ${vyWhenThrustBegan.toFixed(1)}`,
    );
  }

  // Отпускание прекращает тягу, повторное нажатие в воздухе включает её снова.
  {
    const w = flatWorld();
    const p = new Player(60, groundY);
    const input = new FakeInput();
    input.jumpDown = true;
    input.jumpIsHeld = true;
    for (let i = 0; i < 60; i++) {
      p.update(FIXED_DT, asInput(input), w);
      input.jumpDown = false;
    }
    input.jumpIsHeld = false;
    // Гашение подъёма -110 занимает ~21 шаг при гравитации 320, поэтому
    // проверяем переход в падение с запасом, а не сразу после отпускания.
    for (let i = 0; i < 40; i++) p.update(FIXED_DT, asInput(input), w);
    check('Ранец: отпускание прекращает тягу', !p.thrusting && p.vy > 0, `vy=${p.vy.toFixed(1)}`);

    input.jumpIsHeld = true;
    for (let i = 0; i < 20; i++) p.update(FIXED_DT, asInput(input), w);
    check(
      'Ранец: повторное включение в воздухе работает',
      p.thrusting && p.vy < 0,
      `vy=${p.vy.toFixed(1)}`,
    );
  }

  // Взлёт при удержании клавиши на опоре, без повторного нажатия.
  {
    const w = flatWorld();
    const p = new Player(60, groundY);
    const input = new FakeInput();
    for (let i = 0; i < 10; i++) p.update(FIXED_DT, asInput(input), w);
    const startY = p.y;
    input.jumpIsHeld = true; // удерживается, но НЕ нажата в этом шаге
    for (let i = 0; i < 120; i++) p.update(FIXED_DT, asInput(input), w);
    check(
      'Ранец: удержание на опоре поднимает без повторного нажатия',
      p.y < startY - 10,
      `${startY} → ${p.y}`,
    );
  }

  // Упор в потолок мира.
  {
    const w = flatWorld();
    const p = new Player(60, groundY);
    const input = new FakeInput();
    input.jumpIsHeld = true;
    for (let i = 0; i < 600; i++) p.update(FIXED_DT, asInput(input), w);
    check(
      'Ранец: упор в верх мира обнуляет скорость',
      p.vy === 0 && p.y === 0,
      `y=${p.y}, vy=${p.vy}`,
    );
    check(
      'Ранец: персонаж не оказался внутри твёрдых ячеек',
      !w.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH),
    );
    // Продолжаем удерживать — тяга не должна «выдыхаться».
    for (let i = 0; i < 3600; i++) p.update(FIXED_DT, asInput(input), w);
    check('Ранец: полёт не исчерпывается за минуту удержания', p.thrusting);
  }

  // Второго импульса прыжка в воздухе не существует.
  {
    const w = flatWorld();
    const p = new Player(60, 40); // высоко в воздухе
    const input = new FakeInput();
    for (let i = 0; i < 30; i++) p.update(FIXED_DT, asInput(input), w); // падает
    let fastest = 0;
    for (let i = 0; i < 60; i++) {
      input.jumpDown = i === 0;
      input.jumpIsHeld = true;
      p.update(FIXED_DT, asInput(input), w);
      fastest = Math.min(fastest, p.vy);
    }
    check(
      'В воздухе нажатие не даёт импульс прыжка — только тягу',
      fastest >= -PLAYER.maxRiseSpeed - 1,
      `максимальный подъём ${fastest.toFixed(1)}, предел ранца ${PLAYER.maxRiseSpeed}`,
    );
  }

  // Тяга усиливает манёвр вбок.
  function lateralSpeedAfter(thrust: boolean, steps: number): number {
    const w = flatWorld();
    const p = new Player(60, 40);
    const input = new FakeInput();
    for (let i = 0; i < 5; i++) p.update(FIXED_DT, asInput(input), w);
    input.right = true;
    input.jumpIsHeld = thrust;
    for (let i = 0; i < steps; i++) p.update(FIXED_DT, asInput(input), w);
    return p.vx;
  }
  const vxThrust = lateralSpeedAfter(true, 6);
  const vxFall = lateralSpeedAfter(false, 6);
  check(
    'Тяга усиливает манёвр вбок',
    vxThrust > vxFall,
    `${vxThrust.toFixed(1)} > ${vxFall.toFixed(1)}`,
  );
  check(
    'Манёвр в воздухе всё ещё слабее наземного',
    PLAYER.airAccelThrust < PLAYER.groundAccel,
    `${PLAYER.airAccelThrust} < ${PLAYER.groundAccel}`,
  );
}

// --- Coyote time ---
{
  const w = new World(120, 80, world.profile);
  for (let x = 0; x < 40; x++) for (let y = 40; y < 46; y++) w.set(x, y, MAT.ROCK);
  const p = new Player(30, 30);
  const input = new FakeInput();
  for (let i = 0; i < 60; i++) p.update(FIXED_DT, asInput(input), w);
  check('Приземление на площадку', p.onGround);
  // Контракт спеки: при контакте скорость обнуляется. Проверять надо в покое,
  // а не в момент касания — субпиксельный остаток иначе копит скорость молча.
  check('Покой на опоре: вертикальная скорость нулевая', p.vy === 0, `vy=${p.vy}`);

  input.right = true;
  while (p.onGround) p.update(FIXED_DT, asInput(input), w); // сойти с края
  p.update(FIXED_DT, asInput(input), w);
  p.update(FIXED_DT, asInput(input), w);
  input.jumpDown = true;
  input.jumpIsHeld = true;
  p.update(FIXED_DT, asInput(input), w);
  input.jumpDown = false;
  check('Coyote: прыжок сразу после схода с края засчитан', p.vy < 0, `vy=${p.vy.toFixed(1)}`);

  const vyBefore = p.vy;
  input.jumpDown = true;
  p.update(FIXED_DT, asInput(input), w);
  check(
    'Coyote не даёт двойной прыжок',
    p.vy > vyBefore,
    `vy ${vyBefore.toFixed(1)} → ${p.vy.toFixed(1)}`,
  );
}

// --- Jump buffer ---
{
  const w = new World(120, 120, world.profile);
  for (let x = 0; x < 120; x++) for (let y = 100; y < 110; y++) w.set(x, y, MAT.ROCK);
  const p = new Player(50, 40);
  const input = new FakeInput();
  let pressed = false;
  let jumped = false;
  for (let i = 0; i < 400; i++) {
    if (!pressed && !p.onGround && p.y >= 100 - PLAYER.hitboxH - 12) {
      input.jumpDown = true;
      input.jumpIsHeld = true;
      pressed = true;
    } else {
      input.jumpDown = false;
    }
    p.update(FIXED_DT, asInput(input), w);
    if (pressed && p.vy < -50) jumped = true;
  }
  check('Jump buffer: нажатие до приземления не потеряно', jumped);
}

// --- Отсутствие туннелирования ---
{
  const w = new World(60, 400, world.profile);
  for (let x = 0; x < 60; x++) w.set(x, 300, MAT.ROCK); // перекрытие в одну ячейку
  const p = new Player(25, 10);
  const input = new FakeInput();
  let passed = false;
  for (let i = 0; i < 600; i++) {
    p.update(FIXED_DT, asInput(input), w);
    if (p.y > 300) passed = true;
  }
  check('Падение с предельной скоростью не пробивает пол в 1 ячейку', !passed, `y=${p.y}`);
}

// --- Автоподъём на неровности ---
function runIntoWall(wallHeight: number): boolean {
  const w = new World(200, 80, world.profile);
  const floorY = 50;
  for (let x = 0; x < 200; x++) for (let y = floorY; y < 80; y++) w.set(x, y, MAT.ROCK);
  for (let x = 100; x < 200; x++)
    for (let y = floorY - wallHeight; y < floorY; y++) w.set(x, y, MAT.ROCK);
  const p = new Player(60, floorY - PLAYER.hitboxH);
  const input = new FakeInput();
  input.right = true;
  for (let i = 0; i < 400; i++) p.update(FIXED_DT, asInput(input), w);
  return p.x > 110;
}
check('Step-up: выступ 2 ячейки преодолевается', runIntoWall(2));
check('Step-up: выступ 3 ячейки преодолевается', runIntoWall(3));
check('Стена 8 ячеек останавливает', !runIntoWall(8));

{
  // Низкий тоннель: подъём потребовал бы больше свободной высоты, чем есть.
  const w = new World(200, 80, world.profile);
  const floorY = 50;
  for (let x = 0; x < 200; x++) for (let y = floorY; y < 80; y++) w.set(x, y, MAT.ROCK);
  for (let x = 0; x < 200; x++) for (let y = 0; y < floorY - 11; y++) w.set(x, y, MAT.ROCK);
  for (let x = 100; x < 200; x++) for (let y = floorY - 2; y < floorY; y++) w.set(x, y, MAT.ROCK);
  const p = new Player(60, floorY - PLAYER.hitboxH);
  const input = new FakeInput();
  input.right = true;
  let embedded = false;
  for (let i = 0; i < 400; i++) {
    p.update(FIXED_DT, asInput(input), w);
    if (w.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH)) embedded = true;
  }
  check('Низкий тоннель: подъём не состоялся, персонаж остановлен', p.x < 100, `x=${p.x}`);
  check('Низкий тоннель: персонаж не оказался в потолке', !embedded);
}

// --- Продавливание сквозь рыхлое ---
{
  function ground(w = 200, h = 96): World {
    const world = new World(w, h, first.world.profile);
    for (let x = 0; x < w; x++) for (let y = h - 10; y < h; y++) world.set(x, y, MAT.ROCK);
    return world;
  }
  const floorY = 96 - 10 - PLAYER.hitboxH;

  /** Секунды на прохождение dist ячеек вправо; Infinity — не дошёл. */
  function walkTime(build: (w: World) => void, dist: number, limit = 6000): number {
    const w = ground();
    build(w);
    const p = new Player(20, floorY);
    const input = new FakeInput();
    input.right = true;
    const sim = new Simulation();
    for (let i = 0; i < limit; i++) {
      p.update(FIXED_DT, asInput(input), w);
      sim.update(w, { x: p.x, y: p.y, w: PLAYER.hitboxW, h: PLAYER.hitboxH });
      if (p.x >= 20 + dist) return i * FIXED_DT;
    }
    return Infinity;
  }

  // Коридор ровно в рост персонажа: без потолка куча реголита осыпается
  // в пологий склон, и персонаж просто взбегает по нему автоподъёмом,
  // ни разу ничего не продавив.
  function corridor(w: World, fill: number | null): void {
    for (let x = 30; x < 110; x++) w.set(x, floorY - 1, MAT.ROCK);
    if (fill === null) return;
    for (let x = 40; x < 100; x++) {
      for (let y = floorY; y < floorY + PLAYER.hitboxH; y++) w.set(x, y, fill);
    }
  }
  const clear = walkTime((w) => corridor(w, null), 60);
  const through = walkTime((w) => corridor(w, MAT.REGOLITH_LOOSE), 60);
  check('Продавливание доводит сквозь завал', Number.isFinite(through), `${through.toFixed(2)} с`);
  check(
    'Продавливание заметно медленнее ходьбы по твёрдому',
    through > clear * 2,
    `по полу ${clear.toFixed(2)} с, сквозь реголит ${through.toFixed(2)} с`,
  );

  // Порода не продавливается: её убирают копанием, а не напором.
  {
    const w = ground();
    for (let x = 60; x < 70; x++) for (let y = 0; y < 96; y++) w.set(x, y, MAT.ROCK);
    const p = new Player(20, floorY);
    const input = new FakeInput();
    input.right = true;
    input.jumpIsHeld = true;
    for (let i = 0; i < 3000; i++) p.update(FIXED_DT, asInput(input), w);
    check('Порода не продавливается', p.x + PLAYER.hitboxW <= 60, `остановился на x=${p.x}`);
  }

  // Персонаж не тонет в куче, на которой стоит: продавливание вниз запрещено.
  {
    const w = ground();
    for (let x = 0; x < 200; x++)
      for (let y = floorY + PLAYER.hitboxH; y < 86; y++) {
        w.set(x, y, MAT.REGOLITH_LOOSE);
      }
    const p = new Player(20, floorY);
    const input = new FakeInput();
    const sim = new Simulation();
    const startY = p.y;
    for (let i = 0; i < 2000; i++) {
      p.update(FIXED_DT, asInput(input), w);
      sim.update(w, { x: p.x, y: p.y, w: PLAYER.hitboxW, h: PLAYER.hitboxH });
    }
    check('Персонаж не тонет в куче, на которой стоит', p.y <= startY, `y ${startY} → ${p.y}`);
  }

  // Полное засыпание: выход есть, и вещество при этом сохраняется.
  {
    const w = new World(64, 96, first.world.profile);
    for (let i = 0; i < w.cells.length; i++) w.cells[i] = MAT.ROCK;
    for (let y = 20; y < 80; y++) for (let x = 24; x < 32; x++) w.setRaw(x, y, MAT.VACUUM);
    const p = new Player(25, 69);
    const sim = new Simulation();
    // Персонаж прокапывает потолок шахты у себя над головой — штатное действие.
    for (let pass = 0; pass < 14; pass++) {
      for (let cx = 24; cx < 32; cx += 3) Digger.applyBrush(w, cx, 22 + pass);
    }
    w.chunks.wakeAll();
    const idle = new FakeInput();
    const occ = () => ({ x: p.x, y: p.y, w: PLAYER.hitboxW, h: PLAYER.hitboxH });
    for (let i = 0; i < 600; i++) {
      p.update(FIXED_DT, asInput(idle), w);
      sim.update(w, occ());
    }
    const dirs: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, -1],
      [0, 1],
    ];
    const stuck = dirs.filter(
      ([dx, dy]) => !w.rectHitsSolid(p.x + dx, p.y + dy, PLAYER.hitboxW, PLAYER.hitboxH),
    ).length;
    let regolith = 0;
    for (const c of w.cells) if (c === MAT.REGOLITH_LOOSE) regolith++;

    const dig = new FakeInput();
    dig.right = true;
    dig.jumpIsHeld = true;
    const startY = p.y;
    let escaped = 0;
    for (; escaped < 3600; escaped++) {
      p.update(FIXED_DT, asInput(dig), w);
      sim.update(w, occ());
      const free = dirs.filter(
        ([dx, dy]) => !w.rectHitsSolid(p.x + dx, p.y + dy, PLAYER.hitboxW, PLAYER.hitboxH),
      ).length;
      if (free >= 2 && p.y < startY - 4) break;
    }
    let regolithAfter = 0;
    for (const c of w.cells) if (c === MAT.REGOLITH_LOOSE) regolithAfter++;

    check('Засыпание действительно запирает без продавливания', stuck === 0, `свободно ${stuck}/4`);
    check(
      'Засыпанный персонаж выбирается за конечное время',
      escaped < 3600,
      `${(escaped * FIXED_DT).toFixed(2)} с`,
    );
    check(
      'Продавливание не уничтожает вещество',
      regolith === regolithAfter,
      `${regolith} → ${regolithAfter}`,
    );
  }
}
