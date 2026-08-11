/**
 * Захват: квадратная кисть со своим буфером.
 *
 * Инструмент чистый — мир, буфер и цель на входе, изменения на выходе, —
 * поэтому проверяется напрямую, без кадра и без бутстрапа.
 *
 * Жест: удержание набирает, отпускание выбрасывает. Темп набора задан
 * интервалом, и `hold` подряд берёт не чаще него; везде ниже `dt = FIXED_DT`,
 * как в игре.
 */
import { World, MAT, MATERIALS, MAT_PORTABLE } from '../src/world';
import { GRAB, GRAB_CAPACITY, DIG, PLAYER, FIXED_DT } from '../src/config';
import { actionTarget } from '../src/core';
import { Grab, LandingModule } from '../src/entities';
import { Grabber, aimLabel } from '../src/systems';
import { check } from './harness';
import { box, count, settle } from './fixtures/world';

const HALF = (GRAB.side - 1) >> 1;

/** Сколько шагов удержания гарантированно даёт очередное применение. */
const STEPS_PER_TAKE = Math.ceil(GRAB.interval / FIXED_DT) + 1;

type Occupant = Parameters<Grabber['update']>[7];

/** Заливка прямоугольника одним веществом. */
function fill(w: World, x0: number, y0: number, x1: number, y1: number, m: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) w.set(x, y, m);
  }
}

/** Шаг удержания над целью. */
function hold(
  g: Grabber,
  w: World,
  grab: Grab,
  tx: number,
  ty: number,
  occupant: Occupant = null,
): number {
  return g.update(FIXED_DT, w, grab, true, false, tx, ty, occupant);
}

/** Отпускание над целью: выброс. */
function release(
  g: Grabber,
  w: World,
  grab: Grab,
  tx: number,
  ty: number,
  occupant: Occupant = null,
): number {
  return g.update(FIXED_DT, w, grab, false, false, tx, ty, occupant);
}

/** Полный жест над одной точкой: зажал, набрал, отпустил. */
function gesture(
  g: Grabber,
  w: World,
  grab: Grab,
  tx: number,
  ty: number,
  occupant: Occupant = null,
): void {
  hold(g, w, grab, tx, ty, occupant);
  release(g, w, grab, tx, ty, occupant);
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
  hold(g, w, grab, tx, ty);

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

{
  // Дальности у захвата нет: набор и выброс на другом конце кадра работают
  // так же, как вплотную. Персонажа здесь вовсе нет — инструменту нечем
  // мерить расстояние до него.
  const far = 20 + DIG.reach * 2;
  const w = box(far + 20, far + 20);
  const grab = new Grab();
  const g = new Grabber();
  fill(w, far - 5, far - 5, far + 5, far + 5, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, far, far);
  const taken = grab.used;
  release(g, w, grab, 20, 20);

  check(
    'Дальности нет: далёкая цель набирается и принимает комок',
    taken > 0 && grab.used === 0 && count(w, MAT.REGOLITH_LOOSE) === taken,
    `набрано ${taken}, в мире ${count(w, MAT.REGOLITH_LOOSE)}`,
  );
}

// --- Что берётся ---

{
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 60, 60, MAT.REGOLITH_LOOSE);
  const before = count(w, MAT.REGOLITH_LOOSE);
  const taken = hold(g, w, grab, 40, 40);
  const after = count(w, MAT.REGOLITH_LOOSE);

  check(
    'Сколько исчезло из мира, столько прибавилось в буфере',
    before - after === taken && grab.countOf(MAT.REGOLITH_LOOSE) === taken && taken > 0,
    `из мира ${before - after}, в буфер ${grab.countOf(MAT.REGOLITH_LOOSE)}`,
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
    hold(g, w, grab, 40, 40);
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
    hold(g, w, grab, 40, 40);
    const grabbed = grab.used > 0;
    if (grabbed !== portable.includes(m.id)) mismatch += `${m.name} `;
  }
  check('Списки переносимого у захвата и таблицы материалов совпадают', mismatch === '', mismatch);
}

