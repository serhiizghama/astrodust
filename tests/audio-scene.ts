/**
 * Оффлайн-рендер звуковой картины. Выполняется В СТРАНИЦЕ headless Chromium.
 *
 * `OfflineAudioContext` строит тот же самый граф, что и живая игра, и отдаёт
 * результат буфером быстрее реального времени. Дальше звук перестаёт быть
 * вопросом слуха и становится числами: тишина — это нулевой пик, щелчок —
 * скачок между соседними выборками, панорама — перекос между каналами,
 * разделение полос — распределение энергии по спектру.
 *
 * Слухом остаётся то, что числом и не проверить: приятно ли, «пыль» или «снег».
 *
 * Здесь только СЪЁМКА показаний. Все утверждения — в `tests/audio-verify.ts`,
 * рядом друг с другом и в одном месте.
 */
import { AUDIO, FIXED_DT, WORLD_SEED } from '../src/config';
import {
  createBus,
  createVoices,
  AudioClock,
  VoiceSlots,
  createSignals,
  resetSignals,
} from '../src/audio';
import type { AudioSignals } from '../src/audio';

/** Разрешение огибающей. 5 мс — вчетверо мельче спада акцента (90 мс). */
const ENV_MS = 5;
const FFT_SIZE = 2048;
const SAMPLE_RATE = 44100;

export interface Measures {
  seconds: number;
  sampleRate: number;
  /** Наибольшая по модулю выборка. Клиппинг начинается за единицей. */
  peak: number;
  rms: number;
  rmsL: number;
  rmsR: number;
  /** RMS по блокам ENV_MS миллисекунд. */
  env: number[];
  /** Наибольший скачок между соседними выборками во всём рендере. */
  maxJump: number;
  /** Усреднённый спектр мощности: bin i — частота i * sampleRate / FFT_SIZE. */
  spectrum: number[];
  /** Схожесть двух соседних акцентов, 1 = неразличимы. Считается не всегда. */
  strikeSimilarity?: number;
}

/** Как сцена заполняет снапшот сигналов на шаге симуляции. */
export interface Scene {
  seconds: number;
  drive(signals: AudioSignals, step: number): void;
  /** Оставить включённой одну дорожку — «прослушать в одиночку». */
  only?: string;
  /** Шаг, на котором игрок нажимает отключение звука. */
  muteAtStep?: number;
  /** Считать схожесть акцентов: смещения двух окон в секундах. */
  compareStrikesAt?: [number, number];
}

const LISTENER_X = 512;
const LISTENER_Y = 256;

/** Персонаж всегда в одной точке — сцены двигают только источники. */
function atListener(s: AudioSignals): void {
  s.listenerX = LISTENER_X;
  s.listenerY = LISTENER_Y;
}

/**
 * Копание с фактическим темпом кисти: `DIG.interval = 0.03` при шаге 1/60
 * даёт применение через шаг.
 *
 * Выработка — ПЯТЬ ячеек, а не полный круг кисти в 29. Круг превращается
 * целиком только на первом касании; дальше кисть стоит почти на месте, и
 * породой остаётся лишь наступающая кромка. Сцена с 29 ячейками на каждое
 * применение загоняла бы помол в насыщение и ничего не проверяла.
 */
function digging(s: AudioSignals, step: number, offsetX: number): void {
  atListener(s);
  s.digX = LISTENER_X + offsetX;
  s.digY = LISTENER_Y;
  s.digConverted = step % 2 === 0 ? 5 : 0;
}

function powder(s: AudioSignals, moves: number, offsetX: number): void {
  atListener(s);
  s.powderX = LISTENER_X + offsetX;
  s.powderY = LISTENER_Y;
  s.powderMoves = moves;
}

