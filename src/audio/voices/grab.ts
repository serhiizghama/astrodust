/**
 * Дорожка «Захват»: сухой шорох на порцию набора и глухой сброс комка.
 *
 * Оба звука ОДНОРАЗОВЫЕ, непрерывной части нет. Набор идёт порциями по своему
 * интервалу — тянуть между ними нечего, а текстура «идёт набор» врала бы
 * в паузах, когда квадрат сошёл с кучи.
 *
 * Набор быстрее, чем слух различает события (33 порции в секунду против ~20),
 * поэтому у шорохов свой потолок темпа. Порция, не получившая слота, НЕ
 * теряется: её ячейки возвращаются в окно и делают следующий шорох громче —
 * это и есть «события сверх лимита учитываются в интенсивности дорожки».
 *
 * Файл разрезан надвое: `grabParams` — чистая функция без единой ноды, она
 * и проверяется тестом; ниже драйвер.
 */
import { AUDIO } from '../../config';
import type { AudioBus } from '../context';
import { attenuationAt, clamp01, lerp, panFor, VoiceSlots } from '../model';
import type { AudioSignals } from '../signals';
import type { Voice } from '../voice';

// --- Модель ---

export interface GrabState {
  /** Ячейки, набранные с прошлого шороха. */
  window: number;
  /** Время, прошедшее с прошлого шороха. */
  since: number;
  /** Сколько шорохов прозвучало — детерминированный источник вариативности. */
  rustles: number;
  /** Слышимость и панорама последнего места набора или выброса. */
  att: number;
  pan: number;
}

export interface GrabParams {
  /** Пора ли шороху. */
  rustle: boolean;
  rustleGain: number;
  rustleHz: number;
  /** Ячейки, которые ушли в этот шорох. Нужны, чтобы вернуть их без слота. */
  rustleWindow: number;
  /** Номер шороха: по нему драйвер детерминированно разнообразит тембр. */
  rustleIndex: number;
  /** Выброс случился на этом шаге. */
  drop: boolean;
  dropGain: number;
  /** Панорама общая: набор и выброс на одном шаге не встречаются. */
  pan: number;
}

export function createGrabState(): GrabState {
  return { window: 0, since: 0, rustles: 0, att: 0, pan: 0 };
}

export function createGrabParams(): GrabParams {
  return {
    rustle: false,
    rustleGain: 0,
    rustleHz: AUDIO.grab.hzLow,
    rustleWindow: 0,
    rustleIndex: 0,
    drop: false,
    dropGain: 0,
    pan: 0,
  };
}

/**
 * Сигналы шага → параметры дорожки. Ни одной аллокации: `out` переиспользуется.
 */
export function grabParams(
  signals: AudioSignals,
  state: GrabState,
  dt: number,
  out: GrabParams,
): GrabParams {
  // Место значимо только вместе с ненулевым счётчиком. Пара координат одна:
  // набор и выброс на одном шаге не встречаются.
  if (signals.grabTaken > 0 || signals.grabDropped > 0) {
    state.att = attenuationAt(signals.grabX, signals.grabY, signals.listenerX, signals.listenerY);
    state.pan = panFor(signals.grabX, signals.listenerX);
  }
  state.window += signals.grabTaken;

  const period = 1 / AUDIO.grab.rateHz;
  state.since = Math.min(state.since + dt, period);
  out.rustle = false;
  out.pan = state.pan;

  // Потолок темпа плюс требование ненабранных ячеек за окно: первое не даёт
  // шорохам слиться в треск, второе — звучать над породой, где удержание
  // ничего не меняет.
  if (state.since >= period && state.window > 0) {
    state.since -= period;
    out.rustle = true;
    out.rustleWindow = state.window;
    out.rustleGain =
      Math.sqrt(clamp01(state.window / AUDIO.grab.full)) * AUDIO.grab.gain * state.att;
    // Тона нет: высота шороха гуляет внутри полосы по номеру события. Общий
    // строй дорожка не занимает и с акцентами копания за сетку не спорит.
    out.rustleHz = lerp(AUDIO.grab.hzLow, AUDIO.grab.hzHigh, (state.rustles * 0.618034) % 1);
    out.rustleIndex = state.rustles;
    state.rustles++;
    state.window = 0;
  }

  out.drop = signals.grabDropped > 0;
  out.dropGain = out.drop ? AUDIO.grab.dropGain * state.att : 0;

  return out;
}

