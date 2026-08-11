import { Camera, Backdrop, Renderer, RecordingSurface } from '../src/render';
import type { Display } from '../src/core';
import { MATERIALS, LUNA } from '../src/world';
import { Player } from '../src/entities';
import { WORLD_SEED, BASE_VIEW_W, BASE_VIEW_H, BACKDROP } from '../src/config';
import { check, IDLE_HUD, luna } from './harness';

const first = luna();

// --- Задник неба ---
{
  const profile = first.world.profile;
  const spec = profile.backdrop;

  /**
   * Полный кадр без DOM. Персонаж уводится далеко вниз, а прицел — в породу:
   * иначе они попали бы в область неба и посчитались акцентами задника.
   */
  function renderSky(camX: number, camY: number): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
    const display = {
      pixels,
      ctx: { putImageData() {} },
      width: BASE_VIEW_W,
      height: BASE_VIEW_H,
      image: {},
      present() {},
    } as unknown as Display;

    const renderer = new Renderer(
      display,
      first.world,
      first.surface,
      WORLD_SEED,
      new RecordingSurface(),
    );
    const camera = new Camera(first.world.width, first.world.height);
    camera.snapTo(camX + BASE_VIEW_W / 2, camY + BASE_VIEW_H / 2);
    const offscreen = new Player(camera.x + BASE_VIEW_W / 2, camera.y + BASE_VIEW_H + 40);
    renderer.render({
      camera: camera,
      player: offscreen,
      crosshairX: BASE_VIEW_W / 2,
      crosshairY: BASE_VIEW_H - 1,
      crosshairInReach: true,
      hud: IDLE_HUD,
      fps: 0,
      time: 20,
    });
    return pixels;
  }

  // Небо покрыто задником целиком: поле звёзд выведено из окна неба этого мира,
  // а не назначено числом строк, и у верхней границы мира не обрывается.
  {
    const starColors = new Set(spec.starColors);
    /** Верхняя строка кадра, в которой есть звезда. -1 — звёзд нет вовсе. */
    function topStarRow(camX: number): number {
      const px = renderSky(camX, 0);
      for (let sy = 0; sy < BASE_VIEW_H; sy++) {
        for (let sx = 0; sx < BASE_VIEW_W; sx++) {
          const i = (sy * BASE_VIEW_W + sx) * 4;
          const c = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
          if (starColors.has(c)) return sy;
        }
      }
      return -1;
    }

    let worst = -1;
    for (const camX of [0, 400, 900, 1408]) {
      const row = topStarRow(camX);
      if (row < 0) {
        worst = BASE_VIEW_H;
        break;
      }
      if (row > worst) worst = row;
    }
    check(
      'Звёзды доходят до верха кадра при камере у верхней границы мира',
      worst >= 0 && worst <= 4,
      `самая верхняя звезда на строке ${worst}`,
    );
  }

  // Полоса млечного пути целиком внутри поля: заданная долями, она не уезжает
  // ни за верх неба, ни под линию поверхности.
  {
    const mw = spec.milkyWay!;
    check(
      'Полоса млечного пути лежит внутри окна неба',
      mw.centerY - mw.halfWidth >= 0 && mw.centerY + mw.halfWidth <= 1,
      `центр ${mw.centerY}, полуширина ${mw.halfWidth}`,
    );

    let glow = 0;
    const px = renderSky(500, 0);
    for (let i = 0; i < px.length; i += 4) {
      const c = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
      if (c === mw.glowColor) glow++;
    }
    check('Свечение полосы попадает в кадр', glow > 0, `пикселей свечения ${glow}`);
  }

  // Детерминированность. Проверяется по итоговому кадру, а не по внутренним
  // таблицам: так под проверку попадают и слои, и звёзды, и небесные тела разом.
  {
    const a = renderSky(500, 0);
    const b = renderSky(500, 0);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check('Задник детерминирован: одно зерно → один и тот же кадр', same);
  }

  // Сортировка списка точек. Это контракт, а не деталь: поиск видимого среза
  // бинарный, и на несортированном списке он молча потеряет часть звёзд.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    let sorted = true;
    for (let i = 1; i < bd.pointX.length; i++) {
      if (bd.pointX[i]! < bd.pointX[i - 1]!) sorted = false;
    }
    check(
      'Точки неба отсортированы по x',
      sorted && bd.pointX.length > 0,
      `точек ${bd.pointX.length}`,
    );

    // Бинарный поиск обязан находить ровно то же, что полный перебор.
    const from = 260;
    let expected = 0;
    for (let i = 0; i < bd.pointX.length; i++) {
      const x = bd.pointX[i]!;
      if (x >= from && x < from + BASE_VIEW_W) expected++;
    }
    check('Видимый срез непуст и находится поиском', expected > 100, `в срезе ${expected}`);
  }

  // Лестница значений: задник обязан оставаться темнее переднего плана.
  {
    const luma = (c: number): number =>
      0.3 * ((c >> 16) & 0xff) + 0.6 * ((c >> 8) & 0xff) + 0.1 * (c & 0xff);

    let darkestSolid = Infinity;
    for (const m of MATERIALS) {
      if (m.blocksPlayer) darkestSolid = Math.min(darkestSolid, luma(m.color));
    }

    const fills = spec.layers.map((l) => luma(l.fill));
    check(
      'Все заливки задника темнее самой тёмной твёрдой породы',
      fills.every((f) => f < darkestSolid),
      `слои ${fills.map((f) => f.toFixed(0)).join('/')} против ${darkestSolid.toFixed(0)}`,
    );
    check(
      'Заливки темнеют к зрителю — иначе глубина читается наоборот',
      fills.every((f, i) => i === 0 || f < fills[i - 1]!),
      fills.map((f) => f.toFixed(0)).join(' > '),
    );
    check(
      'Небо темнее любого слоя — силуэт обязан быть виден на фоне',
      fills.every((f) => f > luma(profile.skyColor)),
      `небо ${luma(profile.skyColor).toFixed(0)}`,
    );
  }

  // Бюджет акцентов. Акцент — всё, что в области неба не является ни небом,
  // ни заливкой слоя, ни свечением галактики: звёзды, Земля, кромки, спутник.
  {
    const camX = 260;
    const camY = 0;
    const px = renderSky(camX, camY);
    const background = new Set<number>([profile.skyColor, ...spec.layers.map((l) => l.fill)]);
    if (spec.milkyWay) background.add(spec.milkyWay.glowColor);

    let skyPixels = 0;
    let accents = 0;
    for (let sy = 0; sy < BASE_VIEW_H; sy++) {
      for (let sx = 0; sx < BASE_VIEW_W; sx++) {
        if (camY + sy >= first.surface[camX + sx]!) continue;
        skyPixels++;
        const i = (sy * BASE_VIEW_W + sx) * 4;
        const color = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
        if (!background.has(color)) accents++;
      }
    }
    const share = accents / skyPixels;
    check(
      'Акценты занимают не более 5% неба',
      share <= 0.05,
      `${(share * 100).toFixed(1)}% (${accents} из ${skyPixels})`,
    );
  }

  // Параллакс: слои обязаны расходиться по скорости, иначе глубины нет.
  // Без атмосферы выцветать по дистанции нечему, и это единственный сильный
  // признак дальности, который у задника остался.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const walk = 300;
    const sky = bd.layerOffset(-1, walk, 200).x;
    const offs = spec.layers.map((_, i) => bd.layerOffset(i, walk, 200).x);

    check(
      'Слои расходятся: ближний смещается сильнее дальнего',
      offs.every((o, i) => i === 0 || o > offs[i - 1]!),
      offs.join(' < '),
    );
    check(
      'Звёзды дальше любого слоя силуэтов',
      sky > 0 && sky < offs[0]!,
      `звёзды ${sky} < дальний слой ${offs[0]}`,
    );
    check(
      'Все слои медленнее мира',
      offs.every((o) => o < walk),
      `${offs.join('/')} < ${walk}`,
    );

    // Вертикальное смещение ограничено: иначе на краях хода камеры слои
    // отрываются от линии горизонта.
    const deep = bd.layerOffset(spec.layers.length - 1, 0, 4000).y;
    const atLimit = bd.layerOffset(spec.layers.length - 1, 0, BACKDROP.vertParallaxLimit).y;
    check('Вертикальное смещение слоёв ограничено', deep === atLimit, `${deep} = ${atLimit}`);
  }

  // Земля обязана помещаться в кадр на всём ходе камеры, а не в отдельных её
  // положениях. Её экранная колонка — это companion.x минус смещение параллакса,
  // то есть величина, привязанная к ширине кадра: при сужении кадра диск молча
  // уезжает за правый край и пропадает с неба совсем.
  if (spec.companion) {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const size = BACKDROP.companionSize;
    const maxCamX = first.world.width - BASE_VIEW_W;
    const maxCamY = first.world.height - BASE_VIEW_H;
    let worstLeft = Infinity;
    let worstRight = Infinity;
    let worstTop = Infinity;
    for (let camX = 0; camX <= maxCamX; camX++) {
      const off = bd.layerOffset(-1, camX, 0);
      const sx = spec.companion.x - off.x;
      if (sx < worstLeft) worstLeft = sx;
      if (BASE_VIEW_W - (sx + size) < worstRight) worstRight = BASE_VIEW_W - (sx + size);
    }
    for (let camY = 0; camY <= maxCamY; camY++) {
      const sy = spec.companion.y - bd.layerOffset(-1, 0, camY).y;
      if (sy < worstTop) worstTop = sy;
    }
    check(
      'Земля целиком в кадре на всём ходе камеры',
      worstLeft >= 0 && worstRight >= 0 && worstTop >= 0,
      `запас слева ${worstLeft}, справа ${worstRight}, сверху ${worstTop}`,
    );
  }

  // Стопка силуэтов обязана подниматься над линией горизонта переднего плана.
  // Гребень уезжает вместе с камерой лишь на свою долю параллакса, а горизонт —
  // на всю её величину, поэтому изменение высоты кадра топит слои под рельеф,
  // и задник исчезает целиком, не сломав при этом ни одной другой проверки.
  //
  // Проверяется верх стопки — гребень самого дальнего слоя. Ближний слой лежит
  // ровно на линии горизонта и выходит наружу только размахом формы: это не
  // дефект, а способ склеить задник с рельефом.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    let worstTop = Infinity;
    for (let x = 0; x < first.world.width; x += 37) {
      // Камера, центрированная на персонаже, который стоит на поверхности.
      const surf = first.surface[x]!;
      const camY = Math.max(0, Math.min(first.world.height - BASE_VIEW_H, surf - BASE_VIEW_H / 2));
      const horizon = surf - camY;
      const crest = spec.layers[0]!.crestY - bd.layerOffset(0, 0, camY).y;
      if (horizon - crest < worstTop) worstTop = horizon - crest;
    }
    check(
      'Гребень дальнего слоя выше линии горизонта',
      worstTop > 0,
      `худший просвет ${worstTop} px`,
    );
    // Порядок гребней на экране инвариантом НЕ является и проверке не подлежит:
    // смещение слоя равно camY·parallax, поэтому при углублении камеры ближний
    // слой поднимается быстрее дальнего и в конце концов его обгоняет. Порог —
    // camY ≈ 118 при нынешних числах (0.17·camY < 20) против camY ≈ 76 при
    // прежнем кадре 480×270. Свойство давнее, и при кадре 320×180 оно держится
    // дольше, а не хуже.
  }

  // Под землёй задник не выполняет работы на пиксель.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const camX = 460;
    const deep = 400; // глубоко под любой поверхностью
    check(
      'Под землёй проход задника не выполняется',
      bd.draw(
        new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4),
        camX,
        deep,
        0,
        bd.maxSurfaceInView(camX),
      ) === false,
    );
  }

  // Неподвижная камера — неподвижный кадр. Правило вакуума: мерцать нечему.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const size = BASE_VIEW_W * BASE_VIEW_H * 4;
    const a = new Uint8ClampedArray(size);
    const b = new Uint8ClampedArray(size);
    const max = bd.maxSurfaceInView(260);
    // Времена подобраны внутри паузы между проходами спутника.
    bd.draw(a, 260, 0, 20, max);
    bd.draw(b, 260, 0, 24, max);
    let same = true;
    for (let i = 0; same && i < size; i++) if (a[i] !== b[i]) same = false;
    check('Вакуум: при неподвижной камере кадры идентичны', same);
  }

  // Орбитальный объект — единственное, что движется само.
  {
    const bd = new Backdrop(profile, WORLD_SEED, first.surface);
    const o = spec.orbiter!;
    const max = bd.maxSurfaceInView(260);
    const positions: number[] = [];
    for (let k = 1; k <= 5; k++) {
      const px = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
      bd.draw(px, 260, 0, (o.crossSec * k) / 6, max);
      for (let i = 0; i < px.length; i += 4) {
        const color = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
        if (color === o.color) positions.push((i / 4) % BASE_VIEW_W);
      }
    }
    check(
      'Спутник пересекает кадр слева направо',
      positions.length === 5 && positions.every((x, i) => i === 0 || x > positions[i - 1]!),
      positions.join(' → '),
    );

    // В паузе объекта в кадре нет.
    const idle = new Uint8ClampedArray(BASE_VIEW_W * BASE_VIEW_H * 4);
    bd.draw(idle, 260, 0, o.crossSec + (o.periodSec - o.crossSec) / 2, max);
    let found = false;
    for (let i = 0; i < idle.length; i += 4) {
      if (((idle[i]! << 16) | (idle[i + 1]! << 8) | idle[i + 2]!) === o.color) found = true;
    }
    check('В паузе между проходами спутника в кадре нет', !found);
  }
}

