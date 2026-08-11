/**
 * Сцена с сепаратором: постановка в известную точку и подача сырья.
 *
 * Общая для наборов `separator` и `building-placement`: первый проверяет,
 * что машина делает с веществом, второй — как она встаёт в мир, и обоим нужна
 * одна и та же сцена.
 */
import { World, MAT } from '../../src/world';
import { LandingModule, BuildingRegistry, SEPARATOR_KIND } from '../../src/entities';
import { Builder } from '../../src/systems';
import { SEPARATOR } from '../../src/config';
import { ground } from './world';

/**
 * Сцена под машину: сепаратор 25 ячеек в стороне, лента под ним — секциями
 * по 8, и в песочнице 96×96 им уже негде развернуться.
 */
const SCENE_W = 192;
const SCENE_H = 192;

/** Верхний левый угол здания, стоящего на полу сцены. */
export const BX = 40;
export const BY = SCENE_H - 2 - SEPARATOR.height;

export function scene(credits = 0): {
  world: World;
  module: LandingModule;
  registry: BuildingRegistry;
} {
  const w = ground(SCENE_W, SCENE_H);
  const module = new LandingModule({ x: 2, y: 2, w: 4, h: 4 });
  module.credits = credits;
  return { world: w, module, registry: new BuildingRegistry() };
}

/** Ставит сепаратор в известную точку и отдаёт его. */
export function build(
  w: World,
  registry: BuildingRegistry,
  x = BX,
  y = BY,
): 'placed' | 'demolished' | 'rejected' {
  const cx = x + (SEPARATOR_KIND.width >> 1);
  const cy = y + (SEPARATOR_KIND.height >> 1);
  return Builder.apply(w, registry, SEPARATOR_KIND, cx, cy, cx, cy);
}

/**
 * Насыпает пульпу на приёмную грань — от СЕРЕДИНЫ к краям.
 *
 * Ячейка на самом краю грани скатывается по диагонали мимо машины ещё
 * до того, как та успеет её поглотить, и порция выходит неполной.
 */
export function feed(w: World, cells: number, x = BX, y = BY): number {
  let placed = 0;
  const from = (SEPARATOR.width - Math.min(cells, SEPARATOR.width)) >> 1;
  for (let dx = from; dx < SEPARATOR.width && placed < cells; dx++) {
    if (w.get(x + dx, y - 1) !== MAT.VACUUM) continue;
    w.set(x + dx, y - 1, MAT.PULP);
    placed++;
  }
  return placed;
}
