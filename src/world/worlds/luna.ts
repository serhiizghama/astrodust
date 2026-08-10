import { World } from '../world';
import type { WorldProfile } from '../world';
import { MAT, MAT_STATE, MatterState } from '../materials';
import { mulberry32, makeNoise } from '../rng';
import { RAMP } from '../../palette';
import { WORLD_W, WORLD_H, PLAYER, MODULE } from '../../config';
import type { Rect } from '../../geometry';

/**
 * Луна — первый мир.
 *
 * Гравитация 320 px/с² — опорная точка, откалиброванная на ощущение:
 * прыжок ~3.5 роста, заметное зависание в верхней точке, медленное падение.
 * Остальные тела считаются от неё по реальному отношению ускорений
 * (Марс ×2.30, Европа ×0.81).
 *
 * Атмосферы нет, поэтому небо почти чёрное и на поверхности, и в тени.
 */
export const LUNA: WorldProfile = {
  id: 'luna',
  name: 'Луна',
  gravity: 320,
  skyColor: RAMP.gray[0],
  // Пещера — глубокая слива, а НЕ ступень фиолетовой лестницы, хотя логика
  // гаммы просилась в `violet[0]`. Причина инструментальная: `violet[0]` —
  // заливка среднего слоя задника, а пещера покрывает в кадре площадь.
  // Совпадение сделало бы подсчёт площади слоя подсчётом площади пещеры,
  // и измерение задника потеряло бы смысл. `rust[1]` — та же глубокая слива,
  // свободная и площадью ни с чем не пересекающаяся.
  //
  // Заливка втрое светлее прежней (12.7 → 41.8), и это заставило заново
  // выбирать тёмный контур персонажа: см. `SPRITE_PALETTE`.
  caveColor: RAMP.rust[1],
  backdrop: {
    starDensity: 0.0045,
    // Три уровня яркости: однородное поле одинаковых точек читается как шум,
    // а не как небо. Тусклых большинство — яркая звезда должна быть событием.
    //
    // Яркость тусклой сохранена почти точно (80.3 → 81.3), поэтому плотность
    // неба на глаз не изменилась, а цвет добавился. Средняя стала розовой,
    // а не бирюзовой: бирюзу забрал визор скафандра, и делить цвет между
    // акцентом неба и постоянной деталью персонажа значило бы путать их.
    starColors: [RAMP.violet[2], RAMP.violet[4], RAMP.warm[5]],
    starWeights: [0.65, 0.27, 0.08],
    // Не ноль: при строгом нуле поле выглядит приклеенным к экрану. И не больше,
    // чем у самого дальнего слоя силуэтов — звёзды обязаны быть дальше всего.
    skyParallax: 0.05,
    // Полоса позиционируется долей окна неба (от края кадра до кромки дальнего
    // слоя), а не строкой кадра: при кадре 320×180 окно сжалось со 122 строк
    // до 77, и полоса прежней полуширины 44 оказалась бы шире самого неба —
    // осталась бы ровная засветка вместо узнаваемой наклонной полосы.
    milkyWay: {
      centerY: 48,
      halfWidth: 28,
      tilt: 0.06,
      densityBoost: 3.4,
      glowColor: RAMP.rust[0],
    },
    // Лестница значений: всё темнее самой тёмной породы переднего плана
    // (глубинная, `earth[0]` `#4d2b32`, яркость 53.9), иначе фон начинает
    // спорить с миром. Убывает к зрителю — ближний слой самый тёмный. Шаги
    // между слоями обязаны быть различимы: слишком близкие значения сливаются
    // в одну чёрную массу, и никакой глубины из трёх слоёв не выходит.
    // Фактическая лестница `50.7 → 32.1 → 19.9` при небе `10.7`; шаги 18.6
    // и 12.2 против прежних 7 и 9 — глубина читается лучше, чем до перекраски.
    //
    // ЗАПАС ДАЛЬНЕГО СЛОЯ ДО ПОРОДЫ — 3.2 единицы, самая узкая точка всей
    // палитры, и держится он на разнице ТОНА, а не яркости: слои фиолетовые,
    // порода коричневая, и при равной светлоте они всё равно не путаются.
    // Соседства в кадре у них к тому же не возникает — гребень дальнего слоя
    // стоит на `crestY = 88`, сплошная глубинная порода начинается с `y ≈ 360`,
    // а под поверхностью задник не рисуется вовсе.
    //
    // crestY привязан к линии горизонта, а не к строке кадра. Гребень стоит на
    // экране в `crestY − camY·parallax`, горизонт — в `SURFACE − camY`, поэтому
    // при изменении высоты кадра на ΔH камера у центрированного персонажа
    // сдвигается на ΔH/2, горизонт уезжает на всю эту величину, а гребень —
    // только на её долю parallax. Просвет между ними сохраняет правило
    //
    //     crestY_new = crestY_old − (ΔH / 2) · (1 − parallax)
    //
    // По нему и получены нынешние значения из прежних 126/139/154 при переходе
    // 270 → 180. Без него все три гребня тонут под рельефом и задник исчезает.
    //
    // amplitude и detail при этом не трогают: они в пикселях буфера, и сузившийся
    // кадр сам делает форму крупнее ровно во столько же раз.
    layers: [
      { parallax: 0.15, fill: RAMP.violet[1], crestY: 88, amplitude: 16, detail: 40 },
      { parallax: 0.32, fill: RAMP.violet[0], crestY: 108, amplitude: 22, detail: 19 },
      { parallax: 0.55, fill: RAMP.gray[1], crestY: 134, amplitude: 28, detail: 9 },
    ],
    sunDirX: -1,
    // Тёплая от Солнца, холодная от отражённого света Земли. Пунктиром:
    // сплошная линия при апскейле ×4–×6 слишком криклива для фона.
    // Обе поднялись с ~50/47 до ~90/88 — пунктир по гребню стал заметно ярче,
    // а бюджета акцентов это не задевает: подсвеченных пикселей столько же.
    rimWarm: RAMP.warm[2],
    rimCold: RAMP.blue[2],
    // x обязан считаться от ширины кадра: экранная колонка диска — это
    // x минус смещение параллакса (ход камеры 0…704 при skyParallax 0.05 даёт
    // 0…35), и прежние 372 при кадре шириной 320 держали бы Землю за правым
    // краем всегда. Нынешнее значение оставляет её в кадре на всём ходе камеры.
    companion: { x: 253, y: 32 },
    // crossSec уменьшен вместе с шириной кадра: код гонит объект через весь
    // кадр за это время независимо от ширины, поэтому в узком кадре прежние 13 с
    // читались бы как замедление.
    // Цвет обязан быть уникален среди всего, что задник способен вывести:
    // на нём целиком держится проверка прохода спутника, которая ищет пиксели
    // ровно этого значения. Со скафандром он общий — и это безопасно:
    // проверка рисует ТОЛЬКО задник, персонажа в том кадре нет по построению,
    // а в игре оба и есть яркий металл на солнце.
    orbiter: { color: RAMP.gray[9], y: 25, periodSec: 41, crossSec: 9 },
  },
};

