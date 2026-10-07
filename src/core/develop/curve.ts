import type { CurvePoint, ToneCurve } from './settings';

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through sorted control points.
 * Returns an evaluator clamped to 0..1. Used for tone curves, Curves adjustment layers and
 * the curve editor UI.
 */
export function makeCurve(points: CurvePoint[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return clamp01(ys[0]);
    if (x >= xs[n - 1]) return clamp01(ys[n - 1]);
    let i = 0;
    let hi = n - 1;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else i = mid;
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    return clamp01(y);
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const LUT_SIZE = 1024;

/**
 * Bakes a ToneCurve into an RGBA float LUT (LUT_SIZE entries). The master RGB curve is
 * composed into each channel: out.r = r(rgb(x)), etc. Alpha holds the master curve alone.
 */
export function bakeToneCurve(curve: ToneCurve, size = LUT_SIZE): Float32Array {
  const fm = makeCurve(curve.rgb);
  const fr = makeCurve(curve.r);
  const fg = makeCurve(curve.g);
  const fb = makeCurve(curve.b);
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    const m = fm(x);
    out[i * 4] = fr(m);
    out[i * 4 + 1] = fg(m);
    out[i * 4 + 2] = fb(m);
    out[i * 4 + 3] = m;
  }
  return out;
}

/** Converts a float LUT to half floats for an RGBA16F texture upload. */
export function toHalf(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i];
    const x = u32[0];
    const sign = (x >> 16) & 0x8000;
    let exp = ((x >> 23) & 0xff) - 127 + 15;
    let mant = (x >> 13) & 0x3ff;
    if (exp <= 0) {
      mant = exp < -10 ? 0 : ((x & 0x7fffff) | 0x800000) >> (14 - exp);
      exp = 0;
    } else if (exp >= 31) {
      exp = 31;
      mant = 0;
    }
    out[i] = sign | (exp << 10) | mant;
  }
  return out;
}
