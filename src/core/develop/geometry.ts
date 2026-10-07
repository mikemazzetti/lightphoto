import type { Crop, DevelopSettings } from './settings';

/**
 * Crop / straighten / orientation maths. Everything is an affine map, so the whole geometry
 * stage is a single mat3 in the shader.
 *
 * Coordinate spaces (all normalised 0..1, y down):
 *  - source: the decoded image as stored.
 *  - oriented: after 90° rotation(s) and flips.
 *  - output: the final cropped frame.
 */

/** Row-major 3x3 affine: [a, b, c, d, e, f, 0, 0, 1] → x' = a x + b y + c, y' = d x + e y + f. */
export type Mat3 = number[];

export const ident = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}
export const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];
export const scale = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1];
export const rotate = (rad: number): Mat3 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f), 0, 0, 1];
}
export const apply = (m: Mat3, x: number, y: number): [number, number] => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
/** Column-major Float32Array for gl.uniformMatrix3fv(…, false, …). */
export const toGL = (m: Mat3) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

export function orientedSize(w: number, h: number, orientation: number): [number, number] {
  return orientation === 90 || orientation === 270 ? [h, w] : [w, h];
}

/** Full-resolution size of the developed output (after orientation + crop). */
export function outputSize(srcW: number, srcH: number, s: Pick<DevelopSettings, 'orientation' | 'crop'>): [number, number] {
  const [ow, oh] = orientedSize(srcW, srcH, s.orientation);
  return [Math.max(1, Math.round(ow * s.crop.w)), Math.max(1, Math.round(oh * s.crop.h))];
}

/** Maps oriented-normalised coords → source-normalised coords (orientation + flips). */
export function orientedToSource(s: Pick<DevelopSettings, 'orientation' | 'flipH' | 'flipV'>): Mat3 {
  let m = ident();
  // Inverse orientation (clockwise rotation by `orientation` degrees).
  if (s.orientation === 90) m = [0, 1, 0, -1, 0, 1, 0, 0, 1];
  else if (s.orientation === 180) m = [-1, 0, 1, 0, -1, 1, 0, 0, 1];
  else if (s.orientation === 270) m = [0, -1, 1, 1, 0, 0, 0, 0, 1];
  let f = ident();
  if (s.flipH) f = mul([-1, 0, 1, 0, 1, 0, 0, 0, 1], f);
  if (s.flipV) f = mul([1, 0, 0, 0, -1, 1, 0, 0, 1], f);
  return mul(m, f);
}

/** Maps output-normalised (cropped) coords → oriented-normalised coords, undoing straighten. */
export function outputToOriented(srcW: number, srcH: number, s: Pick<DevelopSettings, 'orientation' | 'angle' | 'crop'>): Mat3 {
  const [W, H] = orientedSize(srcW, srcH, s.orientation);
  const c = s.crop;
  const cropM: Mat3 = [c.w, 0, c.x, 0, c.h, c.y, 0, 0, 1];
  const rot = mul(scale(1 / W, 1 / H), mul(translate(W / 2, H / 2), mul(rotate((-s.angle * Math.PI) / 180), mul(translate(-W / 2, -H / 2), scale(W, H)))));
  return mul(rot, cropM);
}

/** Output uv → source uv. Upload with toGL() as the `uGeom` uniform. */
export function outputToSource(srcW: number, srcH: number, s: DevelopSettings): Mat3 {
  return mul(orientedToSource(s), outputToOriented(srcW, srcH, s));
}

export const sourceToOutput = (srcW: number, srcH: number, s: DevelopSettings) => invert(outputToSource(srcW, srcH, s));

/** Oriented frame (un-cropped, straightened) uv → source uv; used by the crop tool overlay. */
export function straightenedToSource(srcW: number, srcH: number, s: DevelopSettings): Mat3 {
  return outputToSource(srcW, srcH, { ...s, crop: { x: 0, y: 0, w: 1, h: 1 } });
}

function cropValid(crop: Crop, angle: number, W: number, H: number): boolean {
  const m = outputToOriented(W, H, { orientation: 0, angle, crop });
  const eps = 1e-4;
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const [u, v] = apply(m, x, y);
    if (u < -eps || u > 1 + eps || v < -eps || v > 1 + eps) return false;
  }
  return true;
}

/**
 * Shrinks a crop (about its centre, keeping aspect) so none of its corners fall outside the
 * rotated image — Lightroom's "Constrain to image" behaviour. W/H are oriented pixel sizes.
 */
export function constrainCrop(crop: Crop, angle: number, W: number, H: number): Crop {
  const cx = Math.min(1, Math.max(0, crop.x + crop.w / 2));
  const cy = Math.min(1, Math.max(0, crop.y + crop.h / 2));
  const at = (k: number): Crop => ({ x: cx - (crop.w * k) / 2, y: cy - (crop.h * k) / 2, w: crop.w * k, h: crop.h * k });
  if (cropValid(at(1), angle, W, H)) return at(1);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (cropValid(at(mid), angle, W, H)) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

/** Largest crop of a given pixel aspect ratio (w/h) centred in the rotated image. */
export function maxCrop(aspect: number | null, angle: number, W: number, H: number): Crop {
  let w = 1;
  let h = 1;
  if (aspect) {
    const imgAspect = W / H;
    if (aspect > imgAspect) h = imgAspect / aspect;
    else w = aspect / imgAspect;
  }
  return constrainCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h }, angle, W, H);
}

export const ASPECT_PRESETS: { label: string; value: number | null }[] = [
  { label: 'Original', value: -1 },
  { label: 'Free', value: null },
  { label: '1 × 1', value: 1 },
  { label: '4 × 5', value: 4 / 5 },
  { label: '5 × 7', value: 5 / 7 },
  { label: '2 × 3', value: 2 / 3 },
  { label: '3 × 4', value: 3 / 4 },
  { label: '16 × 9', value: 16 / 9 },
  { label: '9 × 16', value: 9 / 16 },
  { label: '1.85 : 1', value: 1.85 },
  { label: '2.39 : 1', value: 2.39 },
];