// --- Комок из одного вещества ---

{
  // Тип задаёт ячейка ПОД ПЕРЕКРЕСТИЕМ: она единственная, куда игрок целился
  // точно, тогда как остальной квадрат он накрыл заодно.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.REGOLITH_LOOSE);
  fill(w, 40, 40, 44, 44, MAT.IRIDIUM);
  const regolith = count(w, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 42, 42);

  check(
    'Тип комка задаёт ячейка под перекрестием',
    grab.material === MAT.IRIDIUM &&
      count(w, MAT.IRIDIUM) === 0 &&
      count(w, MAT.REGOLITH_LOOSE) === regolith,
    `вещество ${grab.material}, реголита в мире ${count(w, MAT.REGOLITH_LOOSE)}`,
  );
}

{
  // Пока буфер не пуст, добирается только его вещество: смешанного комка
  // не бывает.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 30, 30, MAT.REGOLITH_LOOSE);
  fill(w, 50, 50, 60, 60, MAT.IRIDIUM);

  hold(g, w, grab, 25, 25);
  const regolith = grab.used;
  const iridium = count(w, MAT.IRIDIUM);
  for (let i = 0; i < STEPS_PER_TAKE; i++) hold(g, w, grab, 55, 55);

  check(
    'Комок остаётся однородным: чужое вещество не добирается',
    grab.material === MAT.REGOLITH_LOOSE &&
      grab.used === regolith &&
      count(w, MAT.IRIDIUM) === iridium,
    `вещество ${grab.material}, в буфере ${grab.used}, иридия в мире ${count(w, MAT.IRIDIUM)}`,
  );
}

{
  // Перекрестие мимо вещества не начинает набор, даже если квадрат накрывает
  // кучу: выбирать вещество за игрока нечем.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.ROCK);
  fill(w, 44, 44, 48, 48, MAT.REGOLITH_LOOSE);
  const before = count(w, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 40, 40);

  check(
    'Перекрестие мимо вещества не берёт ничего',
    grab.used === 0 && count(w, MAT.REGOLITH_LOOSE) === before,
    `в буфере ${grab.used}`,
  );
}

{
  // На границе ёмкости берётся ровно то, что влезает: остальное остаётся в мире.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  grab.add(MAT.REGOLITH_LOOSE, GRAB_CAPACITY - 3);
  fill(w, 30, 30, 50, 50, MAT.REGOLITH_LOOSE);
  const before = count(w, MAT.REGOLITH_LOOSE);
  hold(g, w, grab, 40, 40);

  check(
    'На границе ёмкости берётся ровно то, что влезает',
    before - count(w, MAT.REGOLITH_LOOSE) === 3 && grab.used === GRAB_CAPACITY,
    `взято ${before - count(w, MAT.REGOLITH_LOOSE)}, в буфере ${grab.used}`,
  );
}

{
  // Взятое снизу будит мир: лежащее выше обязано осыпаться.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 40, 40, 50, 80, MAT.REGOLITH_LOOSE);
  const topBefore = w.get(45, 40);
  hold(g, w, grab, 45, 70);
  settle(w, 400);

  check(
    'Взятое снизу осыпается сверху',
    topBefore === MAT.REGOLITH_LOOSE && w.get(45, 40) === MAT.VACUUM,
    `верх кучи после осадки: ${w.get(45, 40)}`,
  );
}

// --- Жест: зажал, набрал, перенёс, отпустил ---

{
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 40, 40);
  check('Зажатие набирает', grab.used > 0, `в буфере ${grab.used}`);
}

{
  // Ведение цели при удержании добирает: игрок собирает рассыпанное, не
  // отпуская кнопку.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 24, 24, MAT.REGOLITH_LOOSE);
  fill(w, 60, 60, 64, 64, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 22, 22);
  const first = grab.used;
  for (let i = 0; i < STEPS_PER_TAKE; i++) hold(g, w, grab, 62, 62);

  check(
    'Ведение при удержании добирает со второй кучи',
    first > 0 && grab.used > first && count(w, MAT.REGOLITH_LOOSE) === 0,
    `сначала ${first}, потом ${grab.used}`,
  );
}

