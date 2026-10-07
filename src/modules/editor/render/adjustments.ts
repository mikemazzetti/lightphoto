import { makeCurve } from '@/core/develop/curve';
import type { AdjustParams, AdjustType, GradientStop, LevelsChannel, RGBA } from '../model/types';

export const ADJUST_TYPES: { type: AdjustType; label: string; shortcut?: string }[] = [
  { type: 'brightness', label: 'Brightness/Contrast…' },
  { type: 'levels', label: 'Levels…', shortcut: 'mod+l' },
  { type: 'curves', label: 'Curves…', shortcut: 'mod+m' },
  { type: 'exposure', label: 'Exposure…' },
  { type: 'vibrance', label: 'Vibrance…' },
  { type: 'hueSat', label: 'Hue/Saturation…', shortcut: 'mod+u' },
  { type: 'colorBalance', label: 'Color Balance…', shortcut: 'mod+b' },
  { type: 'bw', label: 'Black & White…', shortcut: 'alt+shift+mod+b' },
  { type: 'photoFilter', label: 'Photo Filter…' },
  { type: 'invert', label: 'Invert', shortcut: 'mod+i' },
  { type: 'posterize', label: 'Posterize…' },
  { type: 'threshold', label: 'Threshold…' },
  { type: 'gradientMap', label: 'Gradient Map…' },
];

export const ADJUST_NAMES: Record<AdjustType, string> = {
  brightness: 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  hueSat: 'Hue/Saturation',
  colorBalance: 'Color Balance',
  bw: 'Black & White',
  photoFilter: 'Photo Filter',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  gradientMap: 'Gradient Map',
};

export const levelsIdentity = (): LevelsChannel => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const idCurve = (): [number, number][] => [
  [0, 0],
  [1, 1],
];

