/**
 * Денежная сумма: единственное место, знающее, как в игре выглядят деньги.
 *
 * Форма одна и та же везде — значок монеты, просвет, число. Всё остальное
 * задаёт МЕСТО через обычный `TextStyle`: счётчик в углу кадра лежит на мире
 * и идёт с ореолом, цена под узлом лежит на подложке и несёт тоном состояние
 * покупки. Отсюда — тон валюты по умолчанию и ширина суммы для раскладки.
 *
 * Значок под кегль не масштабируется: спрайт пиксельный, а шкала кеглей целых
 * множителей не даёт. Согласованность держит выравнивание значка по строке.
 *
 * Держит `tests/ui-layer.ts`.
 */
import { UI } from '../config';
import { RAMP } from '../palette';
import { COIN_ICON } from './sprites/icons';
import type { TextStyle, UiSurface } from './ui';

/**
 * Тон валюты. Одна запись на игру: сумма, показанная в двух местах двумя
 * тонами, читается как две разные величины.
 */
export const CREDITS_TONE = RAMP.warm[4];

/** Ключ значка валюты: им сумма опознаётся в журнале поверхности. */
export const COIN_KEY = COIN_ICON.key;

/** Ширина суммы в ячейках кадра: значок, просвет, число. */
export function measureCredits(ui: UiSurface, amount: number, style: TextStyle): number {
  return COIN_ICON.w + UI.coinGap + ui.measure(`${amount}`, style);
}

/**
 * Сумма от точки `x`. Выравнивание из стиля прижимает ВСЮ группу, а не одно
 * число: иначе значок вылезает за отведённое место слева.
 *
 * @returns ширина суммы. Нужна тому, кто её ставит: сумма стоит в строке
 *          рядом со словами и внутри отведённого места
 */
export function drawCredits(
  ui: UiSurface,
  amount: number,
  x: number,
  y: number,
  style: TextStyle,
): number {
  const value = `${amount}`;
  const width = COIN_ICON.w + UI.coinGap + ui.measure(value, style);
  const left = x - (style.align === 'center' ? width / 2 : style.align === 'right' ? width : 0);

  // Значок по центру кегля строки: смещение ВЫВЕДЕНО из кегля и высоты спрайта,
  // а не подобрано по месту, — иначе оно расходится на каждой ступени шкалы.
  ui.icon(COIN_ICON, left, y + (style.size - COIN_ICON.h) / 2);
  ui.text(value, left + COIN_ICON.w + UI.coinGap, y, { ...style, align: 'left' });
  return width;
}
