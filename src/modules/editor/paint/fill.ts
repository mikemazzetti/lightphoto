/** Flood fill / colour-distance masks (Magic Wand, Paint Bucket, Color Range). */

/** Photoshop-like tolerance test: every channel within `tol` of the seed (alpha included). */
function within(d: Uint8ClampedArray | Uint8Array, i: number, r: number, g: number, b: number, a: number, tol: number) {
  // Fully transparent pixels match each other regardless of colour.
  if (a === 0 && d[i + 3] === 0) return true;
  return Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - g) <= tol && Math.abs(d[i + 2] - b) <= tol && Math.abs(d[i + 3] - a) <= tol;
}

/**
 * Returns a w×h mask (255 = filled) of pixels matching the seed colour. Contiguous mode uses a
 * scanline flood fill; global mode tests every pixel.
 */
export function floodMask(data: Uint8ClampedArray | Uint8Array, w: number, h: number, sx: number, sy: number, tolerance: number, contiguous: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
  const si = (sy * w + sx) * 4;
  const r = data[si];
  const g = data[si + 1];
  const b = data[si + 2];
  const a = data[si + 3];
  const tol = tolerance;
  if (!contiguous) {
    for (let p = 0, i = 0; p < out.length; p++, i += 4) if (within(data, i, r, g, b, a, tol)) out[p] = 255;
    return out;
  }
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let p = y * w + x;
    // move left
    while (x >= 0 && !out[p] && within(data, p * 4, r, g, b, a, tol)) {
      x--;
      p--;
    }
    x++;
    p++;
    let upOpen = false;
    let downOpen = false;
    while (x < w && !out[p] && within(data, p * 4, r, g, b, a, tol)) {
      out[p] = 255;
      if (y > 0) {
        const q = p - w;
        const ok = !out[q] && within(data, q * 4, r, g, b, a, tol);
        if (ok && !upOpen) {
          stack.push(x, y - 1);
          upOpen = true;
        } else if (!ok) upOpen = false;
      }
      if (y < h - 1) {
        const q = p + w;
        const ok = !out[q] && within(data, q * 4, r, g, b, a, tol);
        if (ok && !downOpen) {
          stack.push(x, y + 1);
          downOpen = true;
        } else if (!ok) downOpen = false;
      }
      x++;
      p++;
    }
  }
  return out;
}

/** Softens a binary mask's edge by one pixel (anti-aliased wand / bucket). */
export function antialiasMask(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(m);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = m[i];
      const n = m[i - 1] + m[i + 1] + m[i - w] + m[i + w];
      if ((v === 255 && n < 1020) || (v === 0 && n > 0)) {
        const s = v * 4 + n + m[i - w - 1] + m[i - w + 1] + m[i + w - 1] + m[i + w + 1];
        out[i] = Math.round(s / 12);
      }
    }
  }
  return out;
}

/** Colour Range: soft mask of pixels near any of the sampled colours. fuzziness 0..200. */
export function colorRangeMask(data: Uint8ClampedArray | Uint8Array, w: number, h: number, samples: [number, number, number][], fuzziness: number, invert = false): Uint8Array {
  const out = new Uint8Array(w * h);
  const f = Math.max(1, fuzziness);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    let best = Infinity;
    for (const [r, g, b] of samples) {
      const dr = data[i] - r;
      const dg = data[i + 1] - g;
      const db = data[i + 2] - b;
      const d = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
      if (d < best) best = d;
    }
    let v = best <= f * 0.5 ? 1 : Math.max(0, 1 - (best - f * 0.5) / (f * 0.5));
    v *= data[i + 3] / 255;
    out[p] = Math.round((invert ? 1 - v : v) * 255);
  }
  return out;
}