// --- Цвет пещеры не спорит с заливками слоёв ---
//
// Пещера покрывает в кадре площадь, и слои задника тоже. Совпади их цвета,
// подсчёт площади слоя стал бы подсчётом площади пещеры, и все замеры выше
// потеряли бы смысл, продолжая проходить.
{
  const fills = LUNA.backdrop.layers.map((l) => l.fill);
  // Ступеней у пещеры несколько, и проверять надо КАЖДУЮ: проверка одной
  // базовой пропустила бы вторую молча — ровно тот случай, ради которого
  // ограничение и существует.
  const caveShades = [LUNA.caveColor, LUNA.caveDeepColor];
  const clashing = caveShades.filter((c) => fills.includes(c));
  check(
    'Ни одна ступень пещеры не совпадает с заливкой слоя задника',
    clashing.length === 0,
    clashing.length === 0
      ? `пещера ${caveShades.map((c) => c.toString(16)).join('/')}, слои ${fills.map((f) => f.toString(16)).join(', ')}`
      : `совпали ${clashing.map((c) => c.toString(16)).join(', ')}`,
  );
  check(
    'Цвет неба не совпадает ни с одной заливкой слоя задника',
    !fills.includes(LUNA.skyColor),
    `небо ${LUNA.skyColor.toString(16)}`,
  );
}
