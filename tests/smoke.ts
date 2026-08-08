/**
 * Рантайм-проверка ядра без DOM: генерация мира, физика игрока, камера.
 *
 * Запуск: npm test
 *
 * Эти проверки не косметические. Связность уровня (можно ли дойти до пещеры
 * и вернуться пешком) и корректность точки старта глазами не ловятся —
 * нужно пройти весь маршрут. Симуляция делает это за миллисекунды.
 */
import { generateLuna } from '../src/world/worlds/luna';
import { World } from '../src/world/world';
import { Camera } from '../src/render/camera';
import { Backdrop } from '../src/render/backdrop';
import { Renderer, BRUSH_OUTLINE } from '../src/render/renderer';
import type { Display } from '../src/core/display';
import {
  MAT,
  MAT_SOLID,
  MAT_STATE,
  MAT_SLIP,
  MAT_SPREAD,
  MatterState,
  MATERIALS,
} from '../src/world/materials';
import { Simulation } from '../src/world/simulation';
import type { Occupant } from '../src/world/simulation';
import { Digger } from '../src/world/digging';
import { DebugPainter } from '../src/world/painter';
import { Player } from '../src/entities/player';
import {
  PLAYER,
  FIXED_DT,
  WORLD_SEED,
  VIEW_W,
  VIEW_H,
  CHUNK_SIZE,
  DIG,
  BACKDROP,
  CAMERA,
  AUDIO,
} from '../src/config';
import {
  attenuation,
  attenuationAt,
  panFor,
  changed,
  fillNoise,
  gridHz,
  scaleToneIn,
  snapToScale,
  AudioClock,
  VoiceSlots,
} from '../src/audio/model';
import { createSignals, resetSignals } from '../src/audio/signals';
import { createDigState, createDigParams, digParams, mergeStrike } from '../src/audio/voices/dig';
import {
  createDustState,
  createDustParams,
  dustParams,
  dustIntensity,
} from '../src/audio/voices/dust';
import type { Input } from '../src/core/input';
import { aimDirection, aimTarget, digTarget, AimSourceTracker } from '../src/core/input';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

/** Заглушка ввода с тем же контрактом, что у настоящего Input. */
class FakeInput {
  left = false;
  right = false;
  jumpDown = false;
  jumpIsHeld = false;
  get moveAxis(): number {
    return (this.right ? 1 : 0) - (this.left ? 1 : 0);
  }
  get jumpPressed(): boolean {
    return this.jumpDown;
  }
  get jumpHeld(): boolean {
    return this.jumpIsHeld;
  }
}
const asInput = (f: FakeInput) => f as unknown as Input;

// --- Генерация мира ---
const first = generateLuna(WORLD_SEED);
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
check('Минимальный хоп при тапе ≈ один рост', hop >= 6 && hop <= 14, `${hop} px`);

const heights = [0, 3, 8, 20, 60].map(measureJump);
const monotone = heights.every((h, i) => i === 0 || h > heights[i - 1]);
check('Высота растёт монотонно с длительностью удержания', monotone, heights.join(' < '));

