import { CHUNK_SIZE, CONVEYOR } from '../config';
import { World } from './world';
import type { Rect } from '../geometry';
import { hashChance } from './rng';
import {
  MatterState,
  MAT_STATE,
  MAT_DENSITY,
  MAT_SPREAD,
  MAT_FLOW,
  MAT_SLIP,
  MAT_DISSIPATE,
  MAT_CARRY,
  MAT_FALLS,
  MAT_RISES,
  MAT,
} from './materials';
import { reactAround, MAT_REACTIVE } from './reactions';

/**
 * «Уровня нет»: свободной поверхности у ячейки не видно.
 *
 * Не то же самое, что нулевой напор. Ячейка под каменной крышкой не имеет
 * своей поверхности вообще — она либо получит уровень от соседей, либо
 * останется без него, и тогда считается зажатой: растекаться ей можно
 * без условий, а подниматься некуда.
 */
const NO_LEVEL = 0xffff;

/**
 * Клеточный автомат материалов.
 *
 * Правила выбираются по агрегатному состоянию, а не по материалу: вещество
 * с уже существующим поведением — запись в таблицу, а не правка этого файла.
 *
 * Инвариант: вариативность берётся из номера шага. Генератор случайных чисел
 * здесь недопустим — поведение мира стало бы невоспроизводимым.
 */
export class Simulation {
  private step = 0;
  private prevOccupant: Rect | null = null;
  /** Сколько ячеек обошёл последний шаг. Улёгшийся мир должен давать ноль. */
  lastCellsVisited = 0;

  /**
   * Сколько сыпучих ячеек фактически сдвинулось за последний шаг и суммы их
   * координат — для центра масс движения.
   *
   * Автомат этими числами не пользуется: они публикуются наружу, как и
   * `lastCellsVisited`. Читатель у них сейчас один — звук, — но знать о нём
   * симуляция не должна, поэтому это счётчики, а не вызовы.
   */
  lastPowderMoves = 0;
  lastPowderSumX = 0;
  lastPowderSumY = 0;

  /**
   * Карта уровня: строка свободной поверхности связанного тела жидкости.
   * Напор ячейки = `y - level`.
   *
   * Хранится координата, а не «давление» условной шкалы: её не надо ни
   * калибровать, ни нормировать, а инвариант «жидкость не поднимается выше
   * своего уровня» виден прямо в сравнении.
   *
   * Выделяется лениво: на Луне жидкостей нет, и мегабайты не нужны.
   */
  private level: Uint16Array | null = null;

  /**
   * Верх непрерывного столбца того же материала. В отличие от `level` не
   * размазывается по телу — это высота именно здесь.
   *
   * Без неё подъём неуправляем: `level` задаёт горстка капель на строку выше
   * поверхности, водоём подтягивается к ним, вещества не хватает, и чаша вечно
   * гоняет воду по кругу (замер: 31 перемещение вниз и 31 обратно каждый шаг).
   */
  private own: Uint16Array | null = null;

  /**
   * Один шаг симуляции.
   *
   * @param occupant область, занятая персонажем. СЫПУЧИЙ материал не
   *   перемещается в её ячейки: иначе он засыпает персонажа изнутри, его хитбокс
   *   оказывается внутри твёрдых ячеек, и движение отказывает по всем
   *   направлениям. Жидкостей и газов запрет не касается — сквозь них персонаж
   *   и так проваливается, а хитбокс шириной шесть ячеек перекрывал бы поток
   *   целиком и работал плотиной.
   */
  update(world: World, occupant: Rect | null): void {
    const { chunks } = world;

    this.lastPowderMoves = 0;
    this.lastPowderSumX = 0;
    this.lastPowderSumY = 0;

    this.wakeAroundMovedOccupant(world, occupant);

    // Смена поколений В НАЧАЛЕ шага, а не в конце. Записи, сделанные между
    // шагами — копание, генерация мира — попадают в «следующее» поколение;
    // если менять их местами в конце, такая запись оживала бы только через
    // кадр. Записи, сделанные ниже по ходу сметки, останутся на следующий шаг,
    // как и должно быть.
    chunks.advance();

    // Два прохода в противоположных направлениях — не расточительность,
    // а необходимость. Правило «обход снизу вверх» работает потому, что
    // сместившаяся ВНИЗ ячейка попадает в уже пройденную строку и не двигается
    // повторно. Для газа всё зеркально: при том же обходе он всплыл бы на всю
    // высоту за один шаг. Одним проходом оба направления корректно не покрыть.
    let visited = this.sweepDown(world, occupant);

    // Уровень и подъём — свой проход сверху вниз, по той же причине, что
    // и у газов. Идёт ПОСЛЕ падения: поднявшаяся ячейка оставляет под собой
    // пустоту, и следующий шаг начинается с того, что нижняя строка затягивает
    // её вбок — раньше, чем поднявшаяся получит шанс упасть обратно.
    if (world.liquidCells > 0) visited += this.pressurePass(world, occupant);

    // Пока газа в мире нет, второй проход не нужен вовсе. Замер показал, что
    // он вчетверо дороже одного прохода в худшем случае, а газ — редкость.
    if (world.gasCells > 0) visited += this.sweepUp(world, occupant);

    this.lastCellsVisited = visited;
    this.step++;
  }

