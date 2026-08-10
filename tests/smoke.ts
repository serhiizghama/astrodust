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
import {
  Renderer,
  BRUSH_OUTLINE,
  VACUUM_OUTLINE,
  vacuumOutline,
  stripeOffset,
  MACHINE_STATE_COLORS,
} from '../src/render/renderer';
import type { HudState } from '../src/render/renderer';
import type { Display } from '../src/core/display';
import {
  MAT,
  MAT_SOLID,
  MAT_STATE,
  MAT_SLIP,
  MAT_SPREAD,
  MAT_DENSITY,
  MAT_YIELDS,
  MAT_YIELD_RATE,
  MAT_PORTABLE,
  MAT_DIGGABLE,
  MAT_CREDIT_RATE,
  MAT_RESEARCH_RATE,
  MAT_CARRY,
  CONVEYOR_STRIPE_COLOR,
  MatterState,
  MATERIALS,
  PORTABLE_MATERIALS,
} from '../src/world/materials';
import { Simulation } from '../src/world/simulation';
import type { Occupant } from '../src/world/simulation';
import { Digger } from '../src/world/digging';
import { Vacuum } from '../src/world/vacuum';
import { reactAround, REACTIONS } from '../src/world/reactions';
import { Builder } from '../src/world/builder';
import { DebugPainter } from '../src/world/painter';
import { Player } from '../src/entities/player';
import { Inventory } from '../src/entities/inventory';
import { LandingModule } from '../src/entities/landing-module';
import { BuildingRegistry } from '../src/entities/buildings';
import {
  SEPARATOR_KIND,
  Separator,
  OUTLET_ROW,
  OUTLET_FROM,
  OUTLET_TO,
  machineSummary,
} from '../src/entities/separator';
import { CONVEYOR_LEFT_KIND, CONVEYOR_RIGHT_KIND } from '../src/entities/conveyor';
import { BUILD_CATALOG, BuildCatalogState, sectionKindByHull } from '../src/entities/catalog';
import { Research, ResearchOverlay } from '../src/progress/research';
import { Tuning, TUNING_BASE } from '../src/progress/tuning';
import { TECHNOLOGIES, TECH_BY_ID, CONTENT, maxTuned } from '../src/progress/technologies';
import {
  PLAYER,
  FIXED_DT,
  WORLD_SEED,
  VIEW_W,
  VIEW_H,
  CHUNK_SIZE,
  DIG,
  VACUUM,
  MODULE,
  SEPARATOR,
  CONVEYOR,
  SIM_HZ,
  BUILD_AIM_DISTANCE,
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
import { Input } from '../src/core/input';
import {
  aimDirection,
  aimTarget,
  actionTarget,
  AimSourceTracker,
  ToolModeState,
  ToolMode,
  NO_INPUT,
} from '../src/core/input';

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

/** Строка состояния в начале партии — для проверок, которым важен не HUD. */
const IDLE_HUD: HudState = {
  mode: 'Копание',
  collecting: false,
  collectRadius: VACUUM.radius,
  carried: [],
  used: 0,
  capacity: VACUUM.capacity,
  selected: MATERIALS[PORTABLE_MATERIALS[0]!]!.name,
  credits: 0,
  research: 0,
  buildKind: '',
  buildIssue: '',
  ghost: null,
  machines: [],
  machineSummary: '',
  overlay: null,
};

/**
 * Дерево, в котором открыто всё.
 *
 * Проверки конвейера, ленты и постановки существовали до исследований и про них
 * ничего не знают: им нужен мир, в котором лента доступна, а не путь, которым
 * она стала доступна. Что закрытый вид не ставится, проверяется отдельно
 * и умолчанием `NO_UNLOCKS`.
 */
const UNLOCKED = { has: () => true };

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

// --- Реакции, инвентарь и приёмник ---
{
  /** Пустой мир с полом по нижней строке. */
  function box(width = 96, height = 96): World {
    const w = new World(width, height, first.world.profile);
    for (let x = 0; x < width; x++) w.set(x, height - 1, MAT.ROCK);
    return w;
  }
  function count(w: World, material: number): number {
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
  /** Сколько чанков разбужено на следующий шаг. */
  function pending(w: World): number {
    let n = 0;
    for (let cy = 0; cy < w.chunks.rows; cy++) {
      for (let cx = 0; cx < w.chunks.cols; cx++) if (w.chunks.isPending(cx, cy)) n++;
    }
    return n;
  }
  /** Опустошает оба поколения флагов: дальше видно только новые пробуждения. */
  function quiet(w: World): void {
    w.chunks.advance();
    w.chunks.advance();
  }

  // --- Новые поля таблицы материалов ---

  // Попарная различимость всех восьми веществ. Пульпа обязана быть отличима
  // от сухого реголита — иначе результат реакции не виден вовсе, — а корпус
  // модуля должен читаться рукотворным на фоне любого грунта.
  {
    const visible = [
      MAT.REGOLITH_PACKED,
      MAT.REGOLITH_LOOSE,
      MAT.PULP,
      MAT.ICE,
      MAT.WATER,
      MAT.LAVA,
      MAT.STEAM,
      MAT.MODULE_HULL,
    ];
    let clashes = '';
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = MATERIALS[visible[i]!]!;
        const b = MATERIALS[visible[j]!]!;
        if (a.color === b.color) clashes += `${a.name}=${b.name} `;
      }
    }
    check('Цвета восьми веществ попарно различны', clashes === '', clashes);
  }

  {
    const portable = MATERIALS.filter((m) => m.portable).map((m) => m.id);
    check(
      'Переносимы ровно реголит, пульпа, иридий и шлак',
      portable.length === 4 &&
        [MAT.REGOLITH_LOOSE, MAT.PULP, MAT.IRIDIUM, MAT.SLAG].every((id) => portable.includes(id)),
      `переносимых ${portable.length}: ${portable.map((id) => MATERIALS[id]!.name).join(', ')}`,
    );
    check(
      'Статичное непереносимо: подобрать породу пылесосом нельзя',
      MATERIALS.filter((m) => m.state === MatterState.Solid).every((m) => !m.portable),
    );
    check(
      'Жидкости и газы непереносимы',
      [MAT.WATER, MAT.LAVA, MAT.STEAM].every((id) => MAT_PORTABLE[id] === 0),
    );

    // Неразрушимо всё, что игрок купил за кредиты, и ничего сверх того.
    // Конвейеров двое, и их одинаковый цвет — не оплошность, а требование:
    // различать ленты обязано направление бегущей полосы, а не оттенок.
    const indestructible = MATERIALS.filter((m) => !m.diggable).map((m) => m.id);
    check(
      'Неразрушимы ровно корпуса модуля, сепаратора и оба конвейера',
      indestructible.length === 4 &&
        [MAT.MODULE_HULL, MAT.SEPARATOR_HULL, MAT.CONVEYOR_LEFT, MAT.CONVEYOR_RIGHT].every((id) =>
          indestructible.includes(id),
        ) &&
        MATERIALS[MAT.MODULE_HULL]!.color !== MATERIALS[MAT.SEPARATOR_HULL]!.color,
      `неразрушимых ${indestructible.length}: ${indestructible.map((id) => MATERIALS[id]!.name).join(', ')}`,
    );
    // Копание читает развёрнутый массив, а не таблицу. Разъезд между ними
    // означал бы, что неразрушимость записана, но не действует.
    check(
      'Развёрнутые массивы совпадают с таблицей',
      MATERIALS.every(
        (m) =>
          MAT_DIGGABLE[m.id] === (m.diggable ? 1 : 0) &&
          MAT_PORTABLE[m.id] === (m.portable ? 1 : 0) &&
          MAT_CREDIT_RATE[m.id] === m.creditRate &&
          MAT_RESEARCH_RATE[m.id] === m.researchRate,
      ),
    );

    check(
      'Ставки кредитов: реголит и пульпа положительны, пульпа дороже',
      MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]! > 0 &&
        MAT_CREDIT_RATE[MAT.PULP]! > MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]!,
      `реголит ${MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]}, пульпа ${MAT_CREDIT_RATE[MAT.PULP]}`,
    );
    check(
      'Остальное не принимается: обе ставки ноль',
      [
        MAT.ROCK,
        MAT.ROCK_DEEP,
        MAT.REGOLITH_PACKED,
        MAT.ICE,
        MAT.WATER,
        MAT.LAVA,
        MAT.STEAM,
        MAT.MODULE_HULL,
        MAT.SLAG,
      ].every((id) => MAT_CREDIT_RATE[id] === 0 && MAT_RESEARCH_RATE[id] === 0),
    );
    // Разделение валют — правило ТАБЛИЦЫ, а не кода: проверяется один раз
    // по всем строкам. Вещество, дающее и деньги, и прогресс, отменяет выбор
    // «сдать сырьём или переработать», ради которого валюты и разделены.
    check(
      'Ни одно вещество не даёт обе валюты сразу',
      MATERIALS.every((m) => m.creditRate === 0 || m.researchRate === 0),
      MATERIALS.filter((m) => m.creditRate !== 0 && m.researchRate !== 0)
        .map((m) => m.name)
        .join(', '),
    );
    // Переработка — единственный источник прогресса. Вторая дорога к очкам
    // обесценила бы машину, ради которой построена вся цепочка.
    {
      const sources = MATERIALS.filter((m) => m.researchRate > 0);
      check(
        'Очки исследований даёт ровно одно вещество — иридий',
        sources.length === 1 && sources[0]!.id === MAT.IRIDIUM,
        sources.map((m) => `${m.name} ${m.researchRate}`).join(', ') || 'ни одного',
      );
    }
    check(
      'Иридий не приносит кредитов',
      MAT_CREDIT_RATE[MAT.IRIDIUM] === 0,
      `${MAT_CREDIT_RATE[MAT.IRIDIUM]} ₡`,
    );
    check(
      'Сырьё не приносит очков',
      MAT_RESEARCH_RATE[MAT.REGOLITH_LOOSE] === 0 && MAT_RESEARCH_RATE[MAT.PULP] === 0,
    );
    check(
      'Плотность пульпы выше плотности воды',
      MAT_DENSITY[MAT.PULP]! > MAT_DENSITY[MAT.WATER]!,
      `пульпа ${MAT_DENSITY[MAT.PULP]}, вода ${MAT_DENSITY[MAT.WATER]}`,
    );
    check('Пульпа сыпучая, а не жидкая', MAT_STATE[MAT.PULP] === MatterState.Powder);
    check(
      'Осыпаемость пульпы ниже, чем у сухого реголита',
      MAT_SLIP[MAT.PULP]! < MAT_SLIP[MAT.REGOLITH_LOOSE]!,
      `пульпа ${MAT_SLIP[MAT.PULP]}, реголит ${MAT_SLIP[MAT.REGOLITH_LOOSE]}`,
    );
  }

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
      for (let y = 37; y <= 43; y++) for (let x = 36; x <= 45; x++) w.set(x, y, MAT.ROCK);
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

  // --- Инвентарь и сбор ---

  {
    // Сбор забирает переносимое и не трогает всё остальное.
    {
      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(41, 40, MAT.PULP);
      w.set(40, 41, MAT.ROCK);
      w.set(41, 41, MAT.WATER);
      w.set(39, 40, MAT.MODULE_HULL);
      const inv = new Inventory();
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'Сбор забирает реголит и пульпу',
        collected === 2 && inv.count(MAT.REGOLITH_LOOSE) === 1 && inv.count(MAT.PULP) === 1,
        `собрано ${collected}`,
      );
      check(
        'Сбор не трогает породу, воду и корпус модуля',
        w.get(40, 41) === MAT.ROCK &&
          w.get(41, 41) === MAT.WATER &&
          w.get(39, 40) === MAT.MODULE_HULL,
      );
      check(
        'Собранные ячейки исчезли из мира',
        w.get(40, 40) === MAT.VACUUM && w.get(41, 40) === MAT.VACUUM,
      );
    }

    // Сохранение вещества: сколько исчезло из мира, столько прибавилось.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const before = count(w, MAT.REGOLITH_LOOSE);
      const inv = new Inventory();
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'Собранное сохраняется: убыль мира равна приросту инвентаря',
        before - count(w, MAT.REGOLITH_LOOSE) === collected &&
          inv.count(MAT.REGOLITH_LOOSE) === collected &&
          inv.used === collected,
        `собрано ${collected} из ${before}`,
      );
    }

    // Заполненный инвентарь прекращает сбор, а вещество остаётся в мире.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const before = count(w, MAT.REGOLITH_LOOSE);
      const inv = new Inventory(4);
      inv.add(MAT.PULP, 4);
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'На пределе ёмкости сбор не берёт ничего, а куча остаётся',
        collected === 0 && count(w, MAT.REGOLITH_LOOSE) === before && inv.free === 0,
        `собрано ${collected}, осталось ${count(w, MAT.REGOLITH_LOOSE)}`,
      );
    }

    // Частично помещающаяся кисть забирает ровно остаток ёмкости.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const covered = (() => {
        const inv = new Inventory();
        return Vacuum.collect(box0(w), inv, 40, 40);
      })();
      function box0(src: World): World {
        const c = box();
        c.cells.set(src.cells);
        return c;
      }
      const inv = new Inventory(3);
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'Кисть, накрывшая больше ячеек, чем влезает, забирает ровно остаток',
        covered > 3 && collected === 3 && inv.used === 3 && count(w, MAT.REGOLITH_LOOSE) === 25 - 3,
        `кисть накрывает ${covered}, влезло ${collected}, в мире осталось ${count(w, MAT.REGOLITH_LOOSE)}`,
      );
    }

    // Разные материалы делят одну ёмкость.
    {
      const inv = new Inventory(10);
      inv.add(MAT.REGOLITH_LOOSE, 6);
      const pulp = inv.add(MAT.PULP, 6);
      check(
        'Разные материалы делят один предел',
        pulp === 4 &&
          inv.count(MAT.REGOLITH_LOOSE) === 6 &&
          inv.count(MAT.PULP) === 4 &&
          inv.free === 0,
        `реголит ${inv.count(MAT.REGOLITH_LOOSE)}, пульпа ${inv.count(MAT.PULP)}, свободно ${inv.free}`,
      );
    }

    // Сбор будит область: лежащее выше обязано осыпаться. Столб в шахте
    // с каменными стенками, а не свободная куча: свободная расплылась бы
    // в холм шире кисти, и «осело ли верхнее» стало бы вопросом о форме кучи,
    // а не о пробуждении.
    {
      const w = box();
      for (let y = 60; y < 95; y++) {
        w.set(39, y, MAT.ROCK);
        w.set(41, y, MAT.ROCK);
        w.set(40, y, MAT.REGOLITH_LOOSE);
      }
      settle(w, 500);
      quiet(w);
      const inv = new Inventory();
      Vacuum.collect(w, inv, 40, 93);
      check('Сбор будит область мира', pending(w) > 0, `чанков ${pending(w)}`);
      const topBefore = (() => {
        for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) return y;
        return -1;
      })();
      settle(w, 500);
      const topAfter = (() => {
        for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) return y;
        return -1;
      })();
      check(
        'Оставшееся над собранным осело',
        topAfter > topBefore,
        `верх столба ${topBefore} → ${topAfter}`,
      );
    }

    // Дальность: недостижимая цель не меняет ни мир, ни инвентарь.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const before = count(w, MAT.REGOLITH_LOOSE);
      const inv = new Inventory();
      const vac = new Vacuum();
      const far = DIG.reach + 20;
      vac.updateSuck(FIXED_DT, w, inv, true, 40 + far, 40, 40, 40);
      check(
        'Сбор за пределом дальности не меняет ни мир, ни инвентарь',
        count(w, MAT.REGOLITH_LOOSE) === before && inv.used === 0,
      );
      // …а в пределах — меняет, и темп задан интервалом, а не частотой кадров.
      const first1 = vac.updateSuck(FIXED_DT, w, inv, true, 40, 40, 40, 40);
      const second = vac.updateSuck(FIXED_DT, w, inv, true, 40, 40, 40, 40);
      check(
        'Темп сбора задан интервалом: второе применение в том же кадре не проходит',
        first1 > 0 && second === 0,
        `первое ${first1}, второе ${second}`,
      );
    }

    // Кисть сбора не больше копательной.
    check(
      'Кисть сбора не больше кисти копания',
      VACUUM.radius <= DIG.radius && VACUUM_OUTLINE.length < BRUSH_OUTLINE.length,
      `сбор r=${VACUUM.radius}, копание r=${DIG.radius}`,
    );
  }

  // --- Высыпание ---

  {
    // Ставится только в пустоту, мир не разрушается.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.ROCK);
      const rockBefore = count(w, MAT.ROCK);
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const placed = Vacuum.dump(w, inv, 40, 40);
      check(
        'Высыпание в породу не проходит и счётчик не трогает',
        placed === 0 && inv.count(MAT.REGOLITH_LOOSE) === 50 && count(w, MAT.ROCK) === rockBefore,
        `размещено ${placed}, породы ${rockBefore} → ${count(w, MAT.ROCK)}`,
      );
    }
    {
      const w = box();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const placed = Vacuum.dump(w, inv, 40, 40);
      check(
        'Высыпание в пустоту ставит вещество и уменьшает счётчик ровно на размещённое',
        placed > 0 &&
          count(w, MAT.REGOLITH_LOOSE) === placed &&
          inv.count(MAT.REGOLITH_LOOSE) === 50 - placed &&
          inv.used === 50 - placed,
        `размещено ${placed}`,
      );
      // Высыпанное немедленно подчиняется своим правилам: отдельного поведения
      // у «только что высыпанного» нет.
      settle(w, 1000);
      let lowest = -1;
      for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) lowest = y;
      check(
        'Высыпанное осыпается по правилам своего вещества',
        lowest === 94,
        `нижняя ячейка на y=${lowest}`,
      );
    }
    // Пустой счётчик ничего не даёт.
    {
      const w = box();
      const inv = new Inventory();
      const before = w.cells.slice();
      const placed = Vacuum.dump(w, inv, 40, 40);
      let changed = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
      check('Высыпание при пустом счётчике не меняет мир', placed === 0 && changed === 0);
    }
    // В хитбокс персонажа вещество не попадает.
    {
      const w = box();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const occupant: Occupant = { x: 39, y: 38, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
      Vacuum.dump(w, inv, 40, 40, occupant);
      let inside = 0;
      for (let y = occupant.y; y < occupant.y + occupant.h; y++) {
        for (let x = occupant.x; x < occupant.x + occupant.w; x++) {
          if (w.get(x, y) !== MAT.VACUUM) inside++;
        }
      }
      check(
        'Высыпание в себя не проходит: хитбокс остаётся пустым',
        inside === 0,
        `ячеек внутри хитбокса ${inside}`,
      );
    }
    // Смена выбранного вещества меняет то, что высыпается.
    {
      const inv = new Inventory();
      const startName = inv.selectedName;
      const startId = inv.selected;
      inv.cycleSelected();
      const nextId = inv.selected;
      check(
        'Смена выбранного вещества меняет и вещество, и подпись',
        nextId !== startId && inv.selectedName !== startName,
        `${startName} → ${inv.selectedName}`,
      );
      for (let i = 1; i < PORTABLE_MATERIALS.length; i++) inv.cycleSelected();
      check('Перебор выбранного идёт по кругу', inv.selected === startId);

      const w = box();
      inv.add(nextId, 5);
      inv.cycleSelected();
      while (inv.selected !== nextId) inv.cycleSelected();
      Vacuum.dump(w, inv, 40, 40);
      check('Высыпается именно выбранное вещество', count(w, nextId) > 0);
    }
    // Высыпание тоже подчиняется дальности.
    {
      const w = box();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const vac = new Vacuum();
      vac.updateDump(FIXED_DT, w, inv, true, 40 + DIG.reach + 20, 40, 40, 40);
      check('Высыпание за пределом дальности не меняет мир', count(w, MAT.REGOLITH_LOOSE) === 0);
    }
  }

  // --- Режим инструмента ---

  {
    const tool = new ToolModeState();
    check(
      'Режим начинается с копания и виден подписью',
      tool.digging && !tool.collecting && tool.name.length > 0,
      tool.name,
    );

    // Выражение из главного цикла воспроизведено буквально: копание получает
    // `удержание && режим копания`, сбор — `удержание && режим сбора`.
    const held = true;
    const w = box();
    for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.ROCK);
    for (let x = 36; x <= 37; x++) w.set(x, 40, MAT.REGOLITH_LOOSE);
    const inv = new Inventory();
    const digger = new Digger();
    const vac = new Vacuum();

    const dug = digger.update(FIXED_DT, w, held && tool.digging, 40, 40, 40, 40);
    check('В режиме копания инструмент копает', dug > 0, `выемка ${dug}`);

    tool.cycle();
    check(
      'Переключение режима видно сразу, до первого применения',
      tool.collecting && !tool.digging && tool.name.length > 0,
      tool.name,
    );

    const rockBefore = count(w, MAT.ROCK);
    const dug2 = digger.update(FIXED_DT, w, held && tool.digging, 40, 40, 40, 40);
    check(
      'В режиме сбора кисть копания не применяется вовсе',
      dug2 === 0 && count(w, MAT.ROCK) === rockBefore,
      `выемка ${dug2}, породы ${rockBefore} → ${count(w, MAT.ROCK)}`,
    );

    const sucked = vac.updateSuck(FIXED_DT, w, inv, held && tool.collecting, 37, 40, 37, 40);
    check(
      'В режиме сбора инструмент собирает',
      sucked > 0 && inv.used === sucked,
      `собрано ${sucked}`,
    );

    // Высыпание от режима не зависит.
    for (const mode of ['сбора', 'копания']) {
      const dw = box();
      const di = new Inventory();
      di.add(MAT.REGOLITH_LOOSE, 20);
      const dv = new Vacuum();
      const placed = dv.updateDump(FIXED_DT, dw, di, true, 40, 40, 40, 40);
      check(`Высыпание работает в режиме ${mode}`, placed > 0, `размещено ${placed}`);
      tool.cycle();
    }

    // Полный цикл без мыши: у каждого действия есть клавиша, и клавиатурная
    // цель достижима по построению.
    {
      const dir = aimDirection(0, 0, 1);
      const target = actionTarget(false, 999, 999, 40, 40, dir.x, dir.y);
      check(
        'Без мыши цель берётся от персонажа, а не от нетронутого курсора',
        Digger.inReach(40, 40, target.x, target.y) && target.x !== 999,
        `цель (${target.x},${target.y})`,
      );
    }
  }

  // --- Посадочный модуль и кредиты ---

  {
    /** Мир с приёмником: дно и две стенки из корпуса, открытый верх. */
    function withReceiver(): { world: World; module: LandingModule } {
      const w = box();
      const zone = { x: 40, y: 40, w: 6, h: 5 };
      for (let y = zone.y; y < zone.y + zone.h + 2; y++) {
        for (let d = 0; d < 2; d++) {
          w.set(zone.x - 1 - d, y, MAT.MODULE_HULL);
          w.set(zone.x + zone.w + d, y, MAT.MODULE_HULL);
        }
      }
      for (let y = zone.y + zone.h; y < zone.y + zone.h + 2; y++) {
        for (let x = zone.x - 2; x < zone.x + zone.w + 2; x++) w.set(x, y, MAT.MODULE_HULL);
      }
      return { world: w, module: new LandingModule(zone) };
    }

    // Высыпанное принято, счёт вырос по ставке.
    {
      const { world: w, module } = withReceiver();
      const inv = new Inventory();
      inv.add(MAT.PULP, 20);
      while (inv.selected !== MAT.PULP) inv.cycleSelected();
      const placed = Vacuum.dump(w, inv, 42, 42);
      const earned = module.update(w);
      check(
        'Высыпанная в приёмник пульпа исчезает и даёт кредиты по ставке',
        placed > 0 &&
          earned.credits === placed * MAT_CREDIT_RATE[MAT.PULP]! &&
          count(w, MAT.PULP) === 0,
        `размещено ${placed}, начислено ${earned.credits}, осталось ${count(w, MAT.PULP)}`,
      );
      check(
        'Счёт модуля равен начисленному, а очки за сырьё не растут',
        module.credits === earned.credits && earned.research === 0 && module.research.points === 0,
        `${module.credits} ₡, ${module.research.points} ✦`,
      );
    }

    // Самотёком — так же. Персонажа рядом нет вовсе.
    {
      const { world: w, module } = withReceiver();
      for (let x = 40; x < 46; x++) w.set(x, 30, MAT.REGOLITH_LOOSE);
      const dropped = count(w, MAT.REGOLITH_LOOSE);
      const sim = new Simulation();
      for (let i = 0; i < 400; i++) {
        sim.update(w, null);
        module.update(w);
      }
      check(
        'Скатившееся в зону самотёком принимается так же, и игрок для этого не нужен',
        module.credits === dropped * MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]! &&
          count(w, MAT.REGOLITH_LOOSE) === 0,
        `сброшено ${dropped}, начислено ${module.credits}, осталось ${count(w, MAT.REGOLITH_LOOSE)}`,
      );
    }

    // Непринимаемое остаётся и ведёт себя по своим правилам.
    {
      const { world: w, module } = withReceiver();
      for (let x = 40; x < 46; x++) w.set(x, 41, MAT.WATER);
      const before = count(w, MAT.WATER);
      const sim = new Simulation();
      for (let i = 0; i < 200; i++) {
        sim.update(w, null);
        module.update(w);
      }
      check(
        'Вещество с нулевой ставкой в зоне остаётся и кредитов не даёт',
        module.credits === 0 && count(w, MAT.WATER) === before,
        `воды ${before} → ${count(w, MAT.WATER)}, кредитов ${module.credits}`,
      );
    }

    // Цепочка выгоднее сырья: одна ячейка реголита через воду даёт больше.
    {
      const direct = MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]!;

      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(40, 41, MAT.WATER);
      reactAround(w, 40, 40);
      const pulp = count(w, MAT.PULP);
      const chain = pulp * MAT_CREDIT_RATE[MAT.PULP]!;
      check(
        'Цепочка выгоднее сырья: реголит через воду даёт больше кредитов',
        pulp === 2 && chain > direct,
        `напрямую ${direct} ₡, через воду ${pulp} ячейки пульпы = ${chain} ₡`,
      );
    }

    // Счёт монотонно не убывает при любой последовательности действий.
    {
      const { world: w, module } = withReceiver();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 30);
      inv.add(MAT.PULP, 30);
      const vac = new Vacuum();
      const sim = new Simulation();
      let previous = module.credits;
      let dropped = false;
      for (let i = 0; i < 600; i++) {
        vac.updateDump(FIXED_DT, w, inv, i % 3 === 0, 40, 42, 42, 42);
        Vacuum.collect(w, inv, 43, 38);
        sim.update(w, null);
        module.update(w);
        if (module.credits < previous) dropped = true;
        previous = module.credits;
      }
      check(
        'Счёт кредитов ни разу не убыл и остался целым и неотрицательным',
        !dropped && module.credits > 0 && Number.isInteger(module.credits),
        `счёт ${module.credits}`,
      );
    }
  }

  // --- Модуль в сгенерированном мире ---

  {
    const w = first.world;
    const zone = first.receiver;

    let hull = 0;
    for (const c of w.cells) if (c === MAT.MODULE_HULL) hull++;
    check('В сгенерированном мире есть корпус модуля', hull > 0, `ячеек ${hull}`);

    // Площадка горизонтальна: профиль поверхности под модулем — прямая.
    {
      const from = MODULE.x - MODULE.padMargin;
      const to = MODULE.x + MODULE.width + MODULE.padMargin - 1;
      const level = first.surface[from]!;
      let uneven = 0;
      for (let x = from; x <= to; x++) if (first.surface[x] !== level) uneven++;
      check(
        'Площадка под модулем горизонтальна',
        uneven === 0,
        `колонок вне уровня ${uneven}, уровень ${level}`,
      );
    }

    // Зона открыта сверху и ограничена корпусом с трёх сторон.
    {
      let openAbove = 0;
      for (let x = zone.x; x < zone.x + zone.w; x++) {
        if (w.get(x, zone.y - 1) === MAT.VACUUM) openAbove++;
      }
      let walled = 0;
      for (let y = zone.y; y < zone.y + zone.h; y++) {
        if (w.get(zone.x - 1, y) === MAT.MODULE_HULL) walled++;
        if (w.get(zone.x + zone.w, y) === MAT.MODULE_HULL) walled++;
      }
      let floored = 0;
      for (let x = zone.x; x < zone.x + zone.w; x++) {
        if (w.get(x, zone.y + zone.h) === MAT.MODULE_HULL) floored++;
      }
      let empty = 0;
      for (let y = zone.y; y < zone.y + zone.h; y++) {
        for (let x = zone.x; x < zone.x + zone.w; x++) if (w.get(x, y) === MAT.VACUUM) empty++;
      }
      check(
        'Зона приёмника пуста, открыта сверху и ограничена корпусом с трёх сторон',
        empty === zone.w * zone.h &&
          openAbove === zone.w &&
          walled === zone.h * 2 &&
          floored === zone.w,
        `пустых ${empty}/${zone.w * zone.h}, сверху открыто ${openAbove}, стенок ${walled}, дна ${floored}`,
      );
    }

    // Точка старта корректна и находится вне корпуса.
    {
      const p = new Player(spawn.x, spawn.y);
      let hullAtSpawn = 0;
      for (let x = p.x; x < p.x + PLAYER.hitboxW; x++) {
        for (let y = p.y; y <= p.y + PLAYER.hitboxH; y++) {
          if (w.get(x, y) === MAT.MODULE_HULL) hullAtSpawn++;
        }
      }
      check(
        'Точка старта корректна и вне корпуса модуля',
        !w.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH) &&
          w.rectHitsSolid(p.x, p.y + PLAYER.hitboxH, PLAYER.hitboxW, 1) &&
          hullAtSpawn === 0,
        `корпуса в хитбоксе ${hullAtSpawn}, спавн (${p.x},${p.y})`,
      );
    }

    // Модуль на виду: он попадает в кадр, центрированный на точке старта.
    {
      const cam = new Camera(w.width, w.height);
      cam.snapTo(spawn.x, spawn.y);
      let visible = 0;
      for (let sy = 0; sy < VIEW_H; sy++) {
        for (let sx = 0; sx < VIEW_W; sx++) {
          if (w.get(cam.x + sx, cam.y + sy) === MAT.MODULE_HULL) visible++;
        }
      }
      check('Модуль виден из точки старта', visible > 0, `ячеек корпуса в кадре ${visible}`);
    }

    // По корпусу можно ходить: персонаж, поставленный на крышу стенки, стоит.
    {
      const top = zone.y;
      const p = new Player(MODULE.x, top - PLAYER.hitboxH);
      check(
        'По корпусу модуля можно стоять',
        !w.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH) &&
          w.rectHitsSolid(p.x, p.y + PLAYER.hitboxH, PLAYER.hitboxW, 1),
        `позиция (${p.x},${p.y})`,
      );
    }

    // Корпус не копается и не собирается.
    {
      const probe = new World(64, 64, w.profile);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) probe.set(x, y, MAT.MODULE_HULL);
      const before = probe.cells.slice();
      const excavated = Digger.applyBrush(probe, 32, 32);
      let changed = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== probe.cells[i]) changed++;
      check(
        'Корпус модуля не копается: ни выемки, ни выработки',
        excavated === 0 && changed === 0,
        `выемка ${excavated}, изменено ${changed}`,
      );

      const inv = new Inventory();
      const collected = Vacuum.collect(probe, inv, 32, 32);
      check(
        'Корпус модуля не собирается пылесосом',
        collected === 0 && inv.used === 0 && count(probe, MAT.MODULE_HULL) === 64 * 64,
      );

      // Смешанная кисть: корпус остаётся, порода рядом разрушается.
      for (let y = 0; y < 64; y++) for (let x = 32; x < 64; x++) probe.set(x, y, MAT.ROCK);
      const hullBefore = count(probe, MAT.MODULE_HULL);
      const mixed = Digger.applyBrush(probe, 32, 32);
      check(
        'Кисть по границе корпуса и породы берёт только породу',
        mixed > 0 && count(probe, MAT.MODULE_HULL) === hullBefore,
        `выемка ${mixed}, корпуса ${hullBefore} → ${count(probe, MAT.MODULE_HULL)}`,
      );
    }

    check(
      'В нетронутом мире с модулем по-прежнему нет жидких ячеек',
      w.liquidCells === 0,
      `счётчик жидкого ${w.liquidCells}`,
    );
    check(
      'В нетронутом мире нет ни пульпы, ни рыхлого реголита',
      !w.cells.includes(MAT.PULP) && !w.cells.includes(MAT.REGOLITH_LOOSE),
    );
  }

  // --- Строка состояния ---

  {
    // Строка обязана рисоваться при ВЫКЛЮЧЕННОЙ диагностике: инвентарь и счёт —
    // состояние игры, а не инструмент разработчика.
    const drawn: string[] = [];
    const pixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
    const display = {
      pixels,
      ctx: {
        putImageData() {},
        fillText(line: string) {
          drawn.push(line);
        },
        measureText: (s: string) => ({ width: s.length * 4.8 }),
        // Подложка оверлея и рамка панели: заглушке достаточно их принять —
        // проверяется текст, а не заливка.
        fillRect() {},
        strokeRect() {},
        font: '',
        textBaseline: '',
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
      },
      image: {},
      present() {},
    } as unknown as Display;

    const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED);
    const camera = new Camera(first.world.width, first.world.height);
    camera.snapTo(spawn.x, spawn.y);
    const hud: HudState = {
      mode: 'Сбор',
      collecting: true,
      collectRadius: VACUUM.radius,
      carried: [{ name: 'Пульпа', count: 138 }],
      used: 138,
      capacity: VACUUM.capacity,
      selected: 'Пульпа',
      credits: 1234,
      research: 7,
      buildKind: '',
      buildIssue: '',
      ghost: null,
      machines: [],
      machineSummary: '',
      overlay: null,
    };
    renderer.render(camera, new Player(spawn.x, spawn.y), 160, 90, true, hud, 0);

    const text = drawn.join('\n');
    check(
      'Строка состояния показывает режим, инвентарь с пределом, выбранное и счёт',
      text.includes('Сбор') &&
        text.includes(`138/${VACUUM.capacity}`) &&
        text.includes('Пульпа 138') &&
        text.includes('Высыпать: Пульпа') &&
        text.includes('1234 ₡'),
      text.replace(/\n/g, ' | '),
    );
    check(
      'Диагностики при этом в кадре нет: строка состояния от неё не зависит',
      !text.includes('FPS'),
    );
    // Обе валюты одновременно и без оверлея: игрок принимает по ним разные
    // решения — что построить и что открыть, — и валюта, которую видно только
    // в меню, из этих решений выпадает.
    check(
      'Очки исследований видны в кадре рядом с кредитами и без оверлея',
      text.includes('1234 ₡') && text.includes('7 ✦'),
      text.replace(/\n/g, ' | '),
    );

    // Оверлей рисуется тем же контекстом и поверх строки состояния: всё дерево
    // видно целиком, включая недоступное, а причина недоступности — словами.
    drawn.length = 0;
    renderer.render(
      camera,
      new Player(spawn.x, spawn.y),
      160,
      90,
      true,
      {
        ...hud,
        research: 6,
        overlay: {
          points: 6,
          selected: 1,
          rows: [
            { name: 'Конвейерная лента', cost: 5, status: 'open', note: '' },
            { name: 'Широкий раструб', cost: 8, status: 'poor', note: 'нужно ещё 2 ✦' },
            {
              name: 'Раструб повышенной тяги',
              cost: 20,
              status: 'blocked',
              note: 'требует: Широкий раструб',
            },
            { name: 'Форсированные сопла', cost: 25, status: 'available', note: 'Предел 140' },
          ],
        },
      },
      0,
    );
    const panel = drawn.join('\n');
    check(
      'Оверлей показывает всё дерево целиком, включая недоступное, с ценами и очками',
      panel.includes('ИССЛЕДОВАНИЯ') &&
        panel.includes('6 ✦') &&
        panel.includes('Конвейерная лента') &&
        panel.includes('Раструб повышенной тяги') &&
        panel.includes('20 ✦') &&
        panel.includes('открыта'),
      panel.replace(/\n/g, ' | '),
    );
    check(
      'Причина недоступности видна словами, а не только цветом',
      panel.includes('нужно ещё 2 ✦') && panel.includes('требует: Широкий раструб'),
    );
    check(
      'Выбранная строка отмечена явно',
      panel.includes('▸ Широкий раструб') && panel.includes('  Конвейерная лента'),
      panel.replace(/\n/g, ' | '),
    );
  }
}