// --- Реактивный ранец ---
{
  /** Ровная площадка с большим запасом высоты над ней. */
  function flatWorld(): World {
    const w = new World(200, 400, world.profile);
    for (let x = 0; x < 200; x++) for (let y = 300; y < 400; y++) w.set(x, y, MAT.ROCK);
    return w;
  }
  const groundY = 300 - PLAYER.hitboxH;
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

// --- Камера ---
{
  const cam = new Camera(world.width, world.height);
  cam.snapTo(500, 300);
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  check(
    'Камера: snapTo центрирует цель',
    cam.x === 500 - cx && cam.y === 300 - cy,
    `(${cam.x},${cam.y})`,
  );

  const beforeX = cam.x;
  for (let i = 0; i < 20; i++) cam.follow(510, 300, 0, 0);
  check('Камера: движение в мёртвой зоне не двигает кадр', cam.x === beforeX, `x=${cam.x}`);

  for (let i = 0; i < 200; i++) cam.follow(700, 300, 0, 0);
  check('Камера: догоняет цель за мёртвой зоной', Math.abs(cam.x - (700 - cx)) <= 41, `x=${cam.x}`);

  for (let i = 0; i < 400; i++) cam.follow(5, 5, 0, 0);
  check(
    'Камера: не выезжает за левый/верхний край',
    cam.x === 0 && cam.y === 0,
    `(${cam.x},${cam.y})`,
  );

  for (let i = 0; i < 800; i++) cam.follow(world.width - 5, world.height - 5, 0, 0);
  check(
    'Камера: не выезжает за правый/нижний край',
    cam.x === world.width - VIEW_W && cam.y === world.height - VIEW_H,
    `(${cam.x},${cam.y})`,
  );

  cam.snapTo(500, 300);
  const noLook = cam.x;
  for (let i = 0; i < 200; i++) cam.follow(500, 300, 30, 0);
  check('Камера: смещается в сторону курсора', cam.x > noLook, `${noLook} → ${cam.x}`);

  const wp = cam.screenToWorld(10, 20);
  check('Камера: экран → мир учитывает смещение', wp.x === cam.x + 10 && wp.y === cam.y + 20);
}

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
  function run(world: World, steps: number, occupant: Occupant | null = null): Simulation {
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
    const occ: Occupant = { x: 40, y: 50, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
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
    function pour(occupant: Occupant | null): { left: number; right: number } {
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
    for (let x = 0; x < 200; x++) for (let y = floorY + PLAYER.hitboxH; y < 86; y++) {
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

  // Вытеснение по плотности: реголит (150) тонет в воде (100).
  {
    const w = box();
    for (let y = 80; y < 94; y++) for (let x = 30; x < 50; x++) w.set(x, y, MAT.WATER);
    w.set(40, 70, MAT.REGOLITH_LOOSE);
    run(w, 300);
    let regolithY = -1;
    for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) regolithY = y;
    check('Плотное тонет в менее плотном', regolithY >= 90, `реголит осел на y=${regolithY}`);
    check(
      'Вода при этом не исчезла',
      count(w, MAT.WATER) === 14 * 20,
      `воды ${count(w, MAT.WATER)}`,
    );
  }

  // Обратное не происходит: вода не проходит сквозь плотный реголит.
  //
  // Считается не прямоугольник под слоем, а «есть ли над водой реголит».
  // Прямоугольник ловил не то: куча реголита с отвесными боками оседает
  // в пологий холм шире исходной, вода стекает по его СКЛОНАМ и попадает
  // в окно замера, ни разу не пройдя сквозь вещество.
  {
    const w = box();
    for (let x = 20; x < 60; x++) for (let y = 80; y < 94; y++) w.set(x, y, MAT.REGOLITH_LOOSE);
    for (let x = 20; x < 60; x++) w.set(x, 79, MAT.WATER);
    run(w, 200);
    let waterUnderRegolith = 0;
    for (let y = 1; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        if (w.get(x, y) === MAT.WATER && w.get(x, y - 1) === MAT.REGOLITH_LOOSE) {
          waterUnderRegolith++;
        }
      }
    }
    check(
      'Менее плотное не тонет в более плотном',
      waterUnderRegolith === 0,
      `воды под реголитом: ${waterUnderRegolith}`,
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

  // Сохранение вещества над смесью.
  {
    const w = box();
    for (let y = 70; y < 90; y++) for (let x = 30; x < 50; x++) w.set(x, y, MAT.WATER);
    for (let x = 30; x < 50; x++) for (let y = 60; y < 65; y++) w.set(x, y, MAT.REGOLITH_LOOSE);
    const waterBefore = count(w, MAT.WATER);
    const regolithBefore = count(w, MAT.REGOLITH_LOOSE);
    run(w, 500);
    check(
      'Вещество не исчезает при вытеснении',
      count(w, MAT.WATER) === waterBefore && count(w, MAT.REGOLITH_LOOSE) === regolithBefore,
      `вода ${waterBefore}→${count(w, MAT.WATER)}, реголит ${regolithBefore}→${count(w, MAT.REGOLITH_LOOSE)}`,
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

// --- Копание ---
{
  function rockWorld(): World {
    const w = new World(128, 128, first.world.profile);
    for (let x = 0; x < 128; x++) for (let y = 40; y < 128; y++) w.set(x, y, MAT.ROCK);
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

  // Контур кисти: предпросмотр обводит ровно ту область, которую заденет выемка.
  {
    const r = DIG.radius;
    const inside = (dx: number, dy: number): boolean => dx * dx + dy * dy <= r * r;

    let area = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (inside(dx, dy)) area++;

    const outline = BRUSH_OUTLINE.length / 2;
    let allInside = true;
    let allOnEdge = true;
    let reachesEdge = 0;
    for (let i = 0; i < BRUSH_OUTLINE.length; i += 2) {
      const dx = BRUSH_OUTLINE[i]!;
      const dy = BRUSH_OUTLINE[i + 1]!;
      if (!inside(dx, dy)) allInside = false;
      const enclosed =
        inside(dx - 1, dy) && inside(dx + 1, dy) && inside(dx, dy - 1) && inside(dx, dy + 1);
      if (enclosed) allOnEdge = false;
      if (Math.abs(dx) === r || Math.abs(dy) === r) reachesEdge++;
    }

    check(
      'Контур кисти не выходит за область выемки',
      allInside && outline > 0,
      `${outline} ячеек`,
    );
    check(
      'Контур кисти — периметр, а не заливка: внутренность остаётся видимой',
      allOnEdge && outline < area,
      `контур ${outline} из площади ${area}`,
    );
    check(
      'Контур кисти совпадает с кистью по размеру',
      reachesEdge >= 4,
      `на радиусе ${reachesEdge}`,
    );
  }

  // Дальность.
  {
    const w = rockWorld();
    const before = w.cells.slice();
    const digger = new Digger();
    const far = DIG.reach + 10; // с запасом от края мира шириной 128
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

// --- Прицел с клавиатуры ---
{
  // Восемь направлений: пары (moveAxis, aimAxisY).
  const DIRS: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  // Инвариант расстояния: кисть обязана дотягиваться до тела.
  check(
    'Прицел: расстояние не превышает полуширину хитбокса плюс радиус кисти',
    DIG.aimDistance <= PLAYER.hitboxW / 2 + DIG.radius,
    `aimDistance=${DIG.aimDistance}, предел=${PLAYER.hitboxW / 2 + DIG.radius}`,
  );

  // Сборка направления.
  {
    const seen = new Set<string>();
    for (const [ax, ay] of DIRS) {
      const d = aimDirection(ax, ay, 1);
      seen.add(`${d.x.toFixed(3)},${d.y.toFixed(3)}`);
    }
    check('Прицел: восемь комбинаций дают восемь разных направлений', seen.size === 8);

    const right = aimDirection(0, 0, 1);
    const left = aimDirection(0, 0, -1);
    check(
      'Прицел: без клавиш направление берётся из facing',
      right.x === 1 && right.y === 0 && left.x === -1 && left.y === 0,
    );

    // Диагональ нормируется: иначе она била бы в 1.41 раза дальше прямой.
    const diag = aimDirection(1, 1, 1);
    const len = Math.hypot(diag.x, diag.y);
    check('Прицел: диагональ нормирована', Math.abs(len - 1) < 1e-9, `длина=${len}`);

    const t = aimTarget(60, 60, diag.x, diag.y);
    check(
      'Прицел: диагональная цель не дальше aimDistance',
      Math.hypot(t.x - 60, t.y - 60) <= DIG.aimDistance + 1,
      `(${t.x - 60}, ${t.y - 60})`,
    );
  }

  // Взаимное гашение осей.
  {
    // Та же формула, что в геттерах moveAxis и aimAxisY.
    const axis = (neg: boolean, pos: boolean): number => (pos ? 1 : 0) - (neg ? 1 : 0);
    const bothX = axis(true, true); // A и D вместе
    const bothY = axis(true, true); // W и S вместе
    const d = aimDirection(bothX, bothY, -1);
    check(
      'Прицел: обе клавиши оси гасят друг друга и остаётся facing',
      bothX === 0 && bothY === 0 && d.x === -1 && d.y === 0,
    );
  }

  // Достижимость и отсутствие зазора между телом и выемкой.
  {
    const hw = PLAYER.hitboxW;
    const hh = PLAYER.hitboxH;
    const px = 60;
    const py = 60;
    const cx = px + hw / 2;
    const cy = py + hh / 2;

    let allInReach = true;
    let allTouching = true;
    let allConverted = true;
    const gaps: string[] = [];

    for (const [ax, ay] of DIRS) {
      const w = new World(128, 128, first.world.profile);
      for (let x = 0; x < 128; x++) for (let y = 0; y < 128; y++) w.set(x, y, MAT.ROCK);

      const d = aimDirection(ax, ay, 1);
      const t = aimTarget(cx, cy, d.x, d.y);
      if (!Digger.inReach(cx, cy, t.x, t.y)) allInReach = false;

      const converted = Digger.applyBrush(w, t.x, t.y);
      if (converted === 0) allConverted = false;

      // Кольцо шириной в ячейку вокруг хитбокса: хотя бы одна его ячейка
      // обязана быть выкопана, иначе между телом и выемкой останется порода
      // и в собственный прокоп не шагнуть. Кисть — сплошной круг, поэтому
      // касания кольца достаточно для связности. Разрушена ячейка или отдала
      // материал — неважно: связность даёт сам факт выемки.
      let touches = false;
      for (let y = py - 1; y <= py + hh; y++) {
        for (let x = px - 1; x <= px + hw; x++) {
          const inside = x >= px && x < px + hw && y >= py && y < py + hh;
          if (inside) continue;
          if (w.get(x, y) !== MAT.ROCK) touches = true;
        }
      }
      if (!touches) {
        allTouching = false;
        gaps.push(`(${ax},${ay})`);
      }
    }

    check('Прицел: клавиатурная цель всегда в пределах досягаемости', allInReach);
    check('Прицел: кисть в каждом направлении что-то выкапывает', allConverted);
    check(
      'Прицел: между телом и выемкой нет зазора ни в одном направлении',
      allTouching,
      gaps.length ? `зазор: ${gaps.join(' ')}` : '',
    );
  }

  // Выбор цели: её задаёт удерживаемый орган, а не режим.
  {
    const cx = 60;
    const cy = 60;
    const cursorX = 200;
    const cursorY = 30;
    const d = aimDirection(1, 0, 1);

    const byMouse = digTarget(true, cursorX, cursorY, cx, cy, d.x, d.y);
    check(
      'Цель: при удержании ЛКМ копается под курсором',
      byMouse.x === cursorX && byMouse.y === cursorY,
    );

    const byKeys = digTarget(false, cursorX, cursorY, cx, cy, d.x, d.y);
    check(
      'Цель: без ЛКМ копается вплотную к персонажу, а не под курсором',
      Math.hypot(byKeys.x - cx, byKeys.y - cy) <= DIG.aimDistance,
      `(${byKeys.x - cx}, ${byKeys.y - cy})`,
    );

    // Оба органа удерживаются: побеждает мышь — у неё есть крестик.
    check(
      'Цель: при обоих органах побеждает мышь',
      digTarget(true, cursorX, cursorY, cx, cy, d.x, d.y).x === cursorX,
    );

    // Крестик не зависит от клавиш: цель мыши одна и та же при любом
    // направлении клавиатуры.
    const other = aimDirection(-1, 1, -1);
    check(
      'Цель мыши не зависит от нажатых клавиш направления',
      digTarget(true, cursorX, cursorY, cx, cy, other.x, other.y).x === cursorX,
    );
  }

  // Арбитраж источника — влияет только на смещение кадра.
  {
    const t = new AimSourceTracker();
    check('Источник прицела: до первого ввода — клавиатура', t.source === 'keys');

    t.note('mouse', false);
    check('Источник прицела: движение мыши переключает на мышь', t.source === 'mouse');

    t.note('keys', false);
    check('Источник прицела: клавиша направления переключает обратно', t.source === 'keys');

    t.note('mouse', true);
    check('Источник прицела: во время копания не переключается', t.source === 'keys');

    t.note('mouse', false);
    check('Источник прицела: после отпускания копания переключается снова', t.source === 'mouse');
    t.note('keys', true);
    check('Источник прицела: заморозка работает в обе стороны', t.source === 'mouse');
  }
}

// --- Задник неба ---
{
  const profile = first.world.profile;
  const spec = profile.backdrop;

  /**
   * Полный кадр без DOM. Персонаж уводится далеко вниз, а прицел — в породу:
   * иначе они попали бы в область неба и посчитались акцентами задника.
   */
  function renderSky(camX: number, camY: number): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
    const display = {
      pixels,
      ctx: { putImageData() {}, fillText() {}, font: '', textBaseline: '', fillStyle: '' },
      image: {},
      present() {},
    } as unknown as Display;

    const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED);
    const camera = new Camera(first.world.width, first.world.height);
    camera.snapTo(camX + VIEW_W / 2, camY + VIEW_H / 2);
    const offscreen = new Player(camera.x + VIEW_W / 2, camera.y + VIEW_H + 40);
    renderer.render(camera, offscreen, VIEW_W / 2, VIEW_H - 1, true, 0, 20);
    return pixels;
  }

  // Детерминированность. Проверяется по итоговому кадру, а не по внутренним
  // таблицам: так под проверку попадают и слои, и звёзды, и небесные тела разом.
  {
    const a = renderSky(500, 0);
    const b = renderSky(500, 0);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check('Задник детерминирован: одно зерно → один и тот же кадр', same);
  }

  // Сортировка списка точек. Это контракт, а не деталь: поиск видимого среза
  // бинарный, и на несортированном списке он молча потеряет часть звёзд.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    let sorted = true;
    for (let i = 1; i < bd.pointX.length; i++) {
      if (bd.pointX[i]! < bd.pointX[i - 1]!) sorted = false;
    }
    check(
      'Точки неба отсортированы по x',
      sorted && bd.pointX.length > 0,
      `точек ${bd.pointX.length}`,
    );

    // Бинарный поиск обязан находить ровно то же, что полный перебор.
    const from = 260;
    let expected = 0;
    for (let i = 0; i < bd.pointX.length; i++) {
      const x = bd.pointX[i]!;
      if (x >= from && x < from + VIEW_W) expected++;
    }
    check('Видимый срез непуст и находится поиском', expected > 100, `в срезе ${expected}`);
  }

  // Лестница значений: задник обязан оставаться темнее переднего плана.
  {
    const luma = (c: number): number =>
      0.3 * ((c >> 16) & 0xff) + 0.6 * ((c >> 8) & 0xff) + 0.1 * (c & 0xff);

    let darkestSolid = Infinity;
    for (const m of MATERIALS) {
      if (m.blocksPlayer) darkestSolid = Math.min(darkestSolid, luma(m.color));
    }

    const fills = spec.layers.map((l) => luma(l.fill));
    check(
      'Все заливки задника темнее самой тёмной твёрдой породы',
      fills.every((f) => f < darkestSolid),
      `слои ${fills.map((f) => f.toFixed(0)).join('/')} против ${darkestSolid.toFixed(0)}`,
    );
    check(
      'Заливки темнеют к зрителю — иначе глубина читается наоборот',
      fills.every((f, i) => i === 0 || f < fills[i - 1]!),
      fills.map((f) => f.toFixed(0)).join(' > '),
    );
    check(
      'Небо темнее любого слоя — силуэт обязан быть виден на фоне',
      fills.every((f) => f > luma(profile.skyColor)),
      `небо ${luma(profile.skyColor).toFixed(0)}`,
    );
  }

  // Бюджет акцентов. Акцент — всё, что в области неба не является ни небом,
  // ни заливкой слоя, ни свечением галактики: звёзды, Земля, кромки, спутник.
  {
    const camX = 260;
    const camY = 0;
    const px = renderSky(camX, camY);
    const background = new Set<number>([profile.skyColor, ...spec.layers.map((l) => l.fill)]);
    if (spec.milkyWay) background.add(spec.milkyWay.glowColor);

    let skyPixels = 0;
    let accents = 0;
    for (let sy = 0; sy < VIEW_H; sy++) {
      for (let sx = 0; sx < VIEW_W; sx++) {
        if (camY + sy >= first.surface[camX + sx]!) continue;
        skyPixels++;
        const i = (sy * VIEW_W + sx) * 4;
        const color = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
        if (!background.has(color)) accents++;
      }
    }
    const share = accents / skyPixels;
    check(
      'Акценты занимают не более 5% неба',
      share <= 0.05,
      `${(share * 100).toFixed(1)}% (${accents} из ${skyPixels})`,
    );
  }

  // Параллакс: слои обязаны расходиться по скорости, иначе глубины нет.
  // Без атмосферы выцветать по дистанции нечему, и это единственный сильный
  // признак дальности, который у задника остался.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const walk = 300;
    const sky = bd.layerOffset(-1, walk, 200).x;
    const offs = spec.layers.map((_, i) => bd.layerOffset(i, walk, 200).x);

    check(
      'Слои расходятся: ближний смещается сильнее дальнего',
      offs.every((o, i) => i === 0 || o > offs[i - 1]!),
      offs.join(' < '),
    );
    check(
      'Звёзды дальше любого слоя силуэтов',
      sky > 0 && sky < offs[0]!,
      `звёзды ${sky} < дальний слой ${offs[0]}`,
    );
    check(
      'Все слои медленнее мира',
      offs.every((o) => o < walk),
      `${offs.join('/')} < ${walk}`,
    );

    // Вертикальное смещение ограничено: иначе на краях хода камеры слои
    // отрываются от линии горизонта.
    const deep = bd.layerOffset(spec.layers.length - 1, 0, 4000).y;
    const atLimit = bd.layerOffset(spec.layers.length - 1, 0, BACKDROP.vertParallaxLimit).y;
    check('Вертикальное смещение слоёв ограничено', deep === atLimit, `${deep} = ${atLimit}`);
  }

  // Земля обязана помещаться в кадр на всём ходе камеры, а не в отдельных её
  // положениях. Её экранная колонка — это companion.x минус смещение параллакса,
  // то есть величина, привязанная к ширине кадра: при сужении кадра диск молча
  // уезжает за правый край и пропадает с неба совсем.
  if (spec.companion) {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const size = BACKDROP.companionSize;
    const maxCamX = first.world.width - VIEW_W;
    const maxCamY = first.world.height - VIEW_H;
    let worstLeft = Infinity;
    let worstRight = Infinity;
    let worstTop = Infinity;
    for (let camX = 0; camX <= maxCamX; camX++) {
      const off = bd.layerOffset(-1, camX, 0);
      const sx = spec.companion.x - off.x;
      if (sx < worstLeft) worstLeft = sx;
      if (VIEW_W - (sx + size) < worstRight) worstRight = VIEW_W - (sx + size);
    }
    for (let camY = 0; camY <= maxCamY; camY++) {
      const sy = spec.companion.y - bd.layerOffset(-1, 0, camY).y;
      if (sy < worstTop) worstTop = sy;
    }
    check(
      'Земля целиком в кадре на всём ходе камеры',
      worstLeft >= 0 && worstRight >= 0 && worstTop >= 0,
      `запас слева ${worstLeft}, справа ${worstRight}, сверху ${worstTop}`,
    );
  }

  // Стопка силуэтов обязана подниматься над линией горизонта переднего плана.
  // Гребень уезжает вместе с камерой лишь на свою долю параллакса, а горизонт —
  // на всю её величину, поэтому изменение высоты кадра топит слои под рельеф,
  // и задник исчезает целиком, не сломав при этом ни одной другой проверки.
  //
  // Проверяется верх стопки — гребень самого дальнего слоя. Ближний слой лежит
  // ровно на линии горизонта и выходит наружу только размахом формы: это не
  // дефект, а способ склеить задник с рельефом.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    let worstTop = Infinity;
    for (let x = 0; x < first.world.width; x += 37) {
      // Камера, центрированная на персонаже, который стоит на поверхности.
      const surf = first.surface[x]!;
      const camY = Math.max(0, Math.min(first.world.height - VIEW_H, surf - VIEW_H / 2));
      const horizon = surf - camY;
      const crest = spec.layers[0]!.crestY - bd.layerOffset(0, 0, camY).y;
      if (horizon - crest < worstTop) worstTop = horizon - crest;
    }
    check(
      'Гребень дальнего слоя выше линии горизонта',
      worstTop > 0,
      `худший просвет ${worstTop} px`,
    );
    // Порядок гребней на экране инвариантом НЕ является и проверке не подлежит:
    // смещение слоя равно camY·parallax, поэтому при углублении камеры ближний
    // слой поднимается быстрее дальнего и в конце концов его обгоняет. Порог —
    // camY ≈ 118 при нынешних числах (0.17·camY < 20) против camY ≈ 76 при
    // прежнем кадре 480×270. Свойство давнее, и при кадре 320×180 оно держится
    // дольше, а не хуже.
  }

  // Под землёй задник не выполняет работы на пиксель.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const camX = 460;
    const deep = 400; // глубоко под любой поверхностью
    check(
      'Под землёй проход задника не выполняется',
      bd.draw(
        new Uint8ClampedArray(VIEW_W * VIEW_H * 4),
        camX,
        deep,
        0,
        bd.maxSurfaceInView(camX),
      ) === false,
    );
  }

  // Неподвижная камера — неподвижный кадр. Правило вакуума: мерцать нечему.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const size = VIEW_W * VIEW_H * 4;
    const a = new Uint8ClampedArray(size);
    const b = new Uint8ClampedArray(size);
    const max = bd.maxSurfaceInView(260);
    // Времена подобраны внутри паузы между проходами спутника.
    bd.draw(a, 260, 0, 20, max);
    bd.draw(b, 260, 0, 24, max);
    let same = true;
    for (let i = 0; same && i < size; i++) if (a[i] !== b[i]) same = false;
    check('Вакуум: при неподвижной камере кадры идентичны', same);
  }

  // Орбитальный объект — единственное, что движется само.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const o = spec.orbiter!;
    const max = bd.maxSurfaceInView(260);
    const positions: number[] = [];
    for (let k = 1; k <= 5; k++) {
      const px = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
      bd.draw(px, 260, 0, (o.crossSec * k) / 6, max);
      for (let i = 0; i < px.length; i += 4) {
        const color = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
        if (color === o.color) positions.push((i / 4) % VIEW_W);
      }
    }
    check(
      'Спутник пересекает кадр слева направо',
      positions.length === 5 && positions.every((x, i) => i === 0 || x > positions[i - 1]!),
      positions.join(' → '),
    );

    // В паузе объекта в кадре нет.
    const idle = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
    bd.draw(idle, 260, 0, o.crossSec + (o.periodSec - o.crossSec) / 2, max);
    let found = false;
    for (let i = 0; i < idle.length; i += 4) {
      if (((idle[i]! << 16) | (idle[i + 1]! << 8) | idle[i + 2]!) === o.color) found = true;
    }
    check('В паузе между проходами спутника в кадре нет', !found);
  }
}

// --- Звук ---
//
// Проверяется МОДЕЛЬ — отображение «сигнал за шаг → параметры дорожки».
// Ни одной ноды WebAudio здесь нет и быть не может: тесты идут в Node.
// «Звучит плохо» этим не ловится и ловиться не должно — на то есть приёмка
// на слух; зато рассинхроны, лимиты и кривые ловятся полностью.
{
  // Затухание в вакууме.
  {
    check('Слышимость: в точке персонажа единица', attenuation(0) === 1);

    let monotone = true;
    let prev = attenuation(0);
    for (let d = 1; d <= AUDIO.contactRadius; d++) {
      const a = attenuation(d);
      if (a >= prev) monotone = false;
      prev = a;
    }
    check('Слышимость: убывает монотонно до радиуса', monotone);

    check(
      'Слышимость: за радиусом РОВНЫЙ ноль, а не хвост',
      attenuation(AUDIO.contactRadius) === 0 &&
        attenuation(AUDIO.contactRadius + 1) === 0 &&
        attenuation(1000) === 0,
    );

    // Слышно ближе, чем видно: осыпание на краю кадра беззвучно, и это
    // не недосмотр, а само правило вакуума.
    check(
      'Слышимость: радиус меньше полукадра и вдвое больше дальности копания',
      AUDIO.contactRadius < VIEW_W / 2 && AUDIO.contactRadius === DIG.reach * 2,
      `${AUDIO.contactRadius} < ${VIEW_W / 2}, копание ${DIG.reach}`,
    );

    check(
      'Слышимость: источник на другом конце мира не слышен',
      attenuationAt(1000, 100, 100, 100) === 0,
    );
  }

  // Панорама считается от персонажа, а не от кадра.
  {
    const listenerX = 500;
    const srcX = listenerX + 40;

    const cam = new Camera(world.width, world.height);
    cam.snapTo(listenerX, 200);
    const before = panFor(srcX, listenerX);
    const camBefore = cam.x;

    // Игрок стоит на месте и уводит курсор вправо — кадр уезжает за ним.
    for (let i = 0; i < 120; i++) {
      cam.follow(listenerX, 200, CAMERA.mouseLookAheadMax, 0);
    }
    const after = panFor(srcX, listenerX);

    check(
      'Панорама: смещение камеры к курсору её не двигает',
      before === after && cam.x !== camBefore,
      `кадр ${camBefore} → ${cam.x}, панорама ${before.toFixed(3)}`,
    );

    check(
      'Панорама: знак следует за стороной источника и не выходит за предел',
      panFor(listenerX - 40, listenerX) < 0 &&
        panFor(listenerX + 1000, listenerX) === AUDIO.panMax &&
        panFor(listenerX - 1000, listenerX) === -AUDIO.panMax,
    );
  }

  // Общий строй и полосы.
  {
    const tones: number[] = [];
    for (let i = 0; i < 12; i++) {
      tones.push(scaleToneIn(i, AUDIO.dig.strikeHzLow, AUDIO.dig.strikeHzHigh));
    }
    check(
      'Строй: тон акцента всегда внутри полосы дорожки',
      tones.every((hz) => hz >= AUDIO.dig.strikeHzLow && hz <= AUDIO.dig.strikeHzHigh),
      `${Math.min(...tones).toFixed(0)}…${Math.max(...tones).toFixed(0)} Гц`,
    );
    check(
      'Строй: тонов в полосе больше одного — акценты не одинаковы',
      new Set(tones.map((t) => t.toFixed(3))).size > 1,
      `разных тонов ${new Set(tones.map((t) => t.toFixed(3))).size}`,
    );
    check(
      'Строй: тон лежит на сетке — привязка произвольной частоты его не двигает',
      tones.every((hz) => Math.abs(snapToScale(hz) - hz) < 1e-6),
    );
    check('Строй: сетка растёт от основания', gridHz(0) === AUDIO.rootHz && gridHz(5) > gridHz(0));

    // Низ намеренно пуст: туда пойдут шаги, ранец и обрушения. Если копание
    // займёт его сейчас, потом придётся выселять.
    check(
      'Полосы: ниже 400 Гц не занято ни одной дорожкой',
      AUDIO.dig.hzQuiet >= 400 && AUDIO.dig.strikeHzLow >= 400 && AUDIO.dust.hzQuiet >= 400,
    );
  }

  // Кривая пыли.
  {
    let monotone = true;
    let prev = -1;
    for (let m = 0; m <= 5000; m += 7) {
      const i = dustIntensity(m);
      if (i < prev) monotone = false;
      prev = i;
    }
    check('Пыль: интенсивность растёт монотонно с числом сдвигов', monotone);
    check(
      'Пыль: насыщение ровно на fullMoves и выше единицы не поднимается',
      dustIntensity(AUDIO.dust.fullMoves) === 1 && dustIntensity(100000) === 1,
    );
    check(
      'Пыль: обвал звучит громче осыпания, но в разы, а не в сто раз',
      dustIntensity(1000) > dustIntensity(10) && dustIntensity(1000) < dustIntensity(10) * 20,
      `10 → ${dustIntensity(10).toFixed(3)}, 1000 → ${dustIntensity(1000).toFixed(3)}`,
    );

    const state = createDustState();
    const out = createDustParams();
    const sig = createSignals();
    sig.listenerX = 100;
    sig.listenerY = 100;
    sig.powderX = 100;
    sig.powderY = 100;

    sig.powderMoves = 100000;
    dustParams(sig, state, out);
    check(
      'Пыль: даже тысячи сдвигов не выводят громкость за предел дорожки',
      out.gain <= AUDIO.dust.gain + 1e-9,
      `${out.gain.toFixed(3)} ≤ ${AUDIO.dust.gain}`,
    );

    // Правило вакуума на самой дорожке, а не только на функции затухания.
    sig.powderX = 100 + AUDIO.contactRadius + 1;
    sig.powderMoves = 5000;
    dustParams(sig, state, out);
    check('Пыль: осыпание дальше радиуса не слышно вообще', out.gain === 0);

    // Улёгшийся мир молчит.
    sig.powderX = 100;
    sig.powderMoves = 200;
    dustParams(sig, state, out);
    const loud = out.gain;
    sig.powderMoves = 0;
    dustParams(sig, state, out);
    check(
      'Пыль: последняя остановившаяся ячейка приводит текстуру к ровному нулю',
      loud > 0 && out.gain === 0 && !out.rising,
      `${loud.toFixed(3)} → ${out.gain}`,
    );
  }

  /** Снапшот с персонажем и точкой копания в одном месте — слышимость единица. */
  function digSignals(converted: number) {
    const sig = createSignals();
    sig.listenerX = 100;
    sig.listenerY = 100;
    sig.digX = 100;
    sig.digY = 100;
    sig.digConverted = converted;
    return sig;
  }

  // Лимит темпа акцентов.
  {
    const state = createDigState();
    const out = createDigParams();
    // Кисть применяется 33 раза в секунду — заведомо выше различимого на слух
    // темпа ударов. Слух перестаёт разбирать события примерно с 20 Гц.
    const applications = 33;
    const sig = digSignals(0);
    let strikes = 0;
    let applied = 0;
    for (let i = 0; i < 60; i++) {
      const due = Math.floor((i * applications) / 60) > Math.floor(((i - 1) * applications) / 60);
      sig.digConverted = due ? 12 : 0;
      if (due) applied++;
      digParams(sig, state, FIXED_DT, out);
      if (out.strike) strikes++;
    }
    check(
      'Копание: при 33 применениях кисти в секунду акцентов не больше потолка',
      applied === applications && strikes <= AUDIO.dig.strikeHz,
      `применений ${applied}, акцентов ${strikes} ≤ ${AUDIO.dig.strikeHz}`,
    );
    check(
      'Копание: акценты при этом звучат, а не пропадают',
      strikes >= AUDIO.dig.strikeHz - 2,
      `акцентов ${strikes}`,
    );
  }

  // Молчание там, где мир не изменился.
  {
    const state = createDigState();
    const out = createDigParams();
    const sig = digSignals(0);
    let strikes = 0;
    let loudest = 0;
    for (let i = 0; i < 300; i++) {
      digParams(sig, state, FIXED_DT, out);
      if (out.strike) strikes++;
      loudest = Math.max(loudest, out.grindGain);
    }
    check(
      'Копание: пустота и недостижимая цель не дают ни помола, ни акцентов',
      strikes === 0 && loudest === 0,
      `акцентов ${strikes}, громкость ${loudest}`,
    );
  }

  // Копание за радиусом слышимости.
  {
    const state = createDigState();
    const out = createDigParams();
    const sig = digSignals(12);
    sig.digX = 100 + AUDIO.contactRadius + 10;
    let loudest = 0;
    let strikeGain = 0;
    for (let i = 0; i < 120; i++) {
      digParams(sig, state, FIXED_DT, out);
      loudest = Math.max(loudest, out.grindGain);
      if (out.strike) strikeGain = Math.max(strikeGain, out.strikeGain);
    }
    check(
      'Копание: за радиусом слышимости молчит и помол, и акцент',
      loudest === 0 && strikeGain === 0,
    );
  }

  // Курсор часов аудио.
  {
    const clock = new AudioClock();
    const now = 3;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push(clock.next(now));

    const spaced = times.every((t, i) => i === 0 || Math.abs(t - times[i - 1]! - FIXED_DT) < 1e-12);
    check(
      'Часы: пять шагов в одном кадре дают пять разных времён с шагом симуляции',
      new Set(times).size === 5 && spaced,
      times.map((t) => (t - now).toFixed(4)).join(' '),
    );
    check(
      'Часы: планирования в прошлое не бывает — браузер отдал бы такое молча',
      times.every((t) => t >= now + AUDIO.lookahead - 1e-12),
    );

    // Возврат из свёрнутой вкладки: курсор ушёл далеко вперёд, и накопленное
    // проигралось бы залпом.
    let maxAhead = 0;
    for (let i = 0; i < 500; i++) maxAhead = Math.max(maxAhead, clock.next(now) - now);
    check(
      'Часы: курсор не уходит дальше предела опережения',
      maxAhead <= AUDIO.maxAhead + 1e-12,
      `${maxAhead.toFixed(4)} ≤ ${AUDIO.maxAhead}`,
    );

    clock.reset();
    check(
      'Часы: сброс возвращает курсор к настоящему',
      Math.abs(clock.next(100) - (100 + AUDIO.lookahead)) < 1e-12,
    );
  }

  // Лимит одноразовых голосов.
  {
    const slots = new VoiceSlots(AUDIO.maxOneShots);
    const now = 10;
    let granted = 0;
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      if (slots.acquire(now, now + AUDIO.lookahead, AUDIO.dig.strikeDecay) >= 0) granted++;
      else refused++;
    }
    check(
      'Голоса: залп событий не оставляет больше лимита занятых слотов',
      granted === AUDIO.maxOneShots && slots.activeCount(now) === AUDIO.maxOneShots,
      `выдано ${granted}, отказано ${refused}`,
    );

    const later = now + AUDIO.lookahead + AUDIO.dig.strikeDecay;
    check(
      'Голоса: отзвучавшие слоты освобождаются без колбэков',
      slots.activeCount(later) === 0 && slots.acquire(later, later, 0.05) === 0,
    );

    // Событие сверх лимита не теряется, а вливается в непрерывную часть:
    // обвал должен становиться громче, а не рассыпаться на щелчки.
    const state = createDigState();
    const out = createDigParams();
    state.att = 1;
    out.strikeGain = 0.3;
    mergeStrike(state, out);
    const merged = state.merged;
    mergeStrike(state, out);
    check(
      'Голоса: лишний акцент вливается в помол, складываясь по мощности',
      merged > 0 && state.merged > merged,
      `${merged.toFixed(3)} → ${state.merged.toFixed(3)}`,
    );

    // Залп на обвале обязан упереться в потолок дорожки, а не расти без предела.
    for (let i = 0; i < 50; i++) mergeStrike(state, out);
    check(
      'Голоса: слияние упирается в бюджет дорожки и не перегружает шину',
      state.merged <= AUDIO.dig.gain + 1e-9,
      `${state.merged.toFixed(3)} ≤ ${AUDIO.dig.gain}`,
    );

    const silent = digSignals(0);
    digParams(silent, state, FIXED_DT, out);
    check(
      'Голоса: влитая энергия слышна в помоле, а не пропадает',
      out.grindGain > 0,
      `помол ${out.grindGain.toFixed(3)}`,
    );
  }

  // Детерминированность шума.
  {
    const a = new Float32Array(4096);
    const b = new Float32Array(4096);
    fillNoise(a, WORLD_SEED);
    fillNoise(b, WORLD_SEED);
    let same = true;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check('Шум: одно зерно — одна и та же выборка', same);

    const other = new Float32Array(4096);
    fillNoise(other, WORLD_SEED + 1);
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== other[i]) differs = true;
    check('Шум: другое зерно даёт другой материал', differs);

    let inRange = true;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i]! < -1 || a[i]! > 1) inRange = false;
      sum += a[i]!;
    }
    check(
      'Шум: выборки в пределах и без постоянной составляющей',
      inRange && Math.abs(sum / a.length) < 0.05,
      `среднее ${(sum / a.length).toFixed(4)}`,
    );
  }

  // Порог изменения параметра.
  {
    check(
      'Порог: приход в тишину и уход из неё сообщаются всегда',
      changed(0.0001, 0) && changed(0, 0.0001) && !changed(0.5, 0.5),
    );

    const state = createDigState();
    const out = createDigParams();
    const sig = digSignals(6);
    let lateChanges = 0;
    for (let i = 0; i < 600; i++) {
      digParams(sig, state, FIXED_DT, out);
      if (i >= 300 && out.grindChanged) lateChanges++;
    }
    check(
      'Порог: при постоянном сигнале модель перестаёт трогать параметры',
      lateChanges === 0,
      `автоматизаций за 5 секунд установившегося режима: ${lateChanges}`,
    );

    const ds = createDustState();
    const dout = createDustParams();
    const dsig = createSignals();
    dsig.listenerX = 100;
    dsig.listenerY = 100;
    dsig.powderX = 100;
    dsig.powderY = 100;
    dsig.powderMoves = 120;
    dustParams(dsig, ds, dout);
    const firstChanged = dout.changed;
    let repeats = 0;
    for (let i = 0; i < 300; i++) {
      dustParams(dsig, ds, dout);
      if (dout.changed) repeats++;
    }
    check(
      'Порог: ровный поток осыпания не порождает автоматизаций',
      firstChanged && repeats === 0,
      `повторных ${repeats}`,
    );
  }

  // Счётчики симуляции: наблюдение, а не участие.
  {
    function sandbox(w = 96, h = 96): World {
      const world = new World(w, h, first.world.profile);
      for (let x = 0; x < w; x++) world.set(x, h - 1, MAT.ROCK);
      return world;
    }

    {
      const w = sandbox();
      w.set(20, 10, MAT.REGOLITH_LOOSE);
      const sim = new Simulation();
      sim.update(w, null);
      check(
        'Счётчики: одна падающая ячейка — один сдвиг, центр масс в её новой позиции',
        sim.lastPowderMoves === 1 &&
          sim.lastPowderSumX / sim.lastPowderMoves === 20 &&
          sim.lastPowderSumY / sim.lastPowderMoves === 11,
        `сдвигов ${sim.lastPowderMoves}, центр (${sim.lastPowderSumX}, ${sim.lastPowderSumY})`,
      );

      for (let i = 0; i < 300; i++) sim.update(w, null);
      check(
        'Счётчики: улёгшийся мир даёт ноль сдвигов — звуку нечего играть',
        sim.lastPowderMoves === 0 && w.get(20, 94) === MAT.REGOLITH_LOOSE,
        `сдвигов ${sim.lastPowderMoves}`,
      );
    }

    {
      // Дорожка привязана к состоянию материала, а не к конкретному реголиту:
      // жидкое и газообразное этот счётчик не трогают.
      const w = sandbox();
      w.set(30, 10, MAT.WATER);
      w.set(40, 60, MAT.STEAM);
      const sim = new Simulation();
      let powder = 0;
      for (let i = 0; i < 60; i++) {
        sim.update(w, null);
        powder += sim.lastPowderMoves;
      }
      check('Счётчики: жидкое и газообразное в дорожку пыли не попадают', powder === 0);
    }

    {
      // Эталон: сценарий из существующей проверки детерминированности.
      // Счётчики читаются на каждом шаге, и сетка обязана совпасть с прогоном,
      // который их игнорирует, — иначе учёт влиял бы на автомат.
      function scenario(readCounters: boolean): Uint8Array {
        const w = sandbox();
        const sim = new Simulation();
        let seen = 0;
        for (let i = 0; i < 300; i++) {
          if (i % 3 === 0) w.set(40 + (i % 7), 8, MAT.REGOLITH_LOOSE);
          sim.update(w, null);
          if (readCounters) seen += sim.lastPowderMoves + sim.lastPowderSumX;
        }
        void seen;
        return w.cells.slice();
      }
      const a = scenario(true);
      const b = scenario(false);
      let same = a.length === b.length;
      for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
      check('Счётчики: учёт движения не изменил поведение автомата', same);
    }
  }

  // Снапшот сигналов переиспользуется.
  {
    const sig = createSignals();
    sig.digConverted = 7;
    sig.powderMoves = 300;
    sig.listenerX = 42;
    resetSignals(sig);
    check(
      'Сигналы: сброс обнуляет счётчики шага и не трогает точку отсчёта',
      sig.digConverted === 0 && sig.powderMoves === 0 && sig.listenerX === 42,
    );
  }
}

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛЕНО: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
