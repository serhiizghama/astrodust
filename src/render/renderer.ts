import { CONVEYOR, BUILD_MODULE, SIM_HZ, SHADING, UI } from '../config';
import { Display } from '../core';
import { Camera } from './camera';
import { World, MAT, MAT_CARRY } from '../world';
import { SHADE_R, SHADE_G, SHADE_B, CONVEYOR_ROLLER_COLOR } from './material-colors';
import { GRAIN } from './grain';
import { BAYER, DITHER_MASK, DITHER_LEVELS, threshold } from './dither';
import { Lightmap, LIGHT_NEUTRAL } from './lightmap';
import { Backdrop } from './backdrop';
import { RAMP } from '../palette';
import { setPixel, fillRect, strokeRect, blit } from './draw';
import { smallText } from './ui';
import type { UiSurface } from './ui';
import { hudLayout, drawActionBar, drawCreditsCounter, drawBarLine } from './hud';
import type { HudSlot } from './hud';
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

/** Сколько ступеней у интерьера пещеры: у выхода и в глубине. */
const CAVE_SHADES = 2;

/** Отступ диагностики от левого верхнего угла кадра. */
const DEBUG_MARGIN = 4;

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

/**
 * Лучи прицела: смещения вдоль каждой оси от центра. Держит
 * `tests/terrain-digging.ts`.
 */
const AIM_ARMS = [-3, -2, 2, 3] as const;

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

const ROLLER_R = (CONVEYOR_ROLLER_COLOR >> 16) & 0xff;
const ROLLER_G = (CONVEYOR_ROLLER_COLOR >> 8) & 0xff;
const ROLLER_B = CONVEYOR_ROLLER_COLOR & 0xff;

/**
 * Насколько ролики ушли вперёд к этому моменту игрового времени, в ячейках.
 * Считается ИЗ `stepsPerCell`: ролик, бегущий быстрее груза, — врущий прибор.
 * Игровым временем, а не кадрами: на 144 Гц темп тот же, что и на 60.
 */
export function rollerOffset(time: number): number {
  return Math.floor((time * SIM_HZ) / CONVEYOR.stepsPerCell);
}

/**
 * Маска ряда внутри секции. Модуль — степень двойки ровно ради этой маски:
 * ряд берётся в горячем цикле на каждый пиксель ленты, и деление там дороже.
 */
const MODULE_MASK = BUILD_MODULE - 1;
/** Ряды секции, занятые роликами: середина корпуса. */
const ROLLER_FROM = CONVEYOR.rollerInset;
const ROLLER_TO = BUILD_MODULE - CONVEYOR.rollerInset;

/**
 * Что показать в интерфейсе и каким нарисовать прицел.
 *
 * Одна структура, а не восемь аргументов подряд: рендер про инвентарь ничего
 * не решает, он его показывает, и список того, что показать, обязан читаться
 * на месте вызова.
 */
