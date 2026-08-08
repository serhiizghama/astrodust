/**
 * Таблица материалов.
 *
 * Ячейка мира хранит только id материала (один байт). Все свойства берутся
 * отсюда по этому id — так мир 1024x512 занимает 512 КБ вместо мегабайтов
 * объектов, и его можно передать в WASM без копирования, когда симуляция
 * туда переедет.
 *
 * Ключевое разделение: `blocksPlayer` и правила движения — РАЗНЫЕ вещи.
 * Коллизия персонажа читает первое, симуляция — `state` и `density`. Пока это
 * было одно поле, воду выразить было нельзя: сквозь неё персонаж проваливается,
 * но песок в ней тонет, а не проходит насквозь.
 */

/** Агрегатное состояние: определяет, какой набор правил применяет симуляция. */
export const MatterState = {
  Void: 0,
  /** Не двигается никогда и не вытесняется, какова бы ни была плотность. */
  Solid: 1,
  /** Вниз, затем по диагонали вниз-вбок. */
  Powder: 2,
  /** Вниз, затем по диагонали вниз-вбок, затем вбок на дальность растекаемости. */
  Liquid: 3,
  /** Зеркало жидкости: вверх, затем верхние диагонали, затем вбок. */
  Gas: 4,
} as const;

export type MatterStateValue = (typeof MatterState)[keyof typeof MatterState];

export interface Material {
  readonly id: number;
  readonly name: string;
  /** Цвет вида 0xRRGGBB. Для пустоты не используется — она показывает фон мира. */
  readonly color: number;
  /**
   * Останавливает ли персонажа. НЕ участвует в правилах движения материала —
   * вода персонажа не держит, но песок в неё тонет, а не проваливается сквозь.
   */
  readonly blocksPlayer: boolean;
  /** Кто кого вытесняет: плотное тонет в менее плотном, газ всплывает в более плотном. */
  readonly density: number;
  readonly state: MatterStateValue;
  /**
   * Жидкости: сколько ячеек вбок проходит за шаг, когда вниз и по диагонали
   * занято. Дальность одного смещения, а не вязкость.
   */
  readonly spread: number;
  /**
   * Жидкости: доля шагов, на которых материал вообще пытается двигаться, 0..1.
   * 1 — вода, ближе к нулю — расплав. Вязкость выражается ЗДЕСЬ, а не нулевой
   * растекаемостью: жидкость без бокового течения складывается в кучу под углом
   * естественного откоса и становится неотличима от песка.
   */
  readonly flow: number;
  /**
   * Сыпучие: насколько охотно скатывается по диагонали, 0..1.
   * 1 — расплывается пологой кучей, ближе к 0 — держит крутой склон.
   */
  readonly slip: number;
  /** Газы: вероятность исчезнуть за шаг. Иначе газ копится под потолком вечно. */
  readonly dissipate: number;
}

/**
 * Идентификаторы материалов. До 256 — сетка на Uint8Array.
 *
 * Реголит представлен ДВУМЯ материалами, и это не дублирование:
 * REGOLITH_PACKED — терраин, из него сложена поверхность мира;
 * REGOLITH_LOOSE  — сыпучая добыча, появляется только при копании.
 * Если сделать сыпучим сам материал поверхности, весь ландшафт обрушится
 * на первом же шаге симуляции. Превращение первого во второй и есть добыча.
 */
export const MAT = {
  VACUUM: 0,
  ROCK: 1,
  ROCK_DEEP: 2,
  REGOLITH_PACKED: 3,
  REGOLITH_LOOSE: 4,
  WATER: 5,
  LAVA: 6,
  STEAM: 7,
} as const;

/** Значения по умолчанию: у большинства материалов задействована часть полей. */
const base = { spread: 0, flow: 1, slip: 1, dissipate: 0 };

