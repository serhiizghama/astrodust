import { DIG, VACUUM, CONVEYOR, SIM_HZ, SHADING } from '../config';
import { Display } from '../core';
import { Camera } from './camera';
import { World, MAT, MAT_CARRY } from '../world';
import { SHADE_R, SHADE_G, SHADE_B, CONVEYOR_STRIPE_COLOR } from './material-colors';
import { GRAIN } from './grain';
import { BAYER, DITHER_MASK, DITHER_LEVELS } from './dither';
import { Lightmap, LIGHT_NEUTRAL } from './lightmap';
import { Backdrop } from './backdrop';
import { RAMP, css } from '../palette';
import { drawResearchOverlay } from './overlay';
import type { OverlayView } from './overlay';
import { Player } from '../entities';
import {
  SPRITE_PIXELS,
  SPRITE_PALETTE,
  SPRITE_W,
  SPRITE_H,
  SPRITE_OFFSET_X,
  SPRITE_OFFSET_Y,
} from './sprites/player';

/**
 * Граница круглой кисти: пары смещений (dx, dy) относительно цели.
 *
 * Только периметр: кадр — непрозрачный буфер без альфа-композитинга, и заливку
 * пришлось бы смешивать на каждый пиксель. Контур несёт ту же информацию
 * и не закрывает то, что игрок собирается выкопать.
 *
 * Считается один раз, плоским типизированным массивом: обход без разыменований
 * и без аллокаций на кадр.
 */
function brushOutline(radius: number): Int8Array {
  const rSq = radius * radius;
  const inside = (dx: number, dy: number): boolean => dx * dx + dy * dy <= rSq;
  const pairs: number[] = [];

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!inside(dx, dy)) continue;
      // Граничная — та, у которой хотя бы один сосед по стороне уже снаружи.
      // Ячейка, окружённая своими со всех четырёх сторон, — это заливка.
      const enclosed =
        inside(dx - 1, dy) && inside(dx + 1, dy) && inside(dx, dy - 1) && inside(dx, dy + 1);
      if (enclosed) continue;
      pairs.push(dx, dy);
    }
  }

  return Int8Array.from(pairs);
}

/** Сколько ступеней у интерьера пещеры: у выхода и в глубине. */
const CAVE_SHADES = 2;

/**
 * Кегль интерфейса в ячейках кадра. Длина, соразмерная кадру: строка состояния
 * читается с одного и того же расстояния независимо от того, сколько мира
 * влезло в окно. Отступы интерфейса выведены от него — четверть кегля.
 */
const UI_FONT = '16px monospace';

// Настройки тонирования — в локальные константы модуля. Внутренний цикл
// касается их на каждый пиксель кадра, а `SHADING.x` там — загрузка свойства.
const SHADE_BITS = SHADING.shadeBits;
const SHADE_MAX = SHADING.shadesPerMaterial - 1;
const GRAIN_SIZE = SHADING.grainTile;
const GRAIN_MASK = GRAIN_SIZE - 1;
const EXPOSURE_STEP = SHADING.exposureStep;
const EXPOSURE_MAX = SHADING.exposureMax;
const DEPTH_SHIFT = SHADING.depthShift;
const DEPTH_DITHER_MAX = SHADING.depthDitherMax;
const CAVE_DEPTH_SHIFT = SHADING.caveDepthShift;
const LIGHT_SHIFT = Math.log2(SHADING.lightScale);

/**
 * Ступень твёрдой ячейки: зерно, плюс экспозиция, минус глубина.
 *
 * Экспозиция — число пустых соседей из четырёх. Без неё свежевыкопанный ход
 * неотличим от нетронутой толщи: игрок не видит результата собственного
 * действия иначе как по изменению силуэта.
 *
 * Соседи по горизонтали приходят готовыми: обход идёт по строке, и оба уже
 * прочитаны — левый как ячейка прошлой итерации, правый как ячейка следующей.
 * Повторное чтение стоило бы двух обращений к массиву на каждый пиксель кадра.
 *
 * Края мира: по вертикали смещение обнуляется вызывающим и ячейка читает саму
 * себя, по горизонтали чтение уходит за массив и даёт `undefined`. И то, и
 * другое не равно пустоте, то есть считается твёрдым, — ровно то, что правило
 * непроходимых границ мира и обещает.
 */