export interface HudState {
  /**
   * Слоты панели действий по порядку. Подпись клавиши и вид действия — данные
   * ВИДА, а не режим из `core`: так рендер не заводит у себя правил выбора
   * инструмента, а снапшот панели можно собрать руками в проверке.
   */
  readonly slots: readonly HudSlot[];
  readonly activeSlot: number;
  /** Слот под курсором, или `null`. Мыши не было — подсветки в кадре нет. */
  readonly hoveredSlot: number | null;
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
  /**
   * Открыт ли пылесос. Ёмкость, которой у игрока ещё нет, в кадре
   * не показывается: счётчик «0 из 4096» называет предел, до которого нечем
   * дойти, и читается поломкой, а не целью.
   */
  readonly hasVacuum: boolean;
  /** Комок в захвате: состав и заполнение. Видны ВСЕГДА — захват есть с первого кадра. */
  readonly grabHeld: readonly { readonly name: string; readonly count: number }[];
  readonly grabUsed: number;
  readonly grabCapacity: number;
  /**
   * Счёт кредитов — единственная валюта игры. Виден ВСЕГДА, а не только внутри
   * оверлея: это ответ на вопрос «что я сейчас могу открыть», и валюта,
   * которую видно только в меню, из этого решения выпадает.
   */
  readonly credits: number;
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
   * Что сделает захват и каких ячеек это коснётся. `null` вне режима захвата.
   *
   * План приходит ГОТОВЫМ из шага, а не считается здесь: правило «набор или
   * выброс» живёт в `systems`, и второй его экземпляр в рендере однажды
   * разошёлся бы с первым — подсветка обещала бы не то, что произойдёт.
   */
  readonly grab: GrabView | null;
  /**
   * Подпись выбранного вида постройки. Пустая строка — не в режиме
   * строительства.
   *
   * Видна ДО применения: контур под целью показывает размер и годность, но
   * не говорит, что именно встанет, а видов с одинаковым прямоугольником
   * в каталоге уже два. Цены здесь нет — постройка бесплатна.
   */
  readonly buildKind: string;
  /**
   * Почему место негодно, словами. Красный контур отвечает «нельзя», но
   * не «почему», а все три причины исправимы прямо сейчас: отойти или
   * расчистить.
   */
  readonly buildIssue: string;
  /** Стоящие машины: состояние обязано читаться с самой машины, а не из угла кадра. */
  readonly machines: readonly MachineView[];
  /** Оверлей исследований, если он открыт. `null` — закрыт. */
  readonly overlay: OverlayView | null;
}

export interface GhostView {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly ok: boolean;
  /**
   * Сторона переноса, которую задаст применение, или `0` — у вида её нет.
   *
   * В контуре, а не только в подписи: игрок обязан узнать, куда повезёт лента,
   * ДО того, как она встанет, а смотрит он в место постановки, а не под панель.
   */
  readonly side: -1 | 0 | 1;
}

/**
 * План захвата для кадра.
 *
 * `cells` — ЧУЖОЙ переиспользуемый буфер: пары `x, y` в координатах мира,
 * значимы первые `count * 2` элементов. Копии здесь нет намеренно — план
 * считается в шаге и рисуется тем же кадром, а копирование 338 чисел на кадр
 * ради формальной неизменяемости не окупается.
 */
export interface GrabView {
  readonly action: 'take' | 'drop' | 'none';
  readonly cells: Int16Array;
  readonly count: number;
  /** Сторона квадрата в ячейках: контур рисуется по ней, а не по числу ячеек. */
  readonly side: number;
  readonly used: number;
  readonly capacity: number;
  /** Куда наведён квадрат, в координатах мира. */
  readonly targetX: number;
  readonly targetY: number;
}

function contents(items: readonly { readonly name: string; readonly count: number }[]): string {
  return items.length > 0 ? items.map((c) => `${c.name} ${c.count}`).join('  ') : 'пусто';
}

/**
 * Строка «что я несу»: захват всегда, инвентарь — только когда пылесос открыт.
 *
 * Отдельная функция, а не выражение по месту: правило «пустой ёмкости в кадре
 * нет» проверяемо без браузера, и жить оно должно там, где его видно проверке.
 */
