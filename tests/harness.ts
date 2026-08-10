/**
 * Общая обвязка проверок: счётчик, фикстуры и общий мир.
 *
 * Запуск — `npm test` (все наборы) или `npm test -- <имя>` (один набор).
 */
import { generateLuna, MATERIALS, PORTABLE_MATERIALS } from '../src/world';
import { WORLD_SEED, VACUUM } from '../src/config';
import type { HudState } from '../src/render';
import type { Input } from '../src/core';

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

/** Строка состояния в начале партии — для проверок, которым важен не HUD. */
export const IDLE_HUD: HudState = {
  mode: 'Копание',
  collecting: false,
  collectRadius: VACUUM.radius,
  carried: [],
  used: 0,
  capacity: VACUUM.capacity,
  selected: MATERIALS[PORTABLE_MATERIALS[0]!]!.name,
  credits: 0,
  research: 0,
  buildKind: '',
  buildIssue: '',
  ghost: null,
  machines: [],
  machineSummary: '',
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