function shadeOf(
  cells: Uint8Array,
  c: number,
  left: number | undefined,
  right: number | undefined,
  upOff: number,
  downOff: number,
  grainAt: number,
  bayerAt: number,
  depth: number,
  lit: number,
): number {
  let shade = GRAIN[grainAt]!;

  let open = 0;
  if (cells[c + upOff] === MAT.VACUUM) open++;
  if (cells[c + downOff] === MAT.VACUUM) open++;
  if (left === MAT.VACUUM) open++;
  if (right === MAT.VACUUM) open++;
  if (open > EXPOSURE_MAX) open = EXPOSURE_MAX;
  shade += open * EXPOSURE_STEP;

  // Глубина затемняет ДОЛЮ пикселей, а не сдвигает ступень целиком: сдвиг
  // опустил бы вниз всё распределение зерна, и доминантой на глубине стал бы
  // тёмный акцент вместо базовой ступени.
  const t = BAYER[bayerAt]!;
  if (depth > 0) {
    let level = depth >> DEPTH_SHIFT;
    if (level > DEPTH_DITHER_MAX) level = DEPTH_DITHER_MAX;
    if (t < level) shade--;
  }

  // Освещённость — тоже доля, а не сдвиг ступени, и по той же причине:
  // сплошной сдвиг отнял бы у базовой ступени доминанту рядом с источником.
  //
  // Без проверки «есть ли свет»: карта не опускается ниже нейтрали, поэтому
  // разность неотрицательна, и при нуле сравнение просто не срабатывает.
  // Ветка сэкономила бы сравнение там, где света нет, ценой перехода на
  // каждый непустой пиксель кадра.
  if (t < lit - LIGHT_NEUTRAL) shade++;

  if (shade < 0) return 0;
  return shade > SHADE_MAX ? SHADE_MAX : shade;
}

/**
 * Ступень пустоты ниже поверхности: 0 у выхода, 1 в глубине, переход —
 * дизерингом. Плоская заливка сообщает игроку только «здесь пусто»,
 * затенённая — ещё и «выход в той стороне», а это навигация в мире без карты.
 */
function caveShade(depth: number, bayerAt: number, lit: number): number {
  if (depth <= 0) return 0;
  // Свет отодвигает темноту: пустота у лавы обязана светиться, иначе расплав
  // освещает породу вокруг, а воздух над собой — нет.
  let level = (depth >> CAVE_DEPTH_SHIFT) - (lit - LIGHT_NEUTRAL);
  if (level <= 0) return 0;
  if (level > DITHER_LEVELS) level = DITHER_LEVELS;
  return BAYER[bayerAt]! < level ? 1 : 0;
}

export const BRUSH_OUTLINE = brushOutline(DIG.radius);
/**
 * Контур кисти сбора. Радиус свой, и это единственное, чем отличается вызов:
 * обещать выемку размером с копательную кисть там, где всосётся вдвое меньше,
 * — то же враньё, что и не показывать радиус вовсе.
 */
export const VACUUM_OUTLINE = brushOutline(VACUUM.radius);

/**
 * Контур кисти сбора для ЛЮБОГО радиуса, с памятью на посчитанное. Радиус
 * правит технология, и застывшее кольцо обещало бы выемку меньше настоящей
 * ровно после того, как игрок заплатил за большую. Память — потому что кольцо
 * рисуется каждый кадр, а радиусов за партию бывает три.
 */
const OUTLINE_CACHE = new Map<number, Int8Array>([[VACUUM.radius, VACUUM_OUTLINE]]);

export function vacuumOutline(radius: number): Int8Array {
  let ring = OUTLINE_CACHE.get(radius);
  if (!ring) {
    ring = brushOutline(radius);
    OUTLINE_CACHE.set(radius, ring);
  }
  return ring;
}

