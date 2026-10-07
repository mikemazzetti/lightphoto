/**
 * Evaluates a sequence at a frame: which clips are visible on each video track (with transitions),
 * their source times and resolved (keyframed) parameters. Shared by live playback and export, so
 * both render identically.
 */
import { paramAt } from './keyframes';
import { clipEnd, isBounded } from './ops';
import { dbToGain, exactFps } from './time';
import type { Clip, MediaItem, Sequence, Track, Transition, TransitionType } from './types';

export interface LayerEval {
  clip: Clip;
  media: MediaItem;
  /** Clip-local frame (may lie outside [0, duration) inside a transition's handle region). */
  local: number;
  /** Source time in seconds (clamped to the media). */
  srcTime: number;
  /** 0..1, including fade handles. */
  opacity: number;
  x: number;
  y: number;
  /** Scale factors (1 = 100%). */
  sx: number;
  sy: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
}

export type PlanItem =
  | { kind: 'layer'; layer: LayerEval }
  | { kind: 'adjust'; layer: LayerEval }
  | { kind: 'transition'; a: LayerEval | null; b: LayerEval | null; type: TransitionType; p: number; direction: number };

export interface TrackPlan {
  track: Track;
  item: PlanItem;
}

interface SeqIndex {
  byTrack: Map<string, Clip[]>;
}

const indexCache = new WeakMap<Clip[], SeqIndex>();

export function seqIndex(seq: Sequence): SeqIndex {
  let ix = indexCache.get(seq.clips);
  if (ix) return ix;
  const byTrack = new Map<string, Clip[]>();
  for (const c of seq.clips) {
    let a = byTrack.get(c.trackId);
    if (!a) byTrack.set(c.trackId, (a = []));
    a.push(c);
  }
  for (const a of byTrack.values()) a.sort((x, y) => x.start - y.start);
  ix = { byTrack };
  indexCache.set(seq.clips, ix);
  return ix;
}

/** Index of the clip containing frame f in a start-sorted list, or -1. */
export function clipIndexAt(sorted: Clip[], f: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].start <= f) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found >= 0 && clipEnd(sorted[found]) > f) return found;
  return -1;
}

export function evalLayer(clip: Clip, media: MediaItem, f: number, fps: number): LayerEval {
  const local = f - clip.start;
  const rate = exactFps(fps);
  let srcTime = clip.inPoint + (local / rate) * clip.speed;
  if (isBounded(media)) srcTime = Math.max(0, Math.min(srcTime, media.duration - 0.5 / Math.max(1, media.fps || rate)));
  else srcTime = Math.max(0, srcTime);
  let op = paramAt(clip, 'opacity', local) / 100;
  if (local >= 0 && local < clip.duration) {
    if (clip.fadeIn > 0 && local < clip.fadeIn) op *= Math.min(1, (local + 0.5) / clip.fadeIn);
    if (clip.fadeOut > 0 && clip.duration - local <= clip.fadeOut) op *= Math.min(1, (clip.duration - local - 0.5) / clip.fadeOut);
  }
  const m = clip.motion;
  const scale = paramAt(clip, 'scale', local) / 100;
  const sx = m.uniform ? scale : paramAt(clip, 'scaleW', local) / 100;
  return {
    clip,
    media,
    local,
    srcTime,
    opacity: Math.max(0, Math.min(1, op)),
    x: paramAt(clip, 'x', local),
    y: paramAt(clip, 'y', local),
    sx,
    sy: scale,
    rotation: paramAt(clip, 'rotation', local),
    anchorX: paramAt(clip, 'anchorX', local),
    anchorY: paramAt(clip, 'anchorY', local),
  };
}

function cutRegion(a: Clip, b: Clip, tr: Transition): [number, number] {
  const cut = b.start;
  const d = Math.max(1, tr.duration);
  const off = tr.align === 'start' ? 0 : tr.align === 'end' ? d : Math.floor(d / 2);
  const rs = Math.max(a.start, cut - off);
  const re = Math.min(clipEnd(b), rs + d);
  return [rs, re];
}

/** The transition at the cut between adjacent clips a → b (b's In wins over a's Out). */
export const cutTransition = (a: Clip, b: Clip): Transition | null => b.transIn ?? a.transOut;

/**
 * Plans the frame: one item per visible video track, bottom (V1) to top. Disabled clips, hidden
 * tracks and offline media are skipped.
 */