const SURFACE_BASE = 168;
const DEEP_ROCK_Y = 360;
const DUST_DEPTH = 5;

/**
 * Лавовая трубка. Вынесено в константы, потому что залежи льда выкладываются
 * ДО прорезания и должны знать, куда трубка придёт: держать эти числа в двух
 * местах — гарантированный разъезд, при котором якорная залежь однажды
 * промахнётся мимо стены и требование «залежь выходит в пещеру» тихо отвалится.
 */
const TUBE_FROM_X = 470;
const TUBE_TO_X = 930;
const TUBE_BASE_Y = 310;
/** Размах извива средней линии вокруг `TUBE_BASE_Y`. */
const TUBE_WOBBLE_Y = 22;
/** Колонка якорной залежи льда — внутри трубки, поодаль от стыка со спуском. */
const ICE_ANCHOR_X = 620;

/** Описание кратера: то, что о нём известно генератору поверхности. */
export interface Crater {
  /** Колонка центра. */
  readonly x: number;
  readonly radius: number;
  readonly depth: number;
}

/**
 * Профиль поверхности: высота твёрдого верха для каждой колонки — и кратеры,
 * которые её сформировали.
 *
 * Кратеры возвращаются, а не остаются локальной переменной: под их днищами
 * выкладывается лёд, и искать впадину по готовому профилю значило бы
 * восстанавливать то, что здесь только что было известно точно.
 */