/**
 * Цвета состояния машины — и язык годности при постановке.
 *
 * Экспортируются, потому что цвет здесь СМЫСЛ: проверки считают пиксели ровно
 * этих значений, и литерал в проверке дал бы молчаливую поломку при перекраске.
 *
 * Инвариант: ступени НЕ совпадают со ступенями прицела — он рисуется в том же
 * кадре, и на общем цвете подсчёт полосы считал бы заодно крестик с кольцом.
 * Отказ взял `rust[5]`, а не лаву `rust[4]`: цвет негодности не должен
 * совпадать с площадным веществом, иначе рамка растворяется над расплавом.
 */
export const MACHINE_STATE_COLORS = {
  idle: RAMP.green[0],
  working: RAMP.green[5],
  blocked: RAMP.rust[5],
} as const;

const STRIPE_R = (CONVEYOR_STRIPE_COLOR >> 16) & 0xff;
const STRIPE_G = (CONVEYOR_STRIPE_COLOR >> 8) & 0xff;
const STRIPE_B = CONVEYOR_STRIPE_COLOR & 0xff;

/**
 * Насколько полоса ушла вперёд к этому моменту игрового времени, в ячейках.
 * Считается ИЗ `stepsPerCell`: полоса, бегущая быстрее груза, — врущий прибор.
 * Игровым временем, а не кадрами: на 144 Гц темп тот же, что и на 60.
 */
export function stripeOffset(time: number): number {
  return Math.floor((time * SIM_HZ) / CONVEYOR.stepsPerCell);
}

/**
 * Что показать в строке состояния и каким нарисовать прицел.
 *
 * Одна структура, а не восемь аргументов подряд: рендер про инвентарь ничего
 * не решает, он его показывает, и список того, что показать, обязан читаться
 * на месте вызова.
 */
export interface HudState {
  /** Подпись текущего режима инструмента. */
  readonly mode: string;
  /** Собирает ли инструмент сейчас — от этого зависит вид прицела. */
  readonly collecting: boolean;
  /**
   * Радиус кисти сбора прямо сейчас: он настраиваемый, и кольцо прицела обязано
   * показывать то, что всосётся, а не то, что всасывалось в начале партии.
   */
  readonly collectRadius: number;
  readonly carried: readonly { readonly name: string; readonly count: number }[];
  readonly used: number;
  readonly capacity: number;
  readonly selected: string;
  readonly credits: number;
  /**
   * Очки исследований. Стоят рядом с кредитами и видны ВСЕГДА, а не только
   * внутри оверлея: игрок принимает по двум валютам разные решения — что
   * построить и что открыть, — и валюта, которую видно только в меню,
   * из этих решений выпадает.
   */
  readonly research: number;
  /**
   * Контур будущего здания в координатах МИРА и признак годности места.
   * `null` вне режима строительства.
   *
   * Годность показывается контуром, а не сообщением: прицел уже несёт признак
   * достижимости тем же способом, и второй язык обратной связи для того же типа
   * отказа игроку учить незачем.
   */
  readonly ghost: GhostView | null;
  /**
   * Подпись выбранного вида постройки с ценой. Пустая строка — не в режиме
   * строительства.
   *
   * Видна ДО применения: постройка вслепую — это списание кредитов за то, чего
   * игрок не выбирал. Контур под целью показывает размер и годность, но не
   * говорит ни цену, ни направление ленты.
   */
  readonly buildKind: string;
  /**
   * Почему место негодно, словами. Красный контур отвечает «нельзя», но
   * не «почему», а из четырёх причин три исправимы прямо сейчас: отойти,
   * расчистить, накопить.
   */
  readonly buildIssue: string;
  /** Стоящие машины: состояние обязано читаться с самой машины, а не из угла кадра. */
  readonly machines: readonly MachineView[];
  /** Сводка по машинам для строки состояния. Пустая строка — машин нет. */
  readonly machineSummary: string;
  /** Оверлей исследований, если он открыт. `null` — закрыт. */
  readonly overlay: OverlayView | null;
}

export interface GhostView {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly ok: boolean;
}

export interface MachineView {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly state: 'idle' | 'working' | 'blocked';
  /** Ход текущей порции, 0..1. */
  readonly progress: number;
}

/**
 * Рендер мира в буфер кадра.
 *
 * Обрабатывается только видимая камерой область: стоимость кадра зависит от
 * размера окна вывода, а не от размера мира. Увеличение мира кадр не замедлит.
 *
 * Небо рисует не этот класс, а задник — отдельным проходом ДО прохода мира.
 * Оба делят площадь кадра по профилю поверхности и не заходят на чужую
 * территорию, поэтому ни один пиксель не записывается дважды.
 */
