/**
 * Общий вид слоя интерфейса: чернила теней, стандартная подложка и шкала
 * текста.
 *
 * Здесь лежит только ОБЩЕЕ. Смысловые цвета — состояние слота, состояние
 * покупки узла, вид эффекта технологии — остаются рядом с тем, что их
 * назначает: причина, по которой узел красный, живёт в дереве технологий,
 * а не в наборе токенов.
 *
 * Числа вида (радиусы, толщины, прозрачности) берутся ИЗ `UI` и нигде
 * не подбираются по месту: подложка, слот и узел обязаны выглядеть из одной
 * игры. Держит `tests/ui-layer.ts`.
 */
import { UI } from '../../config';
import { RAMP, css } from '../../palette';
import type { PanelStyle, TextStyle } from './surface';

/**
 * Чернила теней и ореолов. Тон палитры с прозрачностью, а не чистый чёрный:
 * чёрного в гамме игры нет, и заводить единственное место на экране с цветом
 * вне набора ради тени нельзя.
 */
export const SHADOW_INK = css(RAMP.gray[0], UI.alpha.shadow);

/** Подложка панели поверх мира: сквозит, обведена, отброшена тенью. */
export const BAR_PLATE: PanelStyle = {
  fill: css(RAMP.gray[1], UI.alpha.bar),
  fillBottom: css(RAMP.gray[0], UI.alpha.bar),
  stroke: css(RAMP.gray[5], UI.alpha.edge),
  strokeWidth: UI.stroke.thin,
  radius: UI.radius.panel,
  shadow: true,
};

/**
 * Подложка оверлея. Плотнее панели: под ней читают текст, и мир, просвечивающий
 * сквозь неё, ложился бы на буквы узором.
 *
 * Тени у неё НЕТ, и включать её нельзя: подложка размером почти в экран,
 * а размытие стоит по площади. Замер `npm run shot:ui` — 25.9 мс на кадр
 * с тенью против 16.7 без неё, то есть кадр не укладывается в шаг. Видно её
 * при этом только по краю панели, отступающему от края кадра на 24 ячейки.
 */
export const OVERLAY_PLATE: PanelStyle = {
  fill: css(RAMP.gray[1], UI.alpha.overlay),
  fillBottom: css(RAMP.gray[0], UI.alpha.overlay),
  stroke: css(RAMP.gray[5], UI.alpha.edge),
  strokeWidth: UI.stroke.thin,
  radius: UI.radius.panel,
};

/** Мелкий текст: подписи клавиш, цены, вспомогательные строки. */
export function smallText(color: number, over: Partial<TextStyle> = {}): TextStyle {
  return { size: UI.text.small, color: css(color), ...over };
}

/** Основной текст: строки состояния, пояснения, названия. */
export function bodyText(color: number, over: Partial<TextStyle> = {}): TextStyle {
  return { size: UI.text.base, color: css(color), ...over };
}

/** Заголовок: одна надпись на экран. */
export function titleText(color: number, over: Partial<TextStyle> = {}): TextStyle {
  return { size: UI.text.title, color: css(color), weight: 'bold', ...over };
}
