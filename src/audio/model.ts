/**
 * Общая арифметика звука: затухание, панорама, строй, часы, слоты.
 *
 * Ни одной ноды WebAudio — только числа. Всё, что здесь лежит, проверяется
 * в Node без браузера, и на этом держится требование «проверяется модель,
 * а граф остаётся тонким применением уже посчитанных значений».
 */
import { AUDIO, FIXED_DT } from '../config';
import { mulberry32 } from '../world';

/**
 * Слышимость на расстоянии `distance` мировых пикселей от персонажа.
 *
 * Квадратичное убывание и РОВНЫЙ ноль за радиусом. Бесконечный хвост «еле
 * слышно» означал бы, что весь мир всё время шуршит, и тишина как состояние
 * перестала бы существовать — а в вакууме именно она состояние покоя.
 */
export function attenuation(distance: number): number {
  const r = AUDIO.contactRadius;
  if (distance >= r) return 0;
  const t = 1 - distance / r;
  return t * t;
}

/** Слышимость источника от персонажа. */
export function attenuationAt(
  srcX: number,
  srcY: number,
  listenerX: number,
  listenerY: number,
): number {
  return attenuation(Math.hypot(srcX - listenerX, srcY - listenerY));
}

/**
 * Панорама источника.
 *
 * Считается от ПЕРСОНАЖА в координатах мира, а не от центра кадра: камера
 * уходит за курсором на ±32 пикселя, и привязка к экрану качала бы звуковую
 * картину при каждом движении мыши.
 */
export function panFor(srcX: number, listenerX: number): number {
  const t = (srcX - listenerX) / AUDIO.contactRadius;
  return Math.max(-1, Math.min(1, t)) * AUDIO.panMax;
}

/** Частота ступени тональной сетки: пентатоника от `rootHz`, любая октава. */
export function gridHz(step: number): number {
  const degrees = AUDIO.scale.length;
  const octave = Math.floor(step / degrees);
  const semitones = AUDIO.scale[step - octave * degrees]! + 12 * octave;
  return AUDIO.rootHz * Math.pow(2, semitones / 12);
}

/**
 * Тон из сетки внутри полосы дорожки по детерминированному индексу.
 *
 * Источник вариативности — счётчик событий, а не генератор случайных чисел:
 * тем же принципом, что выбор стороны скатывания в клеточном автомате.
 */
export function scaleToneIn(index: number, lowHz: number, highHz: number): number {
  let first = 0;
  while (gridHz(first) < lowHz) first++;
  let count = 0;
  while (gridHz(first + count) <= highHz) count++;
  if (count === 0) return lowHz;
  return gridHz(first + (((index % count) + count) % count));
}

/** Ближайшая ступень сетки к произвольной частоте. */
export function snapToScale(hz: number): number {
  let best = gridHz(0);
  for (let step = 0; ; step++) {
    const g = gridHz(step);
    if (Math.abs(g - hz) < Math.abs(best - hz)) best = g;
    if (g > hz) return best;
  }
}

/**
 * Стоит ли отправлять драйверу новое значение.
 *
 * `range` — полный диапазон параметра: для громкости это 1, для частоты среза
 * ширина её полосы. Абсолютный порог на частотах в килогерцах не имел бы смысла.
 */
export function changed(prev: number, next: number, range = 1): boolean {
  // Приход в РОВНУЮ тишину и уход из неё сообщаются всегда, каким бы малым
  // ни был шаг: иначе дорожка застревала бы на остатке в −50 дБ, и покой мира
  // перестал бы быть полной тишиной.
  if (prev !== next && (prev === 0 || next === 0)) return true;
  return Math.abs(next - prev) >= AUDIO.paramEpsilon * range;
}

/** Экспоненциальный подход к цели за время `tau`. Не зависит от частоты кадров. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Общий буфер белого шума из зерна мира — тем же генератором, что рельеф
 * и задник. Одно зерно даёт один и тот же шумовой материал.
 */
export function fillNoise(out: Float32Array, seed: number): void {
  const rand = mulberry32(seed);
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2 - 1;
}

/**
 * Курсор часов звука: опережает настоящее время и идёт шагами симуляции.
 *
 * `GameLoop` выполняет до пяти шагов подряд внутри одного кадра — все пять
 * при одном и том же `ctx.currentTime`. Планирование «сейчас» схлопнуло бы
 * их в один щелчок, а планирование в прошлое браузер отдаёт молча и без звука.
 */
export class AudioClock {
  private cursor = 0;

  /** Время, на которое планируется всё, что звучит в этом шаге. */
  next(currentTime: number): number {
    const floor = currentTime + AUDIO.lookahead;
    if (this.cursor < floor) this.cursor = floor;

    const at = this.cursor;
    this.cursor += FIXED_DT;

    // Возврат из свёрнутой вкладки: курсор ушёл далеко вперёд, и накопленное
    // проигралось бы залпом. Верхняя граница возвращает его к настоящему.
    if (this.cursor - currentTime > AUDIO.maxAhead) this.cursor = floor;

    return at;
  }

  /** Возврат фокуса: курсор больше не имеет отношения к настоящему. */
  reset(): void {
    this.cursor = 0;
  }
}

/**
 * Занятость слотов одноразовых голосов.
 *
 * Слот — постоянная цепочка нод; здесь только учёт времени, когда он
 * освободится. Колбэков `onended` нет намеренно: колбэк на каждое событие
 * означает замыкание на каждое событие.
 */
export class VoiceSlots {
  private readonly endTimes: Float64Array;

  constructor(count: number) {
    this.endTimes = new Float64Array(count);
  }

  get size(): number {
    return this.endTimes.length;
  }

  /**
   * Занять слот под звук, начинающийся в `at` и длящийся `duration`.
   *
   * @returns индекс слота или `-1`, если свободных нет. Событие сверх лимита
   *   не теряется: вызывающий вливает его в непрерывную часть своей дорожки.
   */
  acquire(now: number, at: number, duration: number): number {
    for (let i = 0; i < this.endTimes.length; i++) {
      if (this.endTimes[i]! <= now) {
        this.endTimes[i] = at + duration;
        return i;
      }
    }
    return -1;
  }

  /** Сколько голосов ещё звучит. */
  activeCount(now: number): number {
    let n = 0;
    for (let i = 0; i < this.endTimes.length; i++) if (this.endTimes[i]! > now) n++;
    return n;
  }

  reset(): void {
    this.endTimes.fill(0);
  }
}