/**
 * Всё, что нужно кадру, одним снапшотом.
 *
 * Один параметр вместо девяти позиционных: у позиционного списка, доросшего
 * до девяти, соседние `number` различаются только порядком, и перепутать
 * крестик с частотой кадров ничто не мешает.
 */
export interface FrameView {
  readonly camera: Camera;
  readonly player: Player;
  readonly crosshairX: number;
  readonly crosshairY: number;
  readonly crosshairInReach: boolean;
  readonly hud: HudState;
  readonly fps: number;
  /** Накопленное время симуляции: движет анимации задника. */
  readonly time?: number;
  /** Подпись выбранного отладочного вещества. Пусто — диагностика выключена. */
  readonly debugMaterial?: string;
}

export class Renderer {
  private readonly backdrop: Backdrop;
  /**
   * Ступени интерьера пещеры, от светлой к тёмной: 0 — у выхода, 1 — в глубине
   * массива. Разложены на байты по той же причине, что и ступени материалов, —
   * их читает внутренний цикл по пикселям.
   */
  private readonly caveR = new Uint8Array(CAVE_SHADES);
  private readonly caveG = new Uint8Array(CAVE_SHADES);
  private readonly caveB = new Uint8Array(CAVE_SHADES);
  private readonly lightmap: Lightmap;

  constructor(
    private readonly display: Display,
    private readonly world: World,
    private readonly surface: Int16Array,
    seed: number,
  ) {
    const p = world.profile;
    const cave = [p.caveColor, p.caveDeepColor];
    for (let i = 0; i < CAVE_SHADES; i++) {
      this.caveR[i] = (cave[i]! >> 16) & 0xff;
      this.caveG[i] = (cave[i]! >> 8) & 0xff;
      this.caveB[i] = cave[i]! & 0xff;
    }
    this.backdrop = new Backdrop(p, seed, surface);
    // Целиком и сразу: чанки при создании помечены грязными все, и догон
    // по потолку растянул бы первые кадры партии на неосвещённой карте.
    this.lightmap = new Lightmap(world);
    this.lightmap.rebuildAll();
  }

  render(view: FrameView): void {
    const { camera, player, crosshairX, crosshairY, crosshairInReach, hud } = view;
    const fps = view.fps;
    const time = view.time ?? 0;
    const debugMaterial = view.debugMaterial ?? '';

    // Размер кадра — до первого обращения к заднику: обе его точки входа
    // читают его, а не получают параметром.
    this.backdrop.setViewport(this.display.width, this.display.height);

    // Считается один раз на кадр и служит обоим проходам: заднику — признаком
    // «неба в кадре нет», миру — границей, ниже которой проверять небо незачем.
    const maxSurface = this.backdrop.maxSurfaceInView(camera.x);

    // Догон карты — до прохода мира, иначе кадр читает её на шаг устаревшей.
    this.lightmap.update();

    this.backdrop.draw(this.display.pixels, camera.x, camera.y, time, maxSurface);
    this.drawWorld(camera, maxSurface, stripeOffset(time));
    this.drawMachines(camera, hud.machines);
    this.drawPlayer(camera, player);
    if (hud.ghost) this.drawGhost(camera, hud.ghost);
    this.drawAim(crosshairX, crosshairY, crosshairInReach, hud.collecting, hud.collectRadius);
    this.display.present();
    this.drawStatus(hud);
    this.drawDebug(fps, debugMaterial);
    // Оверлей — последним: он перекрывает и мир, и строку состояния, и это
    // правильный порядок. Пока он открыт, строка состояния всё равно
    // не описывает того, чем игрок сейчас занят.
    if (hud.overlay) {
      drawResearchOverlay(this.display.ctx, hud.overlay, this.display.width, this.display.height);
    }
  }

