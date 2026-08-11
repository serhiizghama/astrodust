/**
 * Захват: квадратная кисть со своим буфером.
 *
 * Инструмент чистый — мир, буфер и цель на входе, изменения на выходе, —
 * поэтому проверяется напрямую, без кадра и без бутстрапа.
 *
 * Темп задан интервалом, и один вызов `update` с `dt` меньше интервала делает
 * ровно одно применение. Везде ниже `dt = FIXED_DT`, как в игре.
 */
import { World, MAT, MATERIALS, MAT_PORTABLE } from '../src/world';
import { GRAB, GRAB_CAPACITY, DIG, PLAYER, FIXED_DT } from '../src/config';
import { Grab, LandingModule } from '../src/entities';
import { Grabber } from '../src/systems';
import { check } from './harness';
import { box, count, settle } from './fixtures/world';

const HALF = (GRAB.side - 1) >> 1;

/** Персонаж далеко от цели: хитбокс не должен мешать выбросу. */
const AWAY = { cx: 4, cy: 4 };

/** Заливка прямоугольника одним веществом. */
function fill(w: World, x0: number, y0: number, x1: number, y1: number, m: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) w.set(x, y, m);
  }
}

/** Одно применение инструмента: нажатие плюс удержание того же шага. */
function press(
  g: Grabber,
  w: World,
  grab: Grab,
  tx: number,
  ty: number,
  cx = AWAY.cx,
  cy = AWAY.cy,
  occupant: Parameters<Grabber['update']>[9] = null,
): number {
  return g.update(FIXED_DT, w, grab, true, true, cx, cy, tx, ty, occupant);
}

// --- Форма кисти и инварианты стороны ---

{
  check(
    'Сторона квадрата нечётная — квадрат симметричен вокруг ячейки цели',
    GRAB.side % 2 === 1,
    `сторона ${GRAB.side}`,
  );

  check(
    'Ёмкость буфера равна площади квадрата',
    GRAB_CAPACITY === GRAB.side * GRAB.side && new Grab().capacity === GRAB_CAPACITY,
    `${GRAB.side}² = ${GRAB_CAPACITY}`,
  );

  // Инвариант 1: захват не шире кисти копания. Взять за раз больше, чем
  // выкапывается, он не имеет права — иначе копание перестаёт ограничивать добычу.
  check(
    'Захват не шире поперечника кисти копания',
    GRAB.side <= 2 * DIG.radius + 1,
    `${GRAB.side} ≤ ${2 * DIG.radius + 1}`,
  );

  // Инвариант 2: при клавиатурном прицеле вбок квадрат примыкает к хитбоксу
  // без зазора — вещество у ног достижимо без мыши.
  check(
    'Клавиатурный прицел вбок доводит квадрат до хитбокса',
    DIG.aimDistance <= PLAYER.hitboxW / 2 + HALF,
    `${DIG.aimDistance} ≤ ${PLAYER.hitboxW / 2 + HALF}`,
  );
}

{
  // Квадрат, а не круг, и симметричный: опустевшая область отступает от цели
  // на одинаковое число ячеек во все четыре стороны.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 60, 60, MAT.REGOLITH_LOOSE);
  const tx = 40;
  const ty = 40;
  press(g, w, grab, tx, ty);

  // Предел обхода — сторона квадрата: за неё выемка выйти не может, а цикл
  // без предела на краю мира ушёл бы в бесконечность вместо провала проверки.
  const reach = (dx: number, dy: number): number => {
    let n = 0;
    while (n < GRAB.side && w.get(tx + dx * (n + 1), ty + dy * (n + 1)) === MAT.VACUUM) n++;
    return n;
  };
  const left = reach(-1, 0);
  const right = reach(1, 0);
  const up = reach(0, -1);
  const down = reach(0, 1);

  check(
    'Кисть квадратная и симметричная вокруг цели',
    left === HALF && right === HALF && up === HALF && down === HALF,
    `влево ${left}, вправо ${right}, вверх ${up}, вниз ${down}`,
  );

  // Угол квадрата пуст — у круга он остался бы на месте.
  check(
    'Углы квадрата затронуты — это не круг',
    w.get(tx - HALF, ty - HALF) === MAT.VACUUM && w.get(tx + HALF, ty + HALF) === MAT.VACUUM,
  );

  check(
    'Полный квадрат сплошного вещества набивает буфер целиком',
    grab.used === GRAB_CAPACITY && grab.free === 0 && grab.isFull,
    `${grab.used}/${GRAB_CAPACITY}`,
  );
}

