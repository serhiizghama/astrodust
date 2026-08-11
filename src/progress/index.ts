/**
 * Прогресс партии: очки, дерево технологий и профиль настроек.
 *
 * Технологии правят профиль, а читатели параметров видят только его — про
 * исследования они не знают ничего.
 *
 * Это ЕДИНСТВЕННЫЙ вход в подсистему извне: снаружи импортируют отсюда,
 * внутри — напрямую друг у друга. Что не перечислено здесь — не публично.
 */
export { Research, ResearchOverlay, NO_UNLOCKS, statusNote } from './research';
export type {
  ContentUnlocks,
  CreditAccount,
  TechStatus,
  TechNote,
  PointerTarget,
} from './research';
export { TECHNOLOGIES, TECH_BY_ID, CONTENT, maxTuned } from './technologies';
export type { Technology, TechEffect } from './technologies';
export { TECH_NODES, TECH_EDGES, TECH_COLS, TECH_ROWS, stepTo } from './tech-layout';
export type { TechNode, TechEdge } from './tech-layout';
export { Tuning, TUNING_BASE } from './tuning';
