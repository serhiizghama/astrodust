import { World, MAT, MAT_CREDIT_RATE, MAT_RESEARCH_RATE } from '../world';
import type { Rect } from '../geometry';
import { Research } from '../progress';

/** Что начислено за один шаг зоны приёмника. */
export interface Payout {
  readonly credits: number;
  readonly research: number;
}

/**
 * Посадочный модуль: единственное место, где вещество превращается в валюту.
 * Здесь только зона приёмника и счёт — корпус живёт в СЕТКЕ (иначе персонаж
 * прошёл бы сквозь него) и выкладывается генератором мира.
 *
 * Зона поглощает ЛЮБОЕ попадание, а не только высыпанное из инвентаря:
 * вещество приходит и самотёком по склону, и конвейером.
 */
export class LandingModule {
  /**
   * Счёт. Инвариант: целый и НЕОТРИЦАТЕЛЬНЫЙ. Долгов в модели нет — трата
   * неделима, и действие, на которое не хватает, отвергается целиком.
   */
  credits = 0;

  /**
   * Счётчик очков живёт НЕ ЗДЕСЬ, а в исследованиях: модуль только начисляет.
   * Два счётчика (один принимает сдачу, другой платит) однажды разошлись бы.
   */
  constructor(
    readonly receiver: Rect,
    readonly research: Research = new Research(),
  ) {}

  /**
   * Обход зоны раз в шаг по её ячейкам — дешевле любого оповещения: приёмник
   * маленький и неподвижный.
   *
   * Названий веществ приёмник не знает: что принимается и почём, решает таблица.
   * Ноль в ОБЕИХ ставках — «не принимается», и вещество остаётся в мире: зона
   * приёмник, а не мусоросжигатель. Ветки «а если это иридий» здесь быть
   * не может — ради этого ставка и расщеплена на два поля.
   *
   * @returns сколько начислено на этом шаге по каждой валюте
   */
  update(world: World): Payout {
    const { x, y, w, h } = this.receiver;
    let credits = 0;
    let research = 0;

    for (let cy = y; cy < y + h; cy++) {
      for (let cx = x; cx < x + w; cx++) {
        const m = world.get(cx, cy);
        const credit = MAT_CREDIT_RATE[m]!;
        const point = MAT_RESEARCH_RATE[m]!;
        if (credit === 0 && point === 0) continue;
        world.set(cx, cy, MAT.VACUUM);
        credits += credit;
        research += point;
      }
    }

    this.credits += credits;
    this.research.earn(research);
    return { credits, research };
  }

  /**
   * Списывает стоимость. Всё или ничего: при нехватке счёт не меняется вовсе.
   *
   * @returns удалось ли списать
   */
  spend(amount: number): boolean {
    if (amount < 0 || this.credits < amount) return false;
    this.credits -= amount;
    return true;
  }

  /** Возврат при сносе. */
  refund(amount: number): void {
    if (amount > 0) this.credits += amount;
  }
}