  /** Проход снизу вверх: сыпучее и жидкости. */
  private sweepDown(world: World, occupant: Rect | null): number {
    const { chunks, width, height, cells } = world;
    let visited = 0;
    // Направление обхода строки чередуется по шагам.
    //
    // Ячейка, сместившаяся вбок ПО ходу обхода, попадает в ещё не пройденную
    // позицию и обрабатывается повторно — то есть уезжает дальше, чем на свою
    // растекаемость, а против хода обхода такого не происходит. Замер на
    // симметричном источнике показал перекос воды 93% в одну сторону, тогда
    // как у сыпучего и вязкого (растекаемость 0) перекоса не было вовсе.
    // Чередование делает артефакт знакопеременным, и он гасится сам.
    const rightward = (this.step & 1) === 0;

    for (let cy = chunks.rows - 1; cy >= 0; cy--) {
      const yStart = Math.min(height - 1, (cy + 1) * CHUNK_SIZE - 1);
      const yEnd = cy * CHUNK_SIZE;

      for (let y = yStart; y >= yEnd; y--) {
        const rowBase = y * width;
        // Куда на этой строке ячейка только что уехала по несущей поверхности.
        //
        // Перенос — единственное правило, смещающее ячейку в СВОЮ же строку,
        // в позицию, которую обход ещё не прошёл. Без отметки груз по ходу
        // обхода обрабатывался бы заново на каждой следующей позиции и за шаг
        // пролетал бы всю свободную длину ленты вместо одной ячейки.
        //
        // Одной позиции достаточно: смещение ровно на единицу, обход по x
        // монотонен, значит повторно попасться может только следующая.
        let carriedInto = -1;

        for (let ci = 0; ci < chunks.cols; ci++) {
          const cx = rightward ? ci : chunks.cols - 1 - ci;
          if (!chunks.isActive(cx, cy)) continue;

          const xStart = cx * CHUNK_SIZE;
          const xEnd = Math.min(width, xStart + CHUNK_SIZE);

          for (let xi = xStart; xi < xEnd; xi++) {
            const x = rightward ? xi : xEnd - 1 - (xi - xStart);
            visited++;
            if (x === carriedInto) continue;
            let m = cells[rowBase + x]!;

            // Соприкосновение возникает не только от движения. Вещество,
            // высыпанное из инвентаря или полученное выработкой, встаёт вплотную
            // к соседу, ни разу не сдвинувшись, — и если спрашивать только
            // перемещения, такая пара не реагирует НИКОГДА: двигаться ей некуда,
            // чанк засыпает, будить некому. Отсюда проверка здесь, на уже
            // обходимой ячейке: один просмотр массива на ячейку, и ни одного
            // в улёгшемся мире — там активных чанков нет вовсе.
            if (MAT_REACTIVE[m] === 1 && reactAround(world, x, y)) m = cells[rowBase + x]!;

            if (MAT_FALLS[m] !== 1) continue;

            if (MAT_STATE[m] === MatterState.Powder) {
              const to = this.movePowder(world, occupant, x, y, m);
              if (to >= 0) carriedInto = to;
            } else this.moveLiquid(world, occupant, x, y, m);
          }
        }
      }
    }

    return visited;
  }

