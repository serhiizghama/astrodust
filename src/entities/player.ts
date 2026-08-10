import { PLAYER } from '../config';
import { World, MatterState, MAT_STATE, MAT_SOLID } from '../world';
/**
 * Что из снапшота читает персонаж.
 *
 * Уже снапшота намеренно: персонаж не должен видеть ни клавиш каталога,
 * ни кнопок мыши, ни тем более оверлея. Заодно это делает выразимым «ввода
 * не было вовсе» — состояние, в котором персонаж живёт, пока открыто меню.
 */
export interface PlayerInput {
  readonly moveAxis: number;
  readonly jumpPressed: boolean;
  readonly jumpHeld: boolean;
}

/**
 * Ввод, в котором ничего не нажато. Персонаж получает ИМЕННО ЕГО, пока ввод
 * принадлежит меню, а не пропускает шаг: застигнутый в воздухе игрок обязан
 * падать. Ветка «а если открыто меню» внутри персонажа была бы знанием о меню
 * там, где оно дальше всего.
 */
export const NO_INPUT: PlayerInput = {
  moveAxis: 0,
  jumpPressed: false,
  jumpHeld: false,
};

import { Tuning } from '../progress';

export class Player {
  /** Левый верхний угол хитбокса, в ячейках. Целые — движение идёт по ячейкам. */
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  onGround = false;
  facing: 1 | -1 = 1;
  /** Применялась ли тяга ранца в этом шаге. Рендерер рисует по нему выхлоп. */
  thrusting = false;

  /**
   * Субпиксельный остаток. Без него скорость меньше ячейки за шаг округлялась
   * бы в ноль и персонаж стоял бы на месте.
   */
  private remX = 0;
  private remY = 0;

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  /** Идёт ли подъём, который ещё можно обрезать отпусканием клавиши. */
  private jumping = false;
  /** Оставшееся время до следующей продавленной ячейки. */
  private pushTimer = 0;

  /**
   * Профиль параметров: отсюда читается предел скорости подъёма. Персонаж
   * не знает, что исследования существуют. Умолчание базовое.
   */
  constructor(
    x: number,
    y: number,
    private readonly tuning: Tuning = new Tuning(),
  ) {
    this.x = Math.round(x);
    this.y = Math.round(y);
  }

  get centerX(): number {
    return this.x + PLAYER.hitboxW / 2;
  }

  get centerY(): number {
    return this.y + PLAYER.hitboxH / 2;
  }

  update(dt: number, input: PlayerInput, world: World): void {
    // Флаг тяги живёт ровно один шаг: рендерер читает его сразу после update.
    this.thrusting = false;

    // Порядок физический: сначала вес, затем импульс прыжка, затем тяга —
    // тяга должна видеть уже изменённую вертикальную скорость. Горизонталь
    // идёт последней, потому что выбор ускорения зависит от того, работает ли тяга.
    this.applyGravity(dt, world);
    this.applyJump(dt, input);
    this.applyThrust(dt, input, world);
    this.applyHorizontalInput(dt, input);

    this.moveX(this.vx * dt, world);
    this.moveY(this.vy * dt, world);
    this.pushThroughLoose(dt, input, world);

    this.onGround = this.hasGroundBelow(world);
    if (this.onGround && this.vy >= 0) this.jumping = false;
  }

  /** Разгон и трение вместо мгновенной скорости; в воздухе контроль слабее. */
  private applyHorizontalInput(dt: number, input: PlayerInput): void {
    const axis = input.moveAxis;
    const accel = this.onGround
      ? PLAYER.groundAccel
      : this.thrusting
        ? PLAYER.airAccelThrust
        : PLAYER.airAccel;

    if (axis !== 0) {
      this.vx += axis * accel * dt;
      this.vx = Math.max(-PLAYER.runSpeed, Math.min(PLAYER.runSpeed, this.vx));
      this.facing = axis > 0 ? 1 : -1;
    } else if (this.onGround) {
      const drop = PLAYER.groundFriction * dt;
      this.vx = Math.abs(this.vx) <= drop ? 0 : this.vx - Math.sign(this.vx) * drop;
    }
  }

  /** Гравитацию берём из мира, а не из глобальной константы. */
  private applyGravity(dt: number, world: World): void {
    this.vy += world.profile.gravity * dt;
    if (this.vy > PLAYER.maxFallSpeed) this.vy = PLAYER.maxFallSpeed;
  }

  private applyJump(dt: number, input: PlayerInput): void {
    // Буфер: нажатие до приземления не теряется.
    if (input.jumpPressed) this.jumpBufferTimer = PLAYER.jumpBufferTime;
    else this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);