export const MATERIALS: readonly Material[] = [
  {
    ...base,
    id: MAT.VACUUM,
    name: 'Вакуум',
    color: 0x000000,
    blocksPlayer: false,
    density: 0,
    state: MatterState.Void,
  },
  {
    ...base,
    id: MAT.ROCK,
    name: 'Порода',
    color: 0x4a4640,
    blocksPlayer: true,
    density: 400,
    state: MatterState.Solid,
  },
  {
    ...base,
    id: MAT.ROCK_DEEP,
    name: 'Порода (глубинная)',
    color: 0x33302c,
    blocksPlayer: true,
    density: 400,
    state: MatterState.Solid,
  },
  {
    ...base,
    id: MAT.REGOLITH_PACKED,
    name: 'Спёкшийся реголит',
    color: 0x8a8580,
    blocksPlayer: true,
    density: 150,
    state: MatterState.Solid,
  },
  {
    ...base,
    id: MAT.REGOLITH_LOOSE,
    name: 'Реголит',
    // Светлее спёкшегося: свежевыкопанное должно читаться на фоне нетронутого
    // грунта, иначе результат копания не виден.
    color: 0xb5aea4,
    blocksPlayer: true,
    density: 150,
    state: MatterState.Powder,
    // Сухая пыль в вакууме — расплывается пологой кучей.
    slip: 1,
  },
  {
    ...base,
    id: MAT.WATER,
    name: 'Вода',
    color: 0x2f6f9e,
    // Персонажа не держит: сквозь воду он проваливается.
    blocksPlayer: false,
    density: 100,
    state: MatterState.Liquid,
    // Текучая: быстро выравнивает уровень.
    spread: 5,
    flow: 1,
  },
  {
    ...base,
    id: MAT.LAVA,
    name: 'Лава',
    color: 0xd4552a,
    // Жидкость — не пол. Пока лава держала персонажа, по её конусу можно было
    // ходить как по горе, и расплав читался твёрдым телом. Останавливать
    // персонажа расплав будет уроном, когда урон появится.
    blocksPlayer: false,
    // Плотнее воды — сознательное отступление от механики-референса, где лава
    // легче (75). Там это нужно, чтобы вода погружалась и срабатывала реакция
    // с паром. Реакций пока нет: с лёгкой лавой вода просто протекала бы сквозь
    // неё и собиралась под ней. С тяжёлой — остаётся сверху, соприкосновение
    // идёт по границе раздела, где реакция и понадобится. Заодно это ближе
    // к настоящей физике: лава плотнее воды примерно втрое.
    density: 250,
    state: MatterState.Liquid,
    // Растекаемость ненулевая. Прежний ноль выражал вязкость отказом от
    // горизонтального течения — и превращал лаву в сыпучее: силуэт её кучи
    // совпадал с кучей рыхлого реголита ячейка в ячейку, склон под 45°.
    // Вязкость живёт в `flow`, а `spread` остаётся дальностью одного смещения.
    spread: 3,
    // Каждый десятый шаг. Подобрано замером ширины разлива одинакового объёма
    // на ровном полу (шаги: 100 / 300 / 1000 / 3000):
    //   вода           155  155  155  155   — растекается почти мгновенно
    //   лава flow 0.30   39   74   97  102
    //   лава flow 0.10   18   36   73   89   ← вязкость читается сразу
    //   лава flow 0.03   14   17   31   66   — и не успокаивается за 10000 шагов
    // Ниже 0.05 разлив перестаёт сходиться в разумное время, и чанки вокруг
    // лавы не засыпают.
    flow: 0.1,
  },
  {
    ...base,
    id: MAT.STEAM,
    name: 'Пар',
    color: 0x9aa8b4,
    blocksPlayer: false,
    density: 10,
    state: MatterState.Gas,
    spread: 3,
    // Без рассеивания пар, дойдя до потолка, остаётся там навсегда: двигаться
    // ему больше некуда. Позже это место займёт конденсация в воду.
    dissipate: 0.004,
  },
];

/**
 * Развёрнутые в типизированные массивы свойства — рендер, коллизия и симуляция
 * читают их на каждую ячейку, и разыменование объекта там заметно дороже.
 */
const size = MATERIALS.length;
export const MAT_R = new Uint8Array(size);
export const MAT_G = new Uint8Array(size);
export const MAT_B = new Uint8Array(size);
/** Останавливает ли персонажа. Симуляция это поле НЕ читает. */
export const MAT_SOLID = new Uint8Array(size);
export const MAT_STATE = new Uint8Array(size);
export const MAT_DENSITY = new Uint16Array(size);
export const MAT_SPREAD = new Uint8Array(size);
export const MAT_FLOW = new Float32Array(size);
export const MAT_SLIP = new Float32Array(size);
export const MAT_DISSIPATE = new Float32Array(size);

for (const m of MATERIALS) {
  MAT_R[m.id] = (m.color >> 16) & 0xff;
  MAT_G[m.id] = (m.color >> 8) & 0xff;
  MAT_B[m.id] = m.color & 0xff;
  MAT_SOLID[m.id] = m.blocksPlayer ? 1 : 0;
  MAT_STATE[m.id] = m.state;
  MAT_DENSITY[m.id] = m.density;
  MAT_SPREAD[m.id] = m.spread;
  MAT_FLOW[m.id] = m.flow;
  MAT_SLIP[m.id] = m.slip;
  MAT_DISSIPATE[m.id] = m.dissipate;
}

/** Двигается ли материал вниз (сыпучее и жидкое) — проход снизу вверх. */
export const MAT_FALLS = new Uint8Array(size);
/** Двигается ли материал вверх (газы) — отдельный проход сверху вниз. */
export const MAT_RISES = new Uint8Array(size);
/** Жидкость ли это. Мир считает такие ячейки, чтобы пропускать расчёт уровня. */
export const MAT_IS_LIQUID = new Uint8Array(size);

for (const m of MATERIALS) {
  MAT_FALLS[m.id] = m.state === MatterState.Powder || m.state === MatterState.Liquid ? 1 : 0;
  MAT_RISES[m.id] = m.state === MatterState.Gas ? 1 : 0;
  MAT_IS_LIQUID[m.id] = m.state === MatterState.Liquid ? 1 : 0;
}