// --- Здания и сепаратор ---
{
  /** Мир с полом в две нижние строки: под зданием обязана быть опора. */
  function ground(width = 96, height = 96): World {
    const w = new World(width, height, first.world.profile);
    for (let y = height - 2; y < height; y++) {
      for (let x = 0; x < width; x++) w.set(x, y, MAT.ROCK);
    }
    return w;
  }
  function count(w: World, material: number): number {
    let n = 0;
    for (const c of w.cells) if (c === material) n++;
    return n;
  }
  function settle(w: World, limit: number): number {
    const sim = new Simulation();
    for (let i = 0; i < limit; i++) {
      sim.update(w, null);
      if (sim.lastCellsVisited === 0) return i + 1;
    }
    return -1;
  }
  /** Верхний левый угол здания, стоящего на полу мира высотой 96. */
  const BX = 40;
  const BY = 96 - 2 - SEPARATOR.height;

  function scene(credits: number = SEPARATOR.cost): {
    world: World;
    module: LandingModule;
    registry: BuildingRegistry;
  } {
    const w = ground();
    const module = new LandingModule({ x: 2, y: 2, w: 4, h: 4 });
    module.credits = credits;
    return { world: w, module, registry: new BuildingRegistry() };
  }

  /** Ставит сепаратор в известную точку и отдаёт его. */
  function build(
    w: World,
    registry: BuildingRegistry,
    module: LandingModule,
    x = BX,
    y = BY,
  ): 'placed' | 'demolished' | 'rejected' {
    const cx = x + (SEPARATOR_KIND.width >> 1);
    const cy = y + (SEPARATOR_KIND.height >> 1);
    return Builder.apply(w, registry, module, SEPARATOR_KIND, cx, cy, cx, cy);
  }

  /**
   * Насыпает пульпу на приёмную грань — от СЕРЕДИНЫ к краям.
   *
   * Ячейка на самом краю грани скатывается по диагонали мимо машины ещё
   * до того, как та успеет её поглотить, и порция выходит неполной.
   */
  function feed(w: World, cells: number, x = BX, y = BY): number {
    let placed = 0;
    const from = (SEPARATOR.width - Math.min(cells, SEPARATOR.width)) >> 1;
    for (let dx = from; dx < SEPARATOR.width && placed < cells; dx++) {
      if (w.get(x + dx, y - 1) !== MAT.VACUUM) continue;
      w.set(x + dx, y - 1, MAT.PULP);
      placed++;
    }
    return placed;
  }

  // --- Материалы ---

  {
    const densities = MATERIALS.filter((m) => m.id !== MAT.VACUUM);
    const heaviest = densities.reduce((a, b) => (b.density > a.density ? b : a));
    check(
      'Иридий — самое плотное вещество мира',
      heaviest.id === MAT.IRIDIUM &&
        densities.every((m) => m.id === MAT.IRIDIUM || m.density < MAT_DENSITY[MAT.IRIDIUM]!),
      `иридий ${MAT_DENSITY[MAT.IRIDIUM]}, следом ${heaviest.id === MAT.IRIDIUM ? '' : heaviest.name}` +
        ` порода ${MAT_DENSITY[MAT.ROCK]}`,
    );

    const powders = MATERIALS.filter((m) => m.state === MatterState.Powder);
    const lightest = powders.reduce((a, b) => (b.density < a.density ? b : a));
    check(
      'Шлак — самое лёгкое из сыпучих',
      lightest.id === MAT.SLAG,
      `сыпучих ${powders.length}, легчайший ${lightest.name} (${lightest.density})`,
    );

    // Ставка кредитов растёт от реголита к пульпе и обрывается на иридии:
    // переработанное платит не деньгами, а прогрессом, и «дороже» для него
    // измеряется в другой валюте.
    check(
      'Ставка кредитов растёт от реголита к пульпе, у иридия и шлака ноль',
      MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]! < MAT_CREDIT_RATE[MAT.PULP]! &&
        MAT_CREDIT_RATE[MAT.IRIDIUM] === 0 &&
        MAT_CREDIT_RATE[MAT.SLAG] === 0,
      `${MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]} → ${MAT_CREDIT_RATE[MAT.PULP]}, иридий ${MAT_CREDIT_RATE[MAT.IRIDIUM]}, шлак ${MAT_CREDIT_RATE[MAT.SLAG]}`,
    );
    check(
      'Ставка исследований ненулевая только у иридия',
      MAT_RESEARCH_RATE[MAT.IRIDIUM]! > 0 && MAT_RESEARCH_RATE[MAT.SLAG] === 0,
      `иридий ${MAT_RESEARCH_RATE[MAT.IRIDIUM]}, шлак ${MAT_RESEARCH_RATE[MAT.SLAG]}`,
    );

    const visible = [
      MAT.REGOLITH_PACKED,
      MAT.REGOLITH_LOOSE,
      MAT.PULP,
      MAT.IRIDIUM,
      MAT.SLAG,
      MAT.ICE,
      MAT.WATER,
      MAT.LAVA,
      MAT.STEAM,
      MAT.MODULE_HULL,
      MAT.SEPARATOR_HULL,
    ];
    let clashes = '';
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = MATERIALS[visible[i]!]!;
        const b = MATERIALS[visible[j]!]!;
        if (a.color === b.color) clashes += `${a.name}=${b.name} `;
      }
    }
    check('Цвета одиннадцати веществ попарно различны', clashes === '', clashes);
  }

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

  // --- Приёмная грань ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;

    const fed = feed(w, 4);
    separator.update(w, FIXED_DT);
    check(
      'Пульпа с приёмной грани уходит в накопитель, а из мира исчезает',
      fed === 4 && separator.stored === 4 && count(w, MAT.PULP) === 0,
      `насыпано ${fed}, в накопителе ${separator.stored}, в мире ${count(w, MAT.PULP)}`,
    );

    // Посторонний материал не поглощается и забивает вход.
    for (let dx = 0; dx < SEPARATOR.width; dx++) w.set(BX + dx, BY - 1, MAT.REGOLITH_LOOSE);
    const storedBefore = separator.stored;
    separator.update(w, FIXED_DT);
    check(
      'Реголит на приёмной грани остаётся и забивает вход',
      separator.stored === storedBefore && count(w, MAT.REGOLITH_LOOSE) === SEPARATOR.width,
      `накопитель ${storedBefore} → ${separator.stored}, реголита ${count(w, MAT.REGOLITH_LOOSE)}`,
    );
  }

  // --- Порция ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;

    // Неполный накопитель ждёт сколько угодно шагов.
    feed(w, SEPARATOR.batch - 1);
    for (let i = 0; i < 600; i++) separator.update(w, FIXED_DT);
    check(
      'Неполная порция не выдаётся, сколько бы шагов ни прошло',
      count(w, MAT.IRIDIUM) === 0 && count(w, MAT.SLAG) === 0 && separator.state === 'idle',
      `иридия ${count(w, MAT.IRIDIUM)}, шлака ${count(w, MAT.SLAG)}, состояние ${separator.state}`,
    );

    // Полная — ждёт задержку, а не выдаётся тем же шагом.
    feed(w, 1);
    separator.update(w, FIXED_DT);
    const sameStep = count(w, MAT.IRIDIUM) + count(w, MAT.SLAG);
    let steps = 0;
    while (count(w, MAT.IRIDIUM) === 0 && steps < 600) {
      separator.update(w, FIXED_DT);
      steps++;
    }
    const expected = Math.round(SEPARATOR.delaySec / FIXED_DT);
    check(
      'Порция выдаётся не в том же шаге, а по истечении задержки',
      sameStep === 0 && Math.abs(steps + 1 - expected) <= 1,
      `в тот же шаг ${sameStep}, шагов до выдачи ${steps + 1} при ожидаемых ${expected}`,
    );
    check(
      'Порция даёт ровно одну ячейку иридия и N−1 ячеек шлака',
      count(w, MAT.IRIDIUM) === 1 && count(w, MAT.SLAG) === SEPARATOR.batch - 1,
      `иридий ${count(w, MAT.IRIDIUM)}, шлак ${count(w, MAT.SLAG)}`,
    );

    // Продукт вышел из выпускного окна, а не сквозь корпус.
    let outsideWindow = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const m = w.get(x, y);
        if (m !== MAT.IRIDIUM && m !== MAT.SLAG) continue;
        const dx = x - BX;
        const dy = y - BY;
        if (dy !== OUTLET_ROW || dx < OUTLET_FROM || dx >= OUTLET_TO) outsideWindow++;
      }
    }
    check(
      'Продукт появился только в выпускном окне',
      outsideWindow === 0,
      `вне окна ${outsideWindow}`,
    );
  }

  // Темп машины задан игровым временем, а не числом кадров: на 144 Гц за те же
  // три секунды выходит столько же порций, сколько на 60.
  {
    function batchesIn(seconds: number, dt: number): number {
      const { world: w, module, registry } = scene(1000);
      build(w, registry, module);
      const separator = registry.all[0] as Separator;
      const steps = Math.round(seconds / dt);
      let emitted = 0;
      for (let i = 0; i < steps; i++) {
        feed(w, SEPARATOR.batch);
        separator.update(w, dt);
        // Убираем выданное, чтобы выход не забился и замер мерил темп,
        // а не длину просвета под окном.
        for (let y = BY; y < 96; y++) {
          for (let x = BX; x < BX + SEPARATOR.width; x++) {
            const m = w.get(x, y);
            if (m === MAT.IRIDIUM) {
              emitted++;
              w.set(x, y, MAT.VACUUM);
            } else if (m === MAT.SLAG) {
              w.set(x, y, MAT.VACUUM);
            }
          }
        }
      }
      return emitted;
    }
    const at60 = batchesIn(8, 1 / 60);
    const at144 = batchesIn(8, 1 / 144);
    check(
      'Темп машины не зависит от частоты кадров',
      at60 === at144 && at60 > 0,
      `на 60 Гц ${at60} порций за 8 с, на 144 Гц ${at144}`,
    );
  }

  // Машина работает сама: ни в одном её вызове персонаж не участвует, и здесь
  // это проверяется явно — во всей сцене его просто нет.
  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;
    const sim = new Simulation();
    feed(w, SEPARATOR.batch);
    for (let i = 0; i < 200; i++) {
      sim.update(w, null);
      registry.update(w, FIXED_DT);
    }
    check(
      'Машина принимает и выдаёт без игрока рядом',
      count(w, MAT.IRIDIUM) === 1 && separator.stored === 0,
      `иридия ${count(w, MAT.IRIDIUM)}, в накопителе ${separator.stored}`,
    );
  }

  // Сохранение вещества на многих порциях.
  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;
    const sim = new Simulation();

    const batches = 6;
    let absorbed = 0;
    for (let i = 0; i < 4000; i++) {
      if (absorbed < SEPARATOR.batch * batches)
        absorbed += feed(w, SEPARATOR.batch * batches - absorbed);
      sim.update(w, null);
      separator.update(w, FIXED_DT);
    }
    settle(w, 2000);
    const out = count(w, MAT.IRIDIUM) + count(w, MAT.SLAG);
    const inside = separator.drain().length;
    check(
      'Сумма выданного и оставшегося внутри равна сумме поглощённого',
      out + inside + count(w, MAT.PULP) === absorbed,
      `поглощено ${absorbed}, выдано ${out}, внутри ${inside}, на грани ${count(w, MAT.PULP)}`,
    );
    check(
      'Иридия ровно по одной ячейке на выданную порцию',
      count(w, MAT.IRIDIUM) === count(w, MAT.SLAG) / (SEPARATOR.batch - 1),
      `иридий ${count(w, MAT.IRIDIUM)}, шлак ${count(w, MAT.SLAG)}`,
    );
  }

  // --- Забитый выход ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;

    // Забиваем окно доверху породой: выйти порции некуда.
    for (let dy = OUTLET_ROW; dy < SEPARATOR.height; dy++) {
      for (let dx = OUTLET_FROM; dx < OUTLET_TO; dx++) w.set(BX + dx, BY + dy, MAT.ROCK);
    }

    feed(w, SEPARATOR.batch);
    for (let i = 0; i < 400; i++) separator.update(w, FIXED_DT);
    check(
      'Забитый выход останавливает машину, и порция не пропадает',
      separator.state === 'blocked' &&
        count(w, MAT.IRIDIUM) === 0 &&
        count(w, MAT.SLAG) === 0 &&
        separator.drain().length === SEPARATOR.batch,
      `состояние ${separator.state}, внутри ${separator.drain().length}`,
    );

    // Накопитель принимает до предела и дальше не растёт.
    const limit = SEPARATOR.batch * SEPARATOR.bufferBatches;
    let leftOnFace = 0;
    for (let round = 0; round < 20; round++) {
      feed(w, SEPARATOR.width);
      separator.update(w, FIXED_DT);
    }
    leftOnFace = count(w, MAT.PULP);
    check(
      'Переполненный накопитель перестаёт принимать, пульпа остаётся на грани',
      separator.stored === limit && leftOnFace > 0,
      `накопитель ${separator.stored} при пределе ${limit}, на грани ${leftOnFace}`,
    );

    // Освобождение выхода возобновляет работу с того же состояния.
    for (let dy = OUTLET_ROW; dy < SEPARATOR.height; dy++) {
      for (let dx = OUTLET_FROM; dx < OUTLET_TO; dx++) w.set(BX + dx, BY + dy, MAT.VACUUM);
    }
    separator.update(w, FIXED_DT);
    check(
      'Освобождение выхода выдаёт задержанную порцию',
      count(w, MAT.IRIDIUM) === 1 && count(w, MAT.SLAG) === SEPARATOR.batch - 1,
      `иридий ${count(w, MAT.IRIDIUM)}, шлак ${count(w, MAT.SLAG)}`,
    );
  }

  // --- Расслоение продуктов ---

  {
    const w = ground();
    // Перемешанная куча: иридий сверху, шлак снизу — заведомо «неправильно».
    for (let x = 40; x < 56; x++) {
      for (let y = 80; y < 86; y++) w.set(x, y, y < 83 ? MAT.IRIDIUM : MAT.SLAG);
    }
    const iridium = count(w, MAT.IRIDIUM);
    const slag = count(w, MAT.SLAG);
    settle(w, 4000);

    let sumIridiumY = 0;
    let sumSlagY = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        if (w.get(x, y) === MAT.IRIDIUM) sumIridiumY += y;
        if (w.get(x, y) === MAT.SLAG) sumSlagY += y;
      }
    }
    check(
      'Иридий тонет в шлаке: перемешанная куча расслаивается',
      sumIridiumY / iridium > sumSlagY / slag &&
        count(w, MAT.IRIDIUM) === iridium &&
        count(w, MAT.SLAG) === slag,
      `центр иридия ${(sumIridiumY / iridium).toFixed(1)}, центр шлака ${(sumSlagY / slag).toFixed(1)}`,
    );
  }

  // --- Экономика ---

  {
    // Окупаемость машины меряется ПРОГРЕССОМ, а не кредитами. По деньгам она
    // всегда в убытке — иридий не приносит ни одного, — и в этом её роль:
    // сепаратор превращает сырьё в то, чего за деньги не купить.
    const directCredits = SEPARATOR.batch * MAT_CREDIT_RATE[MAT.PULP]!;
    const processedCredits =
      MAT_CREDIT_RATE[MAT.IRIDIUM]! + (SEPARATOR.batch - 1) * MAT_CREDIT_RATE[MAT.SLAG]!;
    const processedPoints =
      MAT_RESEARCH_RATE[MAT.IRIDIUM]! + (SEPARATOR.batch - 1) * MAT_RESEARCH_RATE[MAT.SLAG]!;
    check(
      'Переработка даёт то, чего прямая сдача не даёт ни в каком количестве',
      processedPoints > 0 && directCredits > 0 && processedCredits === 0,
      `напрямую ${directCredits} ₡ и 0 ✦, через сепаратор ${processedCredits} ₡ и ${processedPoints} ✦`,
    );
    // Цена машины в кредитах и цена первой технологии в очках согласованы так,
    // чтобы первое открытие наступало за обозримое число порций: иначе игрок,
    // потративший 250 ₡, читает машину как тупик, а не как ступень.
    {
      const firstCost = Math.min(...TECHNOLOGIES.map((t) => t.cost));
      check(
        'Первая технология достижима за обозримое число порций',
        processedPoints > 0 && firstCost / processedPoints <= 10,
        `${(firstCost / processedPoints).toFixed(1)} порций до первой технологии`,
      );
    }

    // Приёмник принимает иридий очками и не принимает шлак вовсе.
    const w = ground();
    const zone = { x: 40, y: 40, w: 6, h: 4 };
    const module = new LandingModule(zone);
    for (let x = zone.x; x < zone.x + 3; x++) w.set(x, zone.y, MAT.IRIDIUM);
    for (let x = zone.x + 3; x < zone.x + 6; x++) w.set(x, zone.y, MAT.SLAG);
    const earned = module.update(w);
    check(
      'Приёмник принимает иридий очками, кредитов не даёт, шлак не принимает',
      earned.research === 3 * MAT_RESEARCH_RATE[MAT.IRIDIUM]! &&
        earned.credits === 0 &&
        module.credits === 0 &&
        module.research.points === earned.research &&
        count(w, MAT.IRIDIUM) === 0 &&
        count(w, MAT.SLAG) === 3,
      `начислено ${earned.credits} ₡ и ${earned.research} ✦, иридия осталось ${count(w, MAT.IRIDIUM)}, шлака ${count(w, MAT.SLAG)}`,
    );
  }

  // Счёт не уходит в минус на длинной последовательности покупок и сносов.
  {
    const { world: w, module, registry } = scene(SEPARATOR.cost);
    let negative = false;
    let placed = 0;
    let demolished = 0;
    for (let i = 0; i < 200; i++) {
      const r = build(w, registry, module);
      if (r === 'placed') placed++;
      if (r === 'demolished') demolished++;
      if (module.credits < 0) negative = true;
    }
    check(
      'Счёт кредитов ни разу не ушёл в минус на длинной последовательности',
      !negative && module.credits >= 0 && placed > 0 && demolished > 0,
      `постановок ${placed}, сносов ${demolished}, счёт ${module.credits}`,
    );

    // Отдельно: покупка при нехватке отвергается целиком.
    module.credits = SEPARATOR.cost - 1;
    while (registry.count > 0) Builder.demolish(w, registry, module, registry.all[0]!);
    const before = module.credits;
    module.credits = SEPARATOR.cost - 1;
    build(w, registry, module);
    check(
      'Нехватка средств отвергает покупку целиком',
      registry.count === 0 && module.credits === SEPARATOR.cost - 1,
      `зданий ${registry.count}, счёт ${before} → ${module.credits}`,
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
    inv.add(MAT.PULP, 10);
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
    const py = 96 - 2 - Math.ceil(PLAYER.hitboxH / 2);

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
    const pixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
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

    renderer.render(
      camera,
      new Player(spawn.x, spawn.y),
      160,
      90,
      true,
      hud({ ghost: { ...rect, ok: true } }),
      0,
    );
    const okPixels = countPixels(MACHINE_STATE_COLORS.working);

    renderer.render(
      camera,
      new Player(spawn.x, spawn.y),
      160,
      90,
      true,
      hud({ ghost: { ...rect, ok: false } }),
      0,
    );
    const badPixels = countPixels(MACHINE_STATE_COLORS.blocked);

    const perimeter = 2 * SEPARATOR.width + 2 * (SEPARATOR.height - 2);
    check(
      'Контур будущего здания рисуется периметром и меняет цвет по годности',
      okPixels === perimeter && badPixels === perimeter,
      `годный ${okPixels}, негодный ${badPixels} при периметре ${perimeter}`,
    );

    // Состояние машины видно НА САМОЙ машине, а не только в строке состояния.
    const machine = { ...rect, progress: 0.5 } as const;
    renderer.render(
      camera,
      new Player(spawn.x, spawn.y),
      160,
      90,
      true,
      hud({ machines: [{ ...machine, state: 'working' }] }),
      0,
    );
    const working = countPixels(MACHINE_STATE_COLORS.working);
    renderer.render(
      camera,
      new Player(spawn.x, spawn.y),
      160,
      90,
      true,
      hud({ machines: [{ ...machine, state: 'blocked' }] }),
      0,
    );
    const blocked = countPixels(MACHINE_STATE_COLORS.blocked);
    renderer.render(
      camera,
      new Player(spawn.x, spawn.y),
      160,
      90,
      true,
      hud({ machines: [{ ...machine, state: 'idle' }] }),
      0,
    );
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

  const SZ = CONVEYOR.size;
  /** Координаты клетки сетки секций, свободной от пола в песочнице. */
  const SECTION_X0 = 20;
  const SECTION_Y = 28;

  /** Ставит секцию, целясь в её левый верхний угол. */
  function lay(
    w: World,
    registry: BuildingRegistry,
    module: LandingModule,
    kind: typeof CONVEYOR_RIGHT_KIND,
    x: number,
    y: number,
  ): 'placed' | 'demolished' | 'rejected' {
    return Builder.apply(w, registry, module, kind, x, y, x, y, UNLOCKED);
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
  // показывает бегущая полоса, а не оттенок — иначе игрок был бы обязан
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
      'Бегущая полоса — вторая ступень той же лестницы, а не чей-то чужой цвет',
      CONVEYOR_STRIPE_COLOR !== beltColor &&
        !MATERIALS.some((m) => m.id !== MAT.VACUUM && m.color === CONVEYOR_STRIPE_COLOR),
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
    // Куча поверх ленты: подошва лежит на ленте, верхний слой — на подошве,
    // и ленты под ним нет. Он обязан вести себя как обычное сыпучее.
    const w = sandbox();
    belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
    w.set(51, 39, MAT.ROCK);
    w.set(50, 39, MAT.PULP);
    w.set(50, 38, MAT.REGOLITH_LOOSE);
    run(w, 60);
    check(
      'На куче поверх ленты подошва стоит на месте, а верхний слой скатывается по диагонали',
      w.get(50, 39) === MAT.PULP && w.get(49, 39) === MAT.REGOLITH_LOOSE,
      `подошва ${MATERIALS[w.get(50, 39)]!.name}, верх на (49,39) ${MATERIALS[w.get(49, 39)]!.name}`,
    );
  }

  {
    // Верхний слой не едет вместе с подошвой: перенос читается из ячейки ПОД
    // грузом, а под ним лежит не лента, а такое же сыпучее.
    const w = sandbox();
    belt(w, 40, 10, 110, MAT.CONVEYOR_RIGHT);
    w.set(50, 39, MAT.REGOLITH_LOOSE);
    w.set(50, 38, MAT.PULP);
    run(w, 1);
    check(
      'Едет только подошва: верхний слой по горизонтали не сместился',
      w.get(51, 39) === MAT.REGOLITH_LOOSE && w.get(50, 39) === MAT.PULP,
      `подошва на (51,39) ${MATERIALS[w.get(51, 39)]!.name}`,
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
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    const registry = new BuildingRegistry();
    // Ряд ленты кратен размеру секции: выравнивание касается обеих осей,
    // и произвольная строка притянулась бы к ближайшей клетке сетки.
    const y0 = 56;
    const cargoRow = y0 - 1;
    const gapAt = 60;
    module.credits = CONVEYOR.sectionCost * 100;
    for (let x = 12; x < 100; x += SZ) {
      if (x !== gapAt) lay(w, registry, module, CONVEYOR_RIGHT_KIND, x, y0);
    }
    for (let i = 0; i < 4; i++) w.set(16 + i * 3, cargoRow, MAT.REGOLITH_LOOSE);
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
    const placed = lay(w, registry, module, CONVEYOR_RIGHT_KIND, gapAt, y0);
    const fresh = 3;
    for (let i = 0; i < fresh; i++) w.set(20 + i * 3, cargoRow, MAT.REGOLITH_LOOSE);

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
      'Конвейер влево и вправо — отдельные виды каталога, а не поворот выбранного',
      BUILD_CATALOG.includes(CONVEYOR_LEFT_KIND) &&
        BUILD_CATALOG.includes(CONVEYOR_RIGHT_KIND) &&
        CONVEYOR_LEFT_KIND.hull !== CONVEYOR_RIGHT_KIND.hull,
    );
    check(
      'Пиксельная постройка не заводит записи в реестре, машина заводит',
      CONVEYOR_LEFT_KIND.create === null &&
        CONVEYOR_RIGHT_KIND.create === null &&
        SEPARATOR_KIND.create !== null,
    );
    check(
      'Опора — свойство вида: машине обязательна, ленте нет',
      SEPARATOR_KIND.needsSupport &&
        !CONVEYOR_LEFT_KIND.needsSupport &&
        !CONVEYOR_RIGHT_KIND.needsSupport,
    );
    check(
      'Цена ячейки ленты живёт в конфиге и попадает в каталог',
      CONVEYOR_LEFT_KIND.cost === CONVEYOR.sectionCost &&
        CONVEYOR_RIGHT_KIND.cost === CONVEYOR.sectionCost,
      `${CONVEYOR.sectionCost} ₡ за ячейку`,
    );
    check(
      'Секция квадратная и равна заданному размеру',
      CONVEYOR_LEFT_KIND.width === CONVEYOR.size &&
        CONVEYOR_LEFT_KIND.height === CONVEYOR.size &&
        CONVEYOR_LEFT_KIND.grid === CONVEYOR.size,
      `${CONVEYOR_LEFT_KIND.width}×${CONVEYOR_LEFT_KIND.height}, сетка ${CONVEYOR_LEFT_KIND.grid}`,
    );
    check('У машины сетки нет: она центрируется на цели', SEPARATOR_KIND.grid === 0);

    // Контур машины симметричен вокруг прицела: у чётной стороны середины нет,
    // и рамка садилась бы на прицел косо.
    {
      const at = Builder.originFor(SEPARATOR_KIND, 100, 100);
      const left = 100 - at.x;
      const right = at.x + SEPARATOR_KIND.width - 1 - 100;
      const up = 100 - at.y;
      const down = at.y + SEPARATOR_KIND.height - 1 - 100;
      check(
        'Контур машины симметричен вокруг прицела и квадратен',
        left === right && up === down && SEPARATOR_KIND.width === SEPARATOR_KIND.height,
        `слева ${left}/справа ${right}, сверху ${up}/снизу ${down}, ` +
          `${SEPARATOR_KIND.width}×${SEPARATOR_KIND.height}`,
      );
      check(
        'Ноги машины по бокам окна одинаковой ширины',
        OUTLET_FROM === SEPARATOR.width - OUTLET_TO,
        `слева ${OUTLET_FROM}, справа ${SEPARATOR.width - OUTLET_TO}`,
      );
      check(
        'Выпускное окно шире порции: выдача не впритык',
        OUTLET_TO - OUTLET_FROM > SEPARATOR.batch,
        `окно ${OUTLET_TO - OUTLET_FROM}, порция ${SEPARATOR.batch}`,
      );
    }

    // Боковой клавиатурный прицел ставит постройку на уровень ступней.
    // Без этого корпус выше девяти ячеек уходит нижним рядом под землю.
    {
      const playerY = 40;
      const y = Builder.groundedTargetY(SEPARATOR_KIND, playerY, PLAYER.hitboxH);
      const at = Builder.originFor(SEPARATOR_KIND, 100, y);
      const bottom = at.y + SEPARATOR_KIND.height - 1;
      check(
        'Боковая клавиатурная цель ставит низ постройки на уровень ступней',
        bottom === playerY + PLAYER.hitboxH - 1,
        `низ корпуса ${bottom}, ступни ${playerY + PLAYER.hitboxH - 1}`,
      );
    }
    // Единственный след секционной постройки в мире — ячейки сетки, и снос
    // спрашивает о ней сетку. Обратный поиск обязан знать оба конвейера
    // и не считать постройкой ни породу, ни корпус машины.
    check(
      'Секционная постройка узнаётся по материалу корпуса, и только она',
      sectionKindByHull(MAT.CONVEYOR_LEFT) === CONVEYOR_LEFT_KIND &&
        sectionKindByHull(MAT.CONVEYOR_RIGHT) === CONVEYOR_RIGHT_KIND &&
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
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    module.credits = CONVEYOR.sectionCost * 10;
    const registry = new BuildingRegistry();
    for (let i = 0; i < 6; i++) lay(w, registry, module, CONVEYOR_RIGHT_KIND, 20 + i * SZ, 32);
    w.set(21, 31, MAT.REGOLITH_LOOSE);
    run(w, STEP * 10);
    const at = findOne(w, MAT.REGOLITH_LOOSE);
    check(
      'Груз едет по верхнему ряду секции, а не внутри неё',
      at !== null && at.y === 31 && at.x === 31,
      at ? `(${at.x},${at.y})` : 'потерялся',
    );
  }

  // Замуровать больше нечем: постройка ставится и поверх персонажа.
  {
    const w = sandbox();
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    module.credits = CONVEYOR.sectionCost;
    const registry = new BuildingRegistry();
    const occupant: Occupant = { x: 20, y: 30, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
    const on = lay(w, registry, module, CONVEYOR_RIGHT_KIND, occupant.x + 1, occupant.y + 1);
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
      Builder.issueAt(w, CONVEYOR_RIGHT_KIND, 50, 20, 1000, UNLOCKED) === null &&
        Builder.issueAt(w, SEPARATOR_KIND, 50, 20, 1000, UNLOCKED) === 'unsupported',
    );
  }

  {
    const w = sandbox();
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    const registry = new BuildingRegistry();
    const sections = 8;
    module.credits = CONVEYOR.sectionCost * sections;

    let laid = 0;
    for (let i = 0; i < sections; i++) {
      const x = SECTION_X0 + i * SZ;
      if (lay(w, registry, module, CONVEYOR_RIGHT_KIND, x, SECTION_Y) === 'placed') laid++;
    }
    check(
      'Лента из N секций списывает ровно N цен секции',
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

    const beyond = SECTION_X0 + sections * SZ;
    const denied = lay(w, registry, module, CONVEYOR_RIGHT_KIND, beyond, SECTION_Y);
    check(
      'При нехватке средств постановка отвергается целиком и счёт не уходит в минус',
      denied === 'rejected' && module.credits === 0 && w.get(beyond, SECTION_Y) === MAT.VACUUM,
      `${denied}, на счету ${module.credits}`,
    );

    // Цель притягивается к клетке: куда именно внутри неё игрок целился,
    // на результат не влияет.
    {
      const w2 = sandbox();
      const m2 = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
      m2.credits = CONVEYOR.sectionCost * 4;
      const r2 = new BuildingRegistry();
      const corners = [
        [SECTION_X0, SECTION_Y],
        [SECTION_X0 + SZ - 1, SECTION_Y],
        [SECTION_X0, SECTION_Y + SZ - 1],
        [SECTION_X0 + SZ - 1, SECTION_Y + SZ - 1],
      ];
      const results = corners.map(([tx, ty]) =>
        Builder.apply(w2, r2, m2, CONVEYOR_RIGHT_KIND, tx!, ty!, tx!, ty!, UNLOCKED),
      );
      check(
        'Секция встаёт по сетке: прицел в любую точку клетки даёт одно и то же место',
        results[0] === 'placed' &&
          results.slice(1).every((r, i) => r === (i % 2 === 0 ? 'demolished' : 'placed')) &&
          m2.credits === CONVEYOR.sectionCost * 4,
        results.join(', '),
      );
    }
  }

  {
    const w = sandbox();
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    const registry = new BuildingRegistry();
    // Три секции подряд; сносим среднюю.
    module.credits = CONVEYOR.sectionCost * 3;
    for (let i = 0; i < 3; i++) {
      lay(w, registry, module, CONVEYOR_LEFT_KIND, SECTION_X0 + i * SZ, SECTION_Y);
    }
    const mid = SECTION_X0 + SZ;
    // Груз лежит на верхнем ряду сносимой секции.
    w.set(mid + 1, SECTION_Y - 1, MAT.REGOLITH_LOOSE);

    // Вид, выбранный в каталоге, на снос не влияет: цель либо попала
    // в постройку, либо нет.
    const razed = Builder.apply(
      w,
      registry,
      module,
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
      'Снос секции ленты возвращает цену секции, не трогает соседние и не роняет груз',
      razed === 'demolished' &&
        module.credits === CONVEYOR.sectionCost &&
        midCells === 0 &&
        w.get(SECTION_X0, SECTION_Y) === MAT.CONVEYOR_LEFT &&
        w.get(mid + SZ, SECTION_Y) === MAT.CONVEYOR_LEFT &&
        w.get(mid + 1, SECTION_Y - 1) === MAT.REGOLITH_LOOSE,
      `${razed}, возврат ${module.credits}, осталось в секции ${midCells}`,
    );

    const other = Builder.apply(
      w,
      registry,
      module,
      CONVEYOR_RIGHT_KIND,
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
    const pixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
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
      image: {},
      present() {},
    } as unknown as Display;

    const w = new World(400, 240, first.world.profile);
    const surface = new Int16Array(400);
    for (let x = 10; x < 300; x++) {
      w.set(x, 100, MAT.CONVEYOR_RIGHT);
      w.set(x, 120, MAT.CONVEYOR_LEFT);
    }
    const renderer = new Renderer(display, w, surface, WORLD_SEED);
    const camera = new Camera(400, 240);
    camera.snapTo(160, 120);
    const rowRight = 100 - camera.y;
    const rowLeft = 120 - camera.y;

    const stripeR = (CONVEYOR_STRIPE_COLOR >> 16) & 0xff;
    const stripeG = (CONVEYOR_STRIPE_COLOR >> 8) & 0xff;
    const stripeB = CONVEYOR_STRIPE_COLOR & 0xff;

    function pattern(row: number): boolean[] {
      const out: boolean[] = [];
      for (let sx = 0; sx < VIEW_W; sx++) {
        const i = (row * VIEW_W + sx) * 4;
        out.push(pixels[i] === stripeR && pixels[i + 1] === stripeG && pixels[i + 2] === stripeB);
      }
      return out;
    }

    const frame = (time: number): void => {
      renderer.render(camera, new Player(160, 220), 0, 0, true, IDLE_HUD, 0, time);
    };

    frame(0);
    const right0 = pattern(rowRight);
    const left0 = pattern(rowLeft);
    const bodyColor = MATERIALS[MAT.CONVEYOR_RIGHT]!.color;
    let body = 0;
    for (let sx = 20; sx < 150; sx++) {
      const i = (rowRight * VIEW_W + sx) * 4;
      if (pixels[i] === ((bodyColor >> 16) & 0xff)) body++;
    }
    const stripes = right0.slice(20, 150).filter(Boolean).length;
    check(
      'Полоса рисуется на ячейках с ненулевым переносом: есть и штрих, и корпус',
      stripes > 0 && body > 0 && stripes + body === 130,
      `штрих ${stripes}, корпус ${body} из 130`,
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
      'Полоса бежит в сторону переноса своей ленты, а виды окрашены одинаково',
      rightOk && leftOk,
      `вправо ${rightOk}, влево ${leftOk}`,
    );

    const steps = STEP * 9;
    check(
      'Скорость бегущей полосы совпадает со скоростью переноса',
      stripeOffset(steps / SIM_HZ) === rideDistance(MAT.CONVEYOR_RIGHT, MAT.REGOLITH_LOOSE, steps),
      `полоса ${stripeOffset(steps / SIM_HZ)}, груз ${rideDistance(MAT.CONVEYOR_RIGHT, MAT.REGOLITH_LOOSE, steps)}`,
    );
  }

  // --- Лента как связь между зданиями ---

  {
    // Лента кормит машину: приёмная грань уже описана как срабатывающая
    // на любое попадание, и нового правила поглощения не понадобилось.
    const w = sandbox(160, 96);
    const registry = new BuildingRegistry();
    const module = new LandingModule({ x: 2, y: 2, w: 4, h: 4 });
    module.credits = SEPARATOR.cost;
    const bx = 80;
    const by = 96 - 2 - SEPARATOR.height;
    const cx = bx + (SEPARATOR_KIND.width >> 1);
    const cy = by + (SEPARATOR_KIND.height >> 1);
    Builder.apply(w, registry, module, SEPARATOR_KIND, cx, cy, cx, cy);
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
      if (module.update(w).research > 0 && earnedAt < 0) earnedAt = i;
    }
    let slagInZone = 0;
    for (let y = receiver.y; y < receiver.y + receiver.h; y++) {
      for (let x = receiver.x; x < receiver.x + receiver.w; x++) {
        if (w.get(x, y) === MAT.SLAG) slagInZone++;
      }
    }
    check(
      'Лента доносит иридий до зоны приёмника, очки начисляются без действий игрока',
      module.research.points === MAT_RESEARCH_RATE[MAT.IRIDIUM] &&
        module.credits === 0 &&
        count(w, MAT.IRIDIUM) === 0,
      `${module.research.points} ✦ на шаге ${earnedAt}`,
    );
    check(
      'Шлак доезжает вместе с иридием и остаётся лежать в зоне приёмника',
      count(w, MAT.SLAG) === 1 && slagInZone === 1,
      `шлака в мире ${count(w, MAT.SLAG)}, в зоне ${slagInZone}`,
    );
  }

  {
    // Сквозной прогон: машина выдаёт продукт, он падает на ленту ПОД ней
    // и уезжает к приёмнику. Внутрь выпускного окна секция 4×4 не помещается —
    // окно шириной 6, и выровненный квадрат попадает туда лишь при совпадении
    // координат, — поэтому лента идёт под машиной, а машина стоит на пьедестале.
    //
    //   ▓▓▓▓▓▓▓▓▓▓▓▓        пульпа на приёмной грани
    //   ▓░░░░░░░░░░▓
    //   ▓▓▓      ▓▓▓        выпускное окно
    //   ═══      ░░░        пьедестал под левой ногой, справа проход
    //   ▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶  лента идёт под машиной к приёмнику
    const w = sandbox(220, 96);
    const registry = new BuildingRegistry();
    const module = new LandingModule({ x: 186, y: 84, w: 10, h: 8 });
    module.credits = SEPARATOR.cost + CONVEYOR.sectionCost * 100;

    // Лента: секции по сетке, верхний ряд 88, груз едет по строке 87.
    const beltTop = 88;
    for (let x = 28; x <= 192; x += SZ) lay(w, registry, module, CONVEYOR_RIGHT_KIND, x, beltTop);
    // Упор в конце: очередь встаёт внутри зоны приёмника, а не сыплется мимо.
    w.set(196, 87, MAT.ROCK);
    w.set(196, 86, MAT.ROCK);

    // Машина: её ноги кончаются на ряд ВЫШЕ строки груза, иначе продукт упёрся
    // бы в собственную ногу и никуда не поехал.
    const bx = 40;
    const by = beltTop - 1 - SEPARATOR.height;
    for (let dx = 0; dx < 3; dx++) w.set(bx + dx, by + SEPARATOR.height, MAT.ROCK);
    const cx = bx + (SEPARATOR_KIND.width >> 1);
    const cy = by + (SEPARATOR_KIND.height >> 1);
    const built = Builder.apply(w, registry, module, SEPARATOR_KIND, cx, cy, cx, cy);
    for (let i = 0; i < SEPARATOR.batch; i++) w.set(bx + 3 + i, by - 1, MAT.PULP);

    const before = module.research.points;
    const sim = new Simulation();
    let earnedAt = -1;
    for (let i = 0; i < STEP * 400; i++) {
      sim.update(w, null);
      registry.update(w, FIXED_DT);
      if (module.update(w).research > 0 && earnedAt < 0) earnedAt = i;
    }
    let slagInZone = 0;
    for (let y = 84; y < 92; y++) {
      for (let x = 186; x < 196; x++) if (w.get(x, y) === MAT.SLAG) slagInZone++;
    }
    check(
      'Сквозной прогон: продукт выходит на ленту под машиной и доезжает до модуля',
      built === 'placed' &&
        module.research.points - before === MAT_RESEARCH_RATE[MAT.IRIDIUM]! &&
        count(w, MAT.IRIDIUM) === 0 &&
        slagInZone === SEPARATOR.batch - 1,
      `${built}, начислено ${module.research.points - before} ✦, шлака в зоне ${slagInZone}`,
    );
    // Замер: сколько занимает доставка от выпускного окна до приёмника.
    check(
      'Доставка от выпускного окна до приёмника укладывается в разумное время',
      earnedAt > 0 && earnedAt < STEP * 400,
      `${(earnedAt / SIM_HZ).toFixed(1)} с на ${192 - bx} ячеек ленты`,
    );
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
    const H = 84;
    const w = new World(200, H, first.world.profile);
    // Пол кратен размеру секции: врезанная в него лента ложится ровно так,
    // что её верхний ряд совпадает с подошвой кучи.
    const floorTop = 80;
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
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    const registry = new BuildingRegistry();
    module.credits = CONVEYOR.sectionCost * 100;
    let laid = 0;
    for (let x = beltFrom; x <= 188; x += SZ) {
      for (let y = floorTop; y < floorTop + SZ; y++) {
        for (let dx = 0; dx < SZ; dx++) w.set(x + dx, y, MAT.VACUUM);
      }
      if (lay(w, registry, module, CONVEYOR_RIGHT_KIND, x, floorTop) === 'placed') laid++;
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

// --- Снапшот ввода ---
//
// `Input` вешает слушатели на `window` и `document`, и до сих пор это означало,
// что раскладка не проверяется вовсе: без DOM класс нельзя было даже создать.
// Заглушка нужна ровно на две функции — «запомни обработчик» и «позови его», —
// после чего проверяется настоящий класс, а не его пересказ.
{
  type Listener = (event: never) => void;
  class FakeTarget {
    private readonly listeners = new Map<string, Listener[]>();
    addEventListener(type: string, fn: Listener): void {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type: string, event: Record<string, unknown>): void {
      for (const fn of this.listeners.get(type) ?? []) fn(event as never);
    }
  }

  /** Событие клавиши с учётом того, отменил ли его обработчик. */
  function keyEvent(code: string): {
    code: string;
    repeat: boolean;
    prevented: boolean;
    preventDefault(): void;
  } {
    return {
      code,
      repeat: false,
      prevented: false,
      preventDefault(): void {
        this.prevented = true;
      },
    };
  }

  const win = new FakeTarget();
  const doc = new FakeTarget();
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedWindow = globals.window;
  const savedDocument = globals.document;
  globals.window = win;
  globals.document = Object.assign(doc, { hidden: false });

  const display = {
    clientToBuffer: (x: number, y: number) => ({ x: x / 2, y: y / 2 }),
  } as unknown as import('../src/core/display').Display;
  const input = new Input(display);

  globals.window = savedWindow;
  globals.document = savedDocument;

  const down = (code: string) => {
    const e = keyEvent(code);
    win.emit('keydown', e);
    return e;
  };
  const up = (code: string) => {
    const e = keyEvent(code);
    win.emit('keyup', e);
    return e;
  };

  // Первое действие игрока: до него признак ложен.
  check('Ввод: до первого нажатия признак взаимодействия ложен', !input.hasInteracted);

  // Одиночное нажатие читается один раз, удержание — на всех шагах.
  {
    down('KeyW');
    let pressedSteps = 0;
    let heldSteps = 0;
    for (let i = 0; i < 10; i++) {
      if (input.jumpPressed) pressedSteps++;
      if (input.jumpHeld) heldSteps++;
      input.endStep();
    }
    up('KeyW');
    check(
      'Ввод: одиночное нажатие истинно ровно на одном шаге, удержание — на всех десяти',
      pressedSteps === 1 && heldSteps === 10,
      `нажата ${pressedSteps}, удерживается ${heldSteps}`,
    );
    check('Ввод: первое нажатие включило признак взаимодействия', input.hasInteracted);
  }

  // Прыжок с обеих половин раскладки, и `Space` к нему отношения не имеет.
  {
    down('ArrowUp');
    const byArrow = input.jumpPressed;
    up('ArrowUp');
    input.endStep();
    const space = down('Space');
    const jumpedBySpace = input.jumpPressed;
    const toolBySpace = input.toolHeld;
    up('Space');
    input.endStep();
    check('Ввод: прыжок работает и со стрелки', byArrow);
    check(
      'Ввод: пробел применяет инструмент, а не прыгает',
      !jumpedBySpace && toolBySpace,
      `прыжок ${jumpedBySpace}, инструмент ${toolBySpace}`,
    );
    check('Ввод: пробел подавляет прокрутку страницы', space.prevented);
  }

  // Каждая новая кнопка мыши имеет клавишу, и все три подавляют прокрутку.
  {
    const r = down('KeyR');
    const modeByKey = input.toolModePressed;
    up('KeyR');
    input.endStep();

    const f = down('KeyF');
    const dumpByKey = input.dumpHeld;
    up('KeyF');
    input.endStep();

    const c = down('KeyC');
    const cycleByKey = input.cycleCarriedPressed;
    up('KeyC');
    input.endStep();

    check(
      'Ввод: режим, высыпание и выбор вещества доступны с клавиатуры',
      modeByKey && dumpByKey && cycleByKey,
      `R ${modeByKey}, F ${dumpByKey}, C ${cycleByKey}`,
    );
    check('Ввод: новые клавиши подавляют прокрутку', r.prevented && f.prevented && c.prevented);
  }

  // Вид постройки живёт на СВОЕЙ клавише. Отбирать `C` на время строительства
  // нечем оправдать: высыпание доступно в любом режиме, и клавиша, означающая
  // в одном режиме одно, а в другом другое, — это ошибка на каждом переключении.
  {
    const x = down('KeyX');
    const kindByKey = input.buildKindPressed;
    const carriedUntouched = !input.cycleCarriedPressed;
    up('KeyX');
    input.endStep();

    down('KeyC');
    const carriedByKey = input.cycleCarriedPressed;
    const kindUntouched = !input.buildKindPressed;
    up('KeyC');
    input.endStep();

    check(
      'Ввод: вид постройки перебирается своей клавишей, а `C` остаётся за веществом',
      kindByKey && carriedUntouched && carriedByKey && kindUntouched && x.prevented,
      `X ${kindByKey}, C ${carriedByKey}`,
    );
  }

  // Оверлей исследований: одна клавиша на открыть и закрыть, и та же клавиша
  // забрана у браузера наравне с остальными игровыми.
  {
    const t = down('KeyT');
    const byKey = input.researchTogglePressed;
    const nothingElse =
      !input.buildKindPressed && !input.toolModePressed && !input.cycleCarriedPressed;
    up('KeyT');
    input.endStep();
    check(
      'Ввод: оверлей исследований живёт на своей клавише и подавляет прокрутку',
      byKey && nothingElse && t.prevented,
    );

    // Одноразовое состояние: удержание не переключает оверлей каждый шаг.
    down('KeyT');
    const firstStep = input.researchTogglePressed;
    input.endStep();
    const secondStep = input.researchTogglePressed;
    up('KeyT');
    input.endStep();
    check(
      'Ввод: клавиша оверлея читается ровно один шаг, а не каждый кадр удержания',
      firstStep && !secondStep,
    );
  }

  // Открытие оверлея сбрасывает удерживаемое ТЕМ ЖЕ механизмом, что и потеря
  // фокуса окном: клавиша, зажатая в момент открытия, иначе оставляет
  // персонажа бегущим всё время, пока игрок читает дерево.
  {
    down('KeyD');
    down('Space');
    const runningBefore = input.moveAxis === 1 && input.toolHeld;
    input.endStep();

    input.releaseAll();
    const stopped = input.moveAxis === 0 && !input.toolHeld && !input.mouseLeftHeld;
    input.endStep();

    check(
      'Ввод: сброс удерживаемого снимает и клавиши, и кнопки мыши',
      runningBefore && stopped,
      `до сброса бег ${runningBefore}, после ${input.moveAxis}`,
    );
    up('KeyD');
    up('Space');
    input.endStep();
  }

  // Не игровая клавиша остаётся браузеру.
  {
    const e = down('KeyZ');
    up('KeyZ');
    input.endStep();
    check('Ввод: посторонняя клавиша странице не мешает', !e.prevented);
  }

  // Отключение звука — одноразовое состояние.
  {
    down('KeyM');
    const first1 = input.muteTogglePressed;
    input.endStep();
    const second = input.muteTogglePressed;
    up('KeyM');
    input.endStep();
    check('Ввод: переключение звука истинно ровно на одном шаге', first1 && !second);
  }

  // Правая кнопка: удерживаемое состояние и никакого контекстного меню.
  {
    let prevented = false;
    win.emit('contextmenu', {
      preventDefault: () => {
        prevented = true;
      },
    });
    win.emit('mousedown', { button: 2 });
    const heldRight = input.mouseRightHeld;
    const heldLeft = input.mouseLeftHeld;
    const dumpByMouse = input.dumpHeld;
    win.emit('mouseup', { button: 2 });
    check(
      'Ввод: правая кнопка удерживается и не открывает меню браузера',
      prevented && heldRight && !heldLeft && dumpByMouse && !input.mouseRightHeld,
      `меню отменено ${prevented}, удержание ${heldRight}, высыпание ${dumpByMouse}`,
    );
  }

  // Потеря фокуса отпускает обе кнопки и все клавиши: иначе персонаж вернётся
  // из свёрнутой вкладки копающим и бегущим.
  {
    down('KeyD');
    win.emit('mousedown', { button: 0 });
    win.emit('mousedown', { button: 2 });
    win.emit('blur', {});
    check(
      'Ввод: потеря фокуса отпускает клавиши и обе кнопки мыши',
      !input.moveRight && !input.mouseLeftHeld && !input.mouseRightHeld,
    );
    input.endStep();
  }

  // Позиция курсора приходит в координатах буфера кадра.
  {
    win.emit('mousemove', { clientX: 100, clientY: 60 });
    check(
      'Ввод: позиция курсора пересчитана из координат страницы',
      input.mouseX === 50 && input.mouseY === 30,
      `(${input.mouseX},${input.mouseY})`,
    );
  }

  // Полный экономический цикл — только клавиатурой, ни одного события мыши.
  {
    const seen = { mode: false, tool: false, cycle: false, dump: false };
    down('KeyR');
    seen.mode = input.toolModePressed;
    up('KeyR');
    input.endStep();
    down('Space');
    seen.tool = input.toolHeld;
    up('Space');
    input.endStep();
    down('KeyC');
    seen.cycle = input.cycleCarriedPressed;
    up('KeyC');
    input.endStep();
    down('KeyF');
    seen.dump = input.dumpHeld;
    up('KeyF');
    input.endStep();
    check(
      'Ввод: весь цикл — режим, сбор, выбор вещества, высыпание — проходится без мыши',
      seen.mode &&
        seen.tool &&
        seen.cycle &&
        seen.dump &&
        !input.mouseLeftHeld &&
        !input.mouseRightHeld,
      JSON.stringify(seen),
    );
  }

  // Прокладка ленты — тоже только клавиатурой: выбрать режим, выбрать вид,
  // применить несколько раз подряд, снести. Ни одного события мыши.
  {
    const tool = new ToolModeState();
    // Технология ленты уже открыта: проверяется прокладка с клавиатуры,
    // а не путь, которым лента стала доступна.
    const catalog = new BuildCatalogState(UNLOCKED);

    down('KeyR');
    if (input.toolModePressed) tool.cycle();
    up('KeyR');
    input.endStep();
    down('KeyR');
    if (input.toolModePressed) tool.cycle();
    up('KeyR');
    input.endStep();

    let picked = false;
    for (let i = 0; i < BUILD_CATALOG.length; i++) {
      down('KeyX');
      if (input.buildKindPressed) catalog.cycle();
      up('KeyX');
      input.endStep();
      if (catalog.kind === CONVEYOR_RIGHT_KIND) {
        picked = true;
        break;
      }
    }

    const size = CONVEYOR.size;
    const w = new World(64, 64, first.world.profile);
    const module = new LandingModule({ x: 0, y: 0, w: 1, h: 1 });
    module.credits = CONVEYOR.sectionCost * 4;
    const registry = new BuildingRegistry();
    let laid = 0;
    for (let i = 0; i < 3; i++) {
      down('Space');
      if (input.toolPressed && tool.building) {
        const at = 20 + i * size;
        if (
          Builder.apply(w, registry, module, catalog.kind, at, 32, at, 32, UNLOCKED) === 'placed'
        ) {
          laid++;
        }
      }
      up('Space');
      input.endStep();
    }

    const mid = 20 + size;
    down('Space');
    const removed =
      input.toolPressed &&
      Builder.apply(w, registry, module, catalog.kind, mid + 1, 33, mid + 1, 33, UNLOCKED) ===
        'demolished';
    up('Space');
    input.endStep();

    check(
      'Ввод: лента выбирается, прокладывается и сносится одной клавиатурой',
      tool.building &&
        picked &&
        laid === 3 &&
        removed &&
        w.get(20, 32) === MAT.CONVEYOR_RIGHT &&
        w.get(mid, 32) === MAT.VACUUM &&
        w.get(mid + size, 32) === MAT.CONVEYOR_RIGHT &&
        !input.mouseLeftHeld,
      `вид ${catalog.name}, положено ${laid}, снято ${removed}`,
    );
  }
}

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

    const byMouse = actionTarget(true, cursorX, cursorY, cx, cy, d.x, d.y);
    check(
      'Цель: при удержании ЛКМ копается под курсором',
      byMouse.x === cursorX && byMouse.y === cursorY,
    );

    const byKeys = actionTarget(false, cursorX, cursorY, cx, cy, d.x, d.y);
    check(
      'Цель: без ЛКМ копается вплотную к персонажу, а не под курсором',
      Math.hypot(byKeys.x - cx, byKeys.y - cy) <= DIG.aimDistance,
      `(${byKeys.x - cx}, ${byKeys.y - cy})`,
    );

    // Оба органа удерживаются: побеждает мышь — у неё есть крестик.
    check(
      'Цель: при обоих органах побеждает мышь',
      actionTarget(true, cursorX, cursorY, cx, cy, d.x, d.y).x === cursorX,
    );

    // Крестик не зависит от клавиш: цель мыши одна и та же при любом
    // направлении клавиатуры.
    const other = aimDirection(-1, 1, -1);
    check(
      'Цель мыши не зависит от нажатых клавиш направления',
      actionTarget(true, cursorX, cursorY, cx, cy, other.x, other.y).x === cursorX,
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
      ctx: {
        putImageData() {},
        fillText() {},
        measureText: (s: string) => ({ width: s.length * 4.8 }),
        font: '',
        textBaseline: '',
        fillStyle: '',
      },
      image: {},
      present() {},
    } as unknown as Display;

    const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED);
    const camera = new Camera(first.world.width, first.world.height);
    camera.snapTo(camX + VIEW_W / 2, camY + VIEW_H / 2);
    const offscreen = new Player(camera.x + VIEW_W / 2, camera.y + VIEW_H + 40);
    renderer.render(camera, offscreen, VIEW_W / 2, VIEW_H - 1, true, IDLE_HUD, 0, 20);
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
