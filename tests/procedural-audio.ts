import { World, MAT, Simulation } from '../src/world';
import { Camera } from '../src/render';
import { FIXED_DT, WORLD_SEED, BASE_VIEW_W, DIG, CAMERA, AUDIO } from '../src/config';
import {
  attenuation,
  attenuationAt,
  panFor,
  changed,
  fillNoise,
  gridHz,
  scaleToneIn,
  snapToScale,
  AudioClock,
  VoiceSlots,
} from '../src/audio';
import {
  createSignals,
  resetSignals,
  createDigState,
  createDigParams,
  digParams,
  mergeStrike,
} from '../src/audio';
import { createDustState, createDustParams, dustParams, dustIntensity } from '../src/audio';
import { createGrabState, createGrabParams, grabParams, mergeRustle } from '../src/audio';
import { check, luna } from './harness';

const first = luna();
const { world } = first;

// --- Звук ---
//
// Проверяется МОДЕЛЬ — отображение «сигнал за шаг → параметры дорожки».
// Ни одной ноды WebAudio здесь нет и быть не может: тесты идут в Node.
// «Звучит плохо» этим не ловится и ловиться не должно — на то есть приёмка
// на слух; зато рассинхроны, лимиты и кривые ловятся полностью.
{
  // Затухание в вакууме.
  {
    check('Слышимость: в точке персонажа единица', attenuation(0) === 1);

    let monotone = true;
    let prev = attenuation(0);
    for (let d = 1; d <= AUDIO.contactRadius; d++) {
      const a = attenuation(d);
      if (a >= prev) monotone = false;
      prev = a;
    }
    check('Слышимость: убывает монотонно до радиуса', monotone);

    check(
      'Слышимость: за радиусом РОВНЫЙ ноль, а не хвост',
      attenuation(AUDIO.contactRadius) === 0 &&
        attenuation(AUDIO.contactRadius + 1) === 0 &&
        attenuation(1000) === 0,
    );

    // Слышно ближе, чем видно: осыпание на краю кадра беззвучно, и это
    // не недосмотр, а само правило вакуума.
    check(
      'Слышимость: радиус меньше полукадра и вдвое больше дальности копания',
      AUDIO.contactRadius < BASE_VIEW_W / 2 && AUDIO.contactRadius === DIG.reach * 2,
      `${AUDIO.contactRadius} < ${BASE_VIEW_W / 2}, копание ${DIG.reach}`,
    );

    check(
      'Слышимость: источник на другом конце мира не слышен',
      attenuationAt(1000, 100, 100, 100) === 0,
    );
  }

  // Панорама считается от персонажа, а не от кадра.
  {
    const listenerX = 500;
    const srcX = listenerX + 40;

    const cam = new Camera(world.width, world.height);
    cam.snapTo(listenerX, 200);
    const before = panFor(srcX, listenerX);
    const camBefore = cam.x;

    // Кадр расходится со слушателем сам: цель ушла за мёртвую зону, и камера
    // догоняет её сглаженно. Слушатель при этом остаётся там же, где был.
    for (let i = 0; i < 120; i++) {
      cam.follow(listenerX + CAMERA.deadzoneHalfW * 2, 200);
    }
    const after = panFor(srcX, listenerX);

    check(
      'Панорама: расхождение кадра со слушателем её не двигает',
      before === after && cam.x !== camBefore,
      `кадр ${camBefore} → ${cam.x}, панорама ${before.toFixed(3)}`,
    );

    check(
      'Панорама: знак следует за стороной источника и не выходит за предел',
      panFor(listenerX - 40, listenerX) < 0 &&
        panFor(listenerX + 1000, listenerX) === AUDIO.panMax &&
        panFor(listenerX - 1000, listenerX) === -AUDIO.panMax,
    );
  }

  // Общий строй и полосы.
  {
    const tones: number[] = [];
    for (let i = 0; i < 12; i++) {
      tones.push(scaleToneIn(i, AUDIO.dig.strikeHzLow, AUDIO.dig.strikeHzHigh));
    }
    check(
      'Строй: тон акцента всегда внутри полосы дорожки',
      tones.every((hz) => hz >= AUDIO.dig.strikeHzLow && hz <= AUDIO.dig.strikeHzHigh),
      `${Math.min(...tones).toFixed(0)}…${Math.max(...tones).toFixed(0)} Гц`,
    );
    check(
      'Строй: тонов в полосе больше одного — акценты не одинаковы',
      new Set(tones.map((t) => t.toFixed(3))).size > 1,
      `разных тонов ${new Set(tones.map((t) => t.toFixed(3))).size}`,
    );
    check(
      'Строй: тон лежит на сетке — привязка произвольной частоты его не двигает',
      tones.every((hz) => Math.abs(snapToScale(hz) - hz) < 1e-6),
    );
    check('Строй: сетка растёт от основания', gridHz(0) === AUDIO.rootHz && gridHz(5) > gridHz(0));

    // Низ намеренно пуст: туда пойдут шаги, ранец и обрушения. Если копание
    // займёт его сейчас, потом придётся выселять.
    check(
      'Полосы: ниже 400 Гц не занято ни одной дорожкой',
      AUDIO.dig.hzQuiet >= 400 && AUDIO.dig.strikeHzLow >= 400 && AUDIO.dust.hzQuiet >= 400,
    );
  }

  // Кривая пыли.
  {
    let monotone = true;
    let prev = -1;
    for (let m = 0; m <= 5000; m += 7) {
      const i = dustIntensity(m);
      if (i < prev) monotone = false;
      prev = i;
    }
    check('Пыль: интенсивность растёт монотонно с числом сдвигов', monotone);
    check(
      'Пыль: насыщение ровно на fullMoves и выше единицы не поднимается',
      dustIntensity(AUDIO.dust.fullMoves) === 1 && dustIntensity(100000) === 1,
    );
    check(
      'Пыль: обвал звучит громче осыпания, но в разы, а не в сто раз',
      dustIntensity(1000) > dustIntensity(10) && dustIntensity(1000) < dustIntensity(10) * 20,
      `10 → ${dustIntensity(10).toFixed(3)}, 1000 → ${dustIntensity(1000).toFixed(3)}`,
    );

    const state = createDustState();
    const out = createDustParams();
    const sig = createSignals();
    sig.listenerX = 100;
    sig.listenerY = 100;
    sig.powderX = 100;
    sig.powderY = 100;

    sig.powderMoves = 100000;
    dustParams(sig, state, out);
    check(
      'Пыль: даже тысячи сдвигов не выводят громкость за предел дорожки',
      out.gain <= AUDIO.dust.gain + 1e-9,
      `${out.gain.toFixed(3)} ≤ ${AUDIO.dust.gain}`,
    );

    // Правило вакуума на самой дорожке, а не только на функции затухания.
    sig.powderX = 100 + AUDIO.contactRadius + 1;
    sig.powderMoves = 5000;
    dustParams(sig, state, out);
    check('Пыль: осыпание дальше радиуса не слышно вообще', out.gain === 0);

    // Улёгшийся мир молчит.
    sig.powderX = 100;
    sig.powderMoves = 200;
    dustParams(sig, state, out);
    const loud = out.gain;
    sig.powderMoves = 0;
    dustParams(sig, state, out);
    check(
      'Пыль: последняя остановившаяся ячейка приводит текстуру к ровному нулю',
      loud > 0 && out.gain === 0 && !out.rising,
      `${loud.toFixed(3)} → ${out.gain}`,
    );
  }

  /** Снапшот с персонажем и точкой копания в одном месте — слышимость единица. */
  function digSignals(converted: number) {
    const sig = createSignals();
    sig.listenerX = 100;
    sig.listenerY = 100;
    sig.digX = 100;
    sig.digY = 100;
    sig.digConverted = converted;
    return sig;
  }

  // Лимит темпа акцентов.
  {
    const state = createDigState();
    const out = createDigParams();
    // Кисть применяется 33 раза в секунду — заведомо выше различимого на слух
    // темпа ударов. Слух перестаёт разбирать события примерно с 20 Гц.
    const applications = 33;
    const sig = digSignals(0);
    let strikes = 0;
    let applied = 0;
    for (let i = 0; i < 60; i++) {
      const due = Math.floor((i * applications) / 60) > Math.floor(((i - 1) * applications) / 60);
      sig.digConverted = due ? 12 : 0;
      if (due) applied++;
      digParams(sig, state, FIXED_DT, out);
      if (out.strike) strikes++;
    }
    check(
      'Копание: при 33 применениях кисти в секунду акцентов не больше потолка',
      applied === applications && strikes <= AUDIO.dig.strikeHz,
      `применений ${applied}, акцентов ${strikes} ≤ ${AUDIO.dig.strikeHz}`,
    );
    check(
      'Копание: акценты при этом звучат, а не пропадают',
      strikes >= AUDIO.dig.strikeHz - 2,
      `акцентов ${strikes}`,
    );
  }

  // Молчание там, где мир не изменился.
  {
    const state = createDigState();
    const out = createDigParams();
    const sig = digSignals(0);
    let strikes = 0;
    let loudest = 0;
    for (let i = 0; i < 300; i++) {
      digParams(sig, state, FIXED_DT, out);
      if (out.strike) strikes++;
      loudest = Math.max(loudest, out.grindGain);
    }
    check(
      'Копание: пустота и недостижимая цель не дают ни помола, ни акцентов',
      strikes === 0 && loudest === 0,
      `акцентов ${strikes}, громкость ${loudest}`,
    );
  }

  // Копание за радиусом слышимости.
  {
    const state = createDigState();
    const out = createDigParams();
    const sig = digSignals(12);
    sig.digX = 100 + AUDIO.contactRadius + 10;
    let loudest = 0;
    let strikeGain = 0;
    for (let i = 0; i < 120; i++) {
      digParams(sig, state, FIXED_DT, out);
      loudest = Math.max(loudest, out.grindGain);
      if (out.strike) strikeGain = Math.max(strikeGain, out.strikeGain);
    }
    check(
      'Копание: за радиусом слышимости молчит и помол, и акцент',
      loudest === 0 && strikeGain === 0,
    );
  }

  // --- Дорожка захвата ---

  /** Снапшот с персонажем и местом захвата в одной точке: слышимость единица. */
  function grabSignals(taken: number, dropped = 0) {
    const sig = createSignals();
    sig.listenerX = 100;
    sig.listenerY = 100;
    sig.grabX = 100;
    sig.grabY = 100;
    sig.grabTaken = taken;
    sig.grabDropped = dropped;
    return sig;
  }

  // Потолок темпа шорохов: набор идёт 33 раза в секунду, слух разбирает
  // события примерно до 20 Гц.
  {
    const state = createGrabState();
    const out = createGrabParams();
    const portions = 33;
    const sig = grabSignals(0);
    let rustles = 0;
    for (let i = 0; i < 60; i++) {
      const due = Math.floor((i * portions) / 60) > Math.floor(((i - 1) * portions) / 60);
      sig.grabTaken = due ? 20 : 0;
      grabParams(sig, state, FIXED_DT, out);
      if (out.rustle) rustles++;
    }
    check(
      'Захват: при 33 порциях набора в секунду шорохов не больше потолка',
      rustles <= AUDIO.grab.rateHz,
      `шорохов ${rustles} ≤ ${AUDIO.grab.rateHz}`,
    );
    check(
      'Захват: шорохи при этом звучат, а не пропадают',
      rustles >= AUDIO.grab.rateHz - 2,
      `шорохов ${rustles}`,
    );
  }

  // Удержание без набора молчит: над породой мир не меняется.
  {
    const state = createGrabState();
    const out = createGrabParams();
    const sig = grabSignals(0);
    let rustles = 0;
    let loudest = 0;
    for (let i = 0; i < 300; i++) {
      grabParams(sig, state, FIXED_DT, out);
      if (out.rustle) rustles++;
      loudest = Math.max(loudest, out.rustleGain, out.dropGain);
    }
    check(
      'Захват: удержание без набора не звучит',
      rustles === 0 && loudest === 0,
      `шорохов ${rustles}, громкость ${loudest}`,
    );
  }

  // Громкость шороха следует размеру порции.
  {
    const loud = (taken: number): number => {
      const state = createGrabState();
      const out = createGrabParams();
      const sig = grabSignals(taken);
      for (let i = 0; i < 30; i++) {
        grabParams(sig, state, FIXED_DT, out);
        sig.grabTaken = 0;
        if (out.rustle) return out.rustleGain;
      }
      return 0;
    };
    const big = loud(169);
    const small = loud(3);
    check(
      'Захват: полная порция звучит громче трёх ячеек',
      big > small && small > 0,
      `${big.toFixed(3)} > ${small.toFixed(3)}`,
    );
  }

  // Сброс: один на событие и тише набора.
  {
    const state = createGrabState();
    const out = createGrabParams();
    const sig = grabSignals(0, 40);
    grabParams(sig, state, FIXED_DT, out);
    const dropGain = out.dropGain;
    const fired = out.drop;

    sig.grabDropped = 0;
    let more = 0;
    for (let i = 0; i < 60; i++) {
      grabParams(sig, state, FIXED_DT, out);
      if (out.drop) more++;
    }

    check('Захват: сброс звучит один раз на событие', fired && more === 0, `повторов ${more}`);
    check(
      'Захват: сброс тише шороха набора',
      AUDIO.grab.dropGain < AUDIO.grab.gain && dropGain > 0,
      `${AUDIO.grab.dropGain} < ${AUDIO.grab.gain}`,
    );
  }

  // Отпускание, не положившее ни ячейки, событием не является: сигнал пуст,
  // и дорожке нечего играть.
  {
    const state = createGrabState();
    const out = createGrabParams();
    grabParams(grabSignals(0, 0), state, FIXED_DT, out);
    check('Захват: пустое отпускание не звучит', !out.drop && out.dropGain === 0);
  }

  // За радиусом слышимости молчат оба события.
  {
    const state = createGrabState();
    const out = createGrabParams();
    const sig = grabSignals(96, 0);
    sig.grabX = 100 + AUDIO.contactRadius + 10;
    let rustleGain = 0;
    for (let i = 0; i < 120; i++) {
      grabParams(sig, state, FIXED_DT, out);
      if (out.rustle) rustleGain = Math.max(rustleGain, out.rustleGain);
    }
    sig.grabTaken = 0;
    sig.grabDropped = 40;
    grabParams(sig, state, FIXED_DT, out);
    check(
      'Захват: за радиусом слышимости молчат и шорох, и сброс',
      rustleGain === 0 && out.dropGain === 0,
    );
  }

  // Порция без слота не теряется: её ячейки возвращаются в окно и делают
  // следующий шорох громче.
  {
    const state = createGrabState();
    const out = createGrabParams();
    const sig = grabSignals(48);
    let first = 0;
    for (let i = 0; i < 30; i++) {
      grabParams(sig, state, FIXED_DT, out);
      sig.grabTaken = 0;
      if (out.rustle) {
        first = out.rustleGain;
        mergeRustle(state, out);
        break;
      }
    }
    let next = 0;
    for (let i = 0; i < 30; i++) {
      grabParams(sig, state, FIXED_DT, out);
      if (out.rustle) {
        next = out.rustleGain;
        break;
      }
    }
    check(
      'Захват: порция без слота вливается в следующий шорох',
      next > 0 && Math.abs(next - first) < 1e-9,
      `было ${first.toFixed(3)}, стало ${next.toFixed(3)}`,
    );
  }

  // Полосы: с пылью захват звучит одновременно чаще всего — выброшенный комок
  // осыпается в ту же секунду.
  {
    check(
      'Полосы: захват лежит ниже дорожки пыли',
      Math.max(AUDIO.grab.hzHigh, AUDIO.grab.dropHz) < AUDIO.dust.hzQuiet,
      `${Math.max(AUDIO.grab.hzHigh, AUDIO.grab.dropHz)} < ${AUDIO.dust.hzQuiet}`,
    );
  }

  // Курсор часов аудио.
  {
    const clock = new AudioClock();
    const now = 3;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push(clock.next(now));

    const spaced = times.every((t, i) => i === 0 || Math.abs(t - times[i - 1]! - FIXED_DT) < 1e-12);
    check(
      'Часы: пять шагов в одном кадре дают пять разных времён с шагом симуляции',
      new Set(times).size === 5 && spaced,
      times.map((t) => (t - now).toFixed(4)).join(' '),
    );
    check(
      'Часы: планирования в прошлое не бывает — браузер отдал бы такое молча',
      times.every((t) => t >= now + AUDIO.lookahead - 1e-12),
    );

    // Возврат из свёрнутой вкладки: курсор ушёл далеко вперёд, и накопленное
    // проигралось бы залпом.
    let maxAhead = 0;
    for (let i = 0; i < 500; i++) maxAhead = Math.max(maxAhead, clock.next(now) - now);
    check(
      'Часы: курсор не уходит дальше предела опережения',
      maxAhead <= AUDIO.maxAhead + 1e-12,
      `${maxAhead.toFixed(4)} ≤ ${AUDIO.maxAhead}`,
    );

    clock.reset();
    check(
      'Часы: сброс возвращает курсор к настоящему',
      Math.abs(clock.next(100) - (100 + AUDIO.lookahead)) < 1e-12,
    );
  }

  // Лимит одноразовых голосов.
  {
    const slots = new VoiceSlots(AUDIO.maxOneShots);
    const now = 10;
    let granted = 0;
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      if (slots.acquire(now, now + AUDIO.lookahead, AUDIO.dig.strikeDecay) >= 0) granted++;
      else refused++;
    }
    check(
      'Голоса: залп событий не оставляет больше лимита занятых слотов',
      granted === AUDIO.maxOneShots && slots.activeCount(now) === AUDIO.maxOneShots,
      `выдано ${granted}, отказано ${refused}`,
    );

    const later = now + AUDIO.lookahead + AUDIO.dig.strikeDecay;
    check(
      'Голоса: отзвучавшие слоты освобождаются без колбэков',
      slots.activeCount(later) === 0 && slots.acquire(later, later, 0.05) === 0,
    );

    // Событие сверх лимита не теряется, а вливается в непрерывную часть:
    // обвал должен становиться громче, а не рассыпаться на щелчки.
    const state = createDigState();
    const out = createDigParams();
    state.att = 1;
    out.strikeGain = 0.3;
    mergeStrike(state, out);
    const merged = state.merged;
    mergeStrike(state, out);
    check(
      'Голоса: лишний акцент вливается в помол, складываясь по мощности',
      merged > 0 && state.merged > merged,
      `${merged.toFixed(3)} → ${state.merged.toFixed(3)}`,
    );

    // Залп на обвале обязан упереться в потолок дорожки, а не расти без предела.
    for (let i = 0; i < 50; i++) mergeStrike(state, out);
    check(
      'Голоса: слияние упирается в бюджет дорожки и не перегружает шину',
      state.merged <= AUDIO.dig.gain + 1e-9,
      `${state.merged.toFixed(3)} ≤ ${AUDIO.dig.gain}`,
    );

    const silent = digSignals(0);
    digParams(silent, state, FIXED_DT, out);
    check(
      'Голоса: влитая энергия слышна в помоле, а не пропадает',
      out.grindGain > 0,
      `помол ${out.grindGain.toFixed(3)}`,
    );
  }

  // Детерминированность шума.
  {
    const a = new Float32Array(4096);
    const b = new Float32Array(4096);
    fillNoise(a, WORLD_SEED);
    fillNoise(b, WORLD_SEED);
    let same = true;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check('Шум: одно зерно — одна и та же выборка', same);

    const other = new Float32Array(4096);
    fillNoise(other, WORLD_SEED + 1);
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== other[i]) differs = true;
    check('Шум: другое зерно даёт другой материал', differs);

    let inRange = true;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i]! < -1 || a[i]! > 1) inRange = false;
      sum += a[i]!;
    }
    check(
      'Шум: выборки в пределах и без постоянной составляющей',
      inRange && Math.abs(sum / a.length) < 0.05,
      `среднее ${(sum / a.length).toFixed(4)}`,
    );
  }

  // Порог изменения параметра.
  {
    check(
      'Порог: приход в тишину и уход из неё сообщаются всегда',
      changed(0.0001, 0) && changed(0, 0.0001) && !changed(0.5, 0.5),
    );

    const state = createDigState();
    const out = createDigParams();
    const sig = digSignals(6);
    let lateChanges = 0;
    for (let i = 0; i < 600; i++) {
      digParams(sig, state, FIXED_DT, out);
      if (i >= 300 && out.grindChanged) lateChanges++;
    }
    check(
      'Порог: при постоянном сигнале модель перестаёт трогать параметры',
      lateChanges === 0,
      `автоматизаций за 5 секунд установившегося режима: ${lateChanges}`,
    );

    const ds = createDustState();
    const dout = createDustParams();
    const dsig = createSignals();
    dsig.listenerX = 100;
    dsig.listenerY = 100;
    dsig.powderX = 100;
    dsig.powderY = 100;
    dsig.powderMoves = 120;
    dustParams(dsig, ds, dout);
    const firstChanged = dout.changed;
    let repeats = 0;
    for (let i = 0; i < 300; i++) {
      dustParams(dsig, ds, dout);
      if (dout.changed) repeats++;
    }
    check(
      'Порог: ровный поток осыпания не порождает автоматизаций',
      firstChanged && repeats === 0,
      `повторных ${repeats}`,
    );
  }

  // Счётчики симуляции: наблюдение, а не участие.
  {
    function sandbox(w = 96, h = 96): World {
      const world = new World(w, h, first.world.profile);
      for (let x = 0; x < w; x++) world.set(x, h - 1, MAT.ROCK);
      return world;
    }

    {
      const w = sandbox();
      w.set(20, 10, MAT.REGOLITH_LOOSE);
      const sim = new Simulation();
      sim.update(w, null);
      check(
        'Счётчики: одна падающая ячейка — один сдвиг, центр масс в её новой позиции',
        sim.lastPowderMoves === 1 &&
          sim.lastPowderSumX / sim.lastPowderMoves === 20 &&
          sim.lastPowderSumY / sim.lastPowderMoves === 11,
        `сдвигов ${sim.lastPowderMoves}, центр (${sim.lastPowderSumX}, ${sim.lastPowderSumY})`,
      );

      for (let i = 0; i < 300; i++) sim.update(w, null);
      check(
        'Счётчики: улёгшийся мир даёт ноль сдвигов — звуку нечего играть',
        sim.lastPowderMoves === 0 && w.get(20, 94) === MAT.REGOLITH_LOOSE,
        `сдвигов ${sim.lastPowderMoves}`,
      );
    }

    {
      // Дорожка привязана к состоянию материала, а не к конкретному реголиту:
      // жидкое и газообразное этот счётчик не трогают.
      const w = sandbox();
      w.set(30, 10, MAT.WATER);
      w.set(40, 60, MAT.STEAM);
      const sim = new Simulation();
      let powder = 0;
      for (let i = 0; i < 60; i++) {
        sim.update(w, null);
        powder += sim.lastPowderMoves;
      }
      check('Счётчики: жидкое и газообразное в дорожку пыли не попадают', powder === 0);
    }

    {
      // Эталон: сценарий из существующей проверки детерминированности.
      // Счётчики читаются на каждом шаге, и сетка обязана совпасть с прогоном,
      // который их игнорирует, — иначе учёт влиял бы на автомат.
      function scenario(readCounters: boolean): Uint8Array {
        const w = sandbox();
        const sim = new Simulation();
        let seen = 0;
        for (let i = 0; i < 300; i++) {
          if (i % 3 === 0) w.set(40 + (i % 7), 8, MAT.REGOLITH_LOOSE);
          sim.update(w, null);
          if (readCounters) seen += sim.lastPowderMoves + sim.lastPowderSumX;
        }
        void seen;
        return w.cells.slice();
      }
      const a = scenario(true);
      const b = scenario(false);
      let same = a.length === b.length;
      for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
      check('Счётчики: учёт движения не изменил поведение автомата', same);
    }
  }

  // Снапшот сигналов переиспользуется.
  {
    const sig = createSignals();
    sig.digConverted = 7;
    sig.powderMoves = 300;
    sig.listenerX = 42;
    resetSignals(sig);
    check(
      'Сигналы: сброс обнуляет счётчики шага и не трогает точку отсчёта',
      sig.digConverted === 0 && sig.powderMoves === 0 && sig.listenerX === 42,
    );
  }
}