    // Coyote: прыжок засчитывается ещё немного после схода с края.
    if (this.onGround) this.coyoteTimer = PLAYER.coyoteTime;
    else this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);

    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
      this.vy = -PLAYER.jumpVelocity;
      this.jumpBufferTimer = 0;
      // Обнуляем окно coyote — иначе оно дало бы второй прыжок в воздухе.
      this.coyoteTimer = 0;
      this.onGround = false;
      this.jumping = true;
    }

    // Обрезка прыжка: отпустил рано — поднялся ниже.
    // С тягой не конфликтует по построению: обрезка живёт на отпускании,
    // тяга — на удержании, одновременно они не наступают.
    if (this.jumping && !input.jumpHeld && this.vy < 0) {
      this.vy *= PLAYER.jumpCutMultiplier;
      this.jumping = false;
    }
  }

  /**
   * Тяга ранца: одно неравенство вместо автомата состояний — тяга применяется,
   * пока подъём медленнее предела ранца. Импульс прыжка (150) быстрее предела
   * (110), поэтому сразу после прыжка ранец молчит, а подхватывает, когда
   * гравитация съест избыток. Переход прыжок → полёт получается из физики.
   *
   * Проверки «на земле ли» здесь намеренно нет: иначе приземление с зажатой
   * клавишей даёт мёртвую зону до нового нажатия.
   *
   * Инвариант: технология растит ПРЕДЕЛ, а не ускорение — ускорение задано
   * множителем к гравитации мира, и его правка сломала бы переносимость ранца
   * между мирами. Предел при любом открытом значении обязан остаться строго
   * ниже импульса прыжка, иначе прыжок неотличим от полёта.
   */
  private applyThrust(dt: number, input: PlayerInput, world: World): void {
    if (!input.jumpHeld) return;
    const limit = this.tuning.maxRiseSpeed;
    if (this.vy <= -limit) return;

    this.vy -= world.profile.gravity * PLAYER.thrustGravityMultiplier * dt;
    if (this.vy < -limit) this.vy = -limit;
    this.thrusting = true;

    // Ранец принял управление — фаза прыжка закончилась. Без этого отпускание
    // клавиши в полёте давало бы обрезку прыжка и резкую просадку, а взлёт
    // с земли без прыжка — нет. Ощущение было бы непоследовательным.
    this.jumping = false;
  }

  private hitsWorld(world: World, x: number, y: number): boolean {
    return world.rectHitsSolid(x, y, PLAYER.hitboxW, PLAYER.hitboxH);
  }

  private hasGroundBelow(world: World): boolean {
    return world.rectHitsSolid(this.x, this.y + PLAYER.hitboxH, PLAYER.hitboxW, 1);
  }

  /**
   * Горизонтальное перемещение по одной ячейке за раз.
   *
   * Пошагово, а не «прыжком на всю дельту»: проверяется каждая промежуточная
   * позиция, поэтому проскочить сквозь тонкую преграду нельзя ни на какой
   * достижимой скорости.
   */
  private moveX(amount: number, world: World): void {
    this.remX += amount;
    const total = Math.trunc(this.remX);
    this.remX -= total;

    // По горизонтали скорость намеренно НЕ гасится до попытки шага: иначе
    // упор в проходимый уступ обнулял бы vx каждый кадр, остаток никогда бы
    // не набрал целую ячейку, и автоподъём перестал бы срабатывать.
    // Накопления здесь и не происходит — на беговой скорости остаток набирает
    // ячейку за пару кадров, и ветка столкновения ниже гасит vx сама.
    const dir = Math.sign(total);
    let steps = Math.abs(total);

    while (steps > 0) {
      if (!this.hitsWorld(world, this.x + dir, this.y)) {
        this.x += dir;
      } else if (!this.tryStepUp(world, dir)) {
        // Упёрлись в настоящую стену: гасим скорость и остаток, иначе
        // накопленный субпиксель выстрелит при следующем освобождении пути.
        this.vx = 0;
        this.remX = 0;
        return;
      }
      steps--;
    }
  }

  /**
   * Автоподъём на неровность высотой до stepUpMax.
   *
   * Обязателен: кромка пиксельного рельефа неровная почти везде, и без подъёма
   * персонаж останавливается на ровном месте. Работает только с земли —
   * иначе в прыжке можно было бы карабкаться по отвесной стене.
   */
  private tryStepUp(world: World, dir: number): boolean {
    if (!this.onGround) return false;

    for (let up = 1; up <= PLAYER.stepUpMax; up++) {
      // Проверяется весь хитбокс на новой высоте, поэтому в низком тоннеле
      // подъём честно не состоится, а не втолкнёт персонажа в потолок.
      if (!this.hitsWorld(world, this.x + dir, this.y - up)) {
        this.y -= up;
        this.x += dir;
        return true;
      }
    }
    return false;
  }

  private moveY(amount: number, world: World): void {
    this.remY += amount;
    const total = Math.trunc(this.remY);
    this.remY -= total;

    // Упор гасит скорость и до того, как наберётся целый шаг.
    // Без этого «стою на земле» и «вишу под потолком» дают ненулевую
    // вертикальную скорость: гравитация 320 копит её 12 кадров, прежде чем
    // остаток дорастёт до ячейки и сработает ветка столкновения. Спека
    // требует обнуления при контакте, а не в среднем за десяток кадров.
    // По горизонтали такого гашения нет намеренно — см. комментарий в moveX.
    if (total === 0) {
      this.stopIfBlocked(world, Math.sign(this.vy));
      return;
    }

    const dir = Math.sign(total);
    let steps = Math.abs(total);

    while (steps > 0) {
      if (this.hitsWorld(world, this.x, this.y + dir)) {
        this.vy = 0;
        this.remY = 0;
        return;
      }
      this.y += dir;
      steps--;
    }
  }

  /**
   * Продавливание сквозь рыхлое — единственный выход из завала. Без него
   * засыпать себя это необратимый софтлок: карман вокруг хитбокса держится,
   * но снаружи обкладывает реголит, а кисть копания рыхлое пропускает
   * по построению (замер: 0 свободных направлений из 4 после сорока применений).
   *
   * Отдельно от `moveX`/`moveY`: там шаг случается по субпиксельному остатку,
   * и темп продавливания зависел бы от разгона, а не от своего интервала.
   *
   * Вниз не продавливаемся никогда — иначе персонаж тонет в куче, на которой
   * стоит.
   */
  private pushThroughLoose(dt: number, input: PlayerInput, world: World): void {
    this.pushTimer = Math.max(0, this.pushTimer - dt);
    if (this.pushTimer > 0) return;

    const axis = input.moveAxis;
    if (axis !== 0 && this.hitsWorld(world, this.x + axis, this.y)) {
      if (this.push(world, axis, 0)) return;
    }
    if (input.jumpHeld && this.hitsWorld(world, this.x, this.y - 1)) {
      this.push(world, 0, -1);
    }
  }

  /**
   * Обмен содержимого покидаемой и занимаемой полос. Полосы одного размера
   * по построению, поэтому обмен сохраняет количество ячеек каждого материала
   * без проверок. Удаление вместо обмена — это копание без инструмента.
   */
  private push(world: World, dx: number, dy: number): boolean {
    const w = PLAYER.hitboxW;
    const h = PLAYER.hitboxH;
    const count = dx !== 0 ? h : w;

    // Занимаемая грань, куда персонаж шагнёт, и покидаемая, которая
    // освободится. Для шага вверх грани горизонтальные.
    const intoX = dx > 0 ? this.x + w : this.x - 1;
    const fromX = dx > 0 ? this.x : this.x + w - 1;
    const intoY = this.y - 1;
    const fromY = this.y + h - 1;

    for (let i = 0; i < count; i++) {
      const ix = dx !== 0 ? intoX : this.x + i;
      const iy = dx !== 0 ? this.y + i : intoY;
      const fx = dx !== 0 ? fromX : this.x + i;
      const fy = dx !== 0 ? this.y + i : fromY;

      // Статичное не раздвигается: порода остаётся стеной, её убирают копанием.
      if (MAT_STATE[world.get(ix, iy)] === MatterState.Solid) return false;
      // Освобождаемое встанет внутрь нового хитбокса — оно обязано быть
      // проходимым, иначе персонаж окажется внутри твёрдых ячеек.
      if (MAT_SOLID[world.get(fx, fy)] === 1) return false;
    }

    for (let i = 0; i < count; i++) {
      const ix = dx !== 0 ? intoX : this.x + i;
      const iy = dx !== 0 ? this.y + i : intoY;
      const fx = dx !== 0 ? fromX : this.x + i;
      const fy = dx !== 0 ? this.y + i : fromY;

      const pushed = world.get(ix, iy);
      world.set(ix, iy, world.get(fx, fy));
      world.set(fx, fy, pushed);
    }

    this.x += dx;
    this.y += dy;
    this.pushTimer = PLAYER.pushInterval;
    return true;
  }

  /** Гасит вертикальную скорость, если ячейка в направлении движения занята. */
  private stopIfBlocked(world: World, dirY: number): void {
    if (dirY === 0) return;
    if (!this.hitsWorld(world, this.x, this.y + dirY)) return;
    this.vy = 0;
    this.remY = 0;
  }
}