  /** Проход сверху вниз: газы. */
  private sweepUp(world: World, occupant: Rect | null): number {
    const { chunks, width, height, cells } = world;
    let visited = 0;
    // См. sweepDown: газ растекается вбок по тем же правилам и требует того же
    // чередования, иначе облако сносит в одну сторону.
    const rightward = (this.step & 1) === 0;

    for (let cy = 0; cy < chunks.rows; cy++) {
      const yStart = cy * CHUNK_SIZE;
      const yEnd = Math.min(height, yStart + CHUNK_SIZE);

      for (let y = yStart; y < yEnd; y++) {
        const rowBase = y * width;

        for (let ci = 0; ci < chunks.cols; ci++) {
          const cx = rightward ? ci : chunks.cols - 1 - ci;
          if (!chunks.isActive(cx, cy)) continue;

          const xStart = cx * CHUNK_SIZE;
          const xEnd = Math.min(width, xStart + CHUNK_SIZE);

          for (let xi = xStart; xi < xEnd; xi++) {
            const x = rightward ? xi : xEnd - 1 - (xi - xStart);
            visited++;
            const m = cells[rowBase + x]!;
            if (MAT_RISES[m] !== 1) continue;
            this.moveGas(world, occupant, x, y, m);
          }
        }
      }
    }

    return visited;
  }

  /**
   * Уровень жидкости и подъём под напором. Проход сверху вниз.
   *
   * Три развёртки:
   *
   * - **A, сверху вниз** — собственная поверхность и перенос уровня вниз;
   * - **B, снизу вверх** — перенос уровня вверх;
   * - **C, сверху вниз** — собственно подъём.
   *
   * Каждая развёртка выравнивает строку минимумом влево и вправо. Развёртка B
   * обязательна: без неё порода перемычки разрывает строку, колено выше канала
   * становится отдельным телом с нулевым напором, и перепад на сообщающихся
   * сосудах остаётся 17 ячеек вместо одной.
   *
   * Подъём — отдельной развёрткой сверху вниз: строка выше уже пройдена,
   * поэтому за шаг ячейка поднимается не более чем на одну строку.
   */
  private pressurePass(world: World, occupant: Rect | null): number {
    const { chunks, width, height, cells } = world;
    if (!this.level || this.level.length !== cells.length) {
      this.level = new Uint16Array(cells.length);
      this.own = new Uint16Array(cells.length);
    }
    const level = this.level;
    const own = this.own!;
    let visited = 0;

    // A: сверху вниз. Здесь же считается поверхность столбца: вертикальная
    // рекуррента — это ровно она, до того как строка размажет минимум по телу.
    for (let cy = 0; cy < chunks.rows; cy++) {
      const yStart = cy * CHUNK_SIZE;
      const yEnd = Math.min(height, yStart + CHUNK_SIZE);

      for (let y = yStart; y < yEnd; y++) {
        const row = y * width;

        for (let ci = 0; ci < chunks.cols; ci++) {
          if (!chunks.isActive(ci, cy)) continue;
          // Строка выше принадлежит соседнему чанку — её уровень посчитан
          // только если тот чанк тоже активен. Иначе там лежат значения
          // с прошлых шагов, и читать их нельзя.
          const knowsAbove = y > yStart || (cy > 0 && chunks.isActive(ci, cy - 1));
          const xStart = ci * CHUNK_SIZE;
          const xEnd = Math.min(width, xStart + CHUNK_SIZE);

          for (let x = xStart; x < xEnd; x++) {
            const i = row + x;
            const m = cells[i]!;
            if (MAT_STATE[m] !== MatterState.Liquid) {
              own[i] = NO_LEVEL;
              level[i] = NO_LEVEL;
              continue;
            }
            const up = y > 0 ? cells[i - width]! : MAT.ROCK;
            if (up === m) own[i] = knowsAbove ? own[i - width]! : NO_LEVEL;
            else own[i] = up === MAT.VACUUM ? y : NO_LEVEL;
            level[i] = own[i]!;
          }
        }

        this.levelRow(world, level, row, cy);
      }
    }

    // B: снизу вверх
    for (let cy = chunks.rows - 1; cy >= 0; cy--) {
      const yStart = Math.min(height - 1, (cy + 1) * CHUNK_SIZE - 1);
      const yEnd = cy * CHUNK_SIZE;

      for (let y = yStart; y >= yEnd; y--) {
        const row = y * width;

        for (let ci = 0; ci < chunks.cols; ci++) {
          if (!chunks.isActive(ci, cy)) continue;
          const knowsBelow = y < yStart || (cy + 1 < chunks.rows && chunks.isActive(ci, cy + 1));
          if (!knowsBelow || y + 1 >= height) continue;
          const xStart = ci * CHUNK_SIZE;
          const xEnd = Math.min(width, xStart + CHUNK_SIZE);

          for (let x = xStart; x < xEnd; x++) {
            const i = row + x;
            const m = cells[i]!;
            if (MAT_STATE[m] !== MatterState.Liquid) continue;
            if (cells[i + width] !== m) continue;
            if (level[i + width]! < level[i]!) level[i] = level[i + width]!;
          }
        }

        this.levelRow(world, level, row, cy);
      }
    }

    // C: подъём
    const rightward = (this.step & 1) === 0;
    for (let cy = 0; cy < chunks.rows; cy++) {
      const yStart = cy * CHUNK_SIZE;
      const yEnd = Math.min(height, yStart + CHUNK_SIZE);

      for (let y = yStart; y < yEnd; y++) {
        const row = y * width;

        for (let ci = 0; ci < chunks.cols; ci++) {
          const cx = rightward ? ci : chunks.cols - 1 - ci;
          if (!chunks.isActive(cx, cy)) continue;

          const xStart = cx * CHUNK_SIZE;
          const xEnd = Math.min(width, xStart + CHUNK_SIZE);

          for (let xi = xStart; xi < xEnd; xi++) {
            const x = rightward ? xi : xEnd - 1 - (xi - xStart);
            visited++;
            const m = cells[row + x]!;
            if (MAT_STATE[m] !== MatterState.Liquid) continue;
            this.riseUnderHead(world, occupant, x, y, m);
          }
        }
      }
    }

    return visited;
  }

