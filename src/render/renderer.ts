import { VIEW_W, VIEW_H, DIG, VACUUM, CONVEYOR, SIM_HZ } from '../config';
import { Display } from '../core';
import { Camera } from './camera';
import { World, MAT, MAT_CARRY } from '../world';
import { MAT_R, MAT_G, MAT_B, CONVEYOR_STRIPE_COLOR } from './material-colors';
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
 * Только периметр, без заливки. Кадр — один непрозрачный буфер, альфа-
 * композитинга нет, и «полупрозрачную» заливку пришлось бы делать смешиванием
 * цветов на каждый пиксель области — лишняя работа в горячем цикле ради
 * предпросмотра. Контур несёт ту же информацию и вдобавок не закрывает то,
 * что игрок собирается выкопать.
 *
 * Считается один раз: радиус — константа конфига, и перебирать квадрат
 * (2r+1)² на каждый кадр ради неизменного набора точек незачем. Плоский
 * типизированный массив, а не массив пар, — обход без разыменований
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

export const BRUSH_OUTLINE = brushOutline(DIG.radius);
/**
 * Контур кисти сбора. Радиус свой, и это единственное, чем отличается вызов:
 * обещать выемку размером с копательную кисть там, где всосётся вдвое меньше,
 * — то же враньё, что и не показывать радиус вовсе.
 */
export const VACUUM_OUTLINE = brushOutline(VACUUM.radius);

