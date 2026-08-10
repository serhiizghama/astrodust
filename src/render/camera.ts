import { BASE_VIEW_W, BASE_VIEW_H, CAMERA } from '../config';

/**
 * Камера со слежением через мёртвую зону.
 *
 * Пока цель внутри мёртвой зоны, камера неподвижна — мелкие шаги и дрожание
 * персонажа не дёргают кадр. При выходе за зону камера догоняет цель сглаженно.
 *
 * Слагаемых, кроме цели, у кадра нет и заводить их нельзя: кадр, отвечающий
 * на курсор, полз бы вокруг стоящего персонажа — держит `tests/game-shell.ts`.
 */
export class Camera {
  /** Левый верхний угол видимой области в координатах мира. */
  x = 0;
  y = 0;

  private centerX = 0;
  private centerY = 0;

  /**
   * Размер кадра. Опорный до первого `setViewport` — камера обязана быть
   * работоспособной до того, как окно сообщит свой размер.
   */
  private viewW = BASE_VIEW_W;
  private viewH = BASE_VIEW_H;

  constructor(
    private readonly worldW: number,
    private readonly worldH: number,
  ) {}

  /** Размер кадра меняется вместе с окном; камера узнаёт о нём отсюда. */
  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.applyClamp();
  }

  /** Мгновенно ставит камеру на цель — для инициализации, без сглаживания. */
  snapTo(targetX: number, targetY: number): void {
    this.centerX = targetX;
    this.centerY = targetY;
    this.applyClamp();
  }

  /** @param targetX,targetY центр цели в координатах мира */
  follow(targetX: number, targetY: number): void {
    // Мёртвая зона: сдвигаем центр ровно настолько, чтобы цель вернулась на её край.
    let desiredX = this.centerX;
    const dx = targetX - this.centerX;
    if (dx > CAMERA.deadzoneHalfW) desiredX = targetX - CAMERA.deadzoneHalfW;
    else if (dx < -CAMERA.deadzoneHalfW) desiredX = targetX + CAMERA.deadzoneHalfW;

    let desiredY = this.centerY;
    const dy = targetY - this.centerY;
    if (dy > CAMERA.deadzoneHalfH) desiredY = targetY - CAMERA.deadzoneHalfH;
    else if (dy < -CAMERA.deadzoneHalfH) desiredY = targetY + CAMERA.deadzoneHalfH;

    this.centerX += (desiredX - this.centerX) * CAMERA.smoothing;
    this.centerY += (desiredY - this.centerY) * CAMERA.smoothing;

    this.applyClamp();
  }

  /** Не выпускаем кадр за границы мира — пустота за краем в кадр не попадает. */
  private applyClamp(): void {
    const maxX = Math.max(0, this.worldW - this.viewW);
    const maxY = Math.max(0, this.worldH - this.viewH);
    this.x = Math.min(maxX, Math.max(0, Math.round(this.centerX - this.viewW / 2)));
    this.y = Math.min(maxY, Math.max(0, Math.round(this.centerY - this.viewH / 2)));
  }

  /** Экранная точка буфера кадра → координаты мира. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.x + sx, y: this.y + sy };
  }
}
