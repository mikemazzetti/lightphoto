/**
 * Non-destructive develop settings (Lightroom "Develop" model). Plain JSON — safe to persist,
 * copy/paste, diff and use as presets. All slider values use Lightroom's ranges.
 */

export type CurvePoint = [number, number]; // x, y in 0..1

export interface ToneCurve {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

/** 8 bands: red, orange, yellow, green, aqua, blue, purple, magenta. Values -100..100. */
export interface HSLBands {
  hue: number[];
  sat: number[];
  lum: number[];
}
export const HSL_BAND_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;
/** HSV hue (degrees) of each band centre, matching Lightroom. */
export const HSL_BAND_HUES = [0, 30, 60, 120, 180, 240, 270, 300];
export const HSL_BAND_COLORS = ['#e8443a', '#f08a2c', '#e8d33a', '#4cc04a', '#3ac6c9', '#3a6ee8', '#8a4ae8', '#d94ad0'];

export interface GradeWheel {
  hue: number; // 0..360
  sat: number; // 0..100
  lum: number; // -100..100
}

export interface BrushStroke {
  /** Points in source-normalised coordinates (0..1 of the un-cropped, un-rotated image). */
  points: [number, number][];
  /** Brush diameter as a fraction of the source image width. */
  size: number;
  feather: number; // 0..100
  flow: number; // 0..100
  erase: boolean;
}

export type LocalType = 'linear' | 'radial' | 'brush';

/** Adjustments a local mask can carry (subset of the global ones, same ranges). */
export interface LocalParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  saturation: number;
  clarity: number;
  dehaze: number;
  texture: number;
}

export interface LocalAdjustment extends LocalParams {
  id: string;
  name: string;
  type: LocalType;
  enabled: boolean;
  invert: boolean;
  amount: number; // 0..100 overall strength
  /** Linear gradient: full effect at (x0,y0) fading to none at (x1,y1). Source-normalised coords. */
  linear?: { x0: number; y0: number; x1: number; y1: number };
  /** Radial gradient: centre + radii (fractions of source width / height), rotation (deg), feather 0..100. */
  radial?: { cx: number; cy: number; rx: number; ry: number; angle: number; feather: number };
  strokes?: BrushStroke[];
}

export type Profile = 'none' | 'color' | 'vivid' | 'landscape' | 'portrait' | 'flat' | 'monochrome';
export const PROFILES: { id: Profile; label: string }[] = [
  { id: 'none', label: 'Embedded / Neutral' },
  { id: 'color', label: 'Color' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'flat', label: 'Flat' },
  { id: 'monochrome', label: 'Monochrome' },
];

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DevelopSettings {
  version: 1;
  profile: Profile;
  treatment: 'color' | 'bw';
  // Basic — white balance
  temperature: number; // -100..100
  tint: number; // -100..100
  // Basic — tone
  exposure: number; // -5..5 EV
  contrast: number; // -100..100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  // Basic — presence
  texture: number;
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
  // Tone curve
  curve: ToneCurve;
  // Color mixer
  hsl: HSLBands;
  bwMix: number[]; // 8 bands, -100..100
  // Color grading
  grading: {
    shadows: GradeWheel;
    midtones: GradeWheel;
    highlights: GradeWheel;
    global: GradeWheel;
    blending: number; // 0..100
    balance: number; // -100..100
  };
  // Detail
  sharpening: { amount: number; radius: number; detail: number; masking: number }; // 0..150, 0.5..3, 0..100, 0..100
  noise: { luminance: number; color: number }; // 0..100
  // Optics
  /** Manual distortion / vignetting (-100..100) + whether the camera's built-in lens profile is applied. */
  lens: { distortion: number; vignette: number; profile: boolean };
  // Effects
  vignette: { amount: number; midpoint: number; roundness: number; feather: number; highlights: number };
  grain: { amount: number; size: number; roughness: number };
  // Geometry
  orientation: 0 | 90 | 180 | 270; // clockwise
  flipH: boolean;
  flipV: boolean;
  angle: number; // straighten, degrees (-45..45), positive = clockwise
  crop: Crop; // normalised in the oriented frame
  // Local adjustments (masks)
  locals: LocalAdjustment[];
}

const identityCurve = (): CurvePoint[] => [
  [0, 0],
  [1, 1],
];

