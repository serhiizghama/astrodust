import { World } from '../src/world';
import { Camera, Renderer, BRUSH_OUTLINE, VACUUM_OUTLINE } from '../src/render';
import type { HudState } from '../src/render';
import type { Display } from '../src/core';
import {
  MAT,
  MAT_STATE,
  MAT_SLIP,
  MAT_DENSITY,
  MAT_PORTABLE,
  MAT_DIGGABLE,
  MAT_CREDIT_RATE,
  MAT_RESEARCH_RATE,
  MatterState,
  MATERIALS,
  PORTABLE_MATERIALS,
} from '../src/world';
import type { Rect } from '../src/geometry';
import { Digger, Vacuum } from '../src/systems';
import { Player, Inventory } from '../src/entities';
import { PLAYER, FIXED_DT, WORLD_SEED, BASE_VIEW_W, BASE_VIEW_H, DIG, VACUUM } from '../src/config';
import { aimDirection, actionTarget, ToolModeState } from '../src/core';
import { check, luna } from './harness';
import { box, count, settle, pending, quiet } from './fixtures/world';

const first = luna();
const { spawn } = first;

{
  // --- Новые поля таблицы материалов ---

  // Попарная различимость всех восьми веществ. Пульпа обязана быть отличима
  // от сухого реголита — иначе результат реакции не виден вовсе, — а корпус
  // модуля должен читаться рукотворным на фоне любого грунта.
  {
    const visible = [
      MAT.REGOLITH_PACKED,
      MAT.REGOLITH_LOOSE,
      MAT.PULP,
      MAT.ICE,
      MAT.WATER,
      MAT.LAVA,
      MAT.STEAM,
      MAT.MODULE_HULL,
    ];
    let clashes = '';
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = MATERIALS[visible[i]!]!;
        const b = MATERIALS[visible[j]!]!;
        if (a.color === b.color) clashes += `${a.name}=${b.name} `;
      }
    }
    check('Цвета восьми веществ попарно различны', clashes === '', clashes);
  }

  {
    const portable = MATERIALS.filter((m) => m.portable).map((m) => m.id);
    check(
      'Переносимы ровно реголит, пульпа, иридий и шлак',
      portable.length === 4 &&
        [MAT.REGOLITH_LOOSE, MAT.PULP, MAT.IRIDIUM, MAT.SLAG].every((id) => portable.includes(id)),
      `переносимых ${portable.length}: ${portable.map((id) => MATERIALS[id]!.name).join(', ')}`,
    );
    check(
      'Статичное непереносимо: подобрать породу пылесосом нельзя',
      MATERIALS.filter((m) => m.state === MatterState.Solid).every((m) => !m.portable),
    );
    check(
      'Жидкости и газы непереносимы',
      [MAT.WATER, MAT.LAVA, MAT.STEAM].every((id) => MAT_PORTABLE[id] === 0),
    );

    // Неразрушимо всё, что игрок купил за кредиты, и ничего сверх того.
    // Конвейеров двое, и их одинаковый цвет — не оплошность, а требование:
    // различать ленты обязано направление бегущей полосы, а не оттенок.
    const indestructible = MATERIALS.filter((m) => !m.diggable).map((m) => m.id);
    check(
      'Неразрушимы ровно корпуса модуля, сепаратора и оба конвейера',
      indestructible.length === 4 &&
        [MAT.MODULE_HULL, MAT.SEPARATOR_HULL, MAT.CONVEYOR_LEFT, MAT.CONVEYOR_RIGHT].every((id) =>
          indestructible.includes(id),
        ) &&
        MATERIALS[MAT.MODULE_HULL]!.color !== MATERIALS[MAT.SEPARATOR_HULL]!.color,
      `неразрушимых ${indestructible.length}: ${indestructible.map((id) => MATERIALS[id]!.name).join(', ')}`,
    );
    // Копание читает развёрнутый массив, а не таблицу. Разъезд между ними
    // означал бы, что неразрушимость записана, но не действует.
    check(
      'Развёрнутые массивы совпадают с таблицей',
      MATERIALS.every(
        (m) =>
          MAT_DIGGABLE[m.id] === (m.diggable ? 1 : 0) &&
          MAT_PORTABLE[m.id] === (m.portable ? 1 : 0) &&
          MAT_CREDIT_RATE[m.id] === m.creditRate &&
          MAT_RESEARCH_RATE[m.id] === m.researchRate,
      ),
    );

    check(
      'Ставки кредитов: реголит и пульпа положительны, пульпа дороже',
      MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]! > 0 &&
        MAT_CREDIT_RATE[MAT.PULP]! > MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]!,
      `реголит ${MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]}, пульпа ${MAT_CREDIT_RATE[MAT.PULP]}`,
    );
    check(
      'Остальное не принимается: обе ставки ноль',
      [
        MAT.ROCK,
        MAT.ROCK_DEEP,
        MAT.REGOLITH_PACKED,
        MAT.ICE,
        MAT.WATER,
        MAT.LAVA,
        MAT.STEAM,
        MAT.MODULE_HULL,
        MAT.SLAG,
      ].every((id) => MAT_CREDIT_RATE[id] === 0 && MAT_RESEARCH_RATE[id] === 0),
    );
    // Разделение валют — правило ТАБЛИЦЫ, а не кода: проверяется один раз
    // по всем строкам. Вещество, дающее и деньги, и прогресс, отменяет выбор
    // «сдать сырьём или переработать», ради которого валюты и разделены.
    check(
      'Ни одно вещество не даёт обе валюты сразу',
      MATERIALS.every((m) => m.creditRate === 0 || m.researchRate === 0),
      MATERIALS.filter((m) => m.creditRate !== 0 && m.researchRate !== 0)
        .map((m) => m.name)
        .join(', '),
    );
    // Переработка — единственный источник прогресса. Вторая дорога к очкам
    // обесценила бы машину, ради которой построена вся цепочка.
    {
      const sources = MATERIALS.filter((m) => m.researchRate > 0);
      check(
        'Очки исследований даёт ровно одно вещество — иридий',
        sources.length === 1 && sources[0]!.id === MAT.IRIDIUM,
        sources.map((m) => `${m.name} ${m.researchRate}`).join(', ') || 'ни одного',
      );
    }
    check(
      'Иридий не приносит кредитов',
      MAT_CREDIT_RATE[MAT.IRIDIUM] === 0,
      `${MAT_CREDIT_RATE[MAT.IRIDIUM]} ₡`,
    );
    check(
      'Сырьё не приносит очков',
      MAT_RESEARCH_RATE[MAT.REGOLITH_LOOSE] === 0 && MAT_RESEARCH_RATE[MAT.PULP] === 0,
    );
    check(
      'Плотность пульпы выше плотности воды',
      MAT_DENSITY[MAT.PULP]! > MAT_DENSITY[MAT.WATER]!,
      `пульпа ${MAT_DENSITY[MAT.PULP]}, вода ${MAT_DENSITY[MAT.WATER]}`,
    );
    check('Пульпа сыпучая, а не жидкая', MAT_STATE[MAT.PULP] === MatterState.Powder);
    check(
      'Осыпаемость пульпы ниже, чем у сухого реголита',
      MAT_SLIP[MAT.PULP]! < MAT_SLIP[MAT.REGOLITH_LOOSE]!,
      `пульпа ${MAT_SLIP[MAT.PULP]}, реголит ${MAT_SLIP[MAT.REGOLITH_LOOSE]}`,
    );
  }

  // --- Инвентарь и сбор ---

  {
    // Сбор забирает переносимое и не трогает всё остальное.
    {
      const w = box();
      w.set(40, 40, MAT.REGOLITH_LOOSE);
      w.set(41, 40, MAT.PULP);
      w.set(40, 41, MAT.ROCK);
      w.set(41, 41, MAT.WATER);
      w.set(39, 40, MAT.MODULE_HULL);
      const inv = new Inventory();
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'Сбор забирает реголит и пульпу',
        collected === 2 && inv.count(MAT.REGOLITH_LOOSE) === 1 && inv.count(MAT.PULP) === 1,
        `собрано ${collected}`,
      );
      check(
        'Сбор не трогает породу, воду и корпус модуля',
        w.get(40, 41) === MAT.ROCK &&
          w.get(41, 41) === MAT.WATER &&
          w.get(39, 40) === MAT.MODULE_HULL,
      );
      check(
        'Собранные ячейки исчезли из мира',
        w.get(40, 40) === MAT.VACUUM && w.get(41, 40) === MAT.VACUUM,
      );
    }

    // Сохранение вещества: сколько исчезло из мира, столько прибавилось.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const before = count(w, MAT.REGOLITH_LOOSE);
      const inv = new Inventory();
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'Собранное сохраняется: убыль мира равна приросту инвентаря',
        before - count(w, MAT.REGOLITH_LOOSE) === collected &&
          inv.count(MAT.REGOLITH_LOOSE) === collected &&
          inv.used === collected,
        `собрано ${collected} из ${before}`,
      );
    }

    // Заполненный инвентарь прекращает сбор, а вещество остаётся в мире.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const before = count(w, MAT.REGOLITH_LOOSE);
      const inv = new Inventory(4);
      inv.add(MAT.PULP, 4);
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'На пределе ёмкости сбор не берёт ничего, а куча остаётся',
        collected === 0 && count(w, MAT.REGOLITH_LOOSE) === before && inv.free === 0,
        `собрано ${collected}, осталось ${count(w, MAT.REGOLITH_LOOSE)}`,
      );
    }

    // Частично помещающаяся кисть забирает ровно остаток ёмкости.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const covered = (() => {
        const inv = new Inventory();
        return Vacuum.collect(box0(w), inv, 40, 40);
      })();
      function box0(src: World): World {
        const c = box();
        c.cells.set(src.cells);
        return c;
      }
      const inv = new Inventory(3);
      const collected = Vacuum.collect(w, inv, 40, 40);
      check(
        'Кисть, накрывшая больше ячеек, чем влезает, забирает ровно остаток',
        covered > 3 && collected === 3 && inv.used === 3 && count(w, MAT.REGOLITH_LOOSE) === 25 - 3,
        `кисть накрывает ${covered}, влезло ${collected}, в мире осталось ${count(w, MAT.REGOLITH_LOOSE)}`,
      );
    }

    // Разные материалы делят одну ёмкость.
    {
      const inv = new Inventory(10);
      inv.add(MAT.REGOLITH_LOOSE, 6);
      const pulp = inv.add(MAT.PULP, 6);
      check(
        'Разные материалы делят один предел',
        pulp === 4 &&
          inv.count(MAT.REGOLITH_LOOSE) === 6 &&
          inv.count(MAT.PULP) === 4 &&
          inv.free === 0,
        `реголит ${inv.count(MAT.REGOLITH_LOOSE)}, пульпа ${inv.count(MAT.PULP)}, свободно ${inv.free}`,
      );
    }

    // Сбор будит область: лежащее выше обязано осыпаться. Столб в шахте
    // с каменными стенками, а не свободная куча: свободная расплылась бы
    // в холм шире кисти, и «осело ли верхнее» стало бы вопросом о форме кучи,
    // а не о пробуждении.
    {
      const w = box();
      for (let y = 60; y < 95; y++) {
        w.set(39, y, MAT.ROCK);
        w.set(41, y, MAT.ROCK);
        w.set(40, y, MAT.REGOLITH_LOOSE);
      }
      settle(w, 500);
      quiet(w);
      const inv = new Inventory();
      Vacuum.collect(w, inv, 40, 93);
      check('Сбор будит область мира', pending(w) > 0, `чанков ${pending(w)}`);
      const topBefore = (() => {
        for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) return y;
        return -1;
      })();
      settle(w, 500);
      const topAfter = (() => {
        for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) return y;
        return -1;
      })();
      check(
        'Оставшееся над собранным осело',
        topAfter > topBefore,
        `верх столба ${topBefore} → ${topAfter}`,
      );
    }

    // Дальность: недостижимая цель не меняет ни мир, ни инвентарь.
    {
      const w = box();
      for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.REGOLITH_LOOSE);
      const before = count(w, MAT.REGOLITH_LOOSE);
      const inv = new Inventory();
      const vac = new Vacuum();
      const far = DIG.reach + 20;
      vac.updateSuck(FIXED_DT, w, inv, true, 40 + far, 40, 40, 40);
      check(
        'Сбор за пределом дальности не меняет ни мир, ни инвентарь',
        count(w, MAT.REGOLITH_LOOSE) === before && inv.used === 0,
      );
      // …а в пределах — меняет, и темп задан интервалом, а не частотой кадров.
      const first1 = vac.updateSuck(FIXED_DT, w, inv, true, 40, 40, 40, 40);
      const second = vac.updateSuck(FIXED_DT, w, inv, true, 40, 40, 40, 40);
      check(
        'Темп сбора задан интервалом: второе применение в том же кадре не проходит',
        first1 > 0 && second === 0,
        `первое ${first1}, второе ${second}`,
      );
    }

    // Кисть сбора не больше копательной.
    check(
      'Кисть сбора не больше кисти копания',
      VACUUM.radius <= DIG.radius && VACUUM_OUTLINE.length < BRUSH_OUTLINE.length,
      `сбор r=${VACUUM.radius}, копание r=${DIG.radius}`,
    );
  }

  // --- Высыпание ---

  {
    // Ставится только в пустоту, мир не разрушается.
    {
      const w = box();
      // Порода на всю область кисти: за её краем нашлась бы пустота,
      // и высыпание прошло бы мимо проверки.
      for (let y = 34; y <= 46; y++) for (let x = 34; x <= 46; x++) w.set(x, y, MAT.ROCK);
      const rockBefore = count(w, MAT.ROCK);
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const placed = Vacuum.dump(w, inv, 40, 40);
      check(
        'Высыпание в породу не проходит и счётчик не трогает',
        placed === 0 && inv.count(MAT.REGOLITH_LOOSE) === 50 && count(w, MAT.ROCK) === rockBefore,
        `размещено ${placed}, породы ${rockBefore} → ${count(w, MAT.ROCK)}`,
      );
    }
    {
      const w = box();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const placed = Vacuum.dump(w, inv, 40, 40);
      check(
        'Высыпание в пустоту ставит вещество и уменьшает счётчик ровно на размещённое',
        placed > 0 &&
          count(w, MAT.REGOLITH_LOOSE) === placed &&
          inv.count(MAT.REGOLITH_LOOSE) === 50 - placed &&
          inv.used === 50 - placed,
        `размещено ${placed}`,
      );
      // Высыпанное немедленно подчиняется своим правилам: отдельного поведения
      // у «только что высыпанного» нет.
      settle(w, 1000);
      let lowest = -1;
      for (let y = 0; y < 96; y++) if (w.get(40, y) === MAT.REGOLITH_LOOSE) lowest = y;
      check(
        'Высыпанное осыпается по правилам своего вещества',
        lowest === 94,
        `нижняя ячейка на y=${lowest}`,
      );
    }
    // Пустой счётчик ничего не даёт.
    {
      const w = box();
      const inv = new Inventory();
      const before = w.cells.slice();
      const placed = Vacuum.dump(w, inv, 40, 40);
      let changed = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== w.cells[i]) changed++;
      check('Высыпание при пустом счётчике не меняет мир', placed === 0 && changed === 0);
    }
    // В хитбокс персонажа вещество не попадает.
    {
      const w = box();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const occupant: Rect = { x: 39, y: 38, w: PLAYER.hitboxW, h: PLAYER.hitboxH };
      Vacuum.dump(w, inv, 40, 40, occupant);
      let inside = 0;
      for (let y = occupant.y; y < occupant.y + occupant.h; y++) {
        for (let x = occupant.x; x < occupant.x + occupant.w; x++) {
          if (w.get(x, y) !== MAT.VACUUM) inside++;
        }
      }
      check(
        'Высыпание в себя не проходит: хитбокс остаётся пустым',
        inside === 0,
        `ячеек внутри хитбокса ${inside}`,
      );
    }
    // Смена выбранного вещества меняет то, что высыпается.
    {
      const inv = new Inventory();
      const startName = inv.selectedName;
      const startId = inv.selected;
      inv.cycleSelected();
      const nextId = inv.selected;
      check(
        'Смена выбранного вещества меняет и вещество, и подпись',
        nextId !== startId && inv.selectedName !== startName,
        `${startName} → ${inv.selectedName}`,
      );
      for (let i = 1; i < PORTABLE_MATERIALS.length; i++) inv.cycleSelected();
      check('Перебор выбранного идёт по кругу', inv.selected === startId);

      const w = box();
      inv.add(nextId, 5);
      inv.cycleSelected();
      while (inv.selected !== nextId) inv.cycleSelected();
      Vacuum.dump(w, inv, 40, 40);
      check('Высыпается именно выбранное вещество', count(w, nextId) > 0);
    }
    // Высыпание тоже подчиняется дальности.
    {
      const w = box();
      const inv = new Inventory();
      inv.add(MAT.REGOLITH_LOOSE, 50);
      const vac = new Vacuum();
      vac.updateDump(FIXED_DT, w, inv, true, 40 + DIG.reach + 20, 40, 40, 40);
      check('Высыпание за пределом дальности не меняет мир', count(w, MAT.REGOLITH_LOOSE) === 0);
    }
  }

  // --- Режим инструмента ---

  {
    const tool = new ToolModeState();
    check(
      'Режим начинается с копания и виден подписью',
      tool.digging && !tool.collecting && tool.name.length > 0,
      tool.name,
    );

    // Выражение из главного цикла воспроизведено буквально: копание получает
    // `удержание && режим копания`, сбор — `удержание && режим сбора`.
    const held = true;
    const w = box();
    for (let y = 38; y <= 42; y++) for (let x = 38; x <= 42; x++) w.set(x, y, MAT.ROCK);
    for (let x = 36; x <= 37; x++) w.set(x, 40, MAT.REGOLITH_LOOSE);
    const inv = new Inventory();
    const digger = new Digger();
    const vac = new Vacuum();

    const dug = digger.update(FIXED_DT, w, held && tool.digging, 40, 40, 40, 40);
    check('В режиме копания инструмент копает', dug > 0, `выемка ${dug}`);

    tool.cycle();
    check(
      'Переключение режима видно сразу, до первого применения',
      tool.collecting && !tool.digging && tool.name.length > 0,
      tool.name,
    );

    const rockBefore = count(w, MAT.ROCK);
    const dug2 = digger.update(FIXED_DT, w, held && tool.digging, 40, 40, 40, 40);
    check(
      'В режиме сбора кисть копания не применяется вовсе',
      dug2 === 0 && count(w, MAT.ROCK) === rockBefore,
      `выемка ${dug2}, породы ${rockBefore} → ${count(w, MAT.ROCK)}`,
    );

    const sucked = vac.updateSuck(FIXED_DT, w, inv, held && tool.collecting, 37, 40, 37, 40);
    check(
      'В режиме сбора инструмент собирает',
      sucked > 0 && inv.used === sucked,
      `собрано ${sucked}`,
    );

    // Высыпание от режима не зависит.
    for (const mode of ['сбора', 'копания']) {
      const dw = box();
      const di = new Inventory();
      di.add(MAT.REGOLITH_LOOSE, 20);
      const dv = new Vacuum();
      const placed = dv.updateDump(FIXED_DT, dw, di, true, 40, 40, 40, 40);
      check(`Высыпание работает в режиме ${mode}`, placed > 0, `размещено ${placed}`);
      tool.cycle();
    }

    // Полный цикл без мыши: у каждого действия есть клавиша, и клавиатурная
    // цель достижима по построению.
    {
      const dir = aimDirection(0, 0, 1);
      const target = actionTarget(false, 999, 999, 40, 40, dir.x, dir.y);
      check(
        'Без мыши цель берётся от персонажа, а не от нетронутого курсора',
        Digger.inReach(40, 40, target.x, target.y) && target.x !== 999,
        `цель (${target.x},${target.y})`,
      );
    }
  }

  // --- Строка состояния ---

  {
    // Строка обязана рисоваться при ВЫКЛЮЧЕННОЙ диагностике: инвентарь и счёт —
    // состояние игры, а не инструмент разработчика.
    const drawn: string[] = [];
    const pixels = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
    const display = {
      pixels,
      ctx: {
        putImageData() {},
        fillText(line: string) {
          drawn.push(line);
        },
        measureText: (s: string) => ({ width: s.length * 4.8 }),
        // Подложка оверлея и рамка панели: заглушке достаточно их принять —
        // проверяется текст, а не заливка.
        fillRect() {},
        strokeRect() {},
        font: '',
        textBaseline: '',
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
      },
      width: BASE_VIEW_W,
      height: BASE_VIEW_H,
      image: {},
      present() {},
    } as unknown as Display;

    const renderer = new Renderer(display, first.world, first.surface, WORLD_SEED);
    const camera = new Camera(first.world.width, first.world.height);
    camera.snapTo(spawn.x, spawn.y);
    const hud: HudState = {
      mode: 'Сбор',
      collecting: true,
      collectRadius: VACUUM.radius,
      carried: [{ name: 'Пульпа', count: 138 }],
      used: 138,
      capacity: VACUUM.capacity,
      selected: 'Пульпа',
      credits: 1234,
      research: 7,
      buildKind: '',
      buildIssue: '',
      ghost: null,
      machines: [],
      machineSummary: '',
      overlay: null,
    };
    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: hud,
      fps: 0,
    });

    const text = drawn.join('\n');
    check(
      'Строка состояния показывает режим, инвентарь с пределом, выбранное и счёт',
      text.includes('Сбор') &&
        text.includes(`138/${VACUUM.capacity}`) &&
        text.includes('Пульпа 138') &&
        text.includes('Высыпать: Пульпа') &&
        text.includes('1234 ₡'),
      text.replace(/\n/g, ' | '),
    );
    check(
      'Диагностики при этом в кадре нет: строка состояния от неё не зависит',
      !text.includes('FPS'),
    );
    // Обе валюты одновременно и без оверлея: игрок принимает по ним разные
    // решения — что построить и что открыть, — и валюта, которую видно только
    // в меню, из этих решений выпадает.
    check(
      'Очки исследований видны в кадре рядом с кредитами и без оверлея',
      text.includes('1234 ₡') && text.includes('7 ✦'),
      text.replace(/\n/g, ' | '),
    );

    // Оверлей рисуется тем же контекстом и поверх строки состояния: всё дерево
    // видно целиком, включая недоступное, а причина недоступности — словами.
    drawn.length = 0;
    renderer.render({
      camera: camera,
      player: new Player(spawn.x, spawn.y),
      crosshairX: 160,
      crosshairY: 90,
      crosshairInReach: true,
      hud: {
        ...hud,
        research: 6,
        overlay: {
          points: 6,
          selected: 1,
          rows: [
            { name: 'Конвейерная лента', cost: 5, status: 'open', note: '' },
            { name: 'Широкий раструб', cost: 8, status: 'poor', note: 'нужно ещё 2 ✦' },
            {
              name: 'Раструб повышенной тяги',
              cost: 20,
              status: 'blocked',
              note: 'требует: Широкий раструб',
            },
            { name: 'Форсированные сопла', cost: 25, status: 'available', note: 'Предел 140' },
          ],
        },
      },
      fps: 0,
    });
    const panel = drawn.join('\n');
    check(
      'Оверлей показывает всё дерево целиком, включая недоступное, с ценами и очками',
      panel.includes('ИССЛЕДОВАНИЯ') &&
        panel.includes('6 ✦') &&
        panel.includes('Конвейерная лента') &&
        panel.includes('Раструб повышенной тяги') &&
        panel.includes('20 ✦') &&
        panel.includes('открыта'),
      panel.replace(/\n/g, ' | '),
    );
    check(
      'Причина недоступности видна словами, а не только цветом',
      panel.includes('нужно ещё 2 ✦') && panel.includes('требует: Широкий раструб'),
    );
    check(
      'Выбранная строка отмечена явно',
      panel.includes('▸ Широкий раструб') && panel.includes('  Конвейерная лента'),
      panel.replace(/\n/g, ' | '),
    );
  }
}
