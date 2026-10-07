/**
 * Built-in (camera-embedded) lens corrections for RAW files.
 *
 * Many cameras — notably Sony compacts like the RX100 series, whose lenses rely on software
 * correction — store distortion, chromatic-aberration and vignetting parameters in the RAW. The
 * camera applies them to its JPEGs (and the embedded preview); Lightroom applies them
 * automatically. Without them the RAW shows barrel distortion and dark corners.
 *
 * Model (as in darktable's "embedded metadata" lens correction): knots are evenly spaced over the
 * normalised radius r ∈ [0, 1], where 1 is the half-diagonal. For an output pixel at radius r the
 * source is sampled at radius r · d(r) (per channel for CA). Vignetting knots are linear gains.
 */
export interface LensProfile {
  label: string;
  /** Radial sampling factors for the green channel (source radius = r · factor). */
  distortion: number[];
  /** Extra per-channel factors (multiplied with distortion) correcting lateral CA. */
  caRed: number[];
  caBlue: number[];
  /** Linear brightness gains, knots evenly spaced over r ∈ [0, 1]. */
  vignetting: number[];
}

type Reader = { u16(o: number): number; s16(o: number): number; u32(o: number): number };

function reader(buf: ArrayBuffer): Reader | null {
  const v = new DataView(buf);
  if (v.byteLength < 8) return null;
  const order = v.getUint16(0);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  return { u16: (o) => v.getUint16(o, le), s16: (o) => v.getInt16(o, le), u32: (o) => v.getUint32(o, le) };
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

interface Entry {
  type: number;
  count: number;
  /** Offset of the value data (inline or pointed-to). */
  at: number;
}

function readIfd(r: Reader, off: number, len: number): Map<number, Entry> | null {
  if (off <= 0 || off + 2 > len) return null;
  const n = r.u16(off);
  if (n > 1000 || off + 2 + n * 12 > len) return null;
  const out = new Map<number, Entry>();
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const type = r.u16(e + 2);
    const count = r.u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const at = size <= 4 ? e + 8 : r.u32(e + 8);
    if (at + size > len) continue;
    out.set(r.u16(e), { type, count, at });
  }
  return out;
}

function shorts(r: Reader, e: Entry | undefined): number[] | null {
  if (!e || (e.type !== 3 && e.type !== 8)) return null;
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) out.push(e.type === 8 ? r.s16(e.at + i * 2) : r.u16(e.at + i * 2));
  return out;
}

/** Sony ARW: SubIFD tags 0x7037 (distortion), 0x7035 (CA), 0x7032 (vignetting). */
function readSony(r: Reader, len: number): LensProfile | null {
  const ifd0 = readIfd(r, r.u32(4), len);
  if (!ifd0) return null;
  const candidates: Map<number, Entry>[] = [ifd0];
  const sub = ifd0.get(0x014a);
  if (sub) for (let i = 0; i < Math.min(sub.count, 8); i++) {
    const t = readIfd(r, sub.count === 1 ? r.u32(sub.at) : r.u32(sub.at + i * 4), len);
    if (t) candidates.push(t);
  }
  for (const t of candidates) {
    const dist = shorts(r, t.get(0x7037));
    if (!dist || dist[0] < 2 || dist[0] > 16 || dist.length < dist[0] + 1) continue;
    const n = dist[0];
    const distortion = dist.slice(1, n + 1).map((v) => 1 + v / 16384);
    let caRed = Array(n).fill(1);
    let caBlue = Array(n).fill(1);
    const ca = shorts(r, t.get(0x7035));
    if (ca && ca[0] === 2 * n && ca.length >= 2 * n + 1) {
      caRed = ca.slice(1, n + 1).map((v) => 1 + v / 2097152);
      caBlue = ca.slice(n + 1, 2 * n + 1).map((v) => 1 + v / 2097152);
    }
    let vignetting: number[] = [];
    const vig = shorts(r, t.get(0x7032));
    // darktable applies 2^(v / 2^14); half that strength matches macOS's rendering of the same files.
    if (vig && vig[0] >= 2 && vig[0] <= 16 && vig.length >= vig[0] + 1) vignetting = vig.slice(1, vig[0] + 1).map((v) => 2 ** (v / 32768));
    return { label: 'Built-in (Sony)', distortion, caRed, caBlue, vignetting };
  }
  return null;
}

/** Reads embedded lens-correction data from a RAW file buffer, or null if none is present. */
export function readLensProfile(buf: ArrayBuffer): LensProfile | null {
  try {
    const r = reader(buf);
    if (!r) return null;
    return readSony(r, buf.byteLength);
  } catch {
    return null;
  }
}

/** Piecewise-linear lookup of knots evenly spaced over [0, 1] (clamped at the ends). */
export function sampleKnots(knots: number[], t: number): number {
  if (!knots.length) return 1;
  if (knots.length === 1) return knots[0];
  const x = Math.min(1, Math.max(0, t)) * (knots.length - 1);
  const i = Math.min(knots.length - 2, Math.floor(x));
  return knots[i] + (knots[i + 1] - knots[i]) * (x - i);
}

export const LENS_LUT_SIZE = 256;

/**
 * Bakes a profile into the geometry pass's RGBA LUT over r ∈ [0, 1]. Stored as offsets from 1 so
 * half floats keep the tiny CA differences: (green factor − 1, red/green − 1, blue/green − 1, gain − 1).
 */
export function bakeLensLut(p: LensProfile, size = LENS_LUT_SIZE): Float32Array {
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    out[i * 4] = sampleKnots(p.distortion, t) - 1;
    out[i * 4 + 1] = sampleKnots(p.caRed, t) - 1;
    out[i * 4 + 2] = sampleKnots(p.caBlue, t) - 1;
    out[i * 4 + 3] = (p.vignetting.length ? sampleKnots(p.vignetting, t) : 1) - 1;
  }
  return out;
}