  /**
   * Минимум уровня по непрерывному участку одного материала в строке.
   *
   * Два прохода, влево и вправо: одного мало — участок должен получить минимум
   * независимо от того, с какой стороны тот лежит.
   *
   * Через неактивный чанк перенос обрывается: там лежит уровень с прошлых шагов.
   * Это допустимая неточность — уровень доедет на следующем шаге, когда сосед
   * проснётся от записи.
   */
  private levelRow(world: World, level: Uint16Array, row: number, cy: number): void {
    const { chunks, width, cells } = world;

    let prev = -1;
    for (let ci = 0; ci < chunks.cols; ci++) {
      if (!chunks.isActive(ci, cy)) {
        prev = -1;
        continue;
      }
      const xStart = ci * CHUNK_SIZE;
      const xEnd = Math.min(width, xStart + CHUNK_SIZE);
      for (let x = xStart; x < xEnd; x++) {
        const i = row + x;
        if (prev >= 0 && cells[prev] === cells[i] && level[prev]! < level[i]!) {
          level[i] = level[prev]!;
        }
        prev = i;
      }
    }

    prev = -1;
    for (let ci = chunks.cols - 1; ci >= 0; ci--) {
      if (!chunks.isActive(ci, cy)) {
        prev = -1;
        continue;
      }
      const xStart = ci * CHUNK_SIZE;
      const xEnd = Math.min(width, xStart + CHUNK_SIZE);
      for (let x = xEnd - 1; x >= xStart; x--) {
        const i = row + x;
        if (prev >= 0 && cells[prev] === cells[i] && level[prev]! < level[i]!) {
          level[i] = level[prev]!;
        }
        prev = i;
      }
    }
  }

  /**
   * Подъём одной ячейки под напором.
   *
   * Инвариант: порог ДВА, а не один. Единица тоже выравнивает, но водоём после
   * неё не засыпает никогда — разница в одну строку всё время находит, что
   * переложить. Замер после 3000 шагов: порог 1 — перепад 0, но 20480 ячеек
   * обойдено за пять шагов покоя; порог 2 — перепад 1, обойдено 0. Плата —
   * недоливка на строку, на пиксельной сетке невидимая.
   */
  private riseUnderHead(
    world: World,
    occupant: Rect | null,
    x: number,
    y: number,
    material: number,
  ): void {
    const i = y * world.width + x;
    // Напор считается от уровня ТЕЛА, а не от собственного столбца. Столбец
    // с открытой поверхностью ничего не знает о том, что в другом колене
    // жидкость стоит на двадцать строк выше, — а именно эта разница и должна
    // его поднимать. Замер на сообщающихся сосудах с напором от своего столбца:
    // правое колено вставало на первой же ровной поверхности, перепад 31.
    const src = this.level![i]!;
    if (src === NO_LEVEL || y - src < 2) return;

    // Поднимается только то, чему больше некуда деться: сначала все обычные
    // направления, и лишь если все закрыты — вверх.
    if (this.canEnter(world, occupant, material, x, y + 1)) return;
    const [first, second] = this.sidePreference(x, y);
    if (this.canEnter(world, occupant, material, x + first, y + 1)) return;
    if (this.canEnter(world, occupant, material, x + second, y + 1)) return;
    if (this.canEnter(world, occupant, material, x + first, y)) return;
    if (this.canEnter(world, occupant, material, x + second, y)) return;

    // Текучесть проверяется ПОСЛЕ всех отказов и до самого перемещения: только
    // здесь известно, что ячейке действительно есть куда подняться, и что чанк
    // придётся удержать активным, пока пропускается шаг.
    const gated = this.chance(x, y + 104729) >= MAT_FLOW[material]!;

    // Только по диагоналям, прямо вверх — никогда.
    //
    // Подъём внутри своего столба ничего не переносит: число ячеек в столбце
    // то же, поверхность та же, а под поднявшейся остаётся дырка, которая тут же
    // всплывает обратно. Получается вечный обмен на месте. Перенос происходит
    // только когда ячейка уходит в ДРУГОЙ столбец: тот прибавляет, этот убавляет
    // — именно так выравниваются сообщающиеся сосуды.
    //
    // Плата: жидкость не поднимается по вертикальной щели шириной в одну
    // ячейку. Напорные трубы моделью и не заявлены; шахта от двух ячеек
    // заполняется диагоналями как обычно.
    for (const dir of [first, second]) {
      if (!this.canRiseInto(world, occupant, x, y, dir, material, src)) continue;
      if (gated) {
        world.chunks.touch(x, y);
        return;
      }
      if (this.tryMove(world, occupant, x, y, x + dir, y - 1, material)) return;
    }
  }

