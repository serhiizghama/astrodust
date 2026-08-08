/**
 * Дорожка «Копание»: контактный звук инструмента по породе.
 *
 * 33 применения кисти в секунду — не удары, а треск: слух перестаёт различать
 * отдельные события примерно с 20 Гц. Поэтому дорожка состоит из двух частей:
 * непрерывного ПОМОЛА, сообщающего «идёт работа», и редких АКЦЕНТОВ, дающих
 * ритм. Помол молчит, когда выработки нет: пустота, недостижимая цель и уже
 * рыхлый материал ударом по породе не звучат.
 *
 * Файл разрезан надвое: `digParams` — чистая функция без единой ноды, она
 * и проверяется тестом; ниже драйвер, в котором не осталось условия сложнее
 * «изменилось ли значение».
 */
import { AUDIO } from '../../config';
import type { AudioBus } from '../context';
import {
  approach,
  attenuationAt,
  changed,
  clamp01,
  lerp,
  panFor,
  scaleToneIn,
  VoiceSlots,
} from '../model';
import type { AudioSignals } from '../signals';
import type { Voice } from '../voice';

// --- Модель ---

export interface DigState {
  /** Сглаженная интенсивность помола, 0..1. */
  grind: number;
  /** Энергия акцентов, которым не хватило слота: влита в помол, а не потеряна. */
  merged: number;
  /** Выработка, накопленная с прошлого акцента. */
  window: number;
  /** Время, прошедшее с прошлого акцента. */
  since: number;
  /** Сколько акцентов уже прозвучало — детерминированный источник вариативности. */
  strikes: number;
  /** Слышимость и панорама последней точки копания. */
  att: number;
  pan: number;
  /** Что уже отправлено драйверу: ниже порога параметры не трогаются. */
  sentGain: number;
  sentHz: number;
  sentPan: number;
}

export interface DigParams {
  /** Стоит ли вообще трогать параметры помола в этом шаге. */
  grindChanged: boolean;
  grindGain: number;
  grindHz: number;
  grindPan: number;
  /** Пора ли акценту. */
  strike: boolean;
  strikeGain: number;
  strikeHz: number;
  strikePan: number;
  /** Номер акцента: по нему драйвер детерминированно разнообразит тембр. */
  strikeIndex: number;
}

export function createDigState(): DigState {
  return {
    grind: 0,
    merged: 0,
    window: 0,
    since: 0,
    strikes: 0,
    att: 0,
    pan: 0,
    sentGain: 0,
    sentHz: AUDIO.dig.hzQuiet,
    sentPan: 0,
  };
}

export function createDigParams(): DigParams {
  return {
    grindChanged: false,
    grindGain: 0,
    grindHz: AUDIO.dig.hzQuiet,
    grindPan: 0,
    strike: false,
    strikeGain: 0,
    strikeHz: AUDIO.dig.strikeHzLow,
    strikePan: 0,
    strikeIndex: 0,
  };
}

/**
 * Сигналы шага → параметры дорожки. Ни одной аллокации: `out` переиспользуется.
 */
export function digParams(
  signals: AudioSignals,
  state: DigState,
  dt: number,
  out: DigParams,
): DigParams {
  // Точка копания значима только вместе с ненулевой выработкой. При нулевой
  // слышимость и панорама остаются прежними — гаснущему помолу они и нужны.
  if (signals.digConverted > 0) {
    state.att = attenuationAt(signals.digX, signals.digY, signals.listenerX, signals.listenerY);
    state.pan = panFor(signals.digX, signals.listenerX);
    state.window += signals.digConverted;
  }

  // Помол следует СГЛАЖЕННОМУ темпу выработки: кисть применяется рывками
  // с интервалом в два шага симуляции, и мгновенный темп дёргал бы громкость.
  const target = clamp01(signals.digConverted / (dt * AUDIO.dig.fullRate));
  state.grind = approach(
    state.grind,
    target,
    dt,
    target > state.grind ? AUDIO.dig.attack : AUDIO.dig.release,
  );
  state.merged = approach(state.merged, 0, dt, AUDIO.dig.release);

  let gain = state.grind * AUDIO.dig.gain * state.att + state.merged;
  // Ниже порога — ровно ноль, а не бесконечный экспоненциальный хвост.
  if (gain < AUDIO.paramEpsilon) gain = 0;

  out.grindGain = gain;
  out.grindHz = lerp(AUDIO.dig.hzQuiet, AUDIO.dig.hzLoud, state.grind);
  out.grindPan = state.pan;
  out.grindChanged =
    changed(state.sentGain, out.grindGain) ||
    changed(state.sentHz, out.grindHz, AUDIO.dig.hzLoud - AUDIO.dig.hzQuiet) ||
    changed(state.sentPan, out.grindPan, 2);
  if (out.grindChanged) {
    state.sentGain = out.grindGain;
    state.sentHz = out.grindHz;
    state.sentPan = out.grindPan;
  }

  // Акценты: потолок темпа плюс требование ненулевой выработки за окно.
  // Первое не даёт им слиться в треск, второе — звучать в пустоте.
  const period = 1 / AUDIO.dig.strikeHz;
  state.since = Math.min(state.since + dt, period);
  out.strike = false;
  if (state.since >= period && state.window > 0) {
    state.since -= period;
    out.strike = true;
    out.strikeGain =
      Math.sqrt(clamp01(state.window / AUDIO.dig.strikeFull)) * AUDIO.dig.strikeGain * state.att;
    out.strikeHz = scaleToneIn(state.strikes, AUDIO.dig.strikeHzLow, AUDIO.dig.strikeHzHigh);
    out.strikePan = state.pan;
    out.strikeIndex = state.strikes;
    state.strikes++;
    state.window = 0;
  }

  return out;
}