/**
 * Контур кисти сбора для ЛЮБОГО радиуса, с памятью на посчитанное.
 *
 * Радиус сбора перестал быть константой — его правит технология, — и кольцо
 * обязано следовать за ним. Кольцо, застывшее на базовом радиусе, обещало бы
 * выемку меньше настоящей ровно после того, как игрок заплатил за большую:
 * тот же обман, что и кольцо размером с копательную кисть в режиме сбора.
 *
 * Память нужна потому, что кольцо рисуется каждый кадр, а различных радиусов
 * за партию бывает три. Перебирать квадрат (2r+1)² по шестьдесят раз в секунду
 * ради неизменного набора точек незачем.
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
 * Цвета состояния машины — и они же язык годности при постановке.
 *
 * Экспортируются, потому что цвет здесь СМЫСЛ, а не оформление: по нему
 * проверки отличают работающую машину от забитой, считая пиксели ровно этого
 * значения. Литерал в проверке означал бы, что перекраска машины молча ломает
 * подсчёт, оставляя проверку зелёной или красной по не относящейся к делу
 * причине.
 *
 * Зелёные — из той же лестницы, что и достижимый прицел, но НЕ те же ступени,
 * и это ограничение измерения, а не вкуса: прицел рисуется в том же кадре,
 * что и машина, и на общем цвете подсчёт пикселей полосы начинал считать
 * заодно крестик с кольцом. Проверка при этом продолжала бы проходить — просто
 * по другой причине. Взяты крайние ступени: простой `green[0]`, работа
 * `green[5]`; обе отстоят от корпуса сепаратора (`green[2]`) минимум на две.
 *
 * Отказ взял `rust[5]`, а не более привычную лаву `rust[4]`: цвет негодности
 * не должен совпадать с площадным веществом, иначе рамка призрака
 * растворяется ровно над расплавом.
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
 * Насколько бегущая полоса ушла вперёд к данному моменту игрового времени,
 * в ячейках.
 *
 * Считается ИЗ `stepsPerCell`, а не из своей константы: по полосе игрок судит
 * о темпе ленты, и полоса, бегущая вдвое быстрее груза, — это врущий прибор.
 * Общий источник — единственный способ не дать им разойтись.
 *
 * Игровым временем, а не номером кадра: на 144 Гц полоса обязана бежать с той
 * же скоростью, что и на 60, — ровно как и сам груз.
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
   * Почему место негодно, словами. Пустая строка — годно или не в режиме
   * строительства.
   *
   * Красный контур отвечает «нельзя», но не отвечает «почему», а причин
   * четыре, и три из них исправимы прямо сейчас: отойти, расчистить, накопить.
   * Игрок, жмущий кнопку без результата и без объяснения, читает это как
   * поломку — живая проверка показала ровно этот случай: не хватало
   * пятнадцати кредитов, и узнать об этом было неоткуда.
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
  private readonly caveR: number;
  private readonly caveG: number;
  private readonly caveB: number;

  constructor(
    private readonly display: Display,
    private readonly world: World,
    private readonly surface: Int16Array,
    seed: number,
  ) {
    const p = world.profile;
    this.caveR = (p.caveColor >> 16) & 0xff;
    this.caveG = (p.caveColor >> 8) & 0xff;
    this.caveB = p.caveColor & 0xff;
    this.backdrop = new Backdrop(p, seed, surface);
  }

  render(view: FrameView): void {
    const { camera, player, crosshairX, crosshairY, crosshairInReach, hud } = view;
    const fps = view.fps;
    const time = view.time ?? 0;
    const debugMaterial = view.debugMaterial ?? '';

    // Считается один раз на кадр и служит обоим проходам: заднику — признаком
    // «неба в кадре нет», миру — границей, ниже которой проверять небо незачем.
    const maxSurface = this.backdrop.maxSurfaceInView(camera.x);

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
    if (hud.overlay) drawResearchOverlay(this.display.ctx, hud.overlay);
  }

  /**
   * Мир поверх задника.
   *
   * Цикл разрезан по строке, ниже которой неба уже не встречается: в верхней
   * части кадра пустоту приходится различать на небо и пещеру, в нижней —
   * не приходится, и оттуда ветвление убрано совсем. Под землёй верхняя часть
   * пуста, и весь кадр идёт по короткому пути.
   *
   * Бегущая полоса несущих поверхностей рисуется ЗДЕСЬ, внутри уже
   * существующей ветки «ячейка не пустота», а не отдельным проходом: цена —
   * одна выборка `MAT_CARRY[m]` на непустой пиксель, неизмеримая против
   * прохода задника. Отдельный проход пришлось бы вести по списку лент,
   * которого нет и не будет: лента — вещество, а не сущность.
   *
   * Полоса — единственный признак направления: цвет у обоих конвейеров один,
   * иначе игрок был бы обязан запомнить, какой оттенок куда везёт.
   */
  private drawWorld(camera: Camera, maxSurface: number, offset: number): void {
    const px = this.display.pixels;
    const cells = this.world.cells;
    const worldW = this.world.width;
    const camX = camera.x;
    const camY = camera.y;
    const surface = this.surface;
    const period = CONVEYOR.stripePeriod;
    const stripe = CONVEYOR.stripeWidth;

    let splitRow = maxSurface - camY;
    if (splitRow < 0) splitRow = 0;
    else if (splitRow > VIEW_H) splitRow = VIEW_H;

    let idx = 0;

    // Верхняя часть: здесь встречается небо, и его пиксели уже нарисованы
    // задником — трогать их нельзя.
    for (let sy = 0; sy < splitRow; sy++) {
      const wy = camY + sy;
      const rowBase = wy * worldW;
      for (let sx = 0; sx < VIEW_W; sx++, idx += 4) {
        const wx = camX + sx;
        const m = cells[rowBase + wx]!;

        if (m !== MAT.VACUUM) {
          const carry = MAT_CARRY[m]!;
          if (carry !== 0 && (((wx - carry * offset) % period) + period) % period < stripe) {
            px[idx] = STRIPE_R;
            px[idx + 1] = STRIPE_G;
            px[idx + 2] = STRIPE_B;
          } else {
            px[idx] = MAT_R[m]!;
            px[idx + 1] = MAT_G[m]!;
            px[idx + 2] = MAT_B[m]!;
          }
        } else if (wy >= surface[wx]!) {
          px[idx] = this.caveR;
          px[idx + 1] = this.caveG;
          px[idx + 2] = this.caveB;
        }
      }
    }

    // Нижняя часть: неба здесь быть не может, пустота — всегда пещера.
    for (let sy = splitRow; sy < VIEW_H; sy++) {
      const rowBase = (camY + sy) * worldW;
      for (let sx = 0; sx < VIEW_W; sx++, idx += 4) {
        const wx = camX + sx;
        const m = cells[rowBase + wx]!;
        if (m !== MAT.VACUUM) {
          const carry = MAT_CARRY[m]!;
          if (carry !== 0 && (((wx - carry * offset) % period) + period) % period < stripe) {
            px[idx] = STRIPE_R;
            px[idx + 1] = STRIPE_G;
            px[idx + 2] = STRIPE_B;
          } else {
            px[idx] = MAT_R[m]!;
            px[idx + 1] = MAT_G[m]!;
            px[idx + 2] = MAT_B[m]!;
          }
        } else {
          px[idx] = this.caveR;
          px[idx + 1] = this.caveG;
          px[idx + 2] = this.caveB;
        }
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
    for (const m of machines) {
      const sx = m.x - camera.x;
      const sy = m.y - camera.y;
      if (sx + m.w < 0 || sy + m.h < 0 || sx >= VIEW_W || sy >= VIEW_H) continue;

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
   * Без обратной связи подъём читается как левитация, а не как работа
   * двигателя. Это не система частиц — три пикселя по флагу: настоящие частицы
   * появятся вместе с пылью из-под ног и искрами при копании, и заводить
   * подсистему ради выхлопа преждевременно.
   */
  private drawThrustExhaust(originX: number, originY: number): void {
    const footY = originY + SPRITE_H;
    const centerX = originX + Math.floor(SPRITE_W / 2);
    // Ядро ярче, шлейф тусклее — читается как факел даже в три пикселя.
    // Градиент несёт теперь И ТОН, И ЯРКОСТЬ: золото → розовый → маджента
    // вместо прежнего затухания внутри одного оранжевого. Убывание яркости
    // при этом сохранено (196.6 → 162.6 → 99.8) — смена тона добавляется
    // к спаду, а не заменяет его, иначе факел рассыпался бы на три точки.
    this.setPixel(centerX - 1, footY, RAMP.warm[5]);
    this.setPixel(centerX, footY, RAMP.warm[5]);
    this.setPixel(centerX - 1, footY + 1, RAMP.violet[5]);
    this.setPixel(centerX, footY + 1, RAMP.violet[5]);
    this.setPixel(centerX - 1, footY + 2, RAMP.violet[3]);
  }

  /**
   * Прицел мыши и контур кисти под ним.
   *
   * Цвет обоих показывает, достижима ли цель для копания: без этого
   * недостижимая цель выглядит как сломанное копание — игрок жмёт кнопку,
   * и ничего не происходит без объяснения. Контур обязан следовать той же
   * логике, иначе он обещает выемку там, где её не будет.
   *
   * Прицел показывает КУДА, контур — СКОЛЬКО: радиус кисти иначе узнаётся
   * только по факту разрушения, и промах обнаруживается уже после него.
   * Контур приглушён намеренно — кольцо вдвое длиннее крестика и при равной
   * яркости перебивало бы саму точку прицеливания.
   *
   * Режим инструмента виден ЗДЕСЬ, а не только в строке состояния: узнавать
   * режим по углу кадра, а не по тому, на что смотришь, — лишний путь глазами.
   * Отличается и размер контура (у сбора кисть меньше), и форма крестика:
   * копание — четыре луча наружу, сбор — четыре штриха внутрь, как всасывание.
   * Цвет остаётся признаком достижимости и режимом не занят.
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
    if (x < 0 || y < 0 || x >= VIEW_W || y >= VIEW_H) return;
    const i = (y * VIEW_W + x) * 4;
    const px = this.display.pixels;
    px[i] = (color >> 16) & 0xff;
    px[i + 1] = (color >> 8) & 0xff;
    px[i + 2] = color & 0xff;
  }

  /**
   * Строка состояния: режим, инвентарь, выбранное вещество и счёт.
   *
   * Рисуется ВСЕГДА и к диагностике отношения не имеет. Диагностика —
   * инструмент разработчика, а инвентарь и счёт — состояние игры: не видя их,
   * игрок не понимает, что делает, и узнаёт о заполненном инвентаре только
   * по тому, что сбор перестал работать.
   *
   * Внизу кадра, а не вверху: верхний левый угол занят диагностикой, а взгляд
   * во время игры держится на персонаже в центре — служебная строка не должна
   * спорить с небом и горизонтом.
   */
  private drawStatus(hud: HudState): void {
    const ctx = this.display.ctx;
    ctx.font = '8px monospace';
    ctx.textBaseline = 'alphabetic';

    const carried =
      hud.carried.length > 0 ? hud.carried.map((c) => `${c.name} ${c.count}`).join('  ') : 'пусто';

    // Выбранный вид постройки стоит рядом с подписью режима, а не в отдельной
    // строке: он относится к режиму и без него бессмыслен.
    const mode = hud.buildKind ? `${hud.mode}: ${hud.buildKind}` : hud.mode;
    this.text(`${mode}   ${hud.used}/${hud.capacity}   ${carried}`, 4, VIEW_H - 14, RAMP.gray[9]);
    // Причина отказа — тем же цветом, что и негодный контур: связь между
    // красной рамкой и надписью не должна требовать догадки.
    if (hud.buildIssue) {
      const at = 4 + ctx.measureText(`${mode}   `).width;
      this.text(hud.buildIssue, at, VIEW_H - 24, MACHINE_STATE_COLORS.blocked);
    }
    const second = hud.machineSummary
      ? `Высыпать: ${hud.selected}   ${hud.machineSummary}`
      : `Высыпать: ${hud.selected}`;
    this.text(second, 4, VIEW_H - 4, RAMP.gray[9]);

    // Счёт — справа и цветом корпуса модуля: единственное место, куда кредиты
    // приходят, и единственное золотое пятно в кадре. Связь читается без подписи.
    //
    // Очки исследований стоят СТРОКОЙ ВЫШЕ, у того же края: обе валюты приходят
    // из одного места и обе видны сразу, но разведены по строкам — «250 ₡ 12 ✦»
    // одной строкой читается как одно число с двумя знаками. Цвет холодный
    // против золота кредитов: валюты разводятся тоном, а не яркостью, и тот же
    // `blue[5]` показывает очки внутри оверлея.
    const credits = `${hud.credits} ₡`;
    this.text(credits, VIEW_W - 4 - ctx.measureText(credits).width, VIEW_H - 4, RAMP.warm[4]);
    const research = `${hud.research} ✦`;
    this.text(research, VIEW_W - 4 - ctx.measureText(research).width, VIEW_H - 14, RAMP.blue[5]);
  }

  /** Диагностика поверх кадра. Включается F3 — иначе мешает оценивать картинку. */
  private drawDebug(fps: number, material: string): void {
    if (fps <= 0) return;
    const ctx = this.display.ctx;
    ctx.font = '8px monospace';
    ctx.textBaseline = 'top';

    const lines = [`${fps.toFixed(0)} FPS`];
    // Установка вслепую бесполезна: игрок обязан видеть, что именно поставит.
    if (material) lines.push(`Q/E: ${material}`);

    lines.forEach((line, i) => this.text(line, 4, 4 + i * 10, RAMP.green[4]));
  }

  /**
   * Надпись с подложкой в один пиксель: без неё текст тонет в кадре.
   *
   * Подложка — цвет неба, а не чистый чёрный: чёрного в гамме нет вовсе,
   * и единственное место на экране с цветом вне набора не должно заводиться
   * ради тени под буквами.
   */
  private text(line: string, x: number, y: number, color: number): void {
    const ctx = this.display.ctx;
    ctx.fillStyle = css(RAMP.gray[0]);
    ctx.fillText(line, x + 1, y + 1);
    ctx.fillStyle = css(color);
    ctx.fillText(line, x, y);
  }
}