/**
 * Шороху не хватило слота — его ячейки возвращаются в окно.
 *
 * Не потеря и не отдельный голос: следующий шорох прозвучит громче ровно
 * на столько, на сколько этот не прозвучал.
 */
export function mergeRustle(state: GrabState, params: GrabParams): void {
  state.window += params.rustleWindow;
}

// --- Драйвер ---

interface ShotChain {
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export class GrabVoice implements Voice {
  readonly id = 'grab';

  private readonly state = createGrabState();
  private readonly params = createGrabParams();

  private bus: AudioBus | null = null;
  private slots: VoiceSlots | null = null;
  private readonly shots: ShotChain[] = [];

  get enabled(): boolean {
    return AUDIO.grab.enabled;
  }

  build(bus: AudioBus, slots: VoiceSlots): void {
    const { ctx, destination } = bus;
    this.bus = bus;
    this.slots = slots;

    for (let i = 0; i < slots.size; i++) {
      const pan = ctx.createStereoPanner();
      pan.connect(destination);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(pan);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = AUDIO.grab.hzLow;
      filter.Q.value = AUDIO.grab.q;
      filter.connect(gain);
      this.shots.push({ filter, gain, pan });
    }
  }

  update(dt: number, signals: AudioSignals, at: number, now: number): void {
    const bus = this.bus;
    const slots = this.slots;
    if (!bus || !slots) return;

    const p = grabParams(signals, this.state, dt, this.params);

    if (p.rustle && p.rustleGain > 0) {
      const slot = slots.acquire(now, at, AUDIO.grab.decay);
      if (slot < 0) mergeRustle(this.state, p);
      else {
        this.fire(
          this.shots[slot]!,
          {
            hz: p.rustleHz,
            q: AUDIO.grab.q,
            gain: p.rustleGain,
            pan: p.pan,
            decay: AUDIO.grab.decay,
            index: p.rustleIndex,
            rate: 1,
          },
          at,
        );
      }
    }

    // Сброс за радиусом слышимости не звучит и слота не занимает.
    if (!p.drop || p.dropGain <= 0) return;
    const slot = slots.acquire(now, at, AUDIO.grab.dropDecay);
    if (slot < 0) return;
    this.fire(
      this.shots[slot]!,
      {
        hz: AUDIO.grab.dropHz,
        q: AUDIO.grab.dropQ,
        gain: p.dropGain,
        pan: p.pan,
        decay: AUDIO.grab.dropDecay,
        index: this.state.rustles,
        // Замедленный шум звучит крупнее — комок падает, а не шуршит.
        rate: 0.6,
      },
      at,
    );
  }

  resync(): void {
    const s = this.state;
    s.window = 0;
    s.since = 0;

    const bus = this.bus;
    if (!bus) return;
    const now = bus.ctx.currentTime;
    for (const chain of this.shots) {
      chain.gain.gain.cancelScheduledValues(now);
      chain.gain.gain.setValueAtTime(0, now);
    }
  }

  /** Единственный создаваемый на событие объект — одноразовый по спецификации. */
  private fire(chain: ShotChain, shot: Shot, at: number): void {
    const bus = this.bus!;

    chain.filter.frequency.setValueAtTime(shot.hz, at);
    chain.filter.Q.setValueAtTime(shot.q, at);
    chain.pan.pan.setValueAtTime(shot.pan, at);

    const g = chain.gain.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(shot.gain, at);
    // Экспоненциальный спад: линейный обрывается на нуле и щёлкает.
    g.exponentialRampToValueAtTime(shot.gain * 0.001, at + shot.decay);
    g.setValueAtTime(0, at + shot.decay);

    const src = bus.ctx.createBufferSource();
    src.buffer = bus.noise;
    src.playbackRate.value = shot.rate;
    src.connect(chain.filter);
    const span = bus.noise.duration - shot.decay;
    src.start(at, ((shot.index * 0.618034) % 1) * span, shot.decay);
  }
}

/** Одно событие дорожки. Шорох и сброс отличаются только числами. */
interface Shot {
  hz: number;
  q: number;
  gain: number;
  pan: number;
  decay: number;
  index: number;
  rate: number;
}
