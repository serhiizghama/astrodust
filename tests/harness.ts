/**
 * Общая обвязка проверок: счётчик, фикстуры и общий мир.
 *
 * Запуск — `npm test` (все наборы) или `npm test -- <имя>` (один набор).
 */
import { generateLuna, MATERIALS, PORTABLE_MATERIALS } from '../src/world';
import { WORLD_SEED, VACUUM } from '../src/config';
import { COIN_KEY } from '../src/render';
import type { HudState, HudSlot, UiOp } from '../src/render';
import type { Input } from '../src/core';
import { HUD, UI } from '../src/config';

let failures = 0;
let total = 0;

export function check(name: string, ok: boolean, detail = ''): void {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

/** Итог прогона. Код возврата ненулевой при любом провале. */
export function report(): void {
  console.log(
    failures === 0 ? `\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (${total})` : `\nПРОВАЛЕНО: ${failures} из ${total}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Операции слоя интерфейса одного вида.
 *
 * Кадр интерфейса — векторный, и «что нарисовано» читается из журнала
 * поверхности, а не из пикселей: канваса в прогоне нет.
 */
export function pick<K extends UiOp['kind']>(
  ops: readonly UiOp[],
  kind: K,
): Extract<UiOp, { kind: K }>[] {
  return ops.filter((op): op is Extract<UiOp, { kind: K }> => op.kind === kind);
}

/** Надписи кадра одной строкой — для сравнения «что написано» между кадрами. */
export function said(ops: readonly UiOp[]): string[] {
  return pick(ops, 'text').map((op) => op.text);
}

/** Есть ли в кадре надпись, содержащая подстроку. */
export function saysLike(ops: readonly UiOp[], part: string): boolean {
  return pick(ops, 'text').some((op) => op.text.includes(part));
}

/**
 * Сумма в кадре: число со значком валюты слева от него, просветом общего вида
 * и по центру строки.
 *
 * Один поиск на все наборы: «деньги выглядят везде одинаково» ничего не значит,
 * если каждый набор опознаёт сумму по-своему.
 *
 * @returns значок и надпись суммы, или `null` — такой суммы в кадре нет
 */
export function amountAt(
  ops: readonly UiOp[],
  amount: number,
): { text: Extract<UiOp, { kind: 'text' }>; icon: Extract<UiOp, { kind: 'icon' }> } | null {
  const value = `${amount}`;
  const coins = pick(ops, 'icon').filter((op) => op.key === COIN_KEY);
  for (const text of pick(ops, 'text')) {
    if (text.text !== value) continue;
    const icon = coins.find(
      (ic) =>
        Math.abs(ic.x + ic.w + UI.coinGap - text.x) < 0.001 &&
        Math.abs(ic.y + ic.h / 2 - (text.y + text.style.size / 2)) < 0.001,
    );
    if (icon) return { text, icon };
  }
  return null;
}

/** Заглушка ввода с тем же контрактом, что у настоящего Input. */
export class FakeInput {
  left = false;
  right = false;
  jumpDown = false;
  jumpIsHeld = false;
  get moveAxis(): number {
    return (this.right ? 1 : 0) - (this.left ? 1 : 0);
  }
  get jumpPressed(): boolean {
    return this.jumpDown;
  }
  get jumpHeld(): boolean {
    return this.jumpIsHeld;
  }
}

export const asInput = (f: FakeInput) => f as unknown as Input;

/**
 * Слоты панели действий в начале партии. Собраны здесь, а не взяты у `main.ts`:
 * снапшот кадра должен собираться руками — иначе проверка кадра зависит
 * от бутстрапа, который без DOM не запускается.
 */
export const IDLE_SLOTS: readonly HudSlot[] = Array.from({ length: HUD.slots }, (_, i) => ({
  key: `${(i + 1) % 10}`,
  action: i === 0 ? 'dig' : i === 1 ? 'build' : i === 2 ? 'collect' : null,
}));

/** Интерфейс в начале партии — для проверок, которым важен не HUD. */
export const IDLE_HUD: HudState = {
  slots: IDLE_SLOTS,
  activeSlot: 0,
  hoveredSlot: null,
  collecting: false,
  collectRadius: VACUUM.radius,
  carried: [],
  used: 0,
  capacity: VACUUM.capacity,
  selected: MATERIALS[PORTABLE_MATERIALS[0]!]!.name,
  credits: 0,
  buildKind: '',
  buildIssue: '',
  ghost: null,
  machines: [],
  overlay: null,
};

/**
 * Дерево, в котором открыто всё.
 *
 * Проверки конвейера, ленты и постановки существовали до исследований и про них
 * ничего не знают: им нужен мир, в котором лента доступна, а не путь, которым
 * она стала доступна. Что закрытый вид не ставится, проверяется отдельно
 * и умолчанием `NO_UNLOCKS`.
 */
export const UNLOCKED = { has: () => true };

/**
 * Общий сгенерированный мир — ОДИН на весь прогон.
 *
 * Экземпляр один намеренно: наборы проверок ходят по нему персонажем, а ходьба
 * продавливает рыхлое, то есть меняет мир. Отдельный мир на набор дал бы
 * каждому нетронутый рельеф, и результат прогона зависел бы от того, целиком
 * он идёт или по фильтру.
 *
 * Ленивый: набор, которому мир не нужен (звук, таблицы), за генерацию не платит.
 */
let cached: ReturnType<typeof generateLuna> | null = null;

export function luna(): ReturnType<typeof generateLuna> {
  if (cached === null) cached = generateLuna(WORLD_SEED);
  return cached;
}
