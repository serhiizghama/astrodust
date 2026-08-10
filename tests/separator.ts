import {
  MAT,
  MAT_DENSITY,
  MAT_CREDIT_RATE,
  MAT_RESEARCH_RATE,
  MatterState,
  MATERIALS,
} from '../src/world';
import { Simulation } from '../src/world';
import { Builder } from '../src/systems';
import { LandingModule, Separator, OUTLET_ROW, OUTLET_FROM, OUTLET_TO } from '../src/entities';
import { TECHNOLOGIES } from '../src/progress';
import { FIXED_DT, SEPARATOR } from '../src/config';
import { check } from './harness';
import { ground, count, settle } from './fixtures/world';
import { BX, BY, scene, build, feed } from './fixtures/separator';

{
  // --- Материалы ---

  {
    const densities = MATERIALS.filter((m) => m.id !== MAT.VACUUM);
    const heaviest = densities.reduce((a, b) => (b.density > a.density ? b : a));
    check(
      'Иридий — самое плотное вещество мира',
      heaviest.id === MAT.IRIDIUM &&
        densities.every((m) => m.id === MAT.IRIDIUM || m.density < MAT_DENSITY[MAT.IRIDIUM]!),
      `иридий ${MAT_DENSITY[MAT.IRIDIUM]}, следом ${heaviest.id === MAT.IRIDIUM ? '' : heaviest.name}` +
        ` порода ${MAT_DENSITY[MAT.ROCK]}`,
    );

    const powders = MATERIALS.filter((m) => m.state === MatterState.Powder);
    const lightest = powders.reduce((a, b) => (b.density < a.density ? b : a));
    check(
      'Шлак — самое лёгкое из сыпучих',
      lightest.id === MAT.SLAG,
      `сыпучих ${powders.length}, легчайший ${lightest.name} (${lightest.density})`,
    );

    // Ставка кредитов растёт от реголита к пульпе и обрывается на иридии:
    // переработанное платит не деньгами, а прогрессом, и «дороже» для него
    // измеряется в другой валюте.
    check(
      'Ставка кредитов растёт от реголита к пульпе, у иридия и шлака ноль',
      MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]! < MAT_CREDIT_RATE[MAT.PULP]! &&
        MAT_CREDIT_RATE[MAT.IRIDIUM] === 0 &&
        MAT_CREDIT_RATE[MAT.SLAG] === 0,
      `${MAT_CREDIT_RATE[MAT.REGOLITH_LOOSE]} → ${MAT_CREDIT_RATE[MAT.PULP]}, иридий ${MAT_CREDIT_RATE[MAT.IRIDIUM]}, шлак ${MAT_CREDIT_RATE[MAT.SLAG]}`,
    );
    check(
      'Ставка исследований ненулевая только у иридия',
      MAT_RESEARCH_RATE[MAT.IRIDIUM]! > 0 && MAT_RESEARCH_RATE[MAT.SLAG] === 0,
      `иридий ${MAT_RESEARCH_RATE[MAT.IRIDIUM]}, шлак ${MAT_RESEARCH_RATE[MAT.SLAG]}`,
    );

    const visible = [
      MAT.REGOLITH_PACKED,
      MAT.REGOLITH_LOOSE,
      MAT.PULP,
      MAT.IRIDIUM,
      MAT.SLAG,
      MAT.ICE,
      MAT.WATER,
      MAT.LAVA,
      MAT.STEAM,
      MAT.MODULE_HULL,
      MAT.SEPARATOR_HULL,
    ];
    let clashes = '';
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = MATERIALS[visible[i]!]!;
        const b = MATERIALS[visible[j]!]!;
        if (a.color === b.color) clashes += `${a.name}=${b.name} `;
      }
    }
    check('Цвета одиннадцати веществ попарно различны', clashes === '', clashes);
  }

  // --- Приёмная грань ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;

    const fed = feed(w, 4);
    separator.update(w, FIXED_DT);
    check(
      'Пульпа с приёмной грани уходит в накопитель, а из мира исчезает',
      fed === 4 && separator.stored === 4 && count(w, MAT.PULP) === 0,
      `насыпано ${fed}, в накопителе ${separator.stored}, в мире ${count(w, MAT.PULP)}`,
    );

    // Посторонний материал не поглощается и забивает вход.
    for (let dx = 0; dx < SEPARATOR.width; dx++) w.set(BX + dx, BY - 1, MAT.REGOLITH_LOOSE);
    const storedBefore = separator.stored;
    separator.update(w, FIXED_DT);
    check(
      'Реголит на приёмной грани остаётся и забивает вход',
      separator.stored === storedBefore && count(w, MAT.REGOLITH_LOOSE) === SEPARATOR.width,
      `накопитель ${storedBefore} → ${separator.stored}, реголита ${count(w, MAT.REGOLITH_LOOSE)}`,
    );
  }

  // --- Порция ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;

    // Неполный накопитель ждёт сколько угодно шагов.
    feed(w, SEPARATOR.batch - 1);
    for (let i = 0; i < 600; i++) separator.update(w, FIXED_DT);
    check(
      'Неполная порция не выдаётся, сколько бы шагов ни прошло',
      count(w, MAT.IRIDIUM) === 0 && count(w, MAT.SLAG) === 0 && separator.state === 'idle',
      `иридия ${count(w, MAT.IRIDIUM)}, шлака ${count(w, MAT.SLAG)}, состояние ${separator.state}`,
    );

    // Полная — ждёт задержку, а не выдаётся тем же шагом.
    feed(w, 1);
    separator.update(w, FIXED_DT);
    const sameStep = count(w, MAT.IRIDIUM) + count(w, MAT.SLAG);
    let steps = 0;
    while (count(w, MAT.IRIDIUM) === 0 && steps < 600) {
      separator.update(w, FIXED_DT);
      steps++;
    }
    const expected = Math.round(SEPARATOR.delaySec / FIXED_DT);
    // Допуск в два шага, а не в один: задержка отмеряется игровым временем,
    // и последнее вычитание оставляет от неё дробный остаток — обнулиться
    // ровно на N-м шаге двоичная дробь не обязана.
    check(
      'Порция выдаётся не в том же шаге, а по истечении задержки',
      sameStep === 0 && Math.abs(steps + 1 - expected) <= 2,
      `в тот же шаг ${sameStep}, шагов до выдачи ${steps + 1} при ожидаемых ${expected}`,
    );
    check(
      'Порция даёт ровно `iridium` ячеек иридия и остальное шлаком',
      count(w, MAT.IRIDIUM) === SEPARATOR.iridium &&
        count(w, MAT.SLAG) === SEPARATOR.batch - SEPARATOR.iridium,
      `иридий ${count(w, MAT.IRIDIUM)}, шлак ${count(w, MAT.SLAG)}`,
    );

    // Продукт вышел из выпускного окна, а не сквозь корпус.
    let outsideWindow = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const m = w.get(x, y);
        if (m !== MAT.IRIDIUM && m !== MAT.SLAG) continue;
        const dx = x - BX;
        const dy = y - BY;
        if (dy !== OUTLET_ROW || dx < OUTLET_FROM || dx >= OUTLET_TO) outsideWindow++;
      }
    }
    check(
      'Продукт появился только в выпускном окне',
      outsideWindow === 0,
      `вне окна ${outsideWindow}`,
    );
  }

  // Темп машины задан игровым временем, а не числом кадров: на 144 Гц за те же
  // три секунды выходит столько же порций, сколько на 60.
  {
    function batchesIn(seconds: number, dt: number): number {
      const { world: w, module, registry } = scene(1000);
      build(w, registry, module);
      const separator = registry.all[0] as Separator;
      const steps = Math.round(seconds / dt);
      let emitted = 0;
      for (let i = 0; i < steps; i++) {
        feed(w, SEPARATOR.batch);
        separator.update(w, dt);
        // Убираем выданное, чтобы выход не забился и замер мерил темп,
        // а не длину просвета под окном.
        for (let y = BY; y < BY + SEPARATOR.height + 4; y++) {
          for (let x = BX; x < BX + SEPARATOR.width; x++) {
            const m = w.get(x, y);
            if (m === MAT.IRIDIUM) {
              emitted++;
              w.set(x, y, MAT.VACUUM);
            } else if (m === MAT.SLAG) {
              w.set(x, y, MAT.VACUUM);
            }
          }
        }
      }
      return emitted;
    }
    const at60 = batchesIn(8, 1 / 60);
    const at144 = batchesIn(8, 1 / 144);
    check(
      'Темп машины не зависит от частоты кадров',
      at60 === at144 && at60 > 0,
      `на 60 Гц ${at60} порций за 8 с, на 144 Гц ${at144}`,
    );
  }

  // Машина работает сама: ни в одном её вызове персонаж не участвует, и здесь
  // это проверяется явно — во всей сцене его просто нет.
  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;
    const sim = new Simulation();
    feed(w, SEPARATOR.batch);
    for (let i = 0; i < 200; i++) {
      sim.update(w, null);
      registry.update(w, FIXED_DT);
    }
    check(
      'Машина принимает и выдаёт без игрока рядом',
      count(w, MAT.IRIDIUM) === SEPARATOR.iridium && separator.stored === 0,
      `иридия ${count(w, MAT.IRIDIUM)}, в накопителе ${separator.stored}`,
    );
  }

  // Сохранение вещества на многих порциях.
  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;
    const sim = new Simulation();

    const batches = 6;
    let absorbed = 0;
    for (let i = 0; i < 4000; i++) {
      if (absorbed < SEPARATOR.batch * batches)
        absorbed += feed(w, SEPARATOR.batch * batches - absorbed);
      sim.update(w, null);
      separator.update(w, FIXED_DT);
    }
    settle(w, 2000);
    const out = count(w, MAT.IRIDIUM) + count(w, MAT.SLAG);
    const inside = separator.drain().length;
    check(
      'Сумма выданного и оставшегося внутри равна сумме поглощённого',
      out + inside + count(w, MAT.PULP) === absorbed,
      `поглощено ${absorbed}, выдано ${out}, внутри ${inside}, на грани ${count(w, MAT.PULP)}`,
    );
    check(
      'Иридия ровно по `iridium` ячеек на выданную порцию',
      count(w, MAT.IRIDIUM) / SEPARATOR.iridium ===
        count(w, MAT.SLAG) / (SEPARATOR.batch - SEPARATOR.iridium),
      `иридий ${count(w, MAT.IRIDIUM)}, шлак ${count(w, MAT.SLAG)}`,
    );
  }

  // --- Забитый выход ---

  {
    const { world: w, module, registry } = scene(1000);
    build(w, registry, module);
    const separator = registry.all[0] as Separator;

    // Забиваем окно доверху породой: выйти порции некуда.
    for (let dy = OUTLET_ROW; dy < SEPARATOR.height; dy++) {
      for (let dx = OUTLET_FROM; dx < OUTLET_TO; dx++) w.set(BX + dx, BY + dy, MAT.ROCK);
    }

    feed(w, SEPARATOR.batch);
    for (let i = 0; i < 400; i++) separator.update(w, FIXED_DT);
    check(
      'Забитый выход останавливает машину, и порция не пропадает',
      separator.state === 'blocked' &&
        count(w, MAT.IRIDIUM) === 0 &&
        count(w, MAT.SLAG) === 0 &&
        separator.drain().length === SEPARATOR.batch,
      `состояние ${separator.state}, внутри ${separator.drain().length}`,
    );

    // Накопитель принимает до предела и дальше не растёт.
    const limit = SEPARATOR.batch * SEPARATOR.bufferBatches;
    let leftOnFace = 0;
    for (let round = 0; round < 20; round++) {
      feed(w, SEPARATOR.width);
      separator.update(w, FIXED_DT);
    }
    leftOnFace = count(w, MAT.PULP);
    check(
      'Переполненный накопитель перестаёт принимать, пульпа остаётся на грани',
      separator.stored === limit && leftOnFace > 0,
      `накопитель ${separator.stored} при пределе ${limit}, на грани ${leftOnFace}`,
    );

    // Освобождение выхода возобновляет работу с того же состояния.
    for (let dy = OUTLET_ROW; dy < SEPARATOR.height; dy++) {
      for (let dx = OUTLET_FROM; dx < OUTLET_TO; dx++) w.set(BX + dx, BY + dy, MAT.VACUUM);
    }
    separator.update(w, FIXED_DT);
    check(
      'Освобождение выхода выдаёт задержанную порцию',
      count(w, MAT.IRIDIUM) === SEPARATOR.iridium &&
        count(w, MAT.SLAG) === SEPARATOR.batch - SEPARATOR.iridium,
      `иридий ${count(w, MAT.IRIDIUM)}, шлак ${count(w, MAT.SLAG)}`,
    );
  }

  // --- Расслоение продуктов ---

  {
    const w = ground();
    // Перемешанная куча: иридий сверху, шлак снизу — заведомо «неправильно».
    for (let x = 40; x < 56; x++) {
      for (let y = 80; y < 86; y++) w.set(x, y, y < 83 ? MAT.IRIDIUM : MAT.SLAG);
    }
    const iridium = count(w, MAT.IRIDIUM);
    const slag = count(w, MAT.SLAG);
    settle(w, 4000);

    let sumIridiumY = 0;
    let sumSlagY = 0;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        if (w.get(x, y) === MAT.IRIDIUM) sumIridiumY += y;
        if (w.get(x, y) === MAT.SLAG) sumSlagY += y;
      }
    }
    check(
      'Иридий тонет в шлаке: перемешанная куча расслаивается',
      sumIridiumY / iridium > sumSlagY / slag &&
        count(w, MAT.IRIDIUM) === iridium &&
        count(w, MAT.SLAG) === slag,
      `центр иридия ${(sumIridiumY / iridium).toFixed(1)}, центр шлака ${(sumSlagY / slag).toFixed(1)}`,
    );
  }

  // --- Экономика ---

  {
    // Окупаемость машины меряется ПРОГРЕССОМ, а не кредитами. По деньгам она
    // всегда в убытке — иридий не приносит ни одного, — и в этом её роль:
    // сепаратор превращает сырьё в то, чего за деньги не купить.
    const directCredits = SEPARATOR.batch * MAT_CREDIT_RATE[MAT.PULP]!;
    const slagPerBatch = SEPARATOR.batch - SEPARATOR.iridium;
    const processedCredits =
      SEPARATOR.iridium * MAT_CREDIT_RATE[MAT.IRIDIUM]! + slagPerBatch * MAT_CREDIT_RATE[MAT.SLAG]!;
    const processedPoints =
      SEPARATOR.iridium * MAT_RESEARCH_RATE[MAT.IRIDIUM]! +
      slagPerBatch * MAT_RESEARCH_RATE[MAT.SLAG]!;
    check(
      'Переработка даёт то, чего прямая сдача не даёт ни в каком количестве',
      processedPoints > 0 && directCredits > 0 && processedCredits === 0,
      `напрямую ${directCredits} ₡ и 0 ✦, через сепаратор ${processedCredits} ₡ и ${processedPoints} ✦`,
    );
    // Цена машины в кредитах и цена первой технологии в очках согласованы так,
    // чтобы первое открытие наступало за обозримое ВРЕМЯ работы машины: иначе
    // игрок, потративший на неё все кредиты, читает её как тупик, а не как
    // ступень. Мерка временем, а не порциями: порция — величина настраиваемая,
    // и вдвое более частые порции вдвое меньшего веса ничего не меняют.
    {
      const firstCost = Math.min(...TECHNOLOGIES.map((t) => t.cost));
      const seconds = (firstCost / processedPoints) * SEPARATOR.delaySec;
      check(
        'Первая технология достижима за обозримое время работы машины',
        processedPoints > 0 && seconds <= 10,
        `${seconds.toFixed(1)} с работы машины до первой технологии`,
      );
    }

    // Приёмник принимает иридий очками и не принимает шлак вовсе.
    const w = ground();
    const zone = { x: 40, y: 40, w: 6, h: 4 };
    const module = new LandingModule(zone);
    for (let x = zone.x; x < zone.x + 3; x++) w.set(x, zone.y, MAT.IRIDIUM);
    for (let x = zone.x + 3; x < zone.x + 6; x++) w.set(x, zone.y, MAT.SLAG);
    const earned = module.update(w);
    check(
      'Приёмник принимает иридий очками, кредитов не даёт, шлак не принимает',
      earned.research === 3 * MAT_RESEARCH_RATE[MAT.IRIDIUM]! &&
        earned.credits === 0 &&
        module.credits === 0 &&
        module.research.points === earned.research &&
        count(w, MAT.IRIDIUM) === 0 &&
        count(w, MAT.SLAG) === 3,
      `начислено ${earned.credits} ₡ и ${earned.research} ✦, иридия осталось ${count(w, MAT.IRIDIUM)}, шлака ${count(w, MAT.SLAG)}`,
    );
  }

  // Счёт не уходит в минус на длинной последовательности покупок и сносов.
  {
    const { world: w, module, registry } = scene(SEPARATOR.cost);
    let negative = false;
    let placed = 0;
    let demolished = 0;
    for (let i = 0; i < 200; i++) {
      const r = build(w, registry, module);
      if (r === 'placed') placed++;
      if (r === 'demolished') demolished++;
      if (module.credits < 0) negative = true;
    }
    check(
      'Счёт кредитов ни разу не ушёл в минус на длинной последовательности',
      !negative && module.credits >= 0 && placed > 0 && demolished > 0,
      `постановок ${placed}, сносов ${demolished}, счёт ${module.credits}`,
    );

    // Отдельно: покупка при нехватке отвергается целиком.
    module.credits = SEPARATOR.cost - 1;
    while (registry.count > 0) Builder.demolish(w, registry, module, registry.all[0]!);
    const before = module.credits;
    module.credits = SEPARATOR.cost - 1;
    build(w, registry, module);
    check(
      'Нехватка средств отвергает покупку целиком',
      registry.count === 0 && module.credits === SEPARATOR.cost - 1,
      `зданий ${registry.count}, счёт ${before} → ${module.credits}`,
    );
  }
}
