import { VIEW_W, VIEW_H, DIG } from '../config';
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
    this.drawAim(crosshairX, crosshairY, crosshairInReach);
    this.display.present();
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
   */
  private drawAim(sx: number, sy: number, inReach: boolean): void {
    const x = Math.round(sx);
    const y = Math.round(sy);

    const outline = inReach ? 0x5c3612 : 0x33313a;
    for (let i = 0; i < BRUSH_OUTLINE.length; i += 2) {
      this.setPixel(x + BRUSH_OUTLINE[i]!, y + BRUSH_OUTLINE[i + 1]!, outline);
    }

    const color = inReach ? 0xff9a3c : 0x5a5560;

    for (const d of [-3, -2, 2, 3]) {
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

  /** Диагностика поверх кадра. Включается F3 — иначе мешает оценивать картинку. */
  private drawDebug(fps: number, material: string): void {
    if (fps <= 0) return;
    const ctx = this.display.ctx;
    ctx.font = '8px monospace';
    ctx.textBaseline = 'top';

    const lines = [`${fps.toFixed(0)} FPS`];
    // Установка вслепую бесполезна: игрок обязан видеть, что именно поставит.
    if (material) lines.push(`Q/E: ${material}`);

    lines.forEach((line, i) => {
      const y = 4 + i * 10;
      ctx.fillStyle = '#000000';
      ctx.fillText(line, 5, y + 1);
      ctx.fillStyle = '#7cf07c';
      ctx.fillText(line, 4, y);
    });
  }
}