  /**
   * Годится ли соседний столбец как цель подъёма.
   *
   * Мало того, что там пусто: поверхность ТОГО столбца должна отставать от
   * уровня тела хотя бы на две строки. Отставание в одну не считается —
   * перенос сделал бы соседа выше уровня, следующий шаг погнал бы ячейку
   * обратно, и водоём циркулировал бы вечно: вниз по диагоналям, вверх под
   * напором. Замер до этой проверки: улёгшаяся чаша делала 31 перемещение вниз
   * и ровно 31 обратно каждый шаг.
   *
   * Тот же порог два, что и у самого напора, и по той же причине: перенос
   * обязан уменьшать перепад, а не менять его знак.
   */
  private canRiseInto(
    world: World,
    occupant: Rect | null,
    x: number,
    y: number,
    dir: number,
    material: number,
    src: number,
  ): boolean {
    if (!this.canEnter(world, occupant, material, x + dir, y - 1)) return false;

    // Проверки «цель — не пузырь» здесь намеренно НЕТ, хотя напрашивается.
    // Замер на матрице правил: с ней сообщающиеся сосуды перестают
    // выравниваться совсем (перепад 16–19 вместо нуля) — колено заполняется
    // именно через пустоты, оставшиеся от предыдущих подъёмов. Циркуляцию
    // гасит порог по поверхности соседнего столбца ниже, а не запрет пузырей.
    const nx = x + dir;
    if (nx < 0 || nx >= world.width) return false;
    // Поверхность соседнего столбца: верх участка, на который ячейка ляжет.
    // Сухой столбец поверхности не имеет — считаем её на нашей строке, ниже
    // некуда, и такой перенос всегда полезен.
    const below = world.cells[y * world.width + nx]!;
    let dst = y;
    if (below === material) {
      const o = this.own![y * world.width + nx]!;
      if (o !== NO_LEVEL) dst = o;
    }

    return dst - src >= 2;
  }

  /**
   * Сыпучее: вниз, затем перенос несущей поверхностью, затем по диагонали
   * вниз-вбок.
   *
   * ```
   *   вниз?    ─── занято
   *   несёт подо мной?  ─── да → вбок по carry, и диагонали больше нет
   *   иначе диагональ вниз-вбок?
   * ```
   *
   * Инвариант: перенос ВЫТЕСНЯЕТ диагональ, а не дополняет — ни вместо неё,
   * ни после отказа. Иначе лента течёт: часть груза уходит по диагоналям
   * на пол, и очередь на ленте становится невозможна, а очередь и есть то,
   * чем лента отличается от жёлоба. Выше первого слоя груз лежит уже
   * не на ленте и подчиняется обычным правилам.
   *
   * @returns x, куда ячейка уехала по несущей поверхности, или −1
   */
  private movePowder(
    world: World,
    occupant: Rect | null,
    x: number,
    y: number,
    material: number,
  ): number {
    if (this.tryMove(world, occupant, x, y, x, y + 1, material)) return -1;

    // Читается ИЗ ЯЧЕЙКИ ПОД грузом: правило принадлежит грузу. Лента статична,
    // автомат её не обходит вовсе — спрашивай её, и пустая лента будила бы
    // чанки фактом существования.
    const carry = MAT_CARRY[world.get(x, y + 1)]!;
    if (carry !== 0) {
      // Пропущенный шаг ОБЯЗАН удержать чанк — но только когда ячейке есть
      // куда ехать. Иначе чанк засыпает в паузе между попытками, будить его
      // некому, и груз застывает навсегда. Обратное условие столь же важно:
      // без него вставшая гружёная лента не дала бы чанку уснуть.
      if (this.step % CONVEYOR.stepsPerCell !== 0) {
        if (this.canEnter(world, occupant, material, x + carry, y)) world.chunks.touch(x, y);
        return -1;
      }
      // Через тот же `tryMove`, что и падение: второе понятие проходимости
      // разошлось бы с первым на первом же спорном случае — лента под водой,
      // лента в пыли, лента в потоке.
      return this.tryMove(world, occupant, x, y, x + carry, y, material) ? x + carry : -1;
    }

    // Осыпаемость: насколько охотно вещество скатывается по склону. Единица —
    // всегда, и куча расплывается пологой; ниже — держит крутой склон.
    // Решение детерминировано, как и всё остальное в автомате.
    if (this.chance(x, y) >= MAT_SLIP[material]!) return -1;

    const [first, second] = this.sidePreference(x, y);
    if (this.tryMove(world, occupant, x, y, x + first, y + 1, material)) return -1;
    this.tryMove(world, occupant, x, y, x + second, y + 1, material);
    return -1;
  }