export function defaultAdjust(type: AdjustType, fg?: RGBA, bg?: RGBA): AdjustParams {
  switch (type) {
    case 'brightness':
      return { type, brightness: 0, contrast: 0, legacy: false };
    case 'levels':
      return { type, rgb: levelsIdentity(), r: levelsIdentity(), g: levelsIdentity(), b: levelsIdentity() };
    case 'curves':
      return { type, rgb: idCurve(), r: idCurve(), g: idCurve(), b: idCurve() };
    case 'exposure':
      return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'hueSat':
      return { type, hue: 0, saturation: 0, lightness: 0, colorize: false };
    case 'colorBalance':
      return { type, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLum: true };
    case 'vibrance':
      return { type, vibrance: 0, saturation: 0 };
    case 'bw':
      return { type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: { r: 225, g: 211, b: 179, a: 1 } };
    case 'photoFilter':
      return { type, color: { r: 236, g: 138, b: 0, a: 1 }, density: 25, preserveLum: true };
    case 'invert':
      return { type };
    case 'posterize':
      return { type, levels: 4 };
    case 'threshold':
      return { type, level: 128 };
    case 'gradientMap':
      return {
        type,
        stops: [
          { pos: 0, color: fg ?? { r: 0, g: 0, b: 0, a: 1 } },
          { pos: 1, color: bg ?? { r: 255, g: 255, b: 255, a: 1 } },
        ],
        reverse: false,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Per-channel LUTs

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const srgbToLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function levelsFn(c: LevelsChannel) {
  const ib = c.inBlack / 255;
  const iw = Math.max(ib + 1 / 255, c.inWhite / 255);
  const ob = c.outBlack / 255;
  const ow = c.outWhite / 255;
  const g = Math.max(0.01, c.gamma);
  return (x: number) => ob + (ow - ob) * clamp01((x - ib) / (iw - ib)) ** (1 / g);
}

function brightnessFn(brightness: number, contrast: number, legacy: boolean) {
  if (legacy) {
    const b = brightness / 255;
    const c = contrast / 100;
    const k = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
    return (x: number) => clamp01((x + b - 0.5) * k + 0.5);
  }
  const gamma = Math.exp((-brightness / 150) * 0.9);
  const c = contrast / 100;
  return (x: number) => {
    let y = x ** gamma;
    if (c > 0) {
      const s = 0.5 - 0.5 * Math.cos(Math.PI * y);
      const s2 = 0.5 - 0.5 * Math.cos(Math.PI * s);
      y = c <= 0.5 ? y + (s - y) * (c * 2) : s + (s2 - s) * ((c - 0.5) * 2);
    } else if (c < 0) y = 0.5 + (y - 0.5) * (1 + c * 0.75);
    return clamp01(y);
  };
}

function exposureFn(e: number, offset: number, gamma: number) {
  const k = 2 ** e;
  const g = Math.max(0.01, gamma);
  return (x: number) => clamp01(linToSrgb(Math.max(0, srgbToLin(x) * k + offset)) ** (1 / g));
}

/** Bakes the per-channel LUT (256 × RGBA8) of tone-map adjustments; null for shader-only types. */
export function bakeLut(p: AdjustParams): Uint8Array | null {
  let fr: (x: number) => number;
  let fg: (x: number) => number;
  let fb: (x: number) => number;
  switch (p.type) {
    case 'brightness':
      fr = fg = fb = brightnessFn(p.brightness, p.contrast, p.legacy);
      break;
    case 'levels': {
      const m = levelsFn(p.rgb);
      const r = levelsFn(p.r);
      const g = levelsFn(p.g);
      const b = levelsFn(p.b);
      fr = (x) => m(r(x));
      fg = (x) => m(g(x));
      fb = (x) => m(b(x));
      break;
    }
    case 'curves': {
      const m = makeCurve(p.rgb);
      const r = makeCurve(p.r);
      const g = makeCurve(p.g);
      const b = makeCurve(p.b);
      fr = (x) => r(m(x));
      fg = (x) => g(m(x));
      fb = (x) => b(m(x));
      break;
    }
    case 'exposure':
      fr = fg = fb = exposureFn(p.exposure, p.offset, p.gamma);
      break;
    case 'invert':
      fr = fg = fb = (x) => 1 - x;
      break;
    case 'posterize': {
      const n = Math.max(2, Math.round(p.levels));
      fr = fg = fb = (x) => Math.min(n - 1, Math.floor(x * n)) / (n - 1);
      break;
    }
    case 'gradientMap':
      return bakeGradient(p.reverse ? reverseStops(p.stops) : p.stops);
    default:
      return null;
  }
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    out[i * 4] = Math.round(clamp01(fr(x)) * 255);
    out[i * 4 + 1] = Math.round(clamp01(fg(x)) * 255);
    out[i * 4 + 2] = Math.round(clamp01(fb(x)) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function reverseStops(stops: GradientStop[]): GradientStop[] {
  return stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).sort((a, b) => a.pos - b.pos);
}

/** 256-entry RGBA ramp through gradient stops (straight alpha). */
export function bakeGradient(stops: GradientStop[]): Uint8Array {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = s[0];
    let b = s[s.length - 1];
    for (let k = 0; k < s.length - 1; k++) {
      if (t >= s[k].pos && t <= s[k + 1].pos) {
        a = s[k];
        b = s[k + 1];
        break;
      }
    }
    const span = b.pos - a.pos;
    const u = span > 1e-6 ? clamp01((t - a.pos) / span) : t < a.pos ? 0 : 1;
    const lerp = (x: number, y: number) => x + (y - x) * u;
    out[i * 4] = Math.round(lerp(a.color.r, b.color.r));
    out[i * 4 + 1] = Math.round(lerp(a.color.g, b.color.g));
    out[i * 4 + 2] = Math.round(lerp(a.color.b, b.color.b));
    out[i * 4 + 3] = Math.round(lerp(a.color.a, b.color.a) * 255);
  }
  return out;
}

/** Shader id + uniform vectors for an adjustment (see GLSL_ADJUST). */
export function adjustUniforms(p: AdjustParams): { uAdj: number; uA0: number[]; uA1: number[]; uA2: number[]; uA3: number[] } {
  const z = [0, 0, 0, 0];
  const u = { uAdj: 0, uA0: z, uA1: z, uA2: z, uA3: z };
  switch (p.type) {
    case 'hueSat':
      return { ...u, uAdj: 1, uA0: [p.hue / 360, p.saturation / 100, p.lightness / 100, p.colorize ? 1 : 0] };
    case 'colorBalance':
      return {
        ...u,
        uAdj: 2,
        uA0: [...p.shadows.map((v) => v / 100), 0],
        uA1: [...p.midtones.map((v) => v / 100), 0],
        uA2: [...p.highlights.map((v) => v / 100), 0],
        uA3: [p.preserveLum ? 1 : 0, 0, 0, 0],
      };
    case 'vibrance':
      return { ...u, uAdj: 3, uA0: [p.vibrance / 100, p.saturation / 100, 0, 0] };
    case 'bw':
      return {
        ...u,
        uAdj: 4,
        uA0: [p.reds / 100, p.yellows / 100, p.greens / 100, p.cyans / 100],
        uA1: [p.blues / 100, p.magentas / 100, p.tint ? 1 : 0, 0],
        uA2: [p.tintColor.r / 255, p.tintColor.g / 255, p.tintColor.b / 255, 1],
      };
    case 'photoFilter':
      return { ...u, uAdj: 5, uA0: [p.color.r / 255, p.color.g / 255, p.color.b / 255, p.density / 100], uA1: [p.preserveLum ? 1 : 0, 0, 0, 0] };
    case 'threshold':
      return { ...u, uAdj: 6, uA0: [p.level / 255, 0, 0, 0] };
    case 'gradientMap':
      return { ...u, uAdj: 7 };
    default:
      return u;
  }
}

export const adjustNeedsLut = (p: AdjustParams) => !['hueSat', 'colorBalance', 'vibrance', 'bw', 'photoFilter', 'threshold'].includes(p.type);

// ---------------------------------------------------------------------------------------------
// Auto tone / contrast / colour (computed from an RGBA buffer)

function histograms(px: Uint8ClampedArray | Uint8Array) {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  let n = 0;
  const step = Math.max(1, Math.floor(px.length / 4 / 2_000_000)) * 4;
  for (let i = 0; i < px.length; i += step) {
    if (px[i + 3] < 8) continue;
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
    l[Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])]++;
    n++;
  }
  return { r, g, b, l, n: Math.max(1, n) };
}

function percentile(h: Uint32Array, n: number, p: number) {
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += h[i];
    if (acc / n >= p) return i;
  }
  return 255;
}