// --- Что берётся ---

{
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 60, 60, MAT.REGOLITH_LOOSE);
  const before = count(w, MAT.REGOLITH_LOOSE);
  const taken = press(g, w, grab, 40, 40);
  const after = count(w, MAT.REGOLITH_LOOSE);

  check(
    'Сколько исчезло из мира, столько прибавилось в буфере',
    before - after === taken && grab.count(MAT.REGOLITH_LOOSE) === taken && taken > 0,
    `из мира ${before - after}, в буфер ${grab.count(MAT.REGOLITH_LOOSE)}`,
  );
}

{
  // Непереносимое не берётся, и список у захвата тот же, что у пылесоса:
  // веток по id вещества ни там, ни там нет.
  const cases: readonly [string, number][] = [
    ['порода', MAT.ROCK],
    ['вода', MAT.WATER],
    ['лава', MAT.LAVA],
    ['пар', MAT.STEAM],
    ['лёд', MAT.ICE],
  ];
  let wrong = '';
  for (const [name, m] of cases) {
    const w = box();
    const grab = new Grab();
    const g = new Grabber();
    fill(w, 30, 30, 50, 50, m);
    const before = count(w, m);
    press(g, w, grab, 40, 40);
    if (count(w, m) !== before || grab.used !== 0) wrong += `${name} `;
  }
  check('Порода, вода, лава, пар и лёд захватом не берутся', wrong === '', wrong);

  const portable = MATERIALS.filter((m) => MAT_PORTABLE[m.id] === 1).map((m) => m.id);
  let mismatch = '';
  for (const m of MATERIALS) {
    const w = box();
    const grab = new Grab();
    const g = new Grabber();
    fill(w, 35, 35, 45, 45, m.id);
    press(g, w, grab, 40, 40);
    const grabbed = grab.used > 0;
    if (grabbed !== portable.includes(m.id)) mismatch += `${m.name} `;
  }
  check('Списки переносимого у захвата и таблицы материалов совпадают', mismatch === '', mismatch);
}

{
  // Смешанный комок: счётчики раздельные, предел общий.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 30, 30, MAT.REGOLITH_LOOSE);
  fill(w, 50, 50, 60, 60, MAT.IRIDIUM);
  press(g, w, grab, 25, 25);
  const regolith = grab.count(MAT.REGOLITH_LOOSE);
  g.update(FIXED_DT, w, grab, false, false, AWAY.cx, AWAY.cy, 25, 25); // отпустили
  press(g, w, grab, 55, 55);

  check(
    'Комок бывает смешанным: счётчики раздельные, предел общий',
    grab.count(MAT.REGOLITH_LOOSE) === regolith &&
      grab.count(MAT.IRIDIUM) > 0 &&
      grab.used === regolith + grab.count(MAT.IRIDIUM),
    `реголит ${regolith}, иридий ${grab.count(MAT.IRIDIUM)}, всего ${grab.used}`,
  );
}

{
  // На границе ёмкости берётся ровно то, что влезает: остальное остаётся в мире.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  grab.add(MAT.PULP, GRAB_CAPACITY - 3);
  fill(w, 30, 30, 50, 50, MAT.REGOLITH_LOOSE);
  const before = count(w, MAT.REGOLITH_LOOSE);
  press(g, w, grab, 40, 40);

  check(
    'На границе ёмкости берётся ровно то, что влезает',
    grab.count(MAT.REGOLITH_LOOSE) === 3 &&
      before - count(w, MAT.REGOLITH_LOOSE) === 3 &&
      grab.used === GRAB_CAPACITY,
    `взято ${grab.count(MAT.REGOLITH_LOOSE)}, в буфере ${grab.used}`,
  );
}

