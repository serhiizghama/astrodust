/**
 * Реестр дорожек и шаг звука.
 *
 * Единственная точка, которую знает игра. Механики о звуке не знают вовсе:
 * они публикуют счётчики за шаг, а `main.ts` собирает из них снапшот сигналов
 * и отдаёт сюда. Вырезав папку `src/audio/` и один вызов, игру можно оставить
 * без звука и без единой другой правки.
 */
import { AUDIO } from '../config';
import { AudioEngine } from './context';
import { AudioClock, VoiceSlots } from './model';
import type { AudioSignals } from './signals';
import type { Voice } from './voice';
import { DigVoice } from './voices/dig';
import { DustVoice } from './voices/dust';
import { GrabVoice } from './voices/grab';

/**
 * Реестр дорожек. Новая дорожка — новый файл и одна строка здесь.
 *
 * Функция, а не константа: список нужен и игре, и оффлайн-рендеру проверок,
 * а дорожки держат состояние — общий экземпляр они делить не могут.
 */
export function createVoices(): Voice[] {
  return [new DigVoice(), new DustVoice(), new GrabVoice()];
}

export class Soundscape {
  private readonly engine = new AudioEngine();
  private readonly clock = new AudioClock();
  /**
   * Общий бюджет одноразовых голосов. Он один на все дорожки: ограничивать
   * надо суммарное число звучащих голосов, а не каждую дорожку по отдельности.
   */
  private readonly slots = new VoiceSlots(AUDIO.maxOneShots);

  private readonly voices: Voice[] = createVoices();

  private built = false;

  /**
   * Шаг звука.
   *
   * @param interacted состоялось ли первое действие игрока. До него ранний
   *   выход: события не копятся и не проигрываются залпом при разблокировке,
   *   а контекст не создаётся — браузер всё равно не даст ему звучать.
   */
  update(dt: number, signals: AudioSignals, interacted: boolean): void {
    if (!interacted) return;

    const bus = this.engine.ensure();
    if (!bus) return; // звука не будет: игра идёт дальше

    if (!this.built) {
      for (const voice of this.voices) if (voice.enabled) voice.build(bus, this.slots);
      this.built = true;
    }

    if (this.engine.asleepNow) return;

    if (this.engine.takeWoke()) {
      // Курсор часов ушёл в прошлое, слоты числятся занятыми, сглаженные
      // величины дорожек хранят состояние мира тридцатисекундной давности.
      this.clock.reset();
      this.slots.reset();
      for (const voice of this.voices) if (voice.enabled) voice.resync();
    }

    const now = bus.ctx.currentTime;
    const at = this.clock.next(now);
    for (const voice of this.voices) if (voice.enabled) voice.update(dt, signals, at, now);
  }

  /** Отключение и включение всего звука одной клавишей. */
  toggleMute(): void {
    this.engine.toggleMute();
  }

  get muted(): boolean {
    return this.engine.isMuted;
  }
}
