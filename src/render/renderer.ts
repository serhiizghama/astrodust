import { VIEW_W, VIEW_H, DIG, VACUUM } from '../config';
import { Display } from '../core/display';
import { Camera } from './camera';
import { World } from '../world/world';
import { MAT, MAT_R, MAT_G, MAT_B } from '../world/materials';
import { Backdrop } from './backdrop';
import {
  Player,
  SPRITE_PIXELS,
  SPRITE_PALETTE,
  SPRITE_W,
  SPRITE_H,
  SPRITE_OFFSET_X,
  SPRITE_OFFSET_Y,
} from '../entities/player';

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
  readonly carried: readonly { readonly name: string; readonly count: number }[];
  readonly used: number;
  readonly capacity: number;
  readonly selected: string;
  readonly credits: number;
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

  render(
    camera: Camera,
    player: Player,
    crosshairX: number,
    crosshairY: number,
    crosshairInReach: boolean,
    hud: HudState,
    fps: number,
    time = 0,
    debugMaterial = '',
  ): void {
    // Считается один раз на кадр и служит обоим проходам: заднику — признаком
    // «неба в кадре нет», миру — границей, ниже которой проверять небо незачем.
    const maxSurface = this.backdrop.maxSurfaceInView(camera.x);

    this.backdrop.draw(this.display.pixels, camera.x, camera.y, time, maxSurface);
    this.drawWorld(camera, maxSurface);
    this.drawPlayer(camera, player);
    this.drawAim(crosshairX, crosshairY, crosshairInReach, hud.collecting);
    this.display.present();
    this.drawStatus(hud);
    this.drawDebug(fps, debugMaterial);
  }

  /**
   * Мир поверх задника.
   *
   * Цикл разрезан по строке, ниже которой неба уже не встречается: в верхней
   * части кадра пустоту приходится различать на небо и пещеру, в нижней —
   * не приходится, и оттуда ветвление убрано совсем. Под землёй верхняя часть
   * пуста, и весь кадр идёт по короткому пути.
   */
  private drawWorld(camera: Camera, maxSurface: number): void {
    const px = this.display.pixels;
    const cells = this.world.cells;
    const worldW = this.world.width;
    const camX = camera.x;
    const camY = camera.y;
    const surface = this.surface;

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
          px[idx] = MAT_R[m]!;
          px[idx + 1] = MAT_G[m]!;
          px[idx + 2] = MAT_B[m]!;
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
        const m = cells[rowBase + camX + sx]!;
        if (m !== MAT.VACUUM) {
          px[idx] = MAT_R[m]!;
          px[idx + 1] = MAT_G[m]!;
          px[idx + 2] = MAT_B[m]!;
        } else {
          px[idx] = this.caveR;
          px[idx + 1] = this.caveG;
          px[idx + 2] = this.caveB;
        }
      }
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
    this.setPixel(centerX - 1, footY, 0xffd27a);
    this.setPixel(centerX, footY, 0xffd27a);
    this.setPixel(centerX - 1, footY + 1, 0xff8a3c);
    this.setPixel(centerX, footY + 1, 0xff8a3c);
    this.setPixel(centerX - 1, footY + 2, 0x8a3a1c);
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
  private drawAim(sx: number, sy: number, inReach: boolean, collecting: boolean): void {
    const x = Math.round(sx);
    const y = Math.round(sy);

    const ring = collecting ? VACUUM_OUTLINE : BRUSH_OUTLINE;
    const outline = inReach ? 0x5c3612 : 0x33313a;
    for (let i = 0; i < ring.length; i += 2) {
      this.setPixel(x + ring[i]!, y + ring[i + 1]!, outline);
    }

    const color = inReach ? 0xff9a3c : 0x5a5560;

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

    this.text(`${hud.mode}   ${hud.used}/${hud.capacity}   ${carried}`, 4, VIEW_H - 14, 0xe8e4dc);
    this.text(`Высыпать: ${hud.selected}`, 4, VIEW_H - 4, 0xe8e4dc);

    // Счёт — справа и цветом корпуса модуля: единственное место, куда кредиты
    // приходят, и единственное золотое пятно в кадре. Связь читается без подписи.
    const credits = `${hud.credits} ₡`;
    this.text(credits, VIEW_W - 4 - ctx.measureText(credits).width, VIEW_H - 4, 0xe0b83c);
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

    lines.forEach((line, i) => this.text(line, 4, 4 + i * 10, 0x7cf07c));
  }

  /** Надпись с чёрной подложкой в один пиксель: без неё текст тонет в кадре. */
  private text(line: string, x: number, y: number, color: number): void {
    const ctx = this.display.ctx;
    ctx.fillStyle = '#000000';
    ctx.fillText(line, x + 1, y + 1);
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.fillText(line, x, y);
  }
}