{
  // Взятое снизу будит мир: лежащее выше обязано осыпаться.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 40, 40, 50, 80, MAT.REGOLITH_LOOSE);
  const topBefore = w.get(45, 40);
  press(g, w, grab, 45, 70);
  settle(w, 400);

  check(
    'Взятое снизу осыпается сверху',
    topBefore === MAT.REGOLITH_LOOSE && w.get(45, 40) === MAT.VACUUM,
    `верх кучи после осадки: ${w.get(45, 40)}`,
  );
}

// --- Решение по цели ---

{
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.REGOLITH_LOOSE);

  press(g, w, grab, 40, 40);
  check('Нажатие по веществу берёт', grab.used > 0);
}

{
  // Нажатие по пустоте кладёт: игрок донёс комок и высыпал его.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  grab.add(MAT.REGOLITH_LOOSE, 20);
  press(g, w, grab, 40, 40);

  check(
    'Нажатие по пустоте кладёт комок',
    grab.used === 0 && count(w, MAT.REGOLITH_LOOSE) === 20,
    `в буфере ${grab.used}, в мире ${count(w, MAT.REGOLITH_LOOSE)}`,
  );
}

{
  // Полный буфер кладёт даже над веществом: иначе инструмент замирает.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  grab.add(MAT.IRIDIUM, GRAB_CAPACITY);
  // Куча пониже цели, чтобы в квадрате остались свободные ячейки.
  fill(w, 30, 44, 50, 50, MAT.REGOLITH_LOOSE);
  press(g, w, grab, 40, 40);

  check(
    'Полный буфер кладёт даже над веществом',
    grab.used < GRAB_CAPACITY && count(w, MAT.IRIDIUM) > 0,
    `в буфере ${grab.used}, иридия в мире ${count(w, MAT.IRIDIUM)}`,
  );
}

{
  // Решение штриха держится до отпускания: проводка, добравшая буфер до полного,
  // тем же удержанием не вываливает его обратно.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 70, 70, MAT.REGOLITH_LOOSE);

  g.update(FIXED_DT, w, grab, true, true, AWAY.cx, AWAY.cy, 40, 40);
  let placed = 0;
  // Дальше только удержание, много шагов, целью не двигаем.
  for (let i = 0; i < 60; i++) {
    g.update(FIXED_DT, w, grab, false, true, AWAY.cx, AWAY.cy, 40, 40);
    if (grab.used < GRAB_CAPACITY && grab.used > 0) placed = -1;
  }

  check(
    'Проводка добирает, но не вываливает: буфер полон и не убывает',
    grab.used === GRAB_CAPACITY && placed === 0,
    `в буфере ${grab.used}`,
  );
}

{
  // Выброс — событие, а не кисть: удержание не раскладывает комок порциями.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  grab.add(MAT.REGOLITH_LOOSE, 20);
  press(g, w, grab, 40, 40);
  const afterPress = count(w, MAT.REGOLITH_LOOSE);
  grab.add(MAT.PULP, 20);
  for (let i = 0; i < 30; i++) {
    g.update(FIXED_DT, w, grab, false, true, AWAY.cx, AWAY.cy, 40, 40);
  }

  check(
    'Выброс не повторяется удержанием',
    afterPress === 20 && count(w, MAT.PULP) === 0 && grab.count(MAT.PULP) === 20,
    `пульпы в мире ${count(w, MAT.PULP)}`,
  );
}

