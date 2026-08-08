import { FIXED_DT, MAX_STEPS_PER_FRAME } from '../config';

/**
 * Игровой цикл с фиксированным шагом симуляции.
 *
 * Симуляция идёт ровно SIM_HZ раз в секунду независимо от частоты кадров:
 * на 144 Гц персонаж движется с той же скоростью, что и на 60 Гц. Клеточный
 * автомат материалов (следующие изменения) на переменном шаге недетерминирован,
 * поэтому фиксированный шаг закладывается сразу.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private rafId = 0;

  /** Сглаженная частота кадров для диагностики. */
  fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(
    private readonly step: (dt: number) => void,
    private readonly render: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    const elapsed = (now - this.lastTime) / 1000;
    this.lastTime = now;

    this.updateFps(elapsed);

    this.accumulator += elapsed;

    // Догоняем реальное время, но не больше MAX_STEPS_PER_FRAME шагов:
    // после долгой паузы (свёрнутая вкладка) остаток отбрасывается, иначе
    // игра выполнит лавину шагов и телепортирует персонажа.
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.render();
  };

  private updateFps(elapsed: number): void {
    this.fpsAccum += elapsed;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }
}
