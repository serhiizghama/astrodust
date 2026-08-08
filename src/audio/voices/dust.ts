/**
 * Дорожка «Пыль»: осыпающийся реголит.
 *
 * Сыпучее двигает сотни ячеек за шаг — десятки тысяч в секунду. Одноразовый
 * звук на ячейку не звук, а белый шум и мгновенная смерть по числу нод.
 * Поэтому здесь ОДИН зацикленный источник, созданный при инициализации
 * и не пересоздаваемый никогда; управляется темп движения, а не ячейки.
 *
 * Имя дорожки — «Пыль», не «Снег»: снег подразумевает воздух, шелест и мягкое
 * оседание, а вакуум их запрещает. Реголит — измельчённая порода, падает сухо
 * и жёстко. Переигрывается блоком конфига, а не правкой этого файла.
 */
import { AUDIO } from '../../config';
import type { AudioBus } from '../context';
import { attenuationAt, changed, lerp, panFor, VoiceSlots } from '../model';
import type { AudioSignals } from '../signals';
import type { Voice } from '../voice';

// --- Модель ---

export interface DustState {
  /** Слышимость и панорама последнего центра масс движения. */
  att: number;
  pan: number;
  sentGain: number;
  sentHz: number;
  sentPan: number;
}

export interface DustParams {
  changed: boolean;
  gain: number;
  hz: number;
  pan: number;
  /** Растёт ли интенсивность: атака быстрая, спад медленный. */
  rising: boolean;
}

export function createDustState(): DustState {
  return { att: 0, pan: 0, sentGain: 0, sentHz: AUDIO.dust.hzQuiet, sentPan: 0 };
}

export function createDustParams(): DustParams {
  return { changed: false, gain: 0, hz: AUDIO.dust.hzQuiet, pan: 0, rising: false };
}

/**
 * Интенсивность текстуры по числу сдвигов за шаг.
 *
 * Корень, а не пропорция: между десятью и тысячей движущихся ячеек по
 * громкости должно быть в разы, а не в сто раз. Потолок в единице — обвал
 * достигает своего предела и не перегружает шину.
 */
export function dustIntensity(moves: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, moves) / AUDIO.dust.fullMoves));
}

export function dustParams(signals: AudioSignals, state: DustState, out: DustParams): DustParams {
  const i = dustIntensity(signals.powderMoves);

  if (signals.powderMoves > 0) {
    state.att = attenuationAt(
      signals.powderX,
      signals.powderY,
      signals.listenerX,
      signals.listenerY,
    );
    state.pan = panFor(signals.powderX, signals.listenerX);
  }

  let gain = i * AUDIO.dust.gain * state.att;
  if (gain < AUDIO.paramEpsilon) gain = 0;

  out.rising = gain > state.sentGain;
  out.gain = gain;
  out.hz = lerp(AUDIO.dust.hzQuiet, AUDIO.dust.hzLoud, i);
  out.pan = state.pan;
  out.changed =
    changed(state.sentGain, out.gain) ||
    changed(state.sentHz, out.hz, AUDIO.dust.hzLoud - AUDIO.dust.hzQuiet) ||
    changed(state.sentPan, out.pan, 2);
  if (out.changed) {
    state.sentGain = out.gain;
    state.sentHz = out.hz;
    state.sentPan = out.pan;
  }

  return out;
}

// --- Драйвер ---

export class DustVoice implements Voice {
  readonly id = 'dust';

  private readonly state = createDustState();
  private readonly params = createDustParams();

  private bus: AudioBus | null = null;
  private gain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private pan: StereoPannerNode | null = null;

  get enabled(): boolean {
    return AUDIO.dust.enabled;
  }

  build(bus: AudioBus, _slots: VoiceSlots): void {
    const { ctx, destination, noise } = bus;
    this.bus = bus;

    const pan = ctx.createStereoPanner();
    pan.connect(destination);

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(pan);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = AUDIO.dust.hzQuiet;
    filter.Q.value = AUDIO.dust.q;
    filter.connect(gain);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.connect(filter);
    src.start();

    this.pan = pan;
    this.gain = gain;
    this.filter = filter;
  }

  update(_dt: number, signals: AudioSignals, at: number, _now: number): void {
    if (!this.bus) return;
    const p = dustParams(signals, this.state, this.params);
    if (!p.changed) return;

    // Быстрая атака и медленный спад. Экспоненциальный подход к нулю физически
    // не даёт щелчка на обрыве: последняя остановившаяся ячейка не рвёт звук,
    // а уводит его в тишину.
    const tau = p.rising ? AUDIO.dust.attack : AUDIO.dust.release;
    this.gain!.gain.setTargetAtTime(p.gain, at, tau);
    this.filter!.frequency.setTargetAtTime(p.hz, at, tau);
    // Панорама следует за центром масс движения, а не за кадром.
    this.pan!.pan.setTargetAtTime(p.pan, at, AUDIO.dust.attack);
  }

  resync(): void {
    const s = this.state;
    s.sentGain = 0;
    s.sentHz = AUDIO.dust.hzQuiet;
    s.sentPan = 0;

    const bus = this.bus;
    if (!bus) return;
    const now = bus.ctx.currentTime;
    this.gain!.gain.cancelScheduledValues(now);
    this.gain!.gain.setValueAtTime(0, now);
    this.filter!.frequency.cancelScheduledValues(now);
    this.filter!.frequency.setValueAtTime(AUDIO.dust.hzQuiet, now);
  }
}
