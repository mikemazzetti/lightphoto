import { CurvePoint, defaultSettings, DevelopSettings, GradeWheel, normalizeSettings, SETTING_GROUPS, SettingGroup } from '@/core/develop/settings';

/**
 * Built-in Develop presets. Each preset fully specifies the keys it touches (falling back to
 * neutral values), so hopping between presets never leaves stale values behind. Presets are
 * applied on top of the current settings — white balance (unless the look needs it), exposure,
 * geometry and masks are kept.
 */

export interface BuiltinPreset {
  id: string;
  name: string;
  group: string;
  settings: Partial<DevelopSettings>;
}

const LOOK_KEYS: (keyof DevelopSettings)[] = ['treatment', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'texture', 'clarity', 'dehaze', 'vibrance', 'saturation', 'curve', 'hsl', 'grading', 'vignette', 'grain'];
const BW_KEYS: (keyof DevelopSettings)[] = [...LOOK_KEYS, 'bwMix'];

type BandMap = Partial<Record<'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta', number>>;
const BAND_ORDER = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
const bands = (m: BandMap = {}) => BAND_ORDER.map((b) => m[b] ?? 0);

type GradingIn = Partial<Record<'shadows' | 'midtones' | 'highlights' | 'global', Partial<GradeWheel>>> & { blending?: number; balance?: number };
interface LookIn extends Omit<Partial<DevelopSettings>, 'grading' | 'hsl' | 'curve' | 'vignette' | 'grain'> {
  grading?: GradingIn;
  hsl?: { hue?: BandMap; sat?: BandMap; lum?: BandMap };
  curve?: Partial<DevelopSettings['curve']>;
  vignette?: Partial<DevelopSettings['vignette']>;
  grain?: Partial<DevelopSettings['grain']>;
  mix?: BandMap;
}

function look(o: LookIn, keys: (keyof DevelopSettings)[] = LOOK_KEYS): Partial<DevelopSettings> {
  const d = defaultSettings();
  const out: any = {};
  for (const k of keys) out[k] = structuredClone(d[k]);
  const { grading, hsl, curve, vignette, grain, mix, ...flat } = o;
  Object.assign(out, flat);
  if (grading) {
    out.grading = { ...d.grading, blending: grading.blending ?? d.grading.blending, balance: grading.balance ?? d.grading.balance };
    for (const z of ['shadows', 'midtones', 'highlights', 'global'] as const) out.grading[z] = { ...d.grading[z], ...(grading[z] ?? {}) };
  }
  if (hsl) out.hsl = { hue: bands(hsl.hue), sat: bands(hsl.sat), lum: bands(hsl.lum) };
  if (curve) out.curve = { ...d.curve, ...curve };
  if (vignette) out.vignette = { ...d.vignette, ...vignette };
  if (grain) out.grain = { ...d.grain, ...grain };
  if (mix) out.bwMix = bands(mix);
  return out;
}

const C = (...p: CurvePoint[]) => p;
const FADE = C([0, 0.09], [0.25, 0.27], [0.75, 0.76], [1, 0.95]);
const MEDIUM = C([0, 0], [0.25, 0.21], [0.5, 0.5], [0.75, 0.79], [1, 1]);
const STRONG = C([0, 0], [0.25, 0.16], [0.5, 0.5], [0.75, 0.84], [1, 1]);

