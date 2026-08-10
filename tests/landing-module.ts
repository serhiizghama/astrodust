import { World, MAT, MAT_CREDIT_RATE, Simulation, reactAround } from '../src/world';
import { Camera } from '../src/render';
import { Digger, Vacuum } from '../src/systems';
import { Player, Inventory, LandingModule } from '../src/entities';
import { PLAYER, FIXED_DT, VIEW_W, VIEW_H, MODULE } from '../src/config';
import { check, luna } from './harness';
import { box, count } from './fixtures/world';

const first = luna();
const { spawn } = first;

{
  // --- Посадочный модуль и кредиты ---

  {
    /** Мир с приёмником: дно и две стенки из корпуса, открытый верх. */
    function withReceiver(): { world: World; module: LandingModule } {
      const w = box();
      const zone = { x: 40, y: 40, w: 6, h: 5 };
      for (let y = zone.y; y < zone.y + zone.h + 2; y++) {
        for (let d = 0; d < 2; d++) {
          w.set(zone.x - 1 - d, y, MAT.MODULE_HULL);
          w.set(zone.x + zone.w + d, y, MAT.MODULE_HULL);
        }
      }
      for (let y = zone.y + zone.h; y < zone.y + zone.h + 2; y++) {
        for (let x = zone.x - 2; x < zone.x + zone.w + 2; x++) w.set(x, y, MAT.MODULE_HULL);
      }
      return { world: w, module: new LandingModule(zone) };
    }

    // Высыпанное принято, счёт вырос по ставке.
    {
      const { world: w, module } = withReceiver();
      const inv = new Inventory();
      inv.add(MAT.PULP, 20);
      while (inv.selected !== MAT.PULP) inv.cycleSelected();
      const placed = Vacuum.dump(w, inv, 42, 42);
      const earned = module.update(w);
      check(
        'Высыпанная в приёмник пульпа исчезает и даёт кредиты по ставке',
        placed > 0 &&
          earned.credits === placed * MAT_CREDIT_RATE[MAT.PULP]! &&
          count(w, MAT.PULP) === 0,
        `размещено ${placed}, начислено ${earned.credits}, осталось ${count(w, MAT.PULP)}`,
      );
      check(
        'Счёт модуля равен начисленному, а очки за сырьё не растут',
        module.credits === earned.credits && earned.research === 0 && module.research.points === 0,
        `${module.credits} ₡, ${module.research.points} ✦`,
      );
    }

    // Самотёком — так же. Персонажа рядом нет вовсе.
    {
      const { world: w, module } = withReceiver();
      for (let x = 40; x < 46; x++) w.set(x, 30, MAT.REGOLITH_LOOSE);
      const dropped = count(w, MAT.REGOLITH_LOOSE);
      const sim = new Simulation();
      for (let i = 0; i < 400; i++) {
        sim.update(w, null);
        module.update(w);
      }
      check(
        'Скатившееся в зону самотёком принимается так же, и игрок для этого не нужен',
        module.credits === dropped * MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]! &&
          count(w, MAT.REGOLITH_LOOSE) === 0,
        `сброшено ${dropped}, начислено ${module.credits}, осталось ${count(w, MAT.REGOLITH_LOOSE)}`,
      );
    }

    // Непринимаемое остаётся и ведёт себя по своим правилам.
    {
      const { world: w, module } = withReceiver();
      for (let x = 40; x < 46; x++) w.set(x, 41, MAT.WATER);
      const before = count(w, MAT.WATER);
      const sim = new Simulation();
      for (let i = 0; i < 200; i++) {
        sim.update(w, null);
        module.update(w);
      }
      check(
        'Вещество с нулевой ставкой в зоне остаётся и кредитов не даёт',
        module.credits === 0 && count(w, MAT.WATER) === before,
        `воды ${before} → ${count(w, MAT.WATER)}, кредитов ${module.credits}`,
      );
    }

    // Цепочка выгоднее сырья: одна ячейка реголита через воду даёт больше.
    {
      const direct = MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]!;

      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(40, 41, MAT.WATER);
      reactAround(w, 40, 40);
      const pulp = count(w, MAT.PULP);
      const chain = pulp * MAT_CREDIT_RATE[MAT.PULP]!;
      check(
        'Цепочка выгоднее сырья: реголит через воду даёт больше кредитов',
        pulp === 2 && chain > direct,
        `напрямую ${direct} ₡, через воду ${pulp} ячейки пульпы = ${chain} ₡`,
      );
    }

    // Счёт монотонно не убывает при любой последовательности действий.
    {
      const { world: w, module } = withReceiver();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 30);
      inv.add(MAT.PULP, 30);
      const vac = new Vacuum();
      const sim = new Simulation();
      let previous = module.credits;
      let dropped = false;
      for (let i = 0; i < 600; i++) {
        vac.updateDump(FIXED_DT, w, inv, i % 3 === 0, 40, 42, 42, 42);
        Vacuum.collect(w, inv, 43, 38);
        sim.update(w, null);
        module.update(w);
        if (module.credits < previous) dropped = true;
        previous = module.credits;
      }
      check(
        'Счёт кредитов ни разу не убыл и остался целым и неотрицательным',
        !dropped && module.credits > 0 && Number.isInteger(module.credits),
        `счёт ${module.credits}`,
      );
    }
  }

  // --- Модуль в сгенерированном мире ---

  {
    const w = first.world;
    const zone = first.receiver;

    let hull = 0;
    for (const c of w.cells) if (c === MAT.MODULE_HULL) hull++;
    check('В сгенерированном мире есть корпус модуля', hull > 0, `ячеек ${hull}`);

    // Площадка горизонтальна: профиль поверхности под модулем — прямая.
    {
      const from = MODULE.x - MODULE.padMargin;
      const to = MODULE.x + MODULE.width + MODULE.padMargin - 1;
      const level = first.surface[from]!;
      let uneven = 0;
      for (let x = from; x <= to; x++) if (first.surface[x] !== level) uneven++;
      check(
        'Площадка под модулем горизонтальна',
        uneven === 0,
        `колонок вне уровня ${uneven}, уровень ${level}`,
      );
    }

    // Зона открыта сверху и ограничена корпусом с трёх сторон.
    {
      let openAbove = 0;
      for (let x = zone.x; x < zone.x + zone.w; x++) {
        if (w.get(x, zone.y - 1) === MAT.VACUUM) openAbove++;
      }
      let walled = 0;
      for (let y = zone.y; y < zone.y + zone.h; y++) {
        if (w.get(zone.x - 1, y) === MAT.MODULE_HULL) walled++;
        if (w.get(zone.x + zone.w, y) === MAT.MODULE_HULL) walled++;
      }
      let floored = 0;
      for (let x = zone.x; x < zone.x + zone.w; x++) {
        if (w.get(x, zone.y + zone.h) === MAT.MODULE_HULL) floored++;
      }
      let empty = 0;
      for (let y = zone.y; y < zone.y + zone.h; y++) {
        for (let x = zone.x; x < zone.x + zone.w; x++) if (w.get(x, y) === MAT.VACUUM) empty++;
      }
      check(
        'Зона приёмника пуста, открыта сверху и ограничена корпусом с трёх сторон',
        empty === zone.w * zone.h &&
          openAbove === zone.w &&
          walled === zone.h * 2 &&
          floored === zone.w,
        `пустых ${empty}/${zone.w * zone.h}, сверху открыто ${openAbove}, стенок ${walled}, дна ${floored}`,
      );
    }

    // Точка старта корректна и находится вне корпуса.
    {
      const p = new Player(spawn.x, spawn.y);
      let hullAtSpawn = 0;
      for (let x = p.x; x < p.x + PLAYER.hitboxW; x++) {
        for (let y = p.y; y <= p.y + PLAYER.hitboxH; y++) {
          if (w.get(x, y) === MAT.MODULE_HULL) hullAtSpawn++;
        }
      }
      check(
        'Точка старта корректна и вне корпуса модуля',
        !w.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH) &&
          w.rectHitsSolid(p.x, p.y + PLAYER.hitboxH, PLAYER.hitboxW, 1) &&
          hullAtSpawn === 0,
        `корпуса в хитбоксе ${hullAtSpawn}, спавн (${p.x},${p.y})`,
      );
    }

    // Модуль на виду: он попадает в кадр, центрированный на точке старта.
    {
      const cam = new Camera(w.width, w.height);
      cam.snapTo(spawn.x, spawn.y);
      let visible = 0;
      for (let sy = 0; sy < VIEW_H; sy++) {
        for (let sx = 0; sx < VIEW_W; sx++) {
          if (w.get(cam.x + sx, cam.y + sy) === MAT.MODULE_HULL) visible++;
        }
      }
      check('Модуль виден из точки старта', visible > 0, `ячеек корпуса в кадре ${visible}`);
    }

    // По корпусу можно ходить: персонаж, поставленный на крышу стенки, стоит.
    {
      const top = zone.y;
      const p = new Player(MODULE.x, top - PLAYER.hitboxH);
      check(
        'По корпусу модуля можно стоять',
        !w.rectHitsSolid(p.x, p.y, PLAYER.hitboxW, PLAYER.hitboxH) &&
          w.rectHitsSolid(p.x, p.y + PLAYER.hitboxH, PLAYER.hitboxW, 1),
        `позиция (${p.x},${p.y})`,
      );
    }

    // Корпус не копается и не собирается.
    {
      const probe = new World(64, 64, w.profile);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) probe.set(x, y, MAT.MODULE_HULL);
      const before = probe.cells.slice();
      const excavated = Digger.applyBrush(probe, 32, 32);
      let changed = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== probe.cells[i]) changed++;
      check(
        'Корпус модуля не копается: ни выемки, ни выработки',
        excavated === 0 && changed === 0,
        `выемка ${excavated}, изменено ${changed}`,
      );

      const inv = new Inventory();
      const collected = Vacuum.collect(probe, inv, 32, 32);
      check(
        'Корпус модуля не собирается пылесосом',
        collected === 0 && inv.used === 0 && count(probe, MAT.MODULE_HULL) === 64 * 64,
      );

      // Смешанная кисть: корпус остаётся, порода рядом разрушается.
      for (let y = 0; y < 64; y++) for (let x = 32; x < 64; x++) probe.set(x, y, MAT.ROCK);
      const hullBefore = count(probe, MAT.MODULE_HULL);
      const mixed = Digger.applyBrush(probe, 32, 32);
      check(
        'Кисть по границе корпуса и породы берёт только породу',
        mixed > 0 && count(probe, MAT.MODULE_HULL) === hullBefore,
        `выемка ${mixed}, корпуса ${hullBefore} → ${count(probe, MAT.MODULE_HULL)}`,
      );
    }

    check(
      'В нетронутом мире с модулем по-прежнему нет жидких ячеек',
      w.liquidCells === 0,
      `счётчик жидкого ${w.liquidCells}`,
    );
    check(
      'В нетронутом мире нет ни пульпы, ни рыхлого реголита',
      !w.cells.includes(MAT.PULP) && !w.cells.includes(MAT.REGOLITH_LOOSE),
    );
  }
}
