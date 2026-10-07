/**
 * Pure timeline edit operations. Every function returns a new Sequence (or clip) and never mutates
 * its inputs, so undo snapshots can share untouched clips.
 */
import { uid } from '@/core/util/async';
import { scaleKeyframes, shiftKeyframes } from './keyframes';
import { exactFps } from './time';
import type { Clip, MediaItem, Sequence, Track, TrackKind } from './types';

export const clipEnd = (c: Clip) => c.start + c.duration;
export const isBounded = (m: MediaItem | undefined) => !!m && (m.kind === 'video' || m.kind === 'audio') && m.duration > 0;

export type MediaLookup = (id: string) => MediaItem | undefined;

/** Maximum timeline length (frames) of a clip given its in-point and speed. Infinity for stills/generated. */
export function maxClipFrames(c: Pick<Clip, 'inPoint' | 'speed'>, m: MediaItem | undefined, fps: number): number {
  if (!isBounded(m)) return Infinity;
  return Math.max(1, Math.floor(((m!.duration - c.inPoint) / c.speed) * exactFps(fps) + 1e-4));
}

/** Frames of source available before the in-point (head handle). */
export function headroomFrames(c: Clip, m: MediaItem | undefined, fps: number): number {
  if (!isBounded(m)) return Infinity;
  return Math.floor((c.inPoint / c.speed) * exactFps(fps) + 1e-4);
}

/** Source time (seconds) shown at clip-local frame `local`. */
export const sourceTimeAt = (c: Clip, local: number, fps: number) => c.inPoint + (local / exactFps(fps)) * c.speed;

export function tracksOf(seq: Sequence, kind: TrackKind): Track[] {
  return seq.tracks.filter((t) => t.kind === kind);
}

export function trackIndex(seq: Sequence, trackId: string): { kind: TrackKind; index: number } | null {
  const t = seq.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  return { kind: t.kind, index: tracksOf(seq, t.kind).indexOf(t) };
}

export function sequenceEnd(seq: Sequence): number {
  let e = 0;
  for (const c of seq.clips) e = Math.max(e, clipEnd(c));
  return e;
}

function clampFades(c: Clip): Clip {
  const fi = Math.min(c.fadeIn, c.duration);
  const fo = Math.min(c.fadeOut, c.duration);
  return fi === c.fadeIn && fo === c.fadeOut ? c : { ...c, fadeIn: fi, fadeOut: fo };
}

/** Moves the clip's head to `newStart` (trimming content), clamped to available media and ≥1 frame. */
export function trimHead(c: Clip, newStart: number, m: MediaItem | undefined, fps: number): Clip {
  newStart = Math.round(newStart);
  const end = clipEnd(c);
  newStart = Math.min(newStart, end - 1);
  newStart = Math.max(newStart, 0);
  let d = newStart - c.start;
  if (isBounded(m)) d = Math.max(d, -headroomFrames(c, m, fps));
  if (!d) return c;
  const inPoint = isBounded(m) ? Math.max(0, c.inPoint + (d / exactFps(fps)) * c.speed) : 0;
  return clampFades({ ...c, start: c.start + d, duration: c.duration - d, inPoint, kf: shiftKeyframes(c.kf, -d) });
}

/** Moves the clip's tail to `newEnd`, clamped to available media and ≥1 frame. */
export function trimTail(c: Clip, newEnd: number, m: MediaItem | undefined, fps: number): Clip {
  newEnd = Math.round(newEnd);
  let dur = Math.max(1, newEnd - c.start);
  dur = Math.min(dur, maxClipFrames(c, m, fps));
  if (dur === c.duration) return c;
  return clampFades({ ...c, duration: dur });
}

/**
 * Link id for the piece split off a linked clip at `at`. Pieces of one link group cut at the same frame
 * share it within one edit (`links`, so V+A halves stay linked), but every edit mints fresh ids, so a
 * later cut at the same frame never relinks to pieces split off earlier.
 */
function childLink(linkId: string | null, at: number, links: Map<string, string>): string | null {
  if (!linkId) return null;
  const key = `${linkId}/${at}`;
  let l = links.get(key);
  if (!l) links.set(key, (l = uid('l')));
  return l;
}