export function carryLine(hud: HudState): string {
  const grab = `Захват ${hud.grabUsed}/${hud.grabCapacity}   ${contents(hud.grabHeld)}`;
  if (!hud.hasVacuum) return grab;
  return `${grab}   ·   Инвентарь ${hud.used}/${hud.capacity}   ${contents(hud.carried)}   Высыпать: ${hud.selected}`;
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
    /**
     * Поверхность слоя интерфейса. Подставляется снаружи, а не создаётся здесь:
     * в браузере это канвас, в проверке — журнал, и кадр интерфейса проверяется
     * без канваса ровно поэтому.
     */
    private readonly ui: UiSurface,
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
    this.drawWorld(camera, maxSurface, rollerOffset(time));
    this.drawMachines(camera, hud.machines);
    this.drawPlayer(camera, player);
    if (hud.ghost) this.drawGhost(camera, hud.ghost);
    // Подсветка захвата — ДО прицела: крестик обязан остаться поверх неё,
    // иначе точка прицеливания теряется в залитом квадрате.
    if (hud.grab) this.drawGrab(camera, hud.grab);
    this.drawAim(crosshairX, crosshairY, crosshairInReach);

    // Мир — на экран, и только потом интерфейс. Порядок обратный сломал бы
    // не картинку, а сам замысел: интерфейс лёг бы под вывод буфера и исчез.
    // Всё, что нарисовано в буфер после этой строки, на экран уже не попадёт.
    this.display.present();

    this.ui.begin();
    this.drawHud(hud);
    this.drawDebug(fps, debugMaterial);
    // Оверлей — последним из РИСУЮЩИХ: он перекрывает и мир, и интерфейс, и это
    // правильный порядок. Пока он открыт, низ кадра всё равно не описывает того,
    // чем игрок сейчас занят.
    if (hud.overlay) {
      drawResearchOverlay(this.ui, this.display.width, this.display.height, hud.overlay);
    }
    this.ui.end();
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
    const period = BUILD_MODULE;
    const roller = CONVEYOR.rollerWidth;
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
      // Ряд роликов внутри секции. Считается РАЗ НА СТРОКУ: `wy` на всю строку
      // один, а условие проверяется на каждый пиксель ленты.
      const rollerRow = (wy & MODULE_MASK) >= ROLLER_FROM && (wy & MODULE_MASK) < ROLLER_TO;

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
          if (
            carry !== 0 &&
            rollerRow &&
            (((wx - carry * offset) % period) + period) % period < roller
          ) {
            px[idx] = ROLLER_R;
            px[idx + 1] = ROLLER_G;
            px[idx + 2] = ROLLER_B;
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
      // Ряд роликов внутри секции. Считается РАЗ НА СТРОКУ: `wy` на всю строку
      // один, а условие проверяется на каждый пиксель ленты.
      const rollerRow = (wy & MODULE_MASK) >= ROLLER_FROM && (wy & MODULE_MASK) < ROLLER_TO;

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
          if (
            carry !== 0 &&
            rollerRow &&
            (((wx - carry * offset) % period) + period) % period < roller
          ) {
            px[idx] = ROLLER_R;
            px[idx + 1] = ROLLER_G;
            px[idx + 2] = ROLLER_B;
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
      fillRect(this.display.pixels, viewW, viewH, sx, sy, filled, 1, color);
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
    const color = ghost.ok ? MACHINE_STATE_COLORS.working : MACHINE_STATE_COLORS.blocked;
    strokeRect(
      this.display.pixels,
      this.display.width,
      this.display.height,
      ghost.x - camera.x,
      ghost.y - camera.y,
      ghost.w,
      ghost.h,
      color,
    );
    if (ghost.side !== 0) this.drawGhostSide(camera, ghost, color);
  }

  /**
   * Сторона переноса — стрелкой у ТОГО КРАЯ контура, куда повезёт лента.
   * Край, а не середина: середину линии длиной в двадцать секций игрок
   * не разглядывает, а край — это то место, где груз с ленты сойдёт.
   *
   * Клин из пикселей, а не значок: контур рисуется в буфер мира, где всё
   * измеряется ячейками, и половина секции — четыре ряда — не оставляет места
   * ни на что сложнее.
   */
  private drawGhostSide(camera: Camera, ghost: GhostView, color: number): void {
    const px = this.display.pixels;
    const viewW = this.display.width;
    const viewH = this.display.height;
    const midY = ghost.y + (ghost.h >> 1) - camera.y;
    const tipX = (ghost.side > 0 ? ghost.x + ghost.w : ghost.x - 1) - camera.x;
    const half = ghost.h >> 1;
    for (let k = 0; k < half; k++) {
      const x = tipX - ghost.side * k;
      for (let dy = -k; dy <= k; dy++) {
        const y = midY + dy;
        if (x < 0 || y < 0 || x >= viewW || y >= viewH) continue;
        if (dy !== -k && dy !== k) continue;
        const i = (y * viewW + x) << 2;
        px[i] = (color >> 16) & 0xff;
        px[i + 1] = (color >> 8) & 0xff;
        px[i + 2] = color & 0xff;
      }
    }
  }

  /**
   * Захват: контур квадрата со шкалой заполнения по периметру и подсветка
   * затрагиваемых ячеек.
   *
   * Исключение из правила «прицел показывает точку, а не обводит площадь»,
   * по которому у копания и сбора предпросмотра нет. Держится на том, что
   * вопросы разные: ширину копательной кисти игрок узнаёт, копнув, а
   * пригодность ячейки и остаток места проверить нечем, кроме как потеряв
   * комок. Обоснование целиком — в спеке `matter-grabber`.
   */
  private drawGrab(camera: Camera, grab: GrabView): void {
    const take = grab.action === 'take';
    // Разные СЕМЕЙСТВА лестницы, а не соседние ступени одного: «беру»
    // и «кладу» различаются до нажатия, и различие обязано пережить
    // и светлый реголит, и тёмную пещеру. Синий не путается с водой —
    // выброс подсвечивает только пустые ячейки, а вода пустой не бывает.
    const tint = take ? RAMP.green[4] : RAMP.blue[4];

    // Через ячейку по Байеру: сплошная заливка закрыла бы вещество под собой,
    // а вопрос захвата ровно про то, какое вещество он берёт.
    for (let i = 0; i < grab.count; i++) {
      const x = grab.cells[i * 2]! - camera.x;
      const y = grab.cells[i * 2 + 1]! - camera.y;
      if (threshold(x, y) >= 0.5) continue;
      this.setPixel(x, y, tint);
    }

    this.drawGrabFrame(camera, grab, tint);
  }

  /**
   * Контур квадрата, он же шкала заполнения: первая доля периметра — ярким
   * тоном, остаток — тусклым.
   *
   * Периметр, а не заливка внутри: внутренность занята подсветкой ячеек,
   * и второй слой поверх неё сделал бы нечитаемыми оба. Обход начинается
   * с левого верхнего угла по часовой стрелке — направление произвольно,
   * но постоянно, иначе шкала «дёргалась» бы между кадрами.
   */
  private drawGrabFrame(camera: Camera, grab: GrabView, tint: number): void {
    const half = (grab.side - 1) >> 1;
    const left = grab.targetX - half - camera.x;
    const top = grab.targetY - half - camera.y;
    const side = grab.side;
    const perimeter = 4 * side - 4;
    const filled = Math.round((grab.used / grab.capacity) * perimeter);

    for (let k = 0; k < perimeter; k++) {
      let x: number;
      let y: number;
      if (k < side) {
        x = left + k;
        y = top;
      } else if (k < 2 * side - 1) {
        x = left + side - 1;
        y = top + (k - side + 1);
      } else if (k < 3 * side - 2) {
        x = left + side - 1 - (k - (2 * side - 2));
        y = top + side - 1;
      } else {
        x = left;
        y = top + side - 1 - (k - (3 * side - 3));
      }
      this.setPixel(x, y, k < filled ? tint : RAMP.gray[4]);
    }
  }

  private drawPlayer(camera: Camera, player: Player): void {
    const originX = Math.round(player.x + SPRITE_OFFSET_X - camera.x);
    const originY = Math.round(player.y + SPRITE_OFFSET_Y - camera.y);

    if (player.thrusting) this.drawThrustExhaust(originX, originY);

    blit(
      this.display.pixels,
      this.display.width,
      this.display.height,
      SPRITE_PIXELS,
      SPRITE_W,
      SPRITE_H,
      originX,
      originY,
      SPRITE_PALETTE,
      player.facing === -1,
    );
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
   * Прицел мыши: четыре луча и ядро.
   *
   * Цвет означает достижимость цели: без него недостижимая цель выглядит
   * сломанным копанием. Достижимую отмечает ещё и ядро — отличие обязано
   * читаться формой, а не только яркостью.
   *
   * Инвариант: между лучами и центром остаётся разрыв в ячейку. Сплошной плюс
   * съедает ядро, и от достижимости остаётся один цвет.
   *
   * Режима инструмента прицел не знает: фигура одна на все режимы.
   */
  private drawAim(sx: number, sy: number, inReach: boolean): void {
    const x = Math.round(sx);
    const y = Math.round(sy);

    // Достижимо — зелёный, недостижимо — серый. Оранжевый, которым прицел был
    // раньше, занят лавой и подсветкой кромок, а зелёного в кадре нет вовсе:
    // на коричневом грунте и сливовой пещере он выделяется сильнее всего.
    const color = inReach ? RAMP.green[4] : RAMP.gray[5];

    for (const d of AIM_ARMS) {
      this.setPixel(x + d, y, color);
      this.setPixel(x, y + d, color);
    }
    if (inReach) this.setPixel(x, y, color);
  }

  private setPixel(x: number, y: number, color: number): void {
    setPixel(this.display.pixels, this.display.width, this.display.height, x, y, color);
  }

  /**
   * Постоянный интерфейс: панель действий, счётчики валют и строка инвентаря.
   *
   * Рисуется ВСЕГДА и к диагностике отношения не имеет — без него игрок узнаёт
   * о заполненном инвентаре только по тому, что сбор перестал работать.
   *
   * Подписи режима здесь нет: режим читается по выделенному слоту панели,
   * и вторая запись того же состояния однажды разошлась бы с первой.
   */
  private drawHud(hud: HudState): void {
    const viewW = this.display.width;
    const viewH = this.display.height;
    const layout = hudLayout(viewW, viewH);

    drawActionBar(this.ui, layout, hud.slots, hud.activeSlot, hud.hoveredSlot);
    drawCreditsCounter(this.ui, viewW, hud.credits);

    drawBarLine(this.ui, viewW, layout, 0, carryLine(hud), RAMP.gray[9]);

    // Вид постройки и причина отказа — ТОЛЬКО в режиме строительства и над
    // панелью, туда, куда игрок смотрит, выбирая место. Вне режима этих строк
    // в кадре нет вовсе.
    if (hud.buildKind) drawBarLine(this.ui, viewW, layout, 1, hud.buildKind, RAMP.gray[9]);
    // Причина отказа — тем же цветом, что и негодный контур: связь между
    // красной рамкой и надписью не должна требовать догадки.
    if (hud.buildIssue) {
      drawBarLine(this.ui, viewW, layout, 2, hud.buildIssue, MACHINE_STATE_COLORS.blocked);
    }
  }

  /**
   * Диагностика поверх кадра. Включается F3 — иначе мешает оценивать картинку.
   *
   * В слое интерфейса, а не в буфере мира: это текст, а весь текст игры живёт
   * там. Заодно снимок мира перестал зависеть от того, включена ли она.
   */
  private drawDebug(fps: number, material: string): void {
    if (fps <= 0) return;

    const lines = [`${fps.toFixed(0)} FPS`];
    // Установка вслепую бесполезна: игрок обязан видеть, что именно поставит.
    if (material) lines.push(`Q/E: ${material}`);

    lines.forEach((line, i) =>
      this.ui.text(
        line,
        DEBUG_MARGIN,
        DEBUG_MARGIN + i * UI.line,
        smallText(RAMP.green[4], { shadow: true }),
      ),
    );
  }
}