export function autoLevels(px: Uint8ClampedArray | Uint8Array, mode: 'tone' | 'contrast' | 'color'): AdjustParams {
  const H = histograms(px);
  const clip = 0.001;
  const ch = (h: Uint32Array): LevelsChannel => {
    const lo = percentile(h, H.n, clip);
    const hi = Math.max(lo + 2, percentile(h, H.n, 1 - clip));
    return { inBlack: lo, inWhite: hi, gamma: 1, outBlack: 0, outWhite: 255 };
  };
  const p = defaultAdjust('levels') as Extract<AdjustParams, { type: 'levels' }>;
  if (mode === 'contrast') {
    const lo = Math.min(percentile(H.r, H.n, clip), percentile(H.g, H.n, clip), percentile(H.b, H.n, clip));
    const hi = Math.max(percentile(H.r, H.n, 1 - clip), percentile(H.g, H.n, 1 - clip), percentile(H.b, H.n, 1 - clip));
    p.rgb = { inBlack: lo, inWhite: Math.max(lo + 2, hi), gamma: 1, outBlack: 0, outWhite: 255 };
    return p;
  }
  p.r = ch(H.r);
  p.g = ch(H.g);
  p.b = ch(H.b);
  if (mode === 'color') {
    // Neutralise midtones: gamma per channel so each channel's median maps to the luma median.
    const target = percentile(H.l, H.n, 0.5) / 255;
    for (const [k, h] of [
      ['r', H.r],
      ['g', H.g],
      ['b', H.b],
    ] as const) {
      const c = p[k];
      const med = percentile(h, H.n, 0.5) / 255;
      const x = clamp01((med - c.inBlack / 255) / Math.max(1e-3, (c.inWhite - c.inBlack) / 255));
      if (x > 0.02 && x < 0.98 && target > 0.02 && target < 0.98) c.gamma = Math.max(0.5, Math.min(2, Math.log(x) / Math.log(target)));
    }
  }
  return p;
}