  /**
   * Мир поверх задника.
   *
   * Цикл разрезан по строке, ниже которой неба не встречается: в нижней части
   * различать пустоту на небо и пещеру не нужно, и ветвление оттуда убрано.
   * Под землёй весь кадр идёт по короткому пути.
   *
   * Бегущая полоса рисуется ЗДЕСЬ, внутри ветки «ячейка не пустота», а не
   * отдельным проходом: цена — одна выборка `MAT_CARRY[m]` на непустой пиксель.
   * Отдельный проход требовал бы списка лент, которого нет: лента — вещество,
   * а не сущность.
   *
   * Ступень собирается СЛОЖЕНИЕМ трёх вкладов — зерно, экспозиция, глубина, —
   * а не последовательностью проверок. Соседние пиксели уходили бы в разные
   * ветки, и предсказатель переходов на этом ломается; сложение ветвей не имеет.
   */
  private drawWorld(camera: Camera, maxSurface: number, offset: number): void {
    const px = this.display.pixels;
    const viewW = this.display.width;
    const viewH = this.display.height;
    const cells = this.world.cells;
    const worldW = this.world.width;
    const worldBottom = this.world.height - 1;
    const camX = camera.x;
    const camY = camera.y;
    const surface = this.surface;
    const period = CONVEYOR.stripePeriod;
    const stripe = CONVEYOR.stripeWidth;
    const caveR = this.caveR;
    const caveG = this.caveG;
    const caveB = this.caveB;
    const light = this.lightmap.level;
    const lightCols = this.lightmap.cols;

    let splitRow = maxSurface - camY;
    if (splitRow < 0) splitRow = 0;
    else if (splitRow > viewH) splitRow = viewH;

    let idx = 0;

    // Верхняя часть: здесь встречается небо, и его пиксели уже нарисованы
    // задником — трогать их нельзя.
    for (let sy = 0; sy < splitRow; sy++) {
      const wy = camY + sy;
      const rowBase = wy * worldW;
      // Смещения соседей по вертикали. На краю мира смещение нулевое — ячейка
      // читает саму себя, то есть твёрдое, и открытой не считается. Это не
      // уловка: запрос твёрдости за пределами сетки и обязан давать «твёрдая».
      const upOff = wy > 0 ? -worldW : 0;
      const downOff = wy < worldBottom ? worldW : 0;
      const grainRow = (wy & GRAIN_MASK) * GRAIN_SIZE;
      const bayerRow = (wy & DITHER_MASK) << 2;
      const lightRow = (wy >> LIGHT_SHIFT) * lightCols;

      const rowStart = rowBase + camX;
      let prev = cells[rowStart - 1];
      let cur = cells[rowStart];

      for (let sx = 0; sx < viewW; sx++, idx += 4) {
        const wx = camX + sx;
        const c = rowStart + sx;
        const m = cur!;
        const next = cells[c + 1];

        if (m !== MAT.VACUUM) {
          const carry = MAT_CARRY[m]!;
          if (carry !== 0 && (((wx - carry * offset) % period) + period) % period < stripe) {
            px[idx] = STRIPE_R;
            px[idx + 1] = STRIPE_G;
            px[idx + 2] = STRIPE_B;
          } else {
            const at =
              (m << SHADE_BITS) |
              shadeOf(
                cells,
                c,
                prev,
                next,
                upOff,
                downOff,
                grainRow | (wx & GRAIN_MASK),
                bayerRow | (wx & DITHER_MASK),
                wy - surface[wx]!,
                light[lightRow + (wx >> LIGHT_SHIFT)]!,
              );
            px[idx] = SHADE_R[at]!;
            px[idx + 1] = SHADE_G[at]!;
            px[idx + 2] = SHADE_B[at]!;
          }
        } else if (wy >= surface[wx]!) {
          const s = caveShade(
            wy - surface[wx]!,
            bayerRow | (wx & DITHER_MASK),
            light[lightRow + (wx >> LIGHT_SHIFT)]!,
          );
          px[idx] = caveR[s]!;
          px[idx + 1] = caveG[s]!;
          px[idx + 2] = caveB[s]!;
        }

        prev = m;
        cur = next;
      }
    }

    // Нижняя часть: неба здесь быть не может, пустота — всегда пещера.
    for (let sy = splitRow; sy < viewH; sy++) {
      const wy = camY + sy;
      const rowBase = wy * worldW;
      const upOff = wy > 0 ? -worldW : 0;
      const downOff = wy < worldBottom ? worldW : 0;
      const grainRow = (wy & GRAIN_MASK) * GRAIN_SIZE;
      const bayerRow = (wy & DITHER_MASK) << 2;
      const lightRow = (wy >> LIGHT_SHIFT) * lightCols;

      const rowStart = rowBase + camX;
      let prev = cells[rowStart - 1];
      let cur = cells[rowStart];

      for (let sx = 0; sx < viewW; sx++, idx += 4) {
        const wx = camX + sx;
        const c = rowStart + sx;
        const m = cur!;
        const next = cells[c + 1];

        if (m !== MAT.VACUUM) {
          const carry = MAT_CARRY[m]!;
          if (carry !== 0 && (((wx - carry * offset) % period) + period) % period < stripe) {
            px[idx] = STRIPE_R;
            px[idx + 1] = STRIPE_G;
            px[idx + 2] = STRIPE_B;
          } else {
            const at =
              (m << SHADE_BITS) |
              shadeOf(
                cells,
                c,
                prev,
                next,
                upOff,
                downOff,
                grainRow | (wx & GRAIN_MASK),
                bayerRow | (wx & DITHER_MASK),
                wy - surface[wx]!,
                light[lightRow + (wx >> LIGHT_SHIFT)]!,
              );
            px[idx] = SHADE_R[at]!;
            px[idx + 1] = SHADE_G[at]!;
            px[idx + 2] = SHADE_B[at]!;
          }
        } else {
          const s = caveShade(
            wy - surface[wx]!,
            bayerRow | (wx & DITHER_MASK),
            light[lightRow + (wx >> LIGHT_SHIFT)]!,
          );
          px[idx] = caveR[s]!;
          px[idx + 1] = caveG[s]!;
          px[idx + 2] = caveB[s]!;
        }

        prev = m;
        cur = next;
      }
    }
  }