export function defaultSettings(): DevelopSettings {
  return {
    version: 1,
    profile: 'none',
    treatment: 'color',
    temperature: 0,
    tint: 0,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    vibrance: 0,
    saturation: 0,
    curve: { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    hsl: { hue: Array(8).fill(0), sat: Array(8).fill(0), lum: Array(8).fill(0) },
    bwMix: [-10, -20, -10, -30, -20, 10, 20, 10],
    grading: {
      shadows: { hue: 0, sat: 0, lum: 0 },
      midtones: { hue: 0, sat: 0, lum: 0 },
      highlights: { hue: 0, sat: 0, lum: 0 },
      global: { hue: 0, sat: 0, lum: 0 },
      blending: 50,
      balance: 0,
    },
    sharpening: { amount: 0, radius: 1, detail: 25, masking: 0 },
    noise: { luminance: 0, color: 0 },
    lens: { distortion: 0, vignette: 0, profile: true },
    vignette: { amount: 0, midpoint: 50, roundness: 0, feather: 50, highlights: 0 },
    grain: { amount: 0, size: 25, roughness: 50 },
    orientation: 0,
    flipH: false,
    flipV: false,
    angle: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    locals: [],
  };
}

/** Defaults Lightroom applies to RAW files (base profile + capture sharpening + colour NR). */
/**
 * Defaults for RAW files. The camera tone curve is applied at decode (rawTone.ts), so there is no
 * extra profile contrast. Capture sharpening and luminance noise reduction scale with ISO — tuned so
 * an ISO 400 Sony RX100 V file lands on macOS's rendering (noise ≈1.1×, edge contrast ≈1×).
 */
export function defaultRawSettings(iso?: number): DevelopSettings {
  const s = defaultSettings();
  const stops = iso && iso > 0 ? Math.log2(iso / 100) : 2; // stops above ISO 100; unknown → ISO 400
  // Luminance NR at ISO 100, 200, 400 … 6400 (interpolated per stop, clamped at the ends).
  const NR = [30, 50, 70, 80, 88, 94, 100];
  const k = Math.min(NR.length - 1, Math.max(0, stops));
  const i = Math.min(NR.length - 2, Math.floor(k));
  s.noise.luminance = Math.round(NR[i] + (NR[i + 1] - NR[i]) * (k - i));
  s.noise.color = 25;
  s.sharpening.amount = 60;
  s.sharpening.masking = Math.round(Math.min(40, 15 + 4 * Math.max(0, stops)));
  return s;
}

export function defaultLocal(type: LocalType, id = Math.random().toString(36).slice(2, 10)): LocalAdjustment {
  return {
    id,
    name: type === 'linear' ? 'Linear Gradient' : type === 'radial' ? 'Radial Gradient' : 'Brush',
    type,
    enabled: true,
    invert: false,
    amount: 100,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    clarity: 0,
    dehaze: 0,
    texture: 0,
    linear: type === 'linear' ? { x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.55 } : undefined,
    radial: type === 'radial' ? { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0, feather: 50 } : undefined,
    strokes: type === 'brush' ? [] : undefined,
  };
}

/** Deep clone (settings are plain JSON). */
export const cloneSettings = (s: DevelopSettings): DevelopSettings => structuredClone(s);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Replaces missing / non-finite numbers of `o` with the defaults' values (copying only when needed). */
function fixNumbers<T extends object>(o: unknown, d: T): T {
  let out = (isObj(o) ? o : { ...d }) as any;
  for (const k of Object.keys(d)) {
    if (typeof (d as any)[k] === 'number' && !finite(out[k])) {
      if (out === o) out = { ...out };
      out[k] = (d as any)[k];
    }
  }
  return out;
}

/** Numeric array at least as long as `d` (invalid entries from `d`); a valid `a` is kept as is. */
function fixArray(a: unknown, d: number[]): number[] {
  if (Array.isArray(a) && a.length >= d.length && a.every(finite)) return a;
  return d.map((v, i) => (Array.isArray(a) && finite(a[i]) ? a[i] : v));
}

const validCurve = (c: unknown) => Array.isArray(c) && c.length > 0 && c.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));

function normalizeLocal(l: LocalAdjustment): LocalAdjustment {
  const d = defaultLocal(l.type, l.id);
  const x: any = fixNumbers({ ...d, ...l }, d);
  if (x.type === 'linear') x.linear = fixNumbers(x.linear, d.linear!);
  if (x.type === 'radial') x.radial = fixNumbers(x.radial, d.radial!);
  if (x.type === 'brush' && !Array.isArray(x.strokes)) x.strokes = [];
  return x;
}