function buildSurface(rand: () => number): { surface: Int16Array; craters: Crater[] } {
  const wide = makeNoise(rand, 8);
  const medium = makeNoise(rand, 24);
  const fine = makeNoise(rand, 64);

  const surface = new Int16Array(WORLD_W);
  for (let x = 0; x < WORLD_W; x++) {
    const t = x / WORLD_W;
    const h = SURFACE_BASE + wide(t) * 20 + medium(t) * 7 + fine(t) * 2;
    surface[x] = Math.round(h);
  }

  // Кратеры: параболическая чаша с приподнятым валом по краю.
  // Радиус всегда заметно больше глубины, поэтому максимальный уклон стенки
  // (2*depth/radius) остаётся ниже 3 ячеек — автоподъём справляется, и кратер
  // проходим пешком.
  const craterCount = 6;
  const craters: Crater[] = [];
  for (let c = 0; c < craterCount; c++) {
    const cx = Math.floor(80 + rand() * (WORLD_W - 160));
    const depth = Math.floor(14 + rand() * 13);
    const radius = Math.floor(depth * 2.2 + rand() * 26);
    craters.push({ x: cx, radius, depth });
    const outer = Math.ceil(radius * 1.4);
    for (let dx = -outer; dx <= outer; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= WORLD_W) continue;
      const n = Math.abs(dx) / radius;
      const bowl = n <= 1 ? depth * (1 - n * n) : 0;
      // Вал: гауссиан вокруг кромки, уходящий в ноль к outer — иначе на
      // границе получился бы обрыв.
      const rim = -depth * 0.35 * Math.exp(-Math.pow((n - 1) * 4, 2));
      surface[x] += Math.round(bowl + rim);
    }
  }

  return { surface, craters };
}

/**
 * Ледяная линза: эллипс льда, записываемый ТОЛЬКО поверх уже существующей
 * твёрдой ячейки и только ниже слоя пыли.
 *
 * Оговорка про твёрдое — та же, что у валунов, и по той же причине: линза,
 * задевшая склон кратера или свод пещеры, повисла бы глыбой в воздухе. Залежь —
 * включение в толще, а не парящее тело.
 *
 * Оговорка про пыль нужна из-за рельефа. Линза кладётся от днища кратера, но
 * поверхность вокруг днища не гладкая: на соседней колонке шум опускает её
 * ниже центра, и верх линзы оказывается выше местного грунта — залежь выходит
 * наружу проплешиной голого льда. Замер до этой проверки: 15 колонок с пылью
 * тоньше пяти ячеек, из них одна с льдом прямо на поверхности.
 */
function placeIceLens(
  world: World,
  surface: Int16Array,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): void {
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) continue;
      if (y < surface[x]! + DUST_DEPTH) continue;
      if (MAT_STATE[world.get(x, y)] !== MatterState.Solid) continue;
      world.setRaw(x, y, MAT.ICE);
    }
  }
}

/** Вырезает вертикальный столбец пустоты — общий примитив для тоннелей. */
function carveColumn(world: World, x: number, top: number, height: number): void {
  for (let y = top; y < top + height; y++) world.setRaw(x, y, MAT.VACUUM);
}