  /** Жидкость: вниз, диагонали вниз-вбок, затем вбок на дальность растекаемости. */
  private moveLiquid(
    world: World,
    occupant: Rect | null,
    x: number,
    y: number,
    material: number,
  ): void {
    // Текучесть: доля шагов, на которых материал вообще двигается. Вязкость
    // выражается здесь. Прежде она выражалась нулевой растекаемостью — и лава
    // получалась сыпучим материалом: силуэт её кучи совпадал с кучей реголита
    // ячейка в ячейку. Приём тот же, что у осыпаемости сыпучего, и такой же
    // детерминированный.
    if (this.chance(x, y + 31337) >= MAT_FLOW[material]!) {
      // Пропуская шаг, вязкая ячейка обязана удержать свой чанк активным —
      // но только если ей ЕСТЬ куда двигаться. Иначе чанк засыпает в паузе
      // между попытками, будить его некому, и лава застывает в воздухе
      // навсегда. Замер до этой проверки: капля лавы висела на y=23 одинаково
      // и через 2000 шагов, и через 40000.
      if (this.canFlow(world, occupant, x, y, material)) world.chunks.touch(x, y);
      return;
    }

    if (this.tryMove(world, occupant, x, y, x, y + 1, material)) return;

    const [first, second] = this.sidePreference(x, y);
    if (this.tryMove(world, occupant, x, y, x + first, y + 1, material)) return;
    if (this.tryMove(world, occupant, x, y, x + second, y + 1, material)) return;

    // Боковое растекание разносит жидкость по площади. Идём по одной ячейке
    // и останавливаемся у первого препятствия: перепрыгивать стену жидкость
    // не должна, даже если за ней свободно.
    const reach = MAT_SPREAD[material]!;
    if (reach === 0) return;

    const atSurface = this.atFreeSurface(world, x, y);

    for (const dir of [first, second]) {
      let cx = x;
      let moved = false;
      for (let i = 0; i < reach; i++) {
        if (atSurface && !this.canEnter(world, occupant, material, cx + dir, y + 1)) break;
        if (this.isBubble(world, cx + dir, y, material)) break;
        if (!this.tryMove(world, occupant, cx, y, cx + dir, y, material)) break;
        cx += dir;
        moved = true;
        // Растекание — единственное место, где одна ячейка двигается несколько
        // раз за шаг, и единственное, которому реакция может выбить почву
        // из-под ног: переехавшая ячейка уже могла стать продуктом. Продолжать
        // цепочку нельзя — `tryMove` пишет `material` в цель, НЕ читая источник,
        // и следующий шаг цепочки создал бы жидкость из ничего, стерев продукт.
        if (world.get(cx, y) !== material) break;
      }
      if (moved) return;
    }
  }

  /**
   * Пузырь ли пустота в ячейке — то есть накрыта ли она тем же веществом.
   *
   * Заходить вбок в такую пустоту нельзя. Пузырь обязан всплывать, а не бегать
   * вбок: жидкость сверху сама провалится в него на следующем шаге, и он
   * поднимется на строку. Боковой заход вместо этого уносит пузырь на всю
   * растекаемость, а на следующем шаге — обратно, потому что направление обхода
   * чередуется. Замер до этой проверки: улёгшийся водоём вечно перекладывал
   * 24 ячейки за шаг ровно двухтактным циклом.
   */
  private isBubble(world: World, x: number, y: number, material: number): boolean {
    if (x < 0 || y <= 0 || x >= world.width) return false;
    const i = y * world.width + x;
    return world.cells[i] === MAT.VACUUM && world.cells[i - world.width] === material;
  }

