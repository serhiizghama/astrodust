/**
 * Цвет материала, разложенный на байты, и цвет бегущей полосы конвейера.
 *
 * Данные ПРЕДСТАВЛЕНИЯ, выведенные из таблицы веществ: внутренний цикл рендера
 * читает их на каждый непустой пиксель кадра, и разыменование объекта там
 * заметно дороже. В доменной таблице им делать нечего — она описывает, как
 * вещество себя ведёт, а не каким его показывают.
 */
import { MATERIALS } from '../world';
import { RAMP } from '../palette';

const size = MATERIALS.length;

export const MAT_R = new Uint8Array(size);
export const MAT_G = new Uint8Array(size);
export const MAT_B = new Uint8Array(size);

for (const m of MATERIALS) {
  MAT_R[m.id] = (m.color >> 16) & 0xff;
  MAT_G[m.id] = (m.color >> 8) & 0xff;
  MAT_B[m.id] = m.color & 0xff;
}

/**
 * Цвет бегущей полосы конвейера. Не поле таблицы: в мире полосы нет — ячейка
 * хранит идентификатор ленты, полосу рисует рендер.
 *
 * Инвариант: ступень занята полосой ИСКЛЮЧИТЕЛЬНО — по ней считают пиксели,
 * чтобы увидеть, что лента идёт, и любой сосед по цвету подмешался бы в счёт
 * молча. Держит `tests/conveyor.ts`.
 */
export const CONVEYOR_STRIPE_COLOR = RAMP.gray[7];
