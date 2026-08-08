/**
 * Мастер-шина: контекст, ограничитель, общий буфер шума, отключение звука.
 *
 * Контекст создаётся НЕ при загрузке, а по первому действию игрока. Созданный
 * заранее приостановленный контекст — это предупреждение в консоли на каждой
 * загрузке и нода, висящая без дела.
 */
import { AUDIO, WORLD_SEED } from '../config';
import { fillNoise } from './model';

/**
 * Живой звуковой выход. Появляется целиком или не появляется вовсе:
 * промежуточных состояний у него нет.
 */
export interface AudioBus {
  /**
   * Живой или оффлайновый — дорожкам всё равно. Именно на этом держится
   * возможность отрендерить всю звуковую картину в буфер и проверить её
   * числами, а не ушами.
   */
  ctx: BaseAudioContext;
  /** Куда дорожки подключают свой выход. */
  destination: AudioNode;
  /** Общий буфер белого шума длиной в секунду. */
  noise: AudioBuffer;
}

/**
 * Собирает мастер-шину на переданном контексте: гейн → ограничитель → выход.
 *
 * Вынесено из `AudioEngine` намеренно. `AudioEngine` отвечает за жизненный
 * цикл живого контекста — создание по действию игрока, сон вместе с вкладкой;
 * к тому, КАК устроена шина, это отношения не имеет. Разрезав их, тот же самый
 * граф можно построить в `OfflineAudioContext` и измерить.
 */
export function createBus(
  ctx: BaseAudioContext,
  seed = WORLD_SEED,
): AudioBus & { master: GainNode } {
  const master = ctx.createGain();
  master.gain.value = AUDIO.master;

  // Ограничитель не подменяет сведение, а страхует требование «все дорожки
  // на пределе не дают клиппинга»: сумма независимых дорожек в принципе
  // не имеет верхней оценки, если её не поставить явно.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  limiter.knee.value = 3;

  master.connect(limiter);
  limiter.connect(ctx.destination);

  return { ctx, destination: master, noise: makeNoiseBuffer(ctx, seed), master };
}

export class AudioEngine {
  private bus: AudioBus | null = null;
  private master: GainNode | null = null;
  /** Живой контекст: только он умеет засыпать и просыпаться. */
  private live: AudioContext | null = null;
  /** Одна попытка создания. Отказ — не повод пробовать каждый шаг. */
  private attempted = false;
  private muted = false;
  /** Вкладка потеряла фокус: звука быть не должно. */
  private asleep = false;
  /** Фокус вернулся — сглаженные величины дорожек надо сбросить к настоящему. */
  private woke = false;

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Создаёт контекст, если он ещё не создан.
   *
   * @returns шина, если звук доступен, иначе `null` — игра идёт дальше без него.
   */
  ensure(): AudioBus | null {
    if (this.bus) return this.bus;
    if (this.attempted) return null;
    this.attempted = true;

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      // Политика браузера или отсутствующее устройство. Игра не про звук.
      return null;
    }

    // Контекст создаётся уже ПОСЛЕ первого действия игрока, поэтому обычно
    // рождается работающим. Часть браузеров всё равно отдаёт его спящим —
    // жест игрока уже был, и разбудить его можно сразу.
    if (ctx.state === 'suspended') void ctx.resume();

    const { master, ...bus } = createBus(ctx);
    if (this.muted) master.gain.value = 0;

    this.live = ctx;
    this.master = master;
    this.bus = bus;
    return this.bus;
  }

  /** Спит ли звук: вкладка свёрнута либо контекст ещё не разбужен браузером. */
  get asleepNow(): boolean {
    return this.asleep;
  }

  /**
   * Забирает признак «фокус только что вернулся».
   *
   * Читается один раз: дорожки по нему приравнивают свои сглаженные величины
   * к текущему сигналу, иначе догоняли бы своё состояние от значения,
   * накопленного до сворачивания.
   */
  takeWoke(): boolean {
    const w = this.woke;
    this.woke = false;
    return w;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Отключение и включение звука.
   *
   * Мгновенный ноль даёт щелчок — разрыв волны; 20 мс на слух неотличимы
   * от мгновенного. Дорожки при этом продолжают считаться: включение
   * возвращает текущее состояние мира, а не тишину до следующего события.
   */
  toggleMute(): void {
    this.muted = !this.muted;
    const master = this.master;
    if (!master || !this.bus) return;
    const now = this.bus.ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(this.muted ? 0 : AUDIO.master, now + AUDIO.muteFade);
  }

  private onVisibility = (): void => {
    const live = this.live;
    if (!live) {
      this.asleep = document.hidden;
      return;
    }
    if (document.hidden) {
      this.asleep = true;
      void live.suspend();
    } else {
      this.asleep = false;
      this.woke = true;
      void live.resume();
    }
  };
}

/**
 * Буфер белого шума на секунду по фактической частоте дискретизации устройства.
 *
 * Все шумовые источники — помол, акценты, пыль — читают его же, различаясь
 * фильтром, огибающей и скоростью воспроизведения. 176 КБ при 44.1 кГц.
 */
function makeNoiseBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const length = Math.round(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  fillNoise(buffer.getChannelData(0), seed);
  return buffer;
}