/**
 * Акценту не хватило слота — его энергия уходит в помол.
 *
 * Складываются мощности, а не амплитуды, и сумма упирается в потолок самой
 * дорожки: залп становится ГРОМЧЕ, но не выходит за отведённый ей бюджет
 * и не рассыпается на щелчки.
 */
export function mergeStrike(state: DigState, params: DigParams): void {
  state.merged = Math.min(AUDIO.dig.gain, Math.hypot(state.merged, params.strikeGain));
}

// --- Драйвер ---

interface StrikeChain {
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export class DigVoice implements Voice {
  readonly id = 'dig';

  private readonly state = createDigState();
  private readonly params = createDigParams();

  private bus: AudioBus | null = null;
  private slots: VoiceSlots | null = null;
  private grindGain: GainNode | null = null;
  private grindFilter: BiquadFilterNode | null = null;
  private grindPan: StereoPannerNode | null = null;
  private readonly strikes: StrikeChain[] = [];

  get enabled(): boolean {
    return AUDIO.dig.enabled;
  }

  build(bus: AudioBus, slots: VoiceSlots): void {
    const { ctx, destination, noise } = bus;
    this.bus = bus;
    this.slots = slots;

    const pan = ctx.createStereoPanner();
    pan.connect(destination);

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(pan);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = AUDIO.dig.hzQuiet;
    filter.Q.value = AUDIO.dig.q;
    filter.connect(gain);

    // Источник помола вечный: он создаётся один раз и не пересоздаётся никогда.
    // Управляется только громкость — так дорожка стоит одинаково и в покое,
    // и на обвале.
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.connect(filter);
    src.start();

    this.grindPan = pan;
    this.grindGain = gain;
    this.grindFilter = filter;

    for (let i = 0; i < slots.size; i++) {
      const sp = ctx.createStereoPanner();
      sp.connect(destination);
      const sg = ctx.createGain();
      sg.gain.value = 0;
      sg.connect(sp);
      // Добротная полоса: из шума получается пятно с различимой высотой —
      // призвук инструмента без отдельного осциллятора, то есть без второго
      // создаваемого объекта на событие.
      const sf = ctx.createBiquadFilter();
      sf.type = 'bandpass';
      sf.frequency.value = AUDIO.dig.strikeHzLow;
      sf.Q.value = AUDIO.dig.strikeQ;
      sf.connect(sg);
      this.strikes.push({ filter: sf, gain: sg, pan: sp });
    }
  }

  update(dt: number, signals: AudioSignals, at: number, now: number): void {
    const bus = this.bus;
    const slots = this.slots;
    if (!bus || !slots) return;

    const p = digParams(signals, this.state, dt, this.params);

    if (p.grindChanged) {
      this.grindGain!.gain.setTargetAtTime(p.grindGain, at, AUDIO.smooth);
      this.grindFilter!.frequency.setTargetAtTime(p.grindHz, at, AUDIO.smooth);
      this.grindPan!.pan.setTargetAtTime(p.grindPan, at, AUDIO.smooth);
    }

    // Акцент за радиусом слышимости не звучит и слота не занимает: в вакууме
    // до скафандра доходит только контакт.
    if (!p.strike || p.strikeGain <= 0) return;

    const slot = slots.acquire(now, at, AUDIO.dig.strikeDecay);
    if (slot < 0) mergeStrike(this.state, p);
    else this.fire(this.strikes[slot]!, p, at);
  }

  resync(): void {
    const s = this.state;
    s.grind = 0;
    s.merged = 0;
    s.window = 0;
    s.since = 0;
    s.sentGain = 0;
    s.sentHz = AUDIO.dig.hzQuiet;
    s.sentPan = 0;

    const bus = this.bus;
    if (!bus) return;
    const now = bus.ctx.currentTime;
    hardSet(this.grindGain!.gain, 0, now);
    hardSet(this.grindFilter!.frequency, AUDIO.dig.hzQuiet, now);
    for (const chain of this.strikes) hardSet(chain.gain.gain, 0, now);
  }

  /** Единственный создаваемый на событие объект — одноразовый по спецификации. */
  private fire(chain: StrikeChain, p: DigParams, at: number): void {
    const bus = this.bus!;
    const decay = AUDIO.dig.strikeDecay;

    chain.filter.frequency.setValueAtTime(p.strikeHz, at);
    chain.pan.pan.setValueAtTime(p.strikePan, at);

    const g = chain.gain.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(p.strikeGain, at);
    // Экспоненциальный спад: линейный обрывается на нуле и щёлкает.
    g.exponentialRampToValueAtTime(p.strikeGain * 0.001, at + decay);
    g.setValueAtTime(0, at + decay);

    const src = bus.ctx.createBufferSource();
    src.buffer = bus.noise;
    // Вариативность по детерминированному индексу — против слухового утомления
    // на десятках секунд непрерывного копания. Генератора случайных чисел
    // в игровом коде нет, как и в клеточном автомате.
    src.playbackRate.value = 0.88 + ((p.strikeIndex * 7) % 5) * 0.06;
    src.connect(chain.filter);
    const span = bus.noise.duration - decay;
    src.start(at, ((p.strikeIndex * 0.618034) % 1) * span, decay);
  }
}

/** Мгновенная установка параметра: возврат фокуса — не повод плавно догонять. */
function hardSet(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
}