export const SCENES: Record<string, Scene> = {
  /** Покой: персонаж стоит, мир улёгся. Обязана быть полная тишина. */
  silence: {
    seconds: 2,
    drive: atListener,
  },

  /** Копание по достижимой породе вплотную к персонажу. */
  digNear: {
    seconds: 3,
    drive: (s, step) => digging(s, step, 6),
    // Смещения НЕ кратны секунде: буфер шума длиной ровно секунду зациклен,
    // и окна через целое число секунд совпали бы сами с собой, что бы там
    // ни делали акценты.
    compareStrikesAt: [1.13, 1.71],
  },

  /**
   * Диагностическая: та же средняя выработка, но РОВНЫМ потоком, без пауз
   * между применениями кисти. Помол здесь не может пульсировать по построению,
   * поэтому все засечённые удары — акценты и только они. Разница с `digNear`
   * показывает, сколько ряби помол добавляет от себя.
   */
  digSteady: {
    seconds: 3,
    drive: (s) => {
      atListener(s);
      s.digX = LISTENER_X + 6;
      s.digY = LISTENER_Y;
      s.digConverted = 2.5;
    },
  },

  /** Кисть в пустоте: выработки нет, значит и удара по породе нет. */
  digEmpty: {
    seconds: 2,
    drive: (s) => {
      atListener(s);
      s.digX = LISTENER_X + 6;
      s.digY = LISTENER_Y;
      s.digConverted = 0;
    },
  },

  /**
   * Копание за радиусом контактной слышимости.
   *
   * Расстояние АБСОЛЮТНОЕ, а не `contactRadius + N`. Привязка к константе
   * двигала бы цель вместе с ней, и расширение радиуса — ровно то изменение,
   * которое проверка обязана заметить, — прошло бы незамеченным.
   * `design.md § Решение 6`: радиус меняется намеренно, а не потому что «тихо».
   */
  digFar: {
    seconds: 2,
    drive: (s, step) => digging(s, step, 240),
  },

  /** Обвал: осыпание нарастает, выходит на предел и обрывается. */
  dustSwell: {
    seconds: 3,
    drive: (s, step) => {
      const t = step * FIXED_DT;
      // 0 → 400 сдвигов за 1.2 с, держится до 2.0 с, дальше мир мгновенно лёг.
      const moves = t < 1.2 ? Math.round((t / 1.2) * 400) : t < 2.0 ? 400 : 0;
      powder(s, moves, 8);
    },
  },

  /** Осыпание на другом конце мира. Расстояние абсолютное — см. `digFar`. */
  dustFar: {
    seconds: 2,
    drive: (s) => powder(s, 400, 300),
  },

  /** Источник справа от персонажа. */
  panRight: {
    seconds: 2,
    drive: (s) => powder(s, 300, 70),
  },

  panLeft: {
    seconds: 2,
    drive: (s) => powder(s, 300, -70),
  },

  /** Копание поверх обвала: обе дорожки на пределе одновременно. */
  bothMax: {
    seconds: 3,
    drive: (s, step) => {
      digging(s, step, 6);
      s.powderMoves = 4000;
      s.powderX = LISTENER_X + 4;
      s.powderY = LISTENER_Y;
    },
  },

  /** Та же сцена, но слышна одна дорожка. */
  bothSoloDig: {
    seconds: 2,
    only: 'dig',
    drive: (s, step) => {
      digging(s, step, 6);
      powder(s, 4000, 4);
    },
  },

  bothSoloDust: {
    seconds: 2,
    only: 'dust',
    drive: (s, step) => {
      digging(s, step, 6);
      powder(s, 4000, 4);
    },
  },

  /** Отключение звука посреди обвала: не должно щёлкнуть. */
  muteMidCollapse: {
    seconds: 2,
    muteAtStep: 60, // ровно через секунду
    drive: (s) => powder(s, 400, 8),
  },
};