  /**
   * Лежит ли ячейка на самом верху тела — там, где напора уже нет.
   *
   * Верх — это ровно строка уровня, ни строкой ниже. Ячейка глубже уже под
   * напором: её есть чему выдавливать вбок, и растекание идёт без условий.
   * Ячейка на самом верху ходит вбок, только если с новой позиции сможет сойти
   * вниз, — иначе неполный верхний ряд лужи перекладывается туда-сюда вечно.
   *
   * Проверять «над ячейкой пустота» вместо уровня нельзя: у подошвы
   * растекающейся кучи над крайней ячейкой тоже пустота, а выдавливать её
   * обязано — иначе жидкость застывает конусом под 45°, как песок. Замер той
   * версии: вода складывалась в кучу 32×8 со склоном 0.50 против 27×10 и 0.74
   * у реголита.
   */
  private atFreeSurface(world: World, x: number, y: number): boolean {
    const lv = this.level ? this.level[y * world.width + x]! : NO_LEVEL;
    return lv !== NO_LEVEL && y <= lv;
  }

  /**
   * Есть ли жидкости куда двигаться. Только проверка, без перемещения.
   *
   * Нужна ровно одному месту — пропуску шага по текучести: чанк можно отпустить
   * спать, если вязкой ячейке всё равно некуда идти, и нельзя, если есть.
   */
  private canFlow(
    world: World,
    occupant: Rect | null,
    x: number,
    y: number,
    material: number,
  ): boolean {
    if (this.canEnter(world, occupant, material, x, y + 1)) return true;

    const [first, second] = this.sidePreference(x, y);
    if (this.canEnter(world, occupant, material, x + first, y + 1)) return true;
    if (this.canEnter(world, occupant, material, x + second, y + 1)) return true;

    if (MAT_SPREAD[material] === 0) return false;
    const atSurface = this.atFreeSurface(world, x, y);

    for (const dir of [first, second]) {
      if (!this.canEnter(world, occupant, material, x + dir, y)) continue;
      if (atSurface && !this.canEnter(world, occupant, material, x + dir, y + 1)) continue;
      return true;
    }
    return false;
  }

  /** Газ: зеркало жидкости — вверх, верхние диагонали, вбок. Плюс рассеивание. */
  private moveGas(
    world: World,
    occupant: Rect | null,
    x: number,
    y: number,
    material: number,
  ): void {
    // Единственное правило модели, уничтожающее вещество. Без него газ,
    // дойдя до потолка, остаётся там навсегда: двигаться ему больше некуда.
    if (this.chance(x, y + 7919) < MAT_DISSIPATE[material]!) {
      world.set(x, y, MAT.VACUUM);
      return;
    }

    if (this.tryMove(world, occupant, x, y, x, y - 1, material)) return;

    const [first, second] = this.sidePreference(x, y);
    if (this.tryMove(world, occupant, x, y, x + first, y - 1, material)) return;
    if (this.tryMove(world, occupant, x, y, x + second, y - 1, material)) return;

    const reach = MAT_SPREAD[material]!;
    if (reach === 0) return;

    for (const dir of [first, second]) {
      let cx = x;
      let moved = false;
      for (let i = 0; i < reach; i++) {
        if (!this.tryMove(world, occupant, cx, y, cx + dir, y, material)) break;
        cx += dir;
        moved = true;
      }
      if (moved) return;
    }
  }

  /**
   * Предпочитаемая сторона и запасная.
   *
   * Чётность (x + y + номер шага) — детерминированно и без систематического
   * сноса, из-за которого кучи росли бы скошенными, а лужи уползали в одну
   * сторону.
   */
  private sidePreference(x: number, y: number): [number, number] {
    return ((x + y + this.step) & 1) === 1 ? [1, -1] : [-1, 1];
  }

  /** Детерминированное «случайное» число в [0,1) от координат и номера шага. */
  private chance(x: number, y: number): number {
    return hashChance(x, y, this.step);
  }