export function planFrame(seq: Sequence, media: (id: string) => MediaItem | undefined, f: number): TrackPlan[] {
  const ix = seqIndex(seq);
  const out: TrackPlan[] = [];
  const fps = seq.fps;
  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    const sorted = ix.byTrack.get(track.id);
    if (!sorted?.length) continue;
    const i = clipIndexAt(sorted, f);
    if (i < 0) continue;
    const c = sorted[i];
    const item = planClip(sorted, i, c, f, fps, media);
    if (item) out.push({ track, item });
  }
  return out;
}

function usable(c: Clip | null | undefined, media: (id: string) => MediaItem | undefined): MediaItem | null {
  if (!c || !c.enabled) return null;
  const m = media(c.mediaId);
  if (!m || m.missing) return null;
  return m;
}

function planClip(sorted: Clip[], i: number, c: Clip, f: number, fps: number, media: (id: string) => MediaItem | undefined): PlanItem | null {
  const prev = i > 0 && clipEnd(sorted[i - 1]) === c.start ? sorted[i - 1] : null;
  const next = i < sorted.length - 1 && sorted[i + 1].start === clipEnd(c) ? sorted[i + 1] : null;
  const mc = usable(c, media);
  const mk = (clip: Clip | null, m: MediaItem | null) => (clip && m ? evalLayer(clip, m, f, fps) : null);
  const trans = (a: Clip | null, b: Clip | null, tr: Transition, rs: number, re: number): PlanItem | null => {
    const la = mk(a, usable(a, media));
    const lb = mk(b, usable(b, media));
    if (!la && !lb) return null;
    const p = Math.max(0, Math.min(1, (f - rs + 0.5) / Math.max(1, re - rs)));
    return { kind: 'transition', a: la, b: lb, type: tr.type, p, direction: tr.direction };
  };
  // Head side.
  if (prev) {
    const tr = cutTransition(prev, c);
    if (tr) {
      const [rs, re] = cutRegion(prev, c, tr);
      if (f >= rs && f < re) return trans(prev, c, tr, rs, re);
    }
  } else if (c.transIn) {
    const re = c.start + Math.min(c.duration, Math.max(1, c.transIn.duration));
    if (f < re) return trans(null, c, c.transIn, c.start, re);
  }
  // Tail side.
  if (next) {
    const tr = cutTransition(c, next);
    if (tr) {
      const [rs, re] = cutRegion(c, next, tr);
      if (f >= rs && f < re) return trans(c, next, tr, rs, re);
    }
  } else if (c.transOut) {
    const rs = clipEnd(c) - Math.min(c.duration, Math.max(1, c.transOut.duration));
    if (f >= rs) return trans(c, null, c.transOut, rs, clipEnd(c));
  }
  if (!mc) return null;
  const layer = evalLayer(c, mc, f, fps);
  return mc.kind === 'adjustment' ? { kind: 'adjust', layer } : { kind: 'layer', layer };
}

/** Linear gain of an audio clip at clip-local frame `local` (volume keyframes × fades). */
export function audioGainAt(clip: Clip, local: number): number {
  let g = dbToGain(paramAt(clip, 'volume', local));
  if (clip.fadeIn > 0 && local < clip.fadeIn) g *= Math.max(0, Math.min(1, local / clip.fadeIn));
  if (clip.fadeOut > 0 && clip.duration - local < clip.fadeOut) g *= Math.max(0, Math.min(1, (clip.duration - local) / clip.fadeOut));
  // Audio "transitions" act as fades.
  if (clip.transIn && local < clip.transIn.duration) g *= Math.max(0, Math.min(1, local / clip.transIn.duration));
  if (clip.transOut && clip.duration - local < clip.transOut.duration) g *= Math.max(0, Math.min(1, (clip.duration - local) / clip.transOut.duration));
  return g;
}

/** Whether a clip's gain is constant over its whole length (no fades, no volume keyframes). */
export const audioGainIsStatic = (c: Clip) => !c.fadeIn && !c.fadeOut && !c.transIn && !c.transOut && !(c.kf.volume?.length);

/** Effective gain of an audio track given mute/solo state of all tracks. */
export function trackGain(seq: Sequence, t: Track): number {
  const anySolo = seq.tracks.some((x) => x.kind === 'audio' && x.solo);
  if (t.muted || (anySolo && !t.solo)) return 0;
  return dbToGain(t.volume);
}