/** Splits a clip at timeline frame `at` (start < at < end). */
export function splitClip(c: Clip, at: number, m: MediaItem | undefined, fps: number, links = new Map<string, string>()): [Clip, Clip] | null {
  at = Math.round(at);
  if (at <= c.start || at >= clipEnd(c)) return null;
  const d = at - c.start;
  const left: Clip = clampFades({ ...c, duration: d, fadeOut: 0, transOut: null });
  const right: Clip = clampFades({
    ...c,
    id: uid('c'),
    start: at,
    duration: c.duration - d,
    inPoint: isBounded(m) ? c.inPoint + (d / exactFps(fps)) * c.speed : c.inPoint,
    fadeIn: 0,
    transIn: null,
    linkId: childLink(c.linkId, at, links),
    kf: shiftKeyframes(c.kf, -d),
  });
  return [left, right];
}

/** Clears [s, e) on a track (overwrite semantics): removes, trims or splits clips in the way. */
export function clearRange(clips: Clip[], trackId: string, s: number, e: number, media: MediaLookup, fps: number, ignore?: Set<string>, links = new Map<string, string>()): Clip[] {
  if (e <= s) return clips;
  const out: Clip[] = [];
  for (const c of clips) {
    const ce = clipEnd(c);
    if (c.trackId !== trackId || ignore?.has(c.id) || ce <= s || c.start >= e) {
      out.push(c);
      continue;
    }
    const m = media(c.mediaId);
    if (c.start >= s && ce <= e) continue; // fully covered
    if (c.start < s && ce > e) {
      const parts = splitClip(c, s, m, fps, links);
      if (!parts) continue;
      out.push(parts[0]);
      const r = trimHead(parts[1], e, m, fps);
      out.push({ ...r, linkId: childLink(c.linkId, e, links) });
    } else if (c.start < s) out.push(trimTail(c, s, m, fps));
    else out.push(trimHead(c, e, m, fps));
  }
  return out;
}

/** Places clips with overwrite semantics. */
export function overwriteClips(seq: Sequence, add: Clip[], media: MediaLookup): Sequence {
  let clips = seq.clips;
  const links = new Map<string, string>();
  for (const c of add) clips = clearRange(clips, c.trackId, c.start, clipEnd(c), media, seq.fps, undefined, links);
  return { ...seq, clips: [...clips, ...add] };
}

/** Tracks affected by sync-locked ripple/insert edits, plus `extra`. */
export function rippleTracks(seq: Sequence, extra: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const t of seq.tracks) if (!t.locked && t.syncLock) s.add(t.id);
  for (const id of extra) {
    const t = seq.tracks.find((x) => x.id === id);
    if (t && !t.locked) s.add(id);
  }
  return s;
}

/** Inserts clips at `at`, pushing later material right on the target + sync-locked tracks. */
export function insertClips(seq: Sequence, add: Clip[], media: MediaLookup): Sequence {
  if (!add.length) return seq;
  const at = Math.min(...add.map((c) => c.start));
  const len = Math.max(...add.map(clipEnd)) - at;
  const tracks = rippleTracks(
    seq,
    add.map((c) => c.trackId),
  );
  const clips: Clip[] = [];
  const links = new Map<string, string>();
  for (const c of seq.clips) {
    if (!tracks.has(c.trackId) || clipEnd(c) <= at) {
      clips.push(c);
      continue;
    }
    if (c.start >= at) {
      clips.push({ ...c, start: c.start + len });
      continue;
    }
    const parts = splitClip(c, at, media(c.mediaId), seq.fps, links);
    if (!parts) {
      clips.push(c);
      continue;
    }
    clips.push(parts[0], { ...parts[1], start: parts[1].start + len });
  }
  return { ...seq, clips: [...clips, ...add] };
}

/** True when no clip on the track overlaps [s, e). */
export function isFree(clips: Clip[], trackId: string, s: number, e: number, ignore?: Set<string>): boolean {
  for (const c of clips) if (c.trackId === trackId && !ignore?.has(c.id) && c.start < e && clipEnd(c) > s) return false;
  return true;
}

/**
 * Shifts clips starting at/after `at` by `delta` on the given tracks. For negative deltas a track is
 * only shifted when [at+delta, at) is empty on it (so nothing overlaps) and lies at/after frame 0.
 */