{
  // Промах не тратит ход: пустой буфер над пустотой ничего не делает.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 60, 60, 70, 70, MAT.REGOLITH_LOOSE);

  press(g, w, grab, 20, 20);
  const idle = grab.used === 0 && count(w, MAT.REGOLITH_LOOSE) === 11 * 11;
  g.update(FIXED_DT, w, grab, false, false, AWAY.cx, AWAY.cy, 20, 20);
  press(g, w, grab, 65, 65);

  check(
    'Промах ничего не меняет, следующее нажатие берёт',
    idle && grab.used > 0,
    `после промаха ${idle}, после попадания ${grab.used}`,
  );
}

{
  // Недостижимая цель не меняет НИ мир, НИ буфер — ни набором, ни выбросом.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 60, 60, 80, 80, MAT.REGOLITH_LOOSE);
  const before = count(w, MAT.REGOLITH_LOOSE);
  const far = DIG.reach + 20;

  press(g, w, grab, 70, 70, 70 - far, 70);
  const takeBlocked = grab.used === 0 && count(w, MAT.REGOLITH_LOOSE) === before;

  grab.add(MAT.PULP, 10);
  press(g, w, grab, 20, 20, 20 + far, 20);
  const dropBlocked = grab.count(MAT.PULP) === 10 && count(w, MAT.PULP) === 0;

  check('Недостижимая цель не меняет ни мир, ни буфер', takeBlocked && dropBlocked);
}

// --- Выброс ---

{
  // Выброс не разрушает и не вытесняет: он ставит только в пустоту.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.ROCK);
  grab.add(MAT.REGOLITH_LOOSE, 20);
  const rock = count(w, MAT.ROCK);
  press(g, w, grab, 40, 40);

  check(
    'Выброс в сплошную породу ничего не меняет',
    count(w, MAT.ROCK) === rock && grab.count(MAT.REGOLITH_LOOSE) === 20,
    `породы ${count(w, MAT.ROCK)}, в буфере ${grab.used}`,
  );
}

{
  // Тесное место забирает не всё, и остаток ОСТАЁТСЯ: комок, растворившийся
  // об стену, — это потерянная ходка.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.ROCK);
  w.set(40, 40, MAT.VACUUM);
  w.set(41, 40, MAT.VACUUM);
  w.set(42, 40, MAT.VACUUM);
  grab.add(MAT.REGOLITH_LOOSE, 20);
  press(g, w, grab, 40, 40);

  check(
    'Тесное место принимает сколько влезло, остальное остаётся в буфере',
    count(w, MAT.REGOLITH_LOOSE) === 3 && grab.count(MAT.REGOLITH_LOOSE) === 17,
    `в мире ${count(w, MAT.REGOLITH_LOOSE)}, в буфере ${grab.count(MAT.REGOLITH_LOOSE)}`,
  );
}