  /**
   * Состояние машины — на самой машине, а не только в строке состояния.
   *
   * Игрок обязан отличать работающую машину от остановленной, глядя на неё,
   * а не сверяясь с углом кадра. Полоса по приёмной грани показывает ход
   * порции, её цвет — состояние: работа, простой, забитый выход. Причина
   * остановки читается тем же взглядом, что и сам факт остановки.
   */
  private drawMachines(camera: Camera, machines: readonly MachineView[]): void {
    const viewW = this.display.width;
    const viewH = this.display.height;
    for (const m of machines) {
      const sx = m.x - camera.x;
      const sy = m.y - camera.y;
      if (sx + m.w < 0 || sy + m.h < 0 || sx >= viewW || sy >= viewH) continue;

      const color = MACHINE_STATE_COLORS[m.state];

      // Полоса заполняется слева направо по ходу порции. У простоя и забитого
      // выхода хода нет, поэтому полоса рисуется целиком: важен цвет.
      const filled = m.state === 'working' ? Math.max(1, Math.round(m.w * m.progress)) : m.w;
      for (let i = 0; i < filled; i++) this.setPixel(sx + i, sy, color);
    }
  }

  /**
   * Контур будущего здания под целью.
   *
   * Периметр, а не заливка: заливка закрыла бы ровно то место, куда игрок
   * смотрит, выбирая, встанет ли машина в рельеф. Цвет несёт годность —
   * тот же язык, что у прицела, и второй учить не надо.
   */
  private drawGhost(camera: Camera, ghost: GhostView): void {
    const x0 = ghost.x - camera.x;
    const y0 = ghost.y - camera.y;
    const color = ghost.ok ? MACHINE_STATE_COLORS.working : MACHINE_STATE_COLORS.blocked;

    for (let i = 0; i < ghost.w; i++) {
      this.setPixel(x0 + i, y0, color);
      this.setPixel(x0 + i, y0 + ghost.h - 1, color);
    }
    for (let i = 1; i < ghost.h - 1; i++) {
      this.setPixel(x0, y0 + i, color);
      this.setPixel(x0 + ghost.w - 1, y0 + i, color);
    }
  }