let n = 0;
const P = (group: string, name: string, settings: Partial<DevelopSettings>): BuiltinPreset => ({ id: `builtin-${++n}`, group, name, settings });

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  // ---- Color
  P('Color', 'Vivid Pop', look({ contrast: 20, highlights: -22, shadows: 15, whites: 10, blacks: -10, texture: 10, clarity: 15, vibrance: 35, saturation: 5 })),
  P('Color', 'Clean & Bright', look({ contrast: 6, highlights: -30, shadows: 25, whites: 15, blacks: 4, clarity: 5, vibrance: 15 })),
  P('Color', 'Warm Sunset', look({ temperature: 22, tint: 6, contrast: 10, highlights: -25, shadows: 10, vibrance: 20, grading: { highlights: { hue: 38, sat: 26 }, shadows: { hue: 18, sat: 10 } }, vignette: { amount: -15 } }, [...LOOK_KEYS, 'temperature', 'tint'])),
  P('Color', 'Golden Hour', look({ temperature: 14, contrast: 8, highlights: -18, shadows: 12, vibrance: 15, hsl: { lum: { orange: 10 }, sat: { orange: 8, yellow: 10 } }, grading: { highlights: { hue: 45, sat: 28 }, midtones: { hue: 35, sat: 8 } } }, [...LOOK_KEYS, 'temperature'])),
  P('Color', 'Cool Matte', look({ temperature: -12, contrast: -15, highlights: -20, shadows: 18, saturation: -15, curve: { rgb: FADE }, grading: { shadows: { hue: 210, sat: 18 }, highlights: { hue: 200, sat: 8 } } }, [...LOOK_KEYS, 'temperature'])),
  P('Color', 'Teal & Orange', look({ contrast: 15, highlights: -15, shadows: 8, vibrance: 15, hsl: { hue: { orange: -5, aqua: 12, blue: -12 }, sat: { orange: 15, yellow: -10, green: -25, aqua: 10 } }, grading: { shadows: { hue: 192, sat: 35 }, highlights: { hue: 34, sat: 30 }, balance: -10 } })),
  P('Color', 'Film Fade', look({ contrast: -10, highlights: -15, shadows: 10, saturation: -12, curve: { rgb: FADE }, grain: { amount: 25, size: 30, roughness: 55 }, grading: { midtones: { hue: 45, sat: 6 } } })),
  P('Color', 'Moody', look({ contrast: 20, highlights: -40, shadows: -10, whites: -15, blacks: -20, clarity: 20, dehaze: 8, vibrance: -10, saturation: -20, grading: { shadows: { hue: 220, sat: 20 }, highlights: { hue: 40, sat: 10 } }, vignette: { amount: -25, feather: 70 } })),
  // ---- Black & White
  P('Black & White', 'High Contrast', look({ treatment: 'bw', contrast: 45, highlights: -10, shadows: -10, whites: 25, blacks: -30, clarity: 25, curve: { rgb: STRONG }, mix: { red: 10, orange: 10, green: -20, aqua: -20, blue: -30, purple: -10 } }, BW_KEYS)),
  P('Black & White', 'Soft Matte', look({ treatment: 'bw', contrast: -15, highlights: -20, shadows: 20, clarity: -5, curve: { rgb: FADE }, grain: { amount: 15, size: 25, roughness: 50 }, mix: { orange: 15, yellow: 10, blue: -10 } }, BW_KEYS)),
  P('Black & White', 'Selenium Tone', look({ treatment: 'bw', contrast: 22, highlights: -12, blacks: -10, clarity: 10, grading: { shadows: { hue: 300, sat: 14 }, highlights: { hue: 45, sat: 6 } }, mix: { red: 5, orange: 10, blue: -15 } }, BW_KEYS)),
  P('Black & White', 'Sepia', look({ treatment: 'bw', contrast: 10, highlights: -15, shadows: 10, grading: { midtones: { hue: 38, sat: 32 }, highlights: { hue: 45, sat: 12 }, shadows: { hue: 25, sat: 15 } }, vignette: { amount: -12 } }, BW_KEYS)),
  P('Black & White', 'Infrared Glow', look({ treatment: 'bw', contrast: 25, whites: 20, clarity: -15, mix: { green: 80, yellow: 60, aqua: 20, blue: -60, red: -10 } }, BW_KEYS)),
  // ---- Creative
  P('Creative', 'Cross Process', look({ contrast: 12, saturation: 10, curve: { r: C([0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]), g: C([0, 0], [0.25, 0.22], [0.75, 0.8], [1, 1]), b: C([0, 0.16], [1, 0.84]) } })),
  P('Creative', 'Vintage', look({ temperature: 10, contrast: -10, highlights: -12, saturation: -25, curve: { rgb: FADE }, grading: { shadows: { hue: 190, sat: 10 }, highlights: { hue: 50, sat: 20 } }, vignette: { amount: -20 }, grain: { amount: 20, size: 35, roughness: 60 } }, [...LOOK_KEYS, 'temperature'])),
  P('Creative', 'Bleach Bypass', look({ contrast: 40, highlights: -20, blacks: -15, clarity: 25, saturation: -45, curve: { rgb: MEDIUM } })),
  P('Creative', 'Lomo', look({ contrast: 30, saturation: 25, vibrance: 15, curve: { rgb: STRONG }, grading: { shadows: { hue: 220, sat: 15 }, highlights: { hue: 55, sat: 12 } }, vignette: { amount: -45, midpoint: 35, feather: 60 } })),
  P('Creative', 'Faded Pastel', look({ contrast: -25, highlights: -10, shadows: 30, saturation: -10, vibrance: 10, curve: { rgb: C([0, 0.12], [0.5, 0.52], [1, 0.97]) }, grading: { highlights: { hue: 330, sat: 10 }, shadows: { hue: 200, sat: 8 } } })),
  // ---- Detail
  P('Detail', 'Sharpen – Portrait', { sharpening: { amount: 35, radius: 1.2, detail: 10, masking: 60 } }),
  P('Detail', 'Sharpen – Landscape', { sharpening: { amount: 55, radius: 0.8, detail: 40, masking: 10 } }),
  P('Detail', 'Noise Reduction – High ISO', { noise: { luminance: 40, color: 40 } }),
  P('Detail', 'Grain – Fine Film', { grain: { amount: 20, size: 15, roughness: 40 } }),
];

export const BUILTIN_GROUPS = ['Color', 'Black & White', 'Creative', 'Detail'];

/** Applies a (partial) preset on top of `cur`; keys absent from the preset are kept. */
export function applyPreset(cur: DevelopSettings, preset: Partial<DevelopSettings>): DevelopSettings {
  return normalizeSettings({ ...cur, ...structuredClone(preset) });
}

/** Picks the keys of the chosen groups from `s` (for copy / create preset). */
export function pickGroups(s: DevelopSettings, groups: SettingGroup[]): Partial<DevelopSettings> {
  const out: any = {};
  for (const g of groups) for (const k of SETTING_GROUPS[g]) out[k] = structuredClone(s[k]);
  return out;
}
