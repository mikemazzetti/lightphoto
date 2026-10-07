import type { Clip, Keyframe } from './types';

/**
 * Animatable parameters. Keys are stable strings stored in clip.kf:
 *   motion: x y scale scaleW rotation anchorX anchorY
 *   'opacity', 'volume', 'pan'
 *   effect params: `fx:<effectId>:<param>`
 */
export type ParamKey = string;

export const MOTION_KEYS = ['x', 'y', 'scale', 'scaleW', 'rotation', 'anchorX', 'anchorY'] as const;

/** Static (un-animated) value of a parameter. */
export function staticValue(clip: Clip, key: ParamKey): number {
  switch (key) {
    case 'opacity':
      return clip.opacity;
    case 'volume':
      return clip.volume;
    case 'pan':
      return clip.pan;
  }
  if (key.startsWith('fx:')) {
    const [, id, p] = key.split(':');
    const v = clip.fx.find((e) => e.id === id)?.params[p];
    return typeof v === 'number' ? v : 0;
  }
  const v = (clip.motion as unknown as Record<string, number>)[key];
  return typeof v === 'number' ? v : 0;
}

/** Returns a clip with the static value of `key` replaced. */
export function withStaticValue(clip: Clip, key: ParamKey, v: number): Clip {
  switch (key) {
    case 'opacity':
      return { ...clip, opacity: v };
    case 'volume':
      return { ...clip, volume: v };
    case 'pan':
      return { ...clip, pan: v };
  }
  if (key.startsWith('fx:')) {
    const [, id, p] = key.split(':');
    return { ...clip, fx: clip.fx.map((e) => (e.id === id ? { ...e, params: { ...e.params, [p]: v } } : e)) };
  }
  return { ...clip, motion: { ...clip.motion, [key]: v } };
}

const easeFn = (t: number) => t * t * (3 - 2 * t);

/** Interpolates a sorted keyframe list at local frame `t`. */
export function interpolate(kfs: Keyframe[], t: number): number {
  const n = kfs.length;
  if (n === 1 || t <= kfs[0].t) return kfs[0].v;
  if (t >= kfs[n - 1].t) return kfs[n - 1].v;
  // Binary search for the segment.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo];
  const b = kfs[hi];
  if (a.ease === 'hold') return a.v;
  let u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  if (a.ease === 'ease') u = easeFn(u);
  return a.v + (b.v - a.v) * u;
}

export const isAnimated = (clip: Clip, key: ParamKey) => (clip.kf[key]?.length ?? 0) > 0;

/** Value of a parameter at clip-local frame `local`. */
export function paramAt(clip: Clip, key: ParamKey, local: number): number {
  const k = clip.kf[key];
  return k && k.length ? interpolate(k, local) : staticValue(clip, key);
}

/** Sets a parameter: updates/creates the keyframe at `local` when animated, else the static value. */
export function setParam(clip: Clip, key: ParamKey, local: number, v: number): Clip {
  const k = clip.kf[key];
  if (!k || !k.length) return withStaticValue(clip, key, v);
  const t = Math.round(local);
  const i = k.findIndex((x) => x.t === t);
  const next = i >= 0 ? k.map((x, j) => (j === i ? { ...x, v } : x)) : [...k, { t, v }].sort((a, b) => a.t - b.t);
  return { ...clip, kf: { ...clip.kf, [key]: next } };
}

/** Stopwatch toggle: on → keyframe at `local` with the current value; off → removes animation (keeps the current value). */
export function toggleAnimation(clip: Clip, key: ParamKey, local: number): Clip {
  if (isAnimated(clip, key)) {
    const v = paramAt(clip, key, local);
    const kf = { ...clip.kf };
    delete kf[key];
    return withStaticValue({ ...clip, kf }, key, v);
  }
  const v = staticValue(clip, key);
  return { ...clip, kf: { ...clip.kf, [key]: [{ t: Math.round(local), v }] } };
}

/** Adds a keyframe at `local` (current value) or removes the one there. */
export function toggleKeyframeAt(clip: Clip, key: ParamKey, local: number): Clip {
  const t = Math.round(local);
  const k = clip.kf[key] ?? [];
  const i = k.findIndex((x) => x.t === t);
  if (i >= 0) {
    const next = k.filter((_, j) => j !== i);
    if (!next.length) {
      const kf = { ...clip.kf };
      delete kf[key];
      return withStaticValue({ ...clip, kf }, key, k[i].v);
    }
    return { ...clip, kf: { ...clip.kf, [key]: next } };
  }
  const v = paramAt(clip, key, local);
  return { ...clip, kf: { ...clip.kf, [key]: [...k, { t, v }].sort((a, b) => a.t - b.t) } };
}

export function moveKeyframe(clip: Clip, key: ParamKey, fromT: number, toT: number): Clip {
  const k = clip.kf[key];
  if (!k) return clip;
  toT = Math.round(toT);
  if (k.some((x) => x.t === toT && x.t !== fromT)) return clip;
  return { ...clip, kf: { ...clip.kf, [key]: k.map((x) => (x.t === fromT ? { ...x, t: toT } : x)).sort((a, b) => a.t - b.t) } };
}

/** Shifts every keyframe of a clip by `d` frames (used when trimming the head / splitting, so animation stays attached to the content). */
export function shiftKeyframes(kf: Record<string, Keyframe[]>, d: number): Record<string, Keyframe[]> {
  if (!d) return kf;
  const out: Record<string, Keyframe[]> = {};
  for (const k in kf) out[k] = kf[k].map((x) => ({ ...x, t: x.t + d }));
  return out;
}

/** Scales keyframe times (speed change / frame-rate conversion). */
export function scaleKeyframes(kf: Record<string, Keyframe[]>, s: number): Record<string, Keyframe[]> {
  const out: Record<string, Keyframe[]> = {};
  for (const k in kf) {
    const seen = new Set<number>();
    out[k] = kf[k]
      .map((x) => ({ ...x, t: Math.round(x.t * s) }))
      .filter((x) => (seen.has(x.t) ? false : (seen.add(x.t), true)));
  }
  return out;
}

/** All keyframe times of a clip (sorted, unique) — for prev/next keyframe navigation. */
export function allKeyframeTimes(clip: Clip, keys?: ParamKey[]): number[] {
  const s = new Set<number>();
  for (const k of keys ?? Object.keys(clip.kf)) for (const x of clip.kf[k] ?? []) s.add(x.t);
  return [...s].sort((a, b) => a - b);
}
