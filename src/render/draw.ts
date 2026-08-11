/**
 * Примитивы поверх буфера МИРА.
 *
 * Принимают массив пикселей с шириной и высотой, а не `Display`: буфер — это
 * обычный `Uint8ClampedArray`, и всё, что нарисовано этими примитивами,
 * проверяется в Node без канваса.
 *
 * Альфы нет. Буфер непрозрачный и хранит только RGB, любая запись — замена
 * цвета, а не смешивание. Полупрозрачность живёт в слое интерфейса
 * (`render/ui/`), и сюда она не заходит.
 *
 * Отсечение по границам буфера делает каждый примитив сам: вызывающий считает
 * раскладку от размера кадра, который меняется вместе с окном, и проверять
 * попадание на каждой стороне ему негде.
 */

export function setPixel(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  color: number,
): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  px[i] = (color >> 16) & 0xff;
  px[i + 1] = (color >> 8) & 0xff;
  px[i + 2] = color & 0xff;
}

export function fillRect(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  rw: number,
  rh: number,
  color: number,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(w, x + rw);
  const y1 = Math.min(h, y + rh);
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  for (let py = y0; py < y1; py++) {
    let i = (py * w + x0) * 4;
    for (let pxi = x0; pxi < x1; pxi++, i += 4) {
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    }
  }
}

/** Рамка ВНУТРИ прямоугольника: рамка и заливка того же прямоугольника совпадают по краю. */
export function strokeRect(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  rw: number,
  rh: number,
  color: number,
): void {
  if (rw <= 0 || rh <= 0) return;
  for (let i = 0; i < rw; i++) {
    setPixel(px, w, h, x + i, y, color);
    setPixel(px, w, h, x + i, y + rh - 1, color);
  }
  for (let i = 1; i < rh - 1; i++) {
    setPixel(px, w, h, x, y + i, color);
    setPixel(px, w, h, x + rw - 1, y + i, color);
  }
}

/**
 * Спрайт по индексам палитры. Индекс 0 прозрачен всегда — это соглашение
 * формата, а не свойство конкретной картинки.
 */
export function blit(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  sprite: Uint8Array,
  sw: number,
  sh: number,
  x: number,
  y: number,
  palette: readonly number[],
  flip = false,
): void {
  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      const index = sprite[sy * sw + (flip ? sw - 1 - sx : sx)]!;
      if (index === 0) continue;
      setPixel(px, w, h, x + sx, y + sy, palette[index]!);
    }
  }
}

/** Разбор картинки, набранной строками индексов палитры. `.` — прозрачно. */
export function parseSprite(rows: readonly string[], w: number): Uint8Array {
  const data = new Uint8Array(w * rows.length);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      data[y * w + x] = ch === undefined || ch === '.' ? 0 : Number(ch);
    }
  }
  return data;
}
