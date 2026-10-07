import { ctx2d, makeCanvas } from '../model/surface';

/** Brush tip images (cached). Soft tips use a smoothstep fall-off like Photoshop's round brushes. */

const cache = new Map<string, OffscreenCanvas>();

function key(d: number, hardness: number, rgb: string, pencil: boolean) {
  return `${d}|${hardness}|${rgb}|${pencil ? 1 : 0}`;
}

/** Alpha fall-off for a normalised radius t (0 centre … 1 edge). */
export function falloff(t: number, hardness: number): number {
  if (t >= 1) return 0;
  const h = Math.min(0.999, hardness);
  if (t <= h) return 1;
  const u = (t - h) / (1 - h);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * A round tip of diameter `d` px. Antialiased for brushes, aliased (exact pixel coverage) for the
 * pencil. Colour baked in so stamping is a single drawImage.
 */
export function getDab(d: number, hardness: number, color: { r: number; g: number; b: number }, pencil = false): OffscreenCanvas {
  const D = pencil ? Math.max(1, Math.round(d)) : Math.max(1, Math.ceil(d) + 2);
  const rgb = `${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)}`;
  const h = pencil ? 1 : Math.round(hardness * 100) / 100;
  const k = key(D, h, rgb, pencil);
  let c = cache.get(k);
  if (c) return c;
  c = makeCanvas(D, D);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(D, D);
  const data = img.data;
  const r = pencil ? D / 2 : d / 2;
  const cx = D / 2;
  // Edge antialias width for hard brushes: ~1px.
  const hard = pencil ? 1 : Math.min(h, Math.max(0, 1 - 1.2 / Math.max(r, 0.5)));
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cx;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let a: number;
      if (pencil) a = D <= 2 ? 1 : dist <= r ? 1 : 0;
      else {
        // supersample the rim a little for small tips
        a = falloff(dist / r, hard);
        if (r < 4) {
          let acc = 0;
          for (let sy = 0; sy < 3; sy++)
            for (let sx = 0; sx < 3; sx++) {
              const ex = x + (sx + 0.5) / 3 - cx;
              const ey = y + (sy + 0.5) / 3 - cx;
              acc += falloff(Math.sqrt(ex * ex + ey * ey) / r, hard);
            }
          a = acc / 9;
        }
      }
      const i = (y * D + x) * 4;
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(k, c);
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return c;
}

/** Brush cursor outline radius for a tip (what Photoshop shows: where the tip reaches ~50%). */
export function cursorRadius(size: number, hardness: number) {
  return Math.max(0.5, (size / 2) * (hardness >= 0.99 ? 1 : 0.5 + hardness * 0.5));
}