/**
 * Наклонный спуск с поверхности в лавовую трубку.
 *
 * Уклон 1:2 — на каждый шаг по горизонтали пол поднимается/опускается на
 * пол-ячейки. Автоподъём справляется с этим, поэтому спуск проходим в обе
 * стороны: игрок может дойти до пещеры и вернуться пешком.
 */
function carveRamp(
  world: World,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  height: number,
): void {
  const span = endX - startX;
  for (let i = 0; i <= span; i++) {
    const x = startX + i;
    const y = Math.round(startY + ((endY - startY) * i) / span);
    carveColumn(world, x, y - height, height);
  }
}

/**
 * Лавовая трубка: горизонтальная извилистая пещера под поверхностью.
 * Возвращает уровень пола по колонкам — по нему спуск пристыковывается к трубке.
 */
function carveLavaTube(world: World, rand: () => number, fromX: number, toX: number): Int16Array {
  const wobble = makeNoise(rand, 10);
  const floors = new Int16Array(WORLD_W);

  for (let x = fromX; x <= toX; x++) {
    const t = (x - fromX) / (toX - fromX);
    const centerY = TUBE_BASE_Y + wobble(t) * TUBE_WOBBLE_Y;
    const height = 24 + Math.round(wobble(t * 2.7) * 5);
    const top = Math.round(centerY - height / 2);
    carveColumn(world, x, top, height);
    floors[x] = top + height;
  }

  return floors;
}

/**
 * Выравнивает профиль поверхности под площадку и выкладывает корпус модуля.
 *
 * Выравнивание идёт ДО расчёта точки старта и до прорезания тоннелей: приёмник,
 * повисший над склоном, не наполнить, а спавн обязан садиться на уже готовый
 * рельеф. Уровень площадки берётся по центру будущего модуля, а не по минимуму
 * пролёта: минимум означал бы, что один случайный бугор на краю поднимает
 * площадку на десяток ячеек над окрестностью, и модуль встаёт на постаменте.
 *
 * Форма корпуса — П в разрезе: две боковые стенки, сплошное дно, открытый верх.
 *
 * ```
 *   ▓▓▓▓          ▓▓▓▓     стенки высотой MODULE.depth
 *   ▓▓▓▓   зона   ▓▓▓▓
 *   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓     дно, вровень с площадкой
 * ```
 *
 * `surface` правится на месте: рендер отличает по нему небо от пещеры, и
 * площадка, о которой он не знает, зияла бы полосой звёздного неба под ногами.
 *
 * @returns зона приёмника — прямоугольник пустоты внутри стенок
 */
function placeLandingModule(world: World, surface: Int16Array): Rect {
  const padY = surface[MODULE.x + (MODULE.width >> 1)]!;
  const padFrom = Math.max(0, MODULE.x - MODULE.padMargin);
  const padTo = Math.min(WORLD_W - 1, MODULE.x + MODULE.width + MODULE.padMargin - 1);

  for (let x = padFrom; x <= padTo; x++) {
    const top = surface[x]!;
    // Грунт ниже площадки — досыпаем спёкшимся: рыхлый обрушился бы на первом
    // же шаге симуляции, и площадка перестала бы быть площадкой.
    for (let y = padY; y < top; y++) world.setRaw(x, y, MAT.REGOLITH_PACKED);
    // Грунт выше площадки — срезаем.
    for (let y = top; y < padY; y++) world.setRaw(x, y, MAT.VACUUM);
    surface[x] = padY;
  }

  const innerX = MODULE.x + MODULE.wall;
  const innerW = MODULE.width - 2 * MODULE.wall;
  const topY = padY - MODULE.depth;

  // Стенки: от верха зоны до низа дна, чтобы корпус был одним телом.
  for (let y = topY; y < padY + MODULE.floor; y++) {
    for (let d = 0; d < MODULE.wall; d++) {
      world.setRaw(MODULE.x + d, y, MAT.MODULE_HULL);
      world.setRaw(MODULE.x + MODULE.width - 1 - d, y, MAT.MODULE_HULL);
    }
  }
  // Дно во всю ширину.
  for (let y = padY; y < padY + MODULE.floor; y++) {
    for (let x = MODULE.x; x < MODULE.x + MODULE.width; x++) {
      world.setRaw(x, y, MAT.MODULE_HULL);
    }
  }
  // Зона приёмника: пустота внутри стенок, открытая сверху.
  for (let y = topY; y < padY; y++) {
    for (let x = innerX; x < innerX + innerW; x++) world.setRaw(x, y, MAT.VACUUM);
  }

  return { x: innerX, y: topY, w: innerW, h: MODULE.depth };
}