export function rippleShift(clips: Clip[], at: number, delta: number, tracks: Set<string>, ignore?: Set<string>): Clip[] {
  if (!delta) return clips;
  const ok = new Set<string>();
  for (const t of tracks) if (delta > 0 || (at + delta >= 0 && isFree(clips, t, at + delta, at, ignore))) ok.add(t);
  return clips.map((c) => (ok.has(c.trackId) && !ignore?.has(c.id) && c.start >= at ? { ...c, start: c.start + delta } : c));
}

/** Merges [s,e) intervals. */
function mergeIntervals(iv: [number, number][]): [number, number][] {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

/** Removes clips without closing the gap. */
export function liftClips(seq: Sequence, ids: Set<string>): Sequence {
  return { ...seq, clips: seq.clips.filter((c) => !ids.has(c.id)) };
}

/** Removes clips and closes the resulting gaps on affected + sync-locked tracks. */
export function rippleDeleteClips(seq: Sequence, ids: Set<string>): Sequence {
  const removed = seq.clips.filter((c) => ids.has(c.id));
  if (!removed.length) return seq;
  let clips = seq.clips.filter((c) => !ids.has(c.id));
  const tracks = rippleTracks(
    seq,
    removed.map((c) => c.trackId),
  );
  const iv = mergeIntervals(removed.map((c) => [c.start, clipEnd(c)]));
  for (let i = iv.length - 1; i >= 0; i--) {
    const [s, e] = iv[i];
    clips = rippleShift(clips, e, s - e, tracks);
  }
  return { ...seq, clips };
}

/** Closes a gap [s,e) on a track (and on sync-locked tracks that have room). */
export function rippleDeleteGap(seq: Sequence, trackId: string, s: number, e: number): Sequence {
  return { ...seq, clips: rippleShift(seq.clips, e, s - e, rippleTracks(seq, [trackId])) };
}

/** Removes [s,e) from the given tracks; with `ripple`, closes the gap (Extract) else leaves it (Lift). */
export function removeRange(seq: Sequence, s: number, e: number, trackIds: Set<string>, media: MediaLookup, ripple: boolean): Sequence {
  let clips = seq.clips;
  const links = new Map<string, string>();
  for (const t of trackIds) clips = clearRange(clips, t, s, e, media, seq.fps, undefined, links);
  if (ripple) clips = rippleShift(clips, e, s - e, trackIds);
  return { ...seq, clips };
}

/** Splits every clip in `ids` (or on `trackIds` when ids is empty) that spans `at`. Linked pieces stay linked. */
export function splitAt(seq: Sequence, at: number, pick: (c: Clip) => boolean, media: MediaLookup): Sequence {
  const out: Clip[] = [];
  const links = new Map<string, string>();
  let changed = false;
  for (const c of seq.clips) {
    if (!pick(c) || at <= c.start || at >= clipEnd(c)) {
      out.push(c);
      continue;
    }
    const parts = splitClip(c, at, media(c.mediaId), seq.fps, links);
    if (!parts) out.push(c);
    else {
      out.push(...parts);
      changed = true;
    }
  }
  return changed ? { ...seq, clips: out } : seq;
}

/**
 * Moves clips by `dFrames` and by `dV`/`dA` track positions (within their kind) with overwrite semantics.
 * Returns null when the move is impossible (locked or missing destination track).
 */
export function moveClips(seq: Sequence, ids: Set<string>, dFrames: number, dV: number, dA: number, media: MediaLookup): Sequence | null {
  const moving = seq.clips.filter((c) => ids.has(c.id));
  if (!moving.length) return seq;
  const minStart = Math.min(...moving.map((c) => c.start));
  dFrames = Math.max(Math.round(dFrames), -minStart);
  const vt = tracksOf(seq, 'video');
  const at = tracksOf(seq, 'audio');
  const moved: Clip[] = [];
  for (const c of moving) {
    const ti = trackIndex(seq, c.trackId);
    if (!ti) return null;
    const list = ti.kind === 'video' ? vt : at;
    const ni = ti.index + (ti.kind === 'video' ? dV : dA);
    const dest = list[ni];
    if (!dest || dest.locked) return null;
    moved.push({ ...c, start: c.start + dFrames, trackId: dest.id });
  }
  if (!dFrames && !dV && !dA) return seq;
  let rest = seq.clips.filter((c) => !ids.has(c.id));
  const links = new Map<string, string>();
  for (const c of moved) rest = clearRange(rest, c.trackId, c.start, clipEnd(c), media, seq.fps, undefined, links);
  return { ...seq, clips: [...rest, ...moved] };
}

/** Clamps a group track delta so every clip stays on an existing, unlocked track of its kind. */
export function clampTrackDelta(seq: Sequence, clips: Clip[], kind: TrackKind, d: number): number {
  const list = tracksOf(seq, kind);
  const idx = clips.filter((c) => trackIndex(seq, c.trackId)?.kind === kind).map((c) => trackIndex(seq, c.trackId)!.index);
  if (!idx.length) return 0;
  const lo = -Math.min(...idx);
  const hi = list.length - 1 - Math.max(...idx);
  return Math.max(lo, Math.min(hi, d));
}

/** Ripple trims a clip edge; later clips on its track (+ sync-locked tracks) follow. */
export function rippleTrim(seq: Sequence, ids: Set<string>, edge: 'head' | 'tail', delta: number, media: MediaLookup): Sequence {
  const targets = seq.clips.filter((c) => ids.has(c.id));
  if (!targets.length || !delta) return seq;
  // Clamp delta so every target stays valid.
  for (const c of targets) {
    const m = media(c.mediaId);
    if (edge === 'tail') {
      const maxD = maxClipFrames(c, m, seq.fps) - c.duration;
      delta = Math.min(delta, maxD);
      delta = Math.max(delta, 1 - c.duration);
    } else {
      // Head: +delta removes frames from the head.
      delta = Math.min(delta, c.duration - 1);
      delta = Math.max(delta, -headroomFrames(c, m, seq.fps));
    }
  }
  if (!delta) return seq;
  const tracks = rippleTracks(
    seq,
    targets.map((c) => c.trackId),
  );
  const ownEnd = Math.max(...targets.map(clipEnd));
  const editPoint = edge === 'tail' ? ownEnd : Math.min(...targets.map((c) => c.start));
  let clips = seq.clips.map((c) => {
    if (!ids.has(c.id)) return c;
    const m = media(c.mediaId);
    if (edge === 'tail') return trimTail(c, clipEnd(c) + delta, m, seq.fps);
    // The head stays put, so trim a copy shifted clear of frame 0 (trimHead clamps the new start to ≥ 0,
    // which would shorten head extensions of clips near the sequence start).
    const off = Math.max(0, -(c.start + delta));
    const t = trimHead({ ...c, start: c.start + off }, c.start + off + delta, m, seq.fps);
    return { ...t, start: c.start };
  });
  const ignore = new Set(ids);
  if (edge === 'tail') clips = rippleShift(clips, editPoint, delta, tracks, ignore);
  else {
    // The edited track closes up after the clip's (old) tail; other sync-locked tracks stay in sync
    // with the content, i.e. shift from the edit point (the head).
    const own = new Set(targets.map((c) => c.trackId));
    clips = rippleShift(clips, ownEnd, -delta, own, ignore);
    clips = rippleShift(clips, editPoint, -delta, new Set([...tracks].filter((t) => !own.has(t))), ignore);
  }
  return { ...seq, clips };
}

/** Changes speed (rate 1 = 100%); duration scales accordingly, clamped to the media. */
export function changeSpeed(seq: Sequence, ids: Set<string>, speed: number, ripple: boolean, media: MediaLookup, fixedDuration?: number): Sequence {
  speed = Math.max(0.05, Math.min(20, speed));
  // Target durations first, so linked partners (V+A) whose tracks clamp differently stay the same length.
  const durs = new Map<string, number>();
  const linkDur = new Map<string, number>();
  for (const id of ids) {
    const c = seq.clips.find((x) => x.id === id);
    if (!c) continue;
    let dur = fixedDuration ?? Math.max(1, Math.round((c.duration * c.speed) / speed));
    dur = Math.min(dur, maxClipFrames({ inPoint: c.inPoint, speed }, media(c.mediaId), seq.fps));
    if (!ripple) {
      // Can't grow into the next clip on the same track.
      const next = seq.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id && x.start >= clipEnd(c)).reduce((a, x) => Math.min(a, x.start), Infinity);
      dur = Math.min(dur, next - c.start);
    }
    durs.set(id, dur);
    if (c.linkId) linkDur.set(c.linkId, Math.min(linkDur.get(c.linkId) ?? Infinity, dur));
  }
  let clips = seq.clips;
  for (const id of ids) {
    const c = clips.find((x) => x.id === id);
    if (!c || !durs.has(id)) continue;
    const dur = Math.max(1, Math.min(durs.get(id)!, c.linkId ? linkDur.get(c.linkId)! : Infinity));
    const k = dur / c.duration;
    const nc: Clip = clampFades({ ...c, speed, duration: dur, fadeIn: Math.round(c.fadeIn * k), fadeOut: Math.round(c.fadeOut * k), kf: scaleKeyframes(c.kf, k) });
    const delta = dur - c.duration;
    clips = clips.map((x) => (x.id === id ? nc : x));
    if (ripple && delta) clips = rippleShift(clips, clipEnd(c), delta, new Set([c.trackId]), new Set([c.id]));
  }
  return { ...seq, clips };
}

