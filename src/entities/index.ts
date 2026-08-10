/**
 * Сущности, живущие в мире.
 *
 * Персонаж, инвентарь, постройки и приёмник. Читают мир и меняют его, но
 * не решают, когда это происходит: порядок задаёт шаг игры.
 *
 * Это ЕДИНСТВЕННЫЙ вход в подсистему извне: снаружи импортируют отсюда,
 * внутри — напрямую друг у друга. Что не перечислено здесь — не публично.
 */
export { Player, NO_INPUT } from './player';
export type { PlayerInput } from './player';
export { Inventory } from './inventory';
export { Building, BuildingRegistry, stampKind } from './buildings';
export type { BuildingKind } from './buildings';
export { BUILD_CATALOG, BuildCatalogState, isKindOpen, sectionKindByHull } from './catalog';
export { CONVEYOR_LEFT_KIND, CONVEYOR_RIGHT_KIND } from './conveyor';
export {
  SEPARATOR_KIND,
  Separator,
  OUTLET_ROW,
  OUTLET_FROM,
  OUTLET_TO,
  machineSummary,
} from './separator';
export { LandingModule } from './landing-module';