export async function run(name: string): Promise<Measures> {
  const scene = SCENES[name];
  if (!scene) throw new Error(`Нет сцены «${name}»`);

  const frames = Math.ceil(scene.seconds * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, frames, SAMPLE_RATE);
  const { master, ...bus } = createBus(ctx, WORLD_SEED);

  const slots = new VoiceSlots(AUDIO.maxOneShots);
  const clock = new AudioClock();
  const voices = createVoices().filter((v) => v.enabled && (!scene.only || v.id === scene.only));
  for (const voice of voices) voice.build(bus, slots);

  const signals = createSignals();
  const steps = Math.round(scene.seconds / FIXED_DT);
  for (let step = 0; step < steps; step++) {
    resetSignals(signals);
    scene.drive(signals, step);

    // Часы синтетические: у оффлайнового контекста `currentTime` не идёт,
    // пока рендер не запущен. Шаг тот же, что у симуляции, поэтому курсор
    // ведёт себя ровно как в живой игре.
    const now = step * FIXED_DT;
    const at = clock.next(now);
    for (const voice of voices) voice.update(FIXED_DT, signals, at, now);

    if (scene.muteAtStep === step) {
      master.gain.cancelScheduledValues(at);
      master.gain.setValueAtTime(master.gain.value, at);
      master.gain.linearRampToValueAtTime(0, at + AUDIO.muteFade);
    }
  }

  const rendered = await ctx.startRendering();
  return measure(rendered, scene);
}

function measure(buffer: AudioBuffer, scene: Scene): Measures {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const n = buffer.length;

  let peak = 0;
  let sumSq = 0;
  let sumSqL = 0;
  let sumSqR = 0;
  let maxJump = 0;
  for (let i = 0; i < n; i++) {
    const l = left[i]!;
    const r = right[i]!;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sumSqL += l * l;
    sumSqR += r * r;
    sumSq += (l * l + r * r) / 2;
    if (i > 0) {
      maxJump = Math.max(maxJump, Math.abs(l - left[i - 1]!), Math.abs(r - right[i - 1]!));
    }
  }

  const block = Math.round((ENV_MS / 1000) * buffer.sampleRate);
  const env: number[] = [];
  for (let start = 0; start + block <= n; start += block) {
    let s = 0;
    for (let i = start; i < start + block; i++) {
      const m = (left[i]! + right[i]!) / 2;
      s += m * m;
    }
    env.push(Math.sqrt(s / block));
  }

  const out: Measures = {
    seconds: scene.seconds,
    sampleRate: buffer.sampleRate,
    peak,
    rms: Math.sqrt(sumSq / n),
    rmsL: Math.sqrt(sumSqL / n),
    rmsR: Math.sqrt(sumSqR / n),
    env,
    maxJump,
    spectrum: averageSpectrum(left, right),
  };

  if (scene.compareStrikesAt) {
    const [a, b] = scene.compareStrikesAt;
    out.strikeSimilarity = similarity(
      left,
      Math.round(a * buffer.sampleRate),
      Math.round(b * buffer.sampleRate),
      Math.round(0.04 * buffer.sampleRate),
    );
  }

  return out;
}

/**
 * Усреднённый спектр мощности методом перекрывающихся окон с окном Ханна.
 * Одного окна мало: шум сам по себе изрезан, и по одному срезу полосу дорожки
 * от случайного всплеска не отличить.
 */
function averageSpectrum(left: Float32Array, right: Float32Array): number[] {
  const bins = FFT_SIZE / 2 + 1;
  const acc = new Float64Array(bins);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const hop = FFT_SIZE / 2;

  let windows = 0;
  for (let start = 0; start + FFT_SIZE <= left.length; start += hop) {
    for (let i = 0; i < FFT_SIZE; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      re[i] = ((left[start + i]! + right[start + i]!) / 2) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) acc[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
    windows++;
  }

  if (windows === 0) return Array.from(acc);
  return Array.from(acc, (v) => v / windows);
}

/** Итеративное БПФ по основанию 2, на месте. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Нормированная взаимная корреляция двух окон.
 *
 * Единица означает, что два акцента — одна и та же волна; ради этого числа
 * в акценты и заложена вариативность питча и полосы по индексу.
 */
function similarity(data: Float32Array, offsetA: number, offsetB: number, length: number): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i++) {
    const a = data[offsetA + i] ?? 0;
    const b = data[offsetB + i] ?? 0;
    dot += a * b;
    na += a * a;
    nb += b * b;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.abs(dot) / Math.sqrt(na * nb);
}