/** Converts every frame-based value to a new frame rate. */
export function convertFps(seq: Sequence, fps: number): Sequence {
  const r = exactFps(fps) / exactFps(seq.fps);
  if (Math.abs(r - 1) < 1e-9) return { ...seq, fps };
  const R = (v: number) => Math.round(v * r);
  return {
    ...seq,
    fps,
    clips: seq.clips.map((c) => {
      const s = R(c.start);
      const e = Math.max(s + 1, R(clipEnd(c)));
      return {
        ...c,
        start: s,
        duration: e - s,
        fadeIn: R(c.fadeIn),
        fadeOut: R(c.fadeOut),
        transIn: c.transIn ? { ...c.transIn, duration: Math.max(1, R(c.transIn.duration)) } : null,
        transOut: c.transOut ? { ...c.transOut, duration: Math.max(1, R(c.transOut.duration)) } : null,
        kf: scaleKeyframes(c.kf, r),
      };
    }),
    markers: seq.markers.map((m) => ({ ...m, frame: R(m.frame) })),
    inPoint: seq.inPoint === null ? null : R(seq.inPoint),
    outPoint: seq.outPoint === null ? null : R(seq.outPoint),
  };
}

/** Sorted unique edit points (clip boundaries) on visible/unlocked tracks. */
export function editPoints(seq: Sequence): number[] {
  const s = new Set<number>([0]);
  for (const c of seq.clips) {
    s.add(c.start);
    s.add(clipEnd(c));
  }
  return [...s].sort((a, b) => a - b);
}

