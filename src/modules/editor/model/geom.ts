/** Integer-friendly rectangles and 2D affine matrices used across the editor. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export function rectEmpty(r: Rect | null | undefined): boolean {
  return !r || r.w <= 0 || r.h <= 0;
}

export function rectUnion(a: Rect | null | undefined, b: Rect | null | undefined): Rect | null {
  if (rectEmpty(a)) return rectEmpty(b) ? null : { ...b! };
  if (rectEmpty(b)) return { ...a! };
  const x0 = Math.min(a!.x, b!.x);
  const y0 = Math.min(a!.y, b!.y);
  const x1 = Math.max(a!.x + a!.w, b!.x + b!.w);
  const y1 = Math.max(a!.y + a!.h, b!.y + b!.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectIntersect(a: Rect | null | undefined, b: Rect | null | undefined): Rect | null {
  if (rectEmpty(a) || rectEmpty(b)) return null;
  const x0 = Math.max(a!.x, b!.x);
  const y0 = Math.max(a!.y, b!.y);
  const x1 = Math.min(a!.x + a!.w, b!.x + b!.w);
  const y1 = Math.min(a!.y + a!.h, b!.y + b!.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Expands to integer pixel bounds. */
export function rectRoundOut(r: Rect): Rect {
  const x0 = Math.floor(r.x);
  const y0 = Math.floor(r.y);
  const x1 = Math.ceil(r.x + r.w);
  const y1 = Math.ceil(r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const rectInflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
export const rectTranslate = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
export const rectEq = (a: Rect | null, b: Rect | null) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
export const rectContains = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** Normalised rect from two corner points. */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

// ---------------------------------------------------------------------------------------------
// Affine 2D matrices in canvas order [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f

export type Mat2D = [number, number, number, number, number, number];

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

export function matMul(m: Mat2D, n: Mat2D): Mat2D {
  // m ∘ n (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function matInvert(m: Mat2D): Mat2D {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const matApply = (m: Mat2D, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const matTranslate = (x: number, y: number): Mat2D => [1, 0, 0, 1, x, y];
export const matScale = (sx: number, sy: number): Mat2D => [sx, 0, 0, sy, 0, 0];
export function matRotate(rad: number): Mat2D {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}
export const matIsIdentity = (m: Mat2D | null | undefined) => !m || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);
export const matIsTranslation = (m: Mat2D) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;

/** Bounding box of a rect transformed by m. */
export function matBounds(m: Mat2D, r: Rect): Rect {
  const pts = [matApply(m, r.x, r.y), matApply(m, r.x + r.w, r.y), matApply(m, r.x, r.y + r.h), matApply(m, r.x + r.w, r.y + r.h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** GLSL mat3 (column-major) from an affine Mat2D. */
export function matToGL(m: Mat2D): Float32Array {
  return new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const dist = (x0: number, y0: number, x1: number, y1: number) => Math.hypot(x1 - x0, y1 - y0);