  private drawPlayer(camera: Camera, player: Player): void {
    const originX = Math.round(player.x + SPRITE_OFFSET_X - camera.x);
    const originY = Math.round(player.y + SPRITE_OFFSET_Y - camera.y);
    const flip = player.facing === -1;

    if (player.thrusting) this.drawThrustExhaust(originX, originY);

    for (let y = 0; y < SPRITE_H; y++) {
      for (let x = 0; x < SPRITE_W; x++) {
        const index = SPRITE_PIXELS[y * SPRITE_W + (flip ? SPRITE_W - 1 - x : x)];
        if (index === 0) continue; // 0 — прозрачный
        this.setPixel(originX + x, originY + y, SPRITE_PALETTE[index]);
      }
    }
  }

  /**
   * Выхлоп под ногами, пока работает тяга.
   *
   * Без обратной связи подъём читается левитацией. Не система частиц — три
   * пикселя по флагу: заводить подсистему ради выхлопа преждевременно.
   */
  private drawThrustExhaust(originX: number, originY: number): void {
    const footY = originY + SPRITE_H;
    const centerX = originX + Math.floor(SPRITE_W / 2);
    // Ядро ярче, шлейф тусклее — читается факелом даже в три пикселя. Градиент
    // несёт и тон, и яркость (196.6 → 162.6 → 99.8): без убывания яркости
    // факел рассыпается на три точки.
    this.setPixel(centerX - 1, footY, RAMP.warm[5]);
    this.setPixel(centerX, footY, RAMP.warm[5]);
    this.setPixel(centerX - 1, footY + 1, RAMP.violet[5]);
    this.setPixel(centerX, footY + 1, RAMP.violet[5]);
    this.setPixel(centerX - 1, footY + 2, RAMP.violet[3]);
  }

  /**
   * Прицел мыши и контур кисти под ним.
   *
   * Прицел показывает КУДА, контур — СКОЛЬКО. Цвет обоих означает достижимость
   * цели: без него недостижимая цель выглядит сломанным копанием. Контур
   * следует той же логике, иначе обещает выемку там, где её не будет,
   * и приглушён — кольцо вдвое длиннее крестика.
   *
   * Режим инструмента виден ЗДЕСЬ, а не только в строке состояния. Различаются
   * размер контура и форма крестика (копание — лучи наружу, сбор — штрихи
   * внутрь); цвет занят достижимостью и режимом не пользуется.
   */
  private drawAim(
    sx: number,
    sy: number,
    inReach: boolean,
    collecting: boolean,
    collectRadius: number,
  ): void {
    const x = Math.round(sx);
    const y = Math.round(sy);

    const ring = collecting ? vacuumOutline(collectRadius) : BRUSH_OUTLINE;
    // Достижимо — зелёная пара, недостижимо — серая. Оранжевый, которым прицел
    // был раньше, теперь занят лавой и подсветкой кромок, а зелёного в кадре
    // нет вовсе: на коричневом грунте и сливовой пещере он выделяется сильнее
    // всего. В обеих парах кольцо остаётся тусклее крестика (67 против 180
    // и 70 против 106) — оно вдвое длиннее и при равной яркости перебивало бы
    // саму точку прицеливания. Серый крестик совпадает с корпусом конвейера
    // (`gray[5]`) и на ленте пропадает; курсор при этом остаётся виден
    // по кольцу — оно на ступень темнее и с лентой не совпадает.
    const outline = inReach ? RAMP.green[1] : RAMP.gray[4];
    for (let i = 0; i < ring.length; i += 2) {
      this.setPixel(x + ring[i]!, y + ring[i + 1]!, outline);
    }

    const color = inReach ? RAMP.green[4] : RAMP.gray[5];

    // Копание бьёт наружу, сбор тянет внутрь: лучи у одного начинаются в двух
    // ячейках от центра и уходят от него, у другого стоят вплотную к кольцу
    // и указывают на центр.
    const arms = collecting ? [-1, 1] : [-3, -2, 2, 3];
    for (const d of arms) {
      this.setPixel(x + d, y, color);
      this.setPixel(x, y + d, color);
    }
    // Достижимую цель дополнительно отмечаем ядром: отличие должно читаться
    // и по форме, а не только по яркости.
    if (inReach) this.setPixel(x, y, color);
  }