  private tryMove(
    world: World,
    occupant: Rect | null,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    material: number,
  ): boolean {
    if (!this.canEnter(world, occupant, material, toX, toY)) return false;

    // Обмен, а не затирание: иначе песок, падая в воду, уничтожал бы её,
    // и воду можно было бы вычерпать простым засыпанием. Сохранение вещества —
    // базовое свойство, на которое обопрутся производственные цепочки.
    const displaced = world.get(toX, toY);
    world.set(toX, toY, material);
    world.set(fromX, fromY, displaced);

    // Учёт движения сыпучего: два сложения на успешный сдвиг. Решений автомата
    // не касается — счётчики читаются снаружи и на следующий шаг обнуляются.
    if (MAT_STATE[material] === MatterState.Powder) {
      this.lastPowderMoves++;
      this.lastPowderSumX += toX;
      this.lastPowderSumY += toY;
    }

    // Вторая половина одного правила «спрашивать там, где вещество прибыло»
    // (первая — в `sweepDown`). Здесь она нужна ради СРОКА: соприкосновение,
    // возникшее посреди шага, обязано сработать на этом же шаге. Обход поймал бы
    // его только на следующем — ячейка уезжает в уже пройденную строку.
    //
    // Проверяются ОБА конца перемещения. Ячейка приехала в новое окружение,
    // но и вытесненная встала на её место — и там у неё свои соседи, которых
    // у первой не было. Проверка только цели пропускала бы половину контактов.
    //
    // Улёгшийся мир перемещений не делает, значит, и проверок не делает:
    // бесплатность покоя реакция не трогает.
    reactAround(world, toX, toY);
    reactAround(world, fromX, fromY);

    return true;
  }

  /**
   * Может ли вещество занять ячейку.
   *
   * Читает состояние и плотность, но НЕ «блокирует персонажа»: это разные
   * вопросы. Сквозь воду персонаж проваливается, а песок в ней тонет.
   */
  private canEnter(
    world: World,
    occupant: Rect | null,
    material: number,
    x: number,
    y: number,
  ): boolean {
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) return false;

    const target = world.cells[y * world.width + x]!;

    // Статичность сильнее плотности. Иначе достаточно задать веществу плотность
    // выше породы, и оно начнёт просачиваться сквозь мир.
    if (MAT_STATE[target] === MatterState.Solid) return false;

    // Персонаж — препятствие только для СЫПУЧЕГО. Для жидкости и газа запрет
    // бессмыслен и вреден: сквозь них персонаж проваливается, а хитбокс
    // шириной шесть ячеек перекрывает поток целиком и работает плотиной.
    // Замер: тот же поток без персонажа расходится 163/117 по сторонам,
    // с персонажем — 280/0.
    if (occupant && MAT_STATE[material] === MatterState.Powder) {
      const inside =
        x >= occupant.x &&
        x < occupant.x + occupant.w &&
        y >= occupant.y &&
        y < occupant.y + occupant.h;
      if (inside) return false;
    }

    if (target === MAT.VACUUM) return true;

    // Падающее входит в менее плотное, всплывающее — в более плотное.
    return MAT_RISES[material] === 1
      ? MAT_DENSITY[target]! > MAT_DENSITY[material]!
      : MAT_DENSITY[target]! < MAT_DENSITY[material]!;
  }

  /**
   * Будит область вокруг персонажа, когда тот сдвинулся.
   *
   * Персонаж не лежит в сетке, поэтому его перемещение не проходит через
   * `world.set` и само по себе ничего не будит. Без этого материал, который он
   * удерживал на себе, остаётся висеть в воздухе после его ухода: чанки давно
   * уснули, и разбудить их некому.
   *
   * Будим только при фактическом смещении — стоящий на месте персонаж не должен
   * держать свои чанки активными вечно, иначе улёгшийся мир перестанет быть
   * бесплатным.
   */
  private wakeAroundMovedOccupant(world: World, occupant: Rect | null): void {
    const prev = this.prevOccupant;
    const same =
      prev !== null &&
      occupant !== null &&
      prev.x === occupant.x &&
      prev.y === occupant.y &&
      prev.w === occupant.w &&
      prev.h === occupant.h;
    if (same) return;

    // Будим и покинутую область, и новую: в первую материалу теперь можно
    // падать, во второй он должен остановиться.
    if (prev) this.touchRect(world, prev);
    if (occupant) this.touchRect(world, occupant);

    this.prevOccupant = occupant
      ? { x: occupant.x, y: occupant.y, w: occupant.w, h: occupant.h }
      : null;
  }

  /** Хитбокс мельче чанка, поэтому углов достаточно — touch расширяет на ±1. */
  private touchRect(world: World, r: Rect): void {
    world.chunks.touch(r.x, r.y);
    world.chunks.touch(r.x + r.w - 1, r.y);
    world.chunks.touch(r.x, r.y + r.h - 1);
    world.chunks.touch(r.x + r.w - 1, r.y + r.h - 1);
  }
}