/** Fills in fields missing from older/partial settings objects. */
export function normalizeSettings(s: Partial<DevelopSettings> | null | undefined): DevelopSettings {
  const d = defaultSettings();
  if (!s) return d;
  const out: any = { ...d, ...s };
  for (const k of ['curve', 'hsl', 'grading', 'sharpening', 'noise', 'lens', 'vignette', 'grain', 'crop'] as const) {
    out[k] = { ...(d as any)[k], ...((s as any)[k] ?? {}) };
  }
  out.grading = { ...d.grading, ...(s.grading ?? {}) };
  // Partial / corrupt nested values (older catalogs, hand-made presets, NaN saved as null) would
  // reach the shader as NaN (black frame) or crash the curve baker. Valid values are left untouched
  // (same identity and key order, so settings hashes of existing photos don't change).
  for (const k of Object.keys(d) as (keyof DevelopSettings)[]) if (typeof d[k] === 'number' && !finite(out[k])) out[k] = d[k];
  if (![0, 90, 180, 270].includes(out.orientation)) out.orientation = 0;
  if (typeof out.flipH !== 'boolean') out.flipH = !!out.flipH;
  if (typeof out.flipV !== 'boolean') out.flipV = !!out.flipV;
  for (const k of ['sharpening', 'noise', 'lens', 'vignette', 'grain', 'crop'] as const) out[k] = fixNumbers(out[k], d[k]);
  if (!(out.crop.w > 0 && out.crop.h > 0)) out.crop = d.crop;
  if (typeof out.lens.profile !== 'boolean') out.lens = { ...out.lens, profile: d.lens.profile };
  for (const ch of ['rgb', 'r', 'g', 'b'] as const) if (!validCurve(out.curve[ch])) out.curve[ch] = d.curve[ch];
  for (const k of ['hue', 'sat', 'lum'] as const) out.hsl[k] = fixArray(out.hsl[k], d.hsl[k]);
  out.bwMix = fixArray(out.bwMix, d.bwMix);
  out.grading = fixNumbers(out.grading, d.grading);
  for (const z of ['shadows', 'midtones', 'highlights', 'global'] as const) out.grading[z] = fixNumbers(out.grading[z], d.grading[z]);
  out.locals = (Array.isArray(s.locals) ? s.locals : []).filter(isObj).map((l) => normalizeLocal(l as unknown as LocalAdjustment));
  return out as DevelopSettings;
}

const isIdentityCurve = (c: CurvePoint[]) => c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 1 && c[1][1] === 1;
export const curveIsIdentity = (c: ToneCurve) => isIdentityCurve(c.rgb) && isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b);

/** True when the settings would leave the image untouched (used to skip work / show badges). */
export function isNeutral(s: DevelopSettings): boolean {
  return JSON.stringify(normalizeSettings(s)) === JSON.stringify(defaultSettings());
}

/** Which top-level groups a "copy settings" / preset / sync operation can include. */
export const SETTING_GROUPS = {
  whiteBalance: ['temperature', 'tint'],
  basicTone: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  presence: ['texture', 'clarity', 'dehaze', 'vibrance', 'saturation'],
  toneCurve: ['curve'],
  colorMixer: ['hsl', 'bwMix'],
  treatment: ['treatment', 'profile'],
  colorGrading: ['grading'],
  detail: ['sharpening', 'noise'],
  optics: ['lens'],
  effects: ['vignette', 'grain'],
  geometry: ['orientation', 'flipH', 'flipV', 'angle', 'crop'],
  masks: ['locals'],
} as const satisfies Record<string, readonly (keyof DevelopSettings)[]>;
export type SettingGroup = keyof typeof SETTING_GROUPS;
export const SETTING_GROUP_LABELS: Record<SettingGroup, string> = {
  whiteBalance: 'White Balance',
  basicTone: 'Basic Tone',
  presence: 'Presence',
  toneCurve: 'Tone Curve',
  colorMixer: 'Color Mixer / B&W Mix',
  treatment: 'Treatment & Profile',
  colorGrading: 'Color Grading',
  detail: 'Detail',
  optics: 'Lens Corrections',
  effects: 'Effects',
  geometry: 'Crop & Transform',
  masks: 'Masks',
};

/** Copies the chosen groups from `src` onto a clone of `dst`. */
export function applyGroups(dst: DevelopSettings, src: Partial<DevelopSettings>, groups: SettingGroup[]): DevelopSettings {
  const out: any = cloneSettings(dst);
  for (const g of groups) for (const k of SETTING_GROUPS[g]) if ((src as any)[k] !== undefined) out[k] = structuredClone((src as any)[k]);
  return out;
}
