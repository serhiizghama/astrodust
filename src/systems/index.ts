/**
 * Геймплейные сервисы: применяют действие игрока к миру.
 *
 * Копание, сбор, стройка, отладочная установка. Слой НАД миром и сущностями:
 * им нужны и сетка, и инвентарь, и счёт, и дерево исследований сразу.
 *
 * Это ЕДИНСТВЕННЫЙ вход в подсистему извне: снаружи импортируют отсюда,
 * внутри — напрямую друг у друга. Что не перечислено здесь — не публично.
 */
export { Digger } from './digging';
export { Vacuum } from './vacuum';
export { Grabber, aimLabel } from './grabber';
export type { GrabAction, GrabPlan, AimLabel } from './grabber';
export { Builder, BuildRun } from './builder';
export type { PlacementIssue, BuildPreview, BuildLine, BuildSide } from './builder';
export { DebugPainter } from './painter';