/** The empty region around `frame` on a track, if it lies between two clips (or before the first). */
export function gapAt(seq: Sequence, trackId: string, frame: number): { start: number; end: number } | null {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const c of seq.clips) {
    if (c.trackId !== trackId) continue;
    if (c.start <= frame && clipEnd(c) > frame) return null;
    if (clipEnd(c) <= frame) prevEnd = Math.max(prevEnd, clipEnd(c));
    if (c.start > frame) nextStart = Math.min(nextStart, c.start);
  }
  if (!Number.isFinite(nextStart) || nextStart <= prevEnd) return null;
  return { start: prevEnd, end: nextStart };
}

/** Expands a set of clip ids to include linked partners. */
export function withLinked(seq: Sequence, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const links = new Set<string>();
  for (const c of seq.clips) if (out.has(c.id) && c.linkId) links.add(c.linkId);
  if (links.size) for (const c of seq.clips) if (c.linkId && links.has(c.linkId)) out.add(c.id);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Snapping

export function snapPoints(seq: Sequence, exclude: Set<string>, playhead: number): number[] {
  const s = new Set<number>([0, Math.round(playhead)]);
  for (const c of seq.clips) {
    if (exclude.has(c.id)) continue;
    s.add(c.start);
    s.add(clipEnd(c));
  }
  for (const m of seq.markers) s.add(m.frame);
  if (seq.inPoint !== null) s.add(seq.inPoint);
  if (seq.outPoint !== null) s.add(seq.outPoint);
  return [...s].sort((a, b) => a - b);
}

/** Finds the snap adjustment for any of `candidates` (frames) within `threshold` frames. */
export function snapDelta(candidates: number[], points: number[], threshold: number): { delta: number; point: number } | null {
  let best: { delta: number; point: number } | null = null;
  for (const c of candidates) {
    // binary search nearest
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid] <= c) lo = mid;
      else hi = mid;
    }
    for (const p of [points[lo], points[hi]]) {
      if (p === undefined) continue;
      const d = p - c;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, point: p };
    }
  }
  return best;
}