{
  // Внутрь хитбокса не пишем: из этого состояния нет выхода ни в одну сторону.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  grab.add(MAT.REGOLITH_LOOSE, GRAB_CAPACITY);
  const occupant = { x: 38, y: 38, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
  press(g, w, grab, 40, 40, 41, 43, occupant);

  let inside = 0;
  for (let y = occupant.y; y < occupant.y + occupant.h; y++) {
    for (let x = occupant.x; x < occupant.x + occupant.w; x++) {
      if (w.get(x, y) !== MAT.VACUUM) inside++;
    }
  }
  check(
    'Выброс в себя не проходит: хитбокс остаётся пустым',
    inside === 0 && count(w, MAT.REGOLITH_LOOSE) > 0,
    `занятых ячеек хитбокса ${inside}`,
  );
}

{
  // Повторяемость: один и тот же выброс из одинакового состояния мира даёт
  // одинаковую сетку. Смешанный комок — самый жёсткий случай.
  const grids: string[] = [];
  for (let run = 0; run < 2; run++) {
    const w = box();
    const grab = new Grab();
    const g = new Grabber();
    grab.add(MAT.REGOLITH_LOOSE, 30);
    grab.add(MAT.IRIDIUM, 25);
    grab.add(MAT.PULP, 15);
    press(g, w, grab, 40, 40);
    settle(w, 400);
    grids.push(Array.from(w.cells).join(','));
  }
  check('Повторяемость выброса: сетки идентичны', grids[0] === grids[1]);
}

{
  // Сдача идёт через зону приёмника по общим правилам: отдельной сдачи
  // из захвата в модуле нет.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  const receiver = { x: 34, y: 34, w: 13, h: 13 };
  const landing = new LandingModule(receiver);
  grab.add(MAT.REGOLITH_LOOSE, 40);
  press(g, w, grab, 40, 40);
  const payout = landing.update(w);

  check(
    'Комок, выброшенный в приёмник, даёт кредиты по общей ставке',
    payout.credits === 40 && landing.credits === 40,
    `начислено ${payout.credits}`,
  );
}

// --- План и подсветка ---

{
  // Подсветка и действие — ОДИН план: изменились ровно те ячейки, что были
  // подсвечены. Проверяется срез плана до применения и сетка после.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.REGOLITH_LOOSE);
  fill(w, 36, 36, 44, 44, MAT.ROCK);

  const plan = g.plan(w, grab, AWAY.cx, AWAY.cy, 40, 40);
  const planned = new Set<string>();
  for (let i = 0; i < plan.count; i++) {
    planned.add(`${plan.cells[i * 2]},${plan.cells[i * 2 + 1]}`);
  }
  const highlighted = plan.action;

  press(g, w, grab, 40, 40);
  const changed = new Set<string>();
  for (let y = 40 - HALF; y <= 40 + HALF; y++) {
    for (let x = 40 - HALF; x <= 40 + HALF; x++) {
      if (w.get(x, y) === MAT.VACUUM) changed.add(`${x},${y}`);
    }
  }

  const same =
    planned.size === changed.size && [...planned].every((k) => changed.has(k)) && planned.size > 0;
  check(
    'План подсветки и изменённые ячейки совпадают',
    same && highlighted === 'take',
    `в плане ${planned.size}, изменено ${changed.size}, решение ${highlighted}`,
  );
}

{
  // Подсветка не обещает того, чего не будет: порода в квадрате не подсвечена,
  // а вне дальности не подсвечено ничего.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.ROCK);
  fill(w, 38, 38, 42, 42, MAT.REGOLITH_LOOSE);

  const plan = g.plan(w, grab, AWAY.cx, AWAY.cy, 40, 40);
  let rocky = 0;
  for (let i = 0; i < plan.count; i++) {
    if (w.get(plan.cells[i * 2]!, plan.cells[i * 2 + 1]!) === MAT.ROCK) rocky++;
  }
  check(
    'Подсвечено только переносимое: порода в квадрате не подсвечена',
    plan.count === 25 && rocky === 0,
    `в плане ${plan.count}, из них породы ${rocky}`,
  );

  const far = g.plan(w, grab, 40 + DIG.reach + 20, 40, 40, 40);
  check(
    'Вне дальности не подсвечено ничего',
    far.count === 0 && far.action === 'none',
    `в плане ${far.count}, решение ${far.action}`,
  );
}

{
  // Решение «выброс» подсвечивает СВОБОДНЫЕ ячейки — те, что примут вещество.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 44, 50, 50, MAT.ROCK);
  grab.add(MAT.REGOLITH_LOOSE, 10);

  const plan = g.plan(w, grab, AWAY.cx, AWAY.cy, 40, 40);
  let occupied = 0;
  for (let i = 0; i < plan.count; i++) {
    if (w.get(plan.cells[i * 2]!, plan.cells[i * 2 + 1]!) !== MAT.VACUUM) occupied++;
  }
  check(
    'Выброс подсвечивает только пустые ячейки и не больше, чем несёт',
    plan.action === 'drop' && plan.count === 10 && occupied === 0,
    `решение ${plan.action}, в плане ${plan.count}, занятых ${occupied}`,
  );
}