  private setPixel(x: number, y: number, color: number): void {
    const viewW = this.display.width;
    if (x < 0 || y < 0 || x >= viewW || y >= this.display.height) return;
    const i = (y * viewW + x) * 4;
    const px = this.display.pixels;
    px[i] = (color >> 16) & 0xff;
    px[i + 1] = (color >> 8) & 0xff;
    px[i + 2] = color & 0xff;
  }

  /**
   * Строка состояния: режим, инвентарь, вещество и счёт. Рисуется ВСЕГДА
   * и к диагностике отношения не имеет — без неё игрок узнаёт о заполненном
   * инвентаре только по тому, что сбор перестал работать. Внизу кадра: верхний
   * левый угол занят диагностикой.
   */
  private drawStatus(hud: HudState): void {
    const ctx = this.display.ctx;
    const viewW = this.display.width;
    const viewH = this.display.height;
    ctx.font = UI_FONT;
    ctx.textBaseline = 'alphabetic';

    const carried =
      hud.carried.length > 0 ? hud.carried.map((c) => `${c.name} ${c.count}`).join('  ') : 'пусто';

    // Выбранный вид постройки стоит рядом с подписью режима, а не в отдельной
    // строке: он относится к режиму и без него бессмыслен.
    const mode = hud.buildKind ? `${hud.mode}: ${hud.buildKind}` : hud.mode;
    this.text(`${mode}   ${hud.used}/${hud.capacity}   ${carried}`, 8, viewH - 28, RAMP.gray[9]);
    // Причина отказа — тем же цветом, что и негодный контур: связь между
    // красной рамкой и надписью не должна требовать догадки.
    if (hud.buildIssue) {
      const at = 8 + ctx.measureText(`${mode}   `).width;
      this.text(hud.buildIssue, at, viewH - 48, MACHINE_STATE_COLORS.blocked);
    }
    const second = hud.machineSummary
      ? `Высыпать: ${hud.selected}   ${hud.machineSummary}`
      : `Высыпать: ${hud.selected}`;
    this.text(second, 8, viewH - 8, RAMP.gray[9]);

    // Счёт — справа и цветом корпуса модуля: единственное место, куда кредиты
    // приходят, и единственное золотое пятно в кадре. Связь читается без подписи.
    //
    // Очки исследований стоят СТРОКОЙ ВЫШЕ, у того же края: обе валюты приходят
    // из одного места и обе видны сразу, но разведены по строкам — «250 ₡ 12 ✦»
    // одной строкой читается как одно число с двумя знаками. Цвет холодный
    // против золота кредитов: валюты разводятся тоном, а не яркостью, и тот же
    // `blue[5]` показывает очки внутри оверлея.
    const credits = `${hud.credits} ₡`;
    this.text(credits, viewW - 8 - ctx.measureText(credits).width, viewH - 8, RAMP.warm[4]);
    const research = `${hud.research} ✦`;
    this.text(research, viewW - 8 - ctx.measureText(research).width, viewH - 28, RAMP.blue[5]);
  }

  /** Диагностика поверх кадра. Включается F3 — иначе мешает оценивать картинку. */
  private drawDebug(fps: number, material: string): void {
    if (fps <= 0) return;
    const ctx = this.display.ctx;
    ctx.font = UI_FONT;
    ctx.textBaseline = 'top';

    const lines = [`${fps.toFixed(0)} FPS`];
    // Установка вслепую бесполезна: игрок обязан видеть, что именно поставит.
    if (material) lines.push(`Q/E: ${material}`);

    lines.forEach((line, i) => this.text(line, 8, 8 + i * 20, RAMP.green[4]));
  }

  /**
   * Надпись с подложкой: без неё текст тонет в кадре.
   *
   * Подложка — цвет неба, а не чистый чёрный: чёрного в гамме нет вовсе,
   * и единственное место на экране с цветом вне набора не должно заводиться
   * ради тени под буквами.
   */
  private text(line: string, x: number, y: number, color: number): void {
    const ctx = this.display.ctx;
    ctx.fillStyle = css(RAMP.gray[0]);
    ctx.fillText(line, x + 2, y + 2);
    ctx.fillStyle = css(color);
    ctx.fillText(line, x, y);
  }
}