{
  // Отпускание выбрасывает комок под целью — и это единственный способ его
  // выбросить.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 24, 24, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 22, 22);
  const carried = grab.used;
  const midair = count(w, MAT.REGOLITH_LOOSE);
  release(g, w, grab, 60, 60);

  check(
    'Отпускание выбрасывает комок под целью',
    carried > 0 && midair === 0 && grab.used === 0 && count(w, MAT.REGOLITH_LOOSE) === carried,
    `несли ${carried}, в мире ${count(w, MAT.REGOLITH_LOOSE)}`,
  );
}

{
  // Полный буфер жест не прерывает: удержание продолжает переносить, а не
  // начинает вываливать.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 70, 70, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 40, 40);
  let dropped = false;
  for (let i = 0; i < 60; i++) {
    hold(g, w, grab, 40, 40);
    if (grab.used < GRAB_CAPACITY) dropped = true;
  }

  check(
    'Полный буфер не роняет комок посреди жеста',
    grab.used === GRAB_CAPACITY && !dropped,
    `в буфере ${grab.used}`,
  );
}

{
  // Курсор над панелью приостанавливает жест: отпускание там комок не роняет,
  // а возврат в мир продолжает тот же жест.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 24, 24, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 22, 22);
  const carried = grab.used;
  g.update(FIXED_DT, w, grab, false, true, 60, 60);
  const kept = grab.used === carried && count(w, MAT.REGOLITH_LOOSE) === 0;
  release(g, w, grab, 60, 60);

  check(
    'Отпускание над панелью комок не роняет',
    carried > 0 && kept && count(w, MAT.REGOLITH_LOOSE) === carried,
    `после панели ${kept}, в мире ${count(w, MAT.REGOLITH_LOOSE)}`,
  );
}

{
  // Пустой буфер отпусканием ничего не делает: класть нечего.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  const before = Array.from(w.cells).join(',');
  gesture(g, w, grab, 40, 40);

  check(
    'Пустой буфер отпусканием мир не меняет',
    Array.from(w.cells).join(',') === before && grab.used === 0,
  );
}

{
  // Смена режима прерывает жест, но не буфер: комок ждёт следующего
  // отпускания над миром, а не вываливается в секунду возврата в захват.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 24, 24, MAT.REGOLITH_LOOSE);

  hold(g, w, grab, 22, 22);
  const carried = grab.used;
  g.cancel();
  const idle = release(g, w, grab, 60, 60);

  check(
    'Смена режима не роняет комок',
    carried > 0 && idle === 0 && grab.used === carried && count(w, MAT.REGOLITH_LOOSE) === 0,
    `в буфере ${grab.used}, положено ${idle}`,
  );
}

