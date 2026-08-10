/**
 * Песочницы мира и общие замеры по нему.
 *
 * Одно определение на все наборы: миры-заготовки нужны и симуляции,
 * и инвентарю, и зданиям, а три копии `box()` разошлись бы на первой правке.
 */
import { World, MAT, Simulation } from '../../src/world';
import { luna } from '../harness';

/** Пустой мир с полом по нижней строке. */
export function box(width = 96, height = 96): World {
  const w = new World(width, height, luna().world.profile);
  for (let x = 0; x < width; x++) w.set(x, height - 1, MAT.ROCK);
  return w;
}

/** Мир с полом в две нижние строки: под зданием обязана быть опора. */
export function ground(width = 96, height = 96): World {
  const w = new World(width, height, luna().world.profile);
  for (let y = height - 2; y < height; y++) {
    for (let x = 0; x < width; x++) w.set(x, y, MAT.ROCK);
  }
  return w;
}

export function count(w: World, material: number): number {
  let n = 0;
  for (const c of w.cells) if (c === material) n++;
  return n;
}

/** Прогоняет шаги, пока мир не уляжется. -1, если не улёгся за предел. */
export function settle(w: World, limit: number): number {
  const sim = new Simulation();
  for (let i = 0; i < limit; i++) {
    sim.update(w, null);
    if (sim.lastCellsVisited === 0) return i + 1;
  }
  return -1;
}

/** Сколько чанков разбужено на следующий шаг. */
export function pending(w: World): number {
  let n = 0;
  for (let cy = 0; cy < w.chunks.rows; cy++) {
    for (let cx = 0; cx < w.chunks.cols; cx++) if (w.chunks.isPending(cx, cy)) n++;
  }
  return n;
}

/** Опустошает оба поколения флагов: дальше видно только новые пробуждения. */
export function quiet(w: World): void {
  w.chunks.advance();
  w.chunks.advance();
}