/** Находит верхнюю твёрдую ячейку в колонке. -1, если колонка пуста. */
export function findGroundY(world: World, x: number): number {
  for (let y = 0; y < world.height; y++) {
    if (world.isSolid(x, y)) return y;
  }
  return -1;
}

export interface GeneratedWorld {
  world: World;
  spawn: { x: number; y: number };
  /**
   * Высота твёрдого верха по колонкам. Рендер отличает по ней небо от пещеры:
   * пустота выше поверхности — звёздное небо, ниже — тёмный интерьер.
   */
  surface: Int16Array;
  /**
   * Зона приёмника посадочного модуля. Возвращается генератором, потому что
   * положение модуля зависит от рельефа: искать её потом по сетке значило бы
   * восстанавливать то, что здесь было известно точно.
   */
  receiver: Rect;
}

/**
 * Собирает мир Луны из зерна. Одно и то же зерно всегда даёт одну и ту же сетку.
 */
export function generateLuna(seed: number): GeneratedWorld {
  const rand = mulberry32(seed);
  const world = new World(WORLD_W, WORLD_H, LUNA);
  const { surface, craters } = buildSurface(rand);

  // Заливка: пыль тонким слоем поверх породы, глубже — тёмная порода.
  // Граница глубинной породы идёт по шуму: ровная горизонталь через весь мир
  // читалась бы как артефакт рендера, а не как геология.
  const deepBoundary = makeNoise(rand, 12);
  for (let x = 0; x < WORLD_W; x++) {
    const top = surface[x];
    const deepY = DEEP_ROCK_Y + deepBoundary(x / WORLD_W) * 30;
    for (let y = top; y < WORLD_H; y++) {
      let material: number;
      // Терраин выкладывается СПЁКШИМСЯ реголитом: рыхлый здесь обрушил бы
      // всю поверхность мира на первом же шаге симуляции.
      if (y < top + DUST_DEPTH) material = MAT.REGOLITH_PACKED;
      else if (y < deepY) material = MAT.ROCK;
      else material = MAT.ROCK_DEEP;
      world.setRaw(x, y, material);
    }
  }

  // Валуны: пятна глубинной породы в основном слое. Без них порода —
  // сплошное серое поле, по которому не видно ни глубины, ни движения.
  const boulderCount = 90;
  for (let i = 0; i < boulderCount; i++) {
    const bx = Math.floor(rand() * WORLD_W);
    const by = Math.floor(200 + rand() * (WORLD_H - 220));
    const rx = 4 + Math.floor(rand() * 11);
    const ry = Math.max(2, Math.floor(rx * (0.5 + rand() * 0.5)));
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) continue;
        const x = bx + dx;
        const y = by + dy;
        // Только внутри уже существующей породы — воздух не заполняем.
        if (world.get(x, y) === MAT.ROCK) world.setRaw(x, y, MAT.ROCK_DEEP);
      }
    }
  }

  // Залежи льда — ДО прорезания тоннелей.
  //
  // Порядок принципиален: `carveColumn` пишет пустоту безусловно, поэтому всё,
  // что попало в тоннель, стирается. Связность уровня тем самым не зависит
  // от того, куда лёг лёд: перегородить существующий проход залежь физически
  // не может. Обратный порядок пришлось бы страховать проверками «не задел ли
  // я тоннель», и каждая новая залежь была бы риском для маршрута.

  // 1. Якорная залежь на стене лавовой трубки. Стоит в фиксированной точке
  //    и потому не зависит от зерна — это и есть гарантия требования «залежь
  //    выходит в объём пещеры». Полувысота линзы взята с запасом от размаха
  //    извива (22) плюс половина наибольшей высоты трубки (~15): при любом
  //    изгибе средней линии линза заведомо перекрывает стену, прорезание
  //    съедает её середину, а остаток выходит в пещеру.
  placeIceLens(world, surface, ICE_ANCHOR_X, TUBE_BASE_Y, 14, TUBE_WOBBLE_Y + 8);

  // 2. Кратерные: под днищами самых глубоких кратеров, сразу под слоем пыли.
  //    Затенённый лёд на дне лунных кратеров — реальность и лор игры, а заодно
  //    видимый ориентир: кратер говорит игроку, где копать.
  const deepest = craters.slice().sort((a, b) => b.depth - a.depth);
  for (const crater of deepest.slice(0, 3)) {
    const ry = 5 + Math.floor(rand() * 4);
    const rx = Math.max(6, Math.round(crater.radius * 0.45));
    // Верх линзы — ровно под пылью. Днище кратера — самая нижняя его точка,
    // поэтому на соседних колонках слой пыли остаётся не тоньше.
    placeIceLens(world, surface, crater.x, surface[crater.x]! + DUST_DEPTH + ry, rx, ry);
  }

  // 3. Рассеянные в толще: чтобы лёд встречался и при обычном копании вглубь,
  //    а не только в двух отмеченных местах.
  const scatteredCount = 8;
  for (let i = 0; i < scatteredCount; i++) {
    const bx = Math.floor(rand() * WORLD_W);
    const by = Math.floor(215 + rand() * (WORLD_H - 250));
    const rx = 5 + Math.floor(rand() * 9);
    const ry = Math.max(3, Math.floor(rx * (0.45 + rand() * 0.55)));
    placeIceLens(world, surface, bx, by, rx, ry);
  }

  // Трубка режется первой из тоннелей: спуск должен закончиться ровно на её
  // полу. Иначе на стыке получается уступ в два десятка ячеек — вниз игрок
  // падает, а обратно пешком выйти уже не может.
  const junctionX = TUBE_FROM_X;
  const tubeFloors = carveLavaTube(world, rand, TUBE_FROM_X, TUBE_TO_X);

  const rampStartX = 210;
  const rampStartY = surface[rampStartX] + 2;
  carveRamp(world, rampStartX, rampStartY, junctionX, tubeFloors[junctionX], 22);

  // Модуль — ПОСЛЕ тоннелей и ДО расчёта точки старта. После тоннелей потому,
  // что `carveColumn` пишет пустоту безусловно и срезал бы корпус, задень его
  // спуск; до старта — потому что выравнивание площадки меняет рельеф, и спавн
  // обязан считаться по уже готовому.
  const receiver = placeLandingModule(world, surface);

  // Старт — левее входа в спуск, на нетронутой поверхности.
  // Опора ищется по всей ширине хитбокса: рельеф неровный, и по одной колонке
  // персонаж встал бы наполовину внутри соседнего бугра.
  const spawnLeft = 110;
  let groundY = WORLD_H;
  for (let x = spawnLeft; x < spawnLeft + PLAYER.hitboxW; x++) {
    groundY = Math.min(groundY, findGroundY(world, x));
  }
  const spawn = { x: spawnLeft, y: groundY - PLAYER.hitboxH };

  // Заливка шла через setRaw и чанки не будила — иначе полмиллиона пробуждений
  // на генерацию. Будим мир один раз: если генератор оставил висящий сыпучий
  // материал, он осядет на первых шагах и чанки тут же уснут.
  world.chunks.wakeAll();

  return { world, spawn, surface, receiver };
}