{
  // Остаток донашивается: то, что не влезло в тесное место, выбрасывается
  // следующим отпусканием.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.ROCK);
  w.set(40, 40, MAT.VACUUM);
  w.set(41, 40, MAT.VACUUM);
  w.set(42, 40, MAT.VACUUM);
  grab.add(MAT.REGOLITH_LOOSE, 20);

  hold(g, w, grab, 40, 40);
  release(g, w, grab, 40, 40);
  const left = grab.used;
  hold(g, w, grab, 70, 70);
  release(g, w, grab, 70, 70);

  check(
    'Остаток донашивается до открытого места',
    left === 17 && grab.used === 0 && count(w, MAT.REGOLITH_LOOSE) === 20,
    `остаток ${left}, в мире ${count(w, MAT.REGOLITH_LOOSE)}`,
  );
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
  gesture(g, w, grab, 40, 40);

  check(
    'Выброс в сплошную породу ничего не меняет',
    count(w, MAT.ROCK) === rock && grab.countOf(MAT.REGOLITH_LOOSE) === 20,
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
  gesture(g, w, grab, 40, 40);

  check(
    'Тесное место принимает сколько влезло, остальное остаётся в буфере',
    count(w, MAT.REGOLITH_LOOSE) === 3 && grab.countOf(MAT.REGOLITH_LOOSE) === 17,
    `в мире ${count(w, MAT.REGOLITH_LOOSE)}, в буфере ${grab.countOf(MAT.REGOLITH_LOOSE)}`,
  );
}

{
  // Внутрь хитбокса не пишем: из этого состояния нет выхода ни в одну сторону.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  grab.add(MAT.REGOLITH_LOOSE, GRAB_CAPACITY);
  const occupant = { x: 38, y: 38, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
  gesture(g, w, grab, 40, 40, occupant);

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
  // одинаковую сетку.
  const grids: string[] = [];
  for (let run = 0; run < 2; run++) {
    const w = box();
    const grab = new Grab();
    const g = new Grabber();
    grab.add(MAT.IRIDIUM, 70);
    gesture(g, w, grab, 40, 40);
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
  gesture(g, w, grab, 40, 40);
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
  fill(w, 40, 40, 44, 44, MAT.ROCK);
  // Квадрат целиком внутри залитой области: пустота в нём появляется только
  // от набора, иначе сравнивать план с изменениями было бы не с чем.
  const tx = 38;
  const ty = 38;

  const plan = g.plan(w, grab, tx, ty);
  const planned = new Set<string>();
  for (let i = 0; i < plan.count; i++) {
    planned.add(`${plan.cells[i * 2]},${plan.cells[i * 2 + 1]}`);
  }
  const highlighted = plan.action;

  hold(g, w, grab, tx, ty);
  const changed = new Set<string>();
  for (let y = ty - HALF; y <= ty + HALF; y++) {
    for (let x = tx - HALF; x <= tx + HALF; x++) {
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
  // Подсветка не обещает того, чего не будет: порода в квадрате не подсвечена.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.ROCK);
  fill(w, 38, 38, 42, 42, MAT.REGOLITH_LOOSE);

  const plan = g.plan(w, grab, 40, 40);
  let rocky = 0;
  for (let i = 0; i < plan.count; i++) {
    if (w.get(plan.cells[i * 2]!, plan.cells[i * 2 + 1]!) === MAT.ROCK) rocky++;
  }
  check(
    'Подсвечено только вещество комка: порода в квадрате не подсвечена',
    plan.count === 25 && rocky === 0,
    `в плане ${plan.count}, из них породы ${rocky}`,
  );
}

{
  // Решение «выброс» подсвечивает СВОБОДНЫЕ ячейки — те, что примут вещество.
  // Их же рисует несомый комок, поэтому показанное совпадает со сделанным
  // по построению.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 44, 50, 50, MAT.ROCK);
  grab.add(MAT.REGOLITH_LOOSE, 10);

  const plan = g.plan(w, grab, 40, 40);
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

// --- Подпись вещества под перекрестием ---

{
  // Подпись называет то, что задаст тип комка, и обещает ровно то, что сделает
  // нажатие: приглушается всё, чего оно сейчас не возьмёт.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 30, 30, 50, 50, MAT.REGOLITH_LOOSE);
  fill(w, 60, 60, 70, 70, MAT.IRIDIUM);
  fill(w, 10, 60, 20, 70, MAT.ROCK);

  const loose = aimLabel(w, grab, 40, 40);
  const rock = aimLabel(w, grab, 15, 65);
  const empty = aimLabel(w, grab, 80, 20);

  check(
    'Подпись называет вещество под перекрестием',
    loose.name === MATERIALS[MAT.REGOLITH_LOOSE]!.name && loose.takeable,
    `«${loose.name}», возьмётся ${loose.takeable}`,
  );
  check(
    'Порода названа, но приглушена',
    rock.name === MATERIALS[MAT.ROCK]!.name && !rock.takeable,
    `«${rock.name}», возьмётся ${rock.takeable}`,
  );
  check('Над пустотой подписи нет', empty.name === '' && !empty.takeable);

  // Непустой буфер закрывает чужое вещество: светлое имя обещало бы набор,
  // которого не будет. Берём горстку, чтобы буфер остался неполным.
  const crumbs = new Grab();
  crumbs.add(MAT.REGOLITH_LOOSE, 5);
  const foreign = aimLabel(w, crumbs, 65, 65);
  const same = aimLabel(w, crumbs, 40, 40);
  check(
    'Чужое вещество при непустом буфере приглушено',
    foreign.name === MATERIALS[MAT.IRIDIUM]!.name && !foreign.takeable && same.takeable,
    `иридий возьмётся ${foreign.takeable}, реголит ${same.takeable}`,
  );

  // Полный буфер не примет уже ничего, и подпись обязана это признать.
  const full = new Grab();
  full.add(MAT.REGOLITH_LOOSE, GRAB_CAPACITY);
  check('При полном буфере приглушено даже своё вещество', !aimLabel(w, full, 40, 40).takeable);

  // Обещание подписи и поведение инструмента — одно и то же: то, что подпись
  // назвала невзятым, набором не уходит.
  hold(g, w, grab, 40, 40);
  const before = count(w, MAT.IRIDIUM);
  for (let i = 0; i < STEPS_PER_TAKE; i++) hold(g, w, grab, 65, 65);
  check(
    'Приглушённое подписью не берётся и на деле',
    count(w, MAT.IRIDIUM) === before,
    `иридия в мире ${count(w, MAT.IRIDIUM)}`,
  );
}

// --- Отчёт шага для звука ---

{
  // Набор и выброс — разные события, и на одном шаге они не встречаются:
  // на этом держится одна пара координат в снапшоте сигналов.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  fill(w, 20, 20, 30, 30, MAT.REGOLITH_LOOSE);

  let both = 0;
  let takes = 0;
  let drops = 0;
  let mismatched = 0;
  const step = (held: boolean, tx: number, ty: number): void => {
    const cells = g.update(FIXED_DT, w, grab, held, false, tx, ty);
    const action = g.lastAction;
    if (action !== 'none' && g.lastCells !== cells) mismatched++;
    if (action === 'take') takes++;
    if (action === 'drop') drops++;
    // Отчёт — одно значение, и «оба сразу» им невыразимо; проверяется, что
    // ненулевые ячейки всегда приписаны ровно одному событию.
    if (action === 'none' && cells > 0) both++;
  };

  for (let i = 0; i < 40; i++) step(true, 25, 25);
  step(false, 60, 60);
  for (let i = 0; i < 10; i++) step(false, 60, 60);

  check(
    'Отчёт шага: набор и выброс не встречаются вместе',
    both === 0 && takes > 0 && drops === 1 && mismatched === 0,
    `наборов ${takes}, выбросов ${drops}, расхождений ${mismatched}`,
  );
}

{
  // Отпускание, не положившее ни ячейки, событием не считается: звук
  // подтверждает изменение мира, а не отпускание кнопки.
  const w = box();
  const grab = new Grab();
  const g = new Grabber();
  g.update(FIXED_DT, w, grab, true, false, 40, 40);
  g.update(FIXED_DT, w, grab, false, false, 40, 40);

  check(
    'Отчёт шага: пустое отпускание событием не считается',
    g.lastAction === 'none' && g.lastCells === 0,
    `отчёт ${g.lastAction}`,
  );
}

{
  // Квадрат стоит под АКТИВНЫМ ИСТОЧНИКОМ прицела, а не под нажатой кнопкой:
  // отпущенная мышь целится курсором, и квадрат не уезжает к персонажу.
  // Ровно это `main.ts` передаёт захвату — `actionTarget(aimSource === 'mouse')`.
  const cursor = actionTarget(true, 300, 120, 40, 40, 1, 0);
  const keys = actionTarget(false, 300, 120, 40, 40, 1, 0);

  check(
    'Мышь целит квадрат в курсор, клавиатура — в сторону персонажа',
    cursor.x === 300 &&
      cursor.y === 120 &&
      keys.x === 40 + DIG.aimDistance &&
      keys.y === 40 &&
      DIG.aimDistance < 300,
    `мышь ${cursor.x},${cursor.y}; клавиатура ${keys.x},${keys.y}`,
  );
}
