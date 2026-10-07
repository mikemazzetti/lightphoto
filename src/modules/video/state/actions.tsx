/** Editing commands (all undoable) shared by menus, keyboard shortcuts and panels. */
import { uid } from '@/core/util/async';
import { toast } from '@/state/app';
import { confirmDialog } from '@/ui/overlays';
import { defaultTitle, makeClip, makeEffect, makeLumetri, makeTrack, makeTransition } from '../model/defaults';

import {
  changeSpeed,
  clipEnd,
  convertFps,
  editPoints,
  insertClips,
  isBounded,
  liftClips,
  maxClipFrames,
  moveClips,
  overwriteClips,
  removeRange,
  rippleDeleteClips,
  rippleDeleteGap,
  splitAt,
  tracksOf,
  withLinked,
} from '../model/ops';
import { exactFps, secondsToFrameRound } from '../model/time';
import type { Clip, FxType, MediaItem, MediaKind, Project, Sequence, Track, TrackKind, TransitionType } from '../model/types';
import { mapClips, withSeq } from './clips';
import { clipMap, edit, getProject, getSeq, getState, mediaLookup, useVideo } from './store';
import { transport } from './transport';
import { timelineApi } from '../timeline/api';

export const STILL_SECONDS = 5;

// ---------------------------------------------------------------------------------------------
// Selection

export function selectClips(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace', alt = false) {
  const s = getState();
  const seq = s.project.seq;
  const expand = (x: string[]) => (s.linkedSelection && !alt ? [...withLinked(seq, x)] : x);
  let next: string[];
  if (mode === 'replace') next = expand(ids);
  else if (mode === 'add') next = [...new Set([...s.selection, ...expand(ids)])];
  else {
    const ex = expand(ids);
    const allIn = ex.every((id) => s.selection.includes(id));
    next = allIn ? s.selection.filter((id) => !ex.includes(id)) : [...new Set([...s.selection, ...ex])];
  }
  useVideo.setState({ selection: next, gap: null, transition: null });
}

export function selectAll() {
  useVideo.setState({ selection: getSeq().clips.map((c) => c.id), gap: null, transition: null });
}

export function deselectAll() {
  useVideo.setState({ selection: [], gap: null, transition: null });
}

export const selectedClips = (): Clip[] => {
  const s = getState();
  const m = clipMap(s.project);
  return s.selection.map((id) => m.get(id)).filter((c): c is Clip => !!c);
};

/** The primary selected clip for Effect Controls (prefers video). */
export function primaryClip(p: Project = getProject(), selection: string[] = getState().selection): Clip | null {
  const m = clipMap(p);
  const cl = selection.map((id) => m.get(id)).filter((c): c is Clip => !!c);
  if (!cl.length) return null;
  const vt = new Set(p.seq.tracks.filter((t) => t.kind === 'video').map((t) => t.id));
  return cl.find((c) => vt.has(c.trackId)) ?? cl[0];
}

// ---------------------------------------------------------------------------------------------
// Tracks

export function trackOf(seq: Sequence, id: string): Track | undefined {
  return seq.tracks.find((t) => t.id === id);
}

export function addTrack(kind: TrackKind) {
  edit(`Add ${kind === 'video' ? 'Video' : 'Audio'} Track`, (p) => {
    const n = tracksOf(p.seq, kind).length;
    const t = makeTrack(kind, n);
    const tracks = [...tracksOf(p.seq, 'video'), ...(kind === 'video' ? [t] : []), ...tracksOf(p.seq, 'audio'), ...(kind === 'audio' ? [t] : [])];
    return { ...p, seq: { ...p.seq, tracks } };
  });
}

export async function removeTrack(id: string) {
  const seq = getSeq();
  const t = trackOf(seq, id);
  if (!t) return;
  if (tracksOf(seq, t.kind).length <= 1) return toast(`A sequence needs at least one ${t.kind} track.`, 'warn');
  const n = seq.clips.filter((c) => c.trackId === id).length;
  if (n && !(await confirmDialog(`Delete track ${t.name} and its ${n} clip${n > 1 ? 's' : ''}?`, { ok: 'Delete', danger: true }))) return;
  edit(`Delete Track ${t.name}`, (p) => {
    const tracks = p.seq.tracks.filter((x) => x.id !== id);
    // Renumber default names.
    let vi = 0;
    let ai = 0;
    const renamed = tracks.map((x) => {
      const idx = x.kind === 'video' ? vi++ : ai++;
      return /^[VA]\d+$/.test(x.name) ? { ...x, name: `${x.kind === 'video' ? 'V' : 'A'}${idx + 1}` } : x;
    });
    return { ...p, seq: { ...p.seq, tracks: renamed, clips: p.seq.clips.filter((c) => c.trackId !== id) } };
  });
}

export function updateTrack(id: string, patch: Partial<Track>, label = 'Track Settings') {
  edit(label, (p) => ({ ...p, seq: { ...p.seq, tracks: p.seq.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) } }));
}

/** Target tracks for source edits: first selected track of each kind, else V1 / A1. */
export function targetTracks(seq: Sequence = getSeq()): { video: Track; audio: Track } {
  const sel = new Set(getState().selectedTracks);
  const vt = tracksOf(seq, 'video');
  const at = tracksOf(seq, 'audio');
  return { video: vt.find((t) => sel.has(t.id) && !t.locked) ?? vt.find((t) => !t.locked) ?? vt[0], audio: at.find((t) => sel.has(t.id) && !t.locked) ?? at.find((t) => !t.locked) ?? at[0] };
}

// ---------------------------------------------------------------------------------------------
// Placing media

export interface PlaceSpec {
  media: MediaItem;
  /** Source range in seconds (defaults to the media marks / whole file / still duration). */
  inSec?: number;
  outSec?: number;
}

/** Timeline length (frames) for a media item / range at the sequence rate. */
export function placementFrames(m: MediaItem, seq: Sequence, inSec?: number, outSec?: number): { inPoint: number; frames: number } {
  if (!isBounded(m)) return { inPoint: 0, frames: Math.max(1, Math.round(STILL_SECONDS * exactFps(seq.fps))) };
  const i = Math.max(0, inSec ?? m.markIn ?? 0);
  const o = Math.min(m.duration, outSec ?? m.markOut ?? m.duration);
  return { inPoint: i, frames: Math.max(1, Math.min(maxClipFrames({ inPoint: i, speed: 1 }, m, seq.fps), secondsToFrameRound(o - i, seq.fps))) };
}

function ensureTrackIndex(seq: Sequence, kind: TrackKind, index: number): Sequence {
  let s = seq;
  while (tracksOf(s, kind).length <= index) {
    const t = makeTrack(kind, tracksOf(s, kind).length);
    s = { ...s, tracks: [...tracksOf(s, 'video'), ...(kind === 'video' ? [t] : []), ...tracksOf(s, 'audio'), ...(kind === 'audio' ? [t] : [])] };
  }
  return s;
}

/**
 * Builds clips for media items placed one after another from `at`. `videoTrack`/`audioTrack` are
 * track indices within their kind.
 */
function buildClips(seq: Sequence, items: PlaceSpec[], at: number, vIndex: number, aIndex: number): { seq: Sequence; clips: Clip[]; end: number } {
  let s = seq;
  const clips: Clip[] = [];
  let t = at;
  for (const it of items) {
    const m = it.media;
    const { inPoint, frames } = placementFrames(m, s, it.inSec, it.outSec);
    const hasV = m.kind !== 'audio' && (m.hasVideo || m.kind !== 'video');
    const hasA = m.hasAudio && (m.kind === 'video' || m.kind === 'audio');
    const link = hasV && hasA ? uid('l') : null;
    if (hasV) {
      s = ensureTrackIndex(s, 'video', vIndex);
      const tr = tracksOf(s, 'video')[vIndex];
      clips.push({ ...makeClip(m, tr.id, t, frames, inPoint, 'video'), linkId: link });
    }
    if (hasA) {
      s = ensureTrackIndex(s, 'audio', aIndex);
      const tr = tracksOf(s, 'audio')[aIndex];
      clips.push({ ...makeClip(m, tr.id, t, frames, inPoint, 'audio'), linkId: link });
    }
    t += frames;
  }
  return { seq: s, clips, end: t };
}

async function maybeMatchSequence(items: PlaceSpec[]): Promise<void> {
  const seq = getSeq();
  if (seq.clips.length) return;
  const v = items.find((i) => i.media.kind === 'video' && i.media.hasVideo && i.media.width > 0);
  if (!v) return;
  const m = v.media;
  const fps = m.fps || seq.fps;
  if (m.width === seq.width && m.height === seq.height && Math.abs(fps - seq.fps) < 0.01) return;
  const ok = await confirmDialog(
    <>
      <p style={{ margin: 0 }}>
        This clip ({m.width}×{m.height}, {fps} fps) doesn't match the sequence settings ({seq.width}×{seq.height}, {seq.fps} fps).
      </p>
      <p style={{ marginBottom: 0 }}>Change the sequence to match the clip?</p>
    </>,
    { title: 'Clip Mismatch Warning', ok: 'Change Sequence Settings', cancel: 'Keep Existing Settings' },
  );
  if (!ok) return;
  edit('Match Sequence Settings', (p) => {
    let s: Sequence = { ...p.seq, width: m.width, height: m.height };
    if (Math.abs(fps - s.fps) > 0.001) s = convertFps(s, fps);
    return { ...p, seq: s };
  });
}

/** Places media at `at` (overwrite or insert). Track indices default to the target tracks. */
export async function placeMedia(items: PlaceSpec[], at: number, mode: 'overwrite' | 'insert', opts: { vIndex?: number; aIndex?: number; movePlayhead?: boolean } = {}) {
  if (!items.length) return;
  await maybeMatchSequence(items);
  const seq = getSeq();
  const tt = targetTracks(seq);
  const vIndex = opts.vIndex ?? tracksOf(seq, 'video').indexOf(tt.video);
  const aIndex = opts.aIndex ?? tracksOf(seq, 'audio').indexOf(tt.audio);
  const lockedV = tracksOf(seq, 'video')[vIndex]?.locked;
  const lockedA = tracksOf(seq, 'audio')[aIndex]?.locked;
  if (lockedV || lockedA) return toast('The target track is locked.', 'warn');
  let endFrame = at;
  let ids: string[] = [];
  const wasEmpty = seq.clips.length === 0;
  const label = mode === 'insert' ? 'Insert' : 'Overwrite';
  edit(label, (p) => {
    const lookup = mediaLookup(p);
    const built = buildClips(p.seq, items, Math.max(0, Math.round(at)), Math.max(0, vIndex), Math.max(0, aIndex));
    endFrame = built.end;
    ids = built.clips.map((c) => c.id);
    const s = mode === 'insert' ? insertClips(built.seq, built.clips, lookup) : overwriteClips(built.seq, built.clips, lookup);
    return { ...p, seq: s };
  });
  useVideo.setState({ selection: ids, gap: null, transition: null });
  if (opts.movePlayhead) transport.seek(endFrame);
  if (wasEmpty) setTimeout(() => timelineApi.fit?.(), 0);
}

/** Source monitor → timeline at the playhead. */
export function sourceEdit(mode: 'overwrite' | 'insert') {
  const s = getState();
  const m = s.project.media.find((x) => x.id === s.sourceId);
  if (!m) return toast('Open a clip in the Source monitor first (double-click it in the Project panel).', 'info');
  void placeMedia([{ media: m }], transport.frameInt, mode, { movePlayhead: true });
}

// ---------------------------------------------------------------------------------------------
// Deleting

export function deleteSelection(ripple: boolean) {
  const s = getState();
  if (s.transition) {
    const { clipId, edge } = s.transition;
    edit('Delete Transition', (p) => mapClips(p, clipId, (c) => (edge === 'in' ? { ...c, transIn: null } : { ...c, transOut: null })));
    useVideo.setState({ transition: null });
    return;
  }
  if (s.gap) {
    const g = s.gap;
    edit('Ripple Delete Gap', (p) => withSeq(p, rippleDeleteGap(p.seq, g.trackId, g.start, g.end)));
    useVideo.setState({ gap: null });
    return;
  }
  const seq = s.project.seq;
  const locked = new Set(seq.tracks.filter((t) => t.locked).map((t) => t.id));
  const ids = new Set(s.selection.filter((id) => !locked.has(clipMap(s.project).get(id)?.trackId ?? '')));
  if (!ids.size) return;
  edit(ripple ? 'Ripple Delete' : 'Delete', (p) => withSeq(p, ripple ? rippleDeleteClips(p.seq, ids) : liftClips(p.seq, ids)));
  useVideo.setState({ selection: [] });
}

// ---------------------------------------------------------------------------------------------
// Splitting

/** ⌘K: split selected clips at the playhead; else selected tracks; else every unlocked track. */
export function splitAtPlayhead() {
  const s = getState();
  const f = transport.frameInt;
  const seq = s.project.seq;
  const locked = new Set(seq.tracks.filter((t) => t.locked).map((t) => t.id));
  const sel = new Set(s.selection);
  const tracks = new Set(s.selectedTracks);
  const underSel = seq.clips.some((c) => sel.has(c.id) && c.start < f && clipEnd(c) > f);
  const pick = (c: Clip) => !locked.has(c.trackId) && (underSel ? sel.has(c.id) : tracks.size ? tracks.has(c.trackId) : true);
  const ok = edit('Add Edit', (p) => withSeq(p, splitAt(p.seq, f, pick, mediaLookup(p))));
  if (!ok) toast('Nothing to split at the playhead.', 'info', 1800);
}

/** Razor click: split one clip (and its linked partners) — or every unlocked track with Shift. */
export function razorAt(clipId: string, frame: number, allTracks: boolean) {
  const seq = getSeq();
  const locked = new Set(seq.tracks.filter((t) => t.locked).map((t) => t.id));
  const group = withLinked(seq, [clipId]);
  edit('Razor', (p) => withSeq(p, splitAt(p.seq, frame, (c) => !locked.has(c.trackId) && (allTracks || group.has(c.id)), mediaLookup(p))));
}

// ---------------------------------------------------------------------------------------------
// Moving / nudging

export function nudgeSelection(delta: number) {
  const s = getState();
  // Clips on locked tracks don't move (same as dragging).
  const locked = new Set(s.project.seq.tracks.filter((t) => t.locked).map((t) => t.id));
  const ids = new Set(s.selection.filter((id) => !locked.has(clipMap(s.project).get(id)?.trackId ?? '')));
  if (!ids.size) return;
  edit('Nudge', (p) => withSeq(p, moveClips(p.seq, ids, delta, 0, 0, mediaLookup(p))), true);
}

// ---------------------------------------------------------------------------------------------
// Clipboard

/** Copied clips plus the kind of track each came from (its track may be gone by paste time). */
let clipboard: { clips: Clip[]; min: number; kinds: Record<string, TrackKind> } | null = null;

export function copySelection(): boolean {
  const cl = selectedClips();
  if (!cl.length) return false;
  const seq = getSeq();
  const kinds: Record<string, TrackKind> = {};
  for (const c of cl) kinds[c.id] = trackOf(seq, c.trackId)?.kind ?? 'video';
  clipboard = { clips: structuredClone(cl), min: Math.min(...cl.map((c) => c.start)), kinds };
  toast(`Copied ${cl.length} clip${cl.length > 1 ? 's' : ''}`, 'info', 1400);
  return true;
}

export function cutSelection(): boolean {
  if (!copySelection()) return false;
  deleteSelection(false);
  return true;
}

export function pasteAtPlayhead(): boolean {
  if (!clipboard) return false;
  const cb = clipboard;
  const at = transport.frameInt;
  const seq0 = getSeq();
  // Same track if it still exists, else the first track of the same kind.
  const dest = (seq: Sequence, c: Clip) => (trackOf(seq, c.trackId) ?? tracksOf(seq, cb.kinds[c.id] ?? 'video')[0] ?? seq.tracks[0]).id;
  // Clips whose media was cleared from the project since copying can't be pasted.
  const lookup0 = mediaLookup();
  const clips = cb.clips.filter((c) => lookup0(c.mediaId));
  if (!clips.length) return false;
  // Pasting overwrites the destination range, which must not touch locked tracks.
  if (clips.some((c) => trackOf(seq0, dest(seq0, c))?.locked)) {
    toast('The target track is locked.', 'warn');
    return true;
  }
  let ids: string[] = [];
  let end = at;
  edit('Paste', (p) => {
    const links = new Map<string, string>();
    const fresh = clips.map((c) => {
      let linkId: string | null = null;
      if (c.linkId) {
        if (!links.has(c.linkId)) links.set(c.linkId, uid('l'));
        linkId = links.get(c.linkId)!;
      }
      return { ...c, id: uid('c'), trackId: dest(p.seq, c), linkId, start: at + (c.start - cb.min) };
    });
    ids = fresh.map((c) => c.id);
    end = Math.max(...fresh.map(clipEnd));
    return withSeq(p, overwriteClips(p.seq, fresh, mediaLookup(p)));
  });
  useVideo.setState({ selection: ids, gap: null, transition: null });
  transport.seek(end);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Clip properties

export function toggleEnable() {
  const cl = selectedClips();
  if (!cl.length) return;
  const on = !cl.every((c) => c.enabled);
  edit(on ? 'Enable' : 'Disable', (p) => mapClips(p, new Set(cl.map((c) => c.id)), (c) => ({ ...c, enabled: on })));
}

export function unlinkSelection() {
  const ids = new Set(getState().selection);
  edit('Unlink', (p) => mapClips(p, ids, (c) => ({ ...c, linkId: null })));
}

export function linkSelection() {
  const cl = selectedClips();
  if (cl.length < 2) return;
  const link = uid('l');
  edit('Link', (p) => mapClips(p, new Set(cl.map((c) => c.id)), (c) => ({ ...c, linkId: link })));
}

export function setSpeed(ids: string[], speed: number, ripple: boolean, maintainPitch: boolean, duration?: number) {
  edit('Speed/Duration', (p) => {
    const set = withLinked(p.seq, ids);
    let s = changeSpeed(p.seq, set, speed, ripple, mediaLookup(p), duration);
    s = { ...s, clips: s.clips.map((c) => (set.has(c.id) ? { ...c, maintainPitch } : c)) };
    return withSeq(p, s);
  });
}

export function toggleFit() {
  const cl = selectedClips();
  if (!cl.length) return;
  const on = !cl.every((c) => c.fit);
  edit('Scale to Frame Size', (p) => mapClips(p, new Set(cl.map((c) => c.id)), (c) => ({ ...c, fit: on })));
}

export function renameClip(id: string, name: string) {
  edit('Rename Clip', (p) => mapClips(p, id, (c) => ({ ...c, name })));
}

// ---------------------------------------------------------------------------------------------
// Transitions & effects

export const DEFAULT_TRANSITION_SEC = 1;

/** Adds a transition at a clip edge; at a cut it's stored on the incoming clip (centred). */
export function addTransition(clipId: string, edge: 'in' | 'out', type: TransitionType, durationFrames?: number) {
  const seq = getSeq();
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) return;
  const kind = trackOf(seq, c.trackId)?.kind;
  const d = durationFrames ?? Math.round(DEFAULT_TRANSITION_SEC * exactFps(seq.fps));
  if (kind === 'audio') {
    // Audio "transitions" are fades.
    edit('Add Audio Fade', (p) => mapClips(p, clipId, (x) => (edge === 'in' ? { ...x, fadeIn: Math.min(x.duration, d) } : { ...x, fadeOut: Math.min(x.duration, d) })));
    return;
  }
  const neighbour =
    edge === 'in'
      ? seq.clips.find((x) => x.trackId === c.trackId && clipEnd(x) === c.start && x.id !== c.id)
      : seq.clips.find((x) => x.trackId === c.trackId && x.start === clipEnd(c) && x.id !== c.id);
  const t = makeTransition(type, d);
  edit(`Add ${type === 'crossDissolve' ? 'Cross Dissolve' : 'Transition'}`, (p) => {
    if (neighbour) {
      const incoming = edge === 'in' ? c : neighbour;
      const outgoing = edge === 'in' ? neighbour : c;
      const dd = Math.min(t.duration, incoming.duration + outgoing.duration);
      let q = mapClips(p, incoming.id, (x) => ({ ...x, transIn: { ...t, duration: dd } }));
      q = mapClips(q, outgoing.id, (x) => ({ ...x, transOut: null }));
      return q;
    }
    return mapClips(p, clipId, (x) => {
      const dd = Math.min(t.duration, x.duration);
      return edge === 'in' ? { ...x, transIn: { ...t, duration: dd } } : { ...x, transOut: { ...t, duration: dd } };
    });
  });
  useVideo.setState({ transition: { clipId: neighbour && edge === 'out' ? neighbour.id : clipId, edge: neighbour ? 'in' : edge }, selection: [], gap: null });
}

/** ⇧D: default transition at both ends of the selected clips. */
export function applyDefaultTransitions(type: TransitionType = 'crossDissolve') {
  const cl = selectedClips();
  const seq = getSeq();
  const vt = new Set(tracksOf(seq, 'video').map((t) => t.id));
  const d = Math.round(DEFAULT_TRANSITION_SEC * exactFps(seq.fps));
  const ids = new Set(cl.map((c) => c.id));
  if (!ids.size) return toast('Select clips first.', 'info');
  edit('Apply Default Transitions', (p) => {
    let q = p;
    for (const c of cl) {
      if (!vt.has(c.trackId)) {
        q = mapClips(q, c.id, (x) => ({ ...x, fadeIn: Math.min(x.duration, d), fadeOut: Math.min(x.duration, d) }));
        continue;
      }
      const prev = q.seq.clips.find((x) => x.trackId === c.trackId && clipEnd(x) === c.start);
      const next = q.seq.clips.find((x) => x.trackId === c.trackId && x.start === clipEnd(c));
      q = mapClips(q, c.id, (x) => ({ ...x, transIn: x.transIn ?? makeTransition(type, Math.min(d, x.duration)), transOut: next ? null : x.transOut ?? makeTransition(type, Math.min(d, x.duration)) }));
      if (next && !next.transIn) q = mapClips(q, next.id, (x) => ({ ...x, transIn: makeTransition(type, d) }));
      if (prev) q = mapClips(q, prev.id, (x) => ({ ...x, transOut: null }));
    }
    return q;
  });
}

/** ⌘D: default transition at the edit point nearest the playhead on the target video track. */
export function applyTransitionAtPlayhead(type: TransitionType = 'crossDissolve') {
  const seq = getSeq();
  const f = transport.frameInt;
  const tt = targetTracks(seq).video;
  const onTrack = seq.clips.filter((c) => c.trackId === tt.id);
  let best: { clip: Clip; edge: 'in' | 'out'; dist: number } | null = null;
  for (const c of onTrack) {
    for (const [edge, pos] of [
      ['in', c.start],
      ['out', clipEnd(c)],
    ] as const) {
      const dist = Math.abs(pos - f);
      if (!best || dist < best.dist) best = { clip: c, edge, dist };
    }
  }
  if (!best) return toast('No edit point on the target video track.', 'info');
  addTransition(best.clip.id, best.edge, type);
}

export function addEffectToClips(ids: string[], type: FxType | 'lumetri') {
  const seq = getSeq();
  const vt = new Set(tracksOf(seq, 'video').map((t) => t.id));
  const target = new Set(ids.filter((id) => vt.has(seq.clips.find((c) => c.id === id)?.trackId ?? '')));
  if (!target.size) return toast('Video effects apply to clips on video tracks.', 'info');
  if (type === 'lumetri') edit('Add Lumetri Color', (p) => mapClips(p, target, (c) => (c.lumetri ? { ...c, lumetri: { ...c.lumetri, enabled: true } } : { ...c, lumetri: makeLumetri() })));
  else edit(`Add Effect`, (p) => mapClips(p, target, (c) => ({ ...c, fx: [...c.fx, makeEffect(type)] })));
}

// ---------------------------------------------------------------------------------------------
// Markers & sequence in/out

export function addMarker() {
  const f = transport.frameInt;
  const seq = getSeq();
  if (seq.markers.some((m) => m.frame === f)) return;
  edit('Add Marker', (p) => ({ ...p, seq: { ...p.seq, markers: [...p.seq.markers, { id: uid('mk'), frame: f, name: '', color: '#3fbf6f', comment: '' }].sort((a, b) => a.frame - b.frame) } }));
}

export function removeMarker(id: string) {
  edit('Delete Marker', (p) => ({ ...p, seq: { ...p.seq, markers: p.seq.markers.filter((m) => m.id !== id) } }));
}

export function setSeqInOut(which: 'in' | 'out' | 'clear' | 'clearIn' | 'clearOut', frame = transport.frameInt) {
  edit(which === 'in' ? 'Mark In' : which === 'out' ? 'Mark Out' : 'Clear In/Out', (p) => {
    const s = p.seq;
    let inPoint = s.inPoint;
    let outPoint = s.outPoint;
    if (which === 'in') {
      inPoint = frame;
      if (outPoint !== null && outPoint <= frame) outPoint = null;
    } else if (which === 'out') {
      outPoint = frame + 1;
      if (inPoint !== null && inPoint >= outPoint) inPoint = null;
    } else if (which === 'clear') inPoint = outPoint = null;
    else if (which === 'clearIn') inPoint = null;
    else outPoint = null;
    return { ...p, seq: { ...s, inPoint, outPoint } };
  });
}

/** ; (lift) / ' (extract) the sequence In→Out range on unlocked tracks. */
export function liftExtract(ripple: boolean) {
  const seq = getSeq();
  if (seq.inPoint === null || seq.outPoint === null) return toast('Set In and Out points first (I / O).', 'info');
  const tracks = new Set(seq.tracks.filter((t) => !t.locked).map((t) => t.id));
  const s0 = seq.inPoint;
  const e0 = seq.outPoint;
  edit(ripple ? 'Extract' : 'Lift', (p) => withSeq(p, { ...removeRange(p.seq, s0, e0, tracks, mediaLookup(p), ripple), inPoint: ripple ? null : p.seq.inPoint, outPoint: ripple ? null : p.seq.outPoint }));
  if (ripple) transport.seek(s0);
}

// ---------------------------------------------------------------------------------------------
// Navigation

export function gotoEdit(dir: 1 | -1) {
  const pts = editPoints(getSeq());
  const f = transport.frameInt;
  const t = dir > 0 ? pts.find((p) => p > f) : [...pts].reverse().find((p) => p < f);
  if (t !== undefined) transport.seek(t);
}

export function step(frames: number) {
  if (transport.playing) transport.pause();
  transport.seek(Math.max(0, transport.frameInt + frames));
}

/** J/K/L shuttle. */
export function shuttle(dir: 1 | -1 | 0) {
  if (dir === 0) return transport.pause();
  const cur = transport.playing ? transport.rate : 0;
  let next: number;
  if (Math.sign(cur) === dir) next = Math.min(8, Math.abs(cur) * 2) * dir;
  else next = dir;
  transport.play(next);
}

// ---------------------------------------------------------------------------------------------
// Bin items

export function newGeneratedItem(kind: Extract<MediaKind, 'title' | 'matte' | 'adjustment'>, color = '#1e1e1e'): MediaItem {
  const seq = getSeq();
  const count = getProject().media.filter((m) => m.kind === kind).length + 1;
  const name = kind === 'title' ? `Title ${String(count).padStart(2, '0')}` : kind === 'matte' ? `Color Matte ${count}` : `Adjustment Layer ${count}`;
  const item: MediaItem = {
    id: uid('m'),
    kind,
    name,
    duration: 0,
    width: seq.width,
    height: seq.height,
    fps: 0,
    hasVideo: true,
    hasAudio: false,
    title: kind === 'title' ? defaultTitle() : undefined,
    color: kind === 'matte' ? color : undefined,
  };
  edit(`New ${name}`, (p) => ({ ...p, media: [...p.media, item] }));
  useVideo.setState({ binSelection: [item.id] });
  return item;
}

export async function removeMedia(ids: string[]) {
  const p = getProject();
  const set = new Set(ids);
  const used = p.seq.clips.filter((c) => set.has(c.mediaId)).length;
  if (used && !(await confirmDialog(`${used} clip${used > 1 ? 's' : ''} in the sequence use${used > 1 ? '' : 's'} this media and will be removed too.`, { title: 'Clear Media', ok: 'Remove', danger: true }))) return;
  edit(ids.length > 1 ? `Clear ${ids.length} items` : 'Clear', (q) => ({ ...q, media: q.media.filter((m) => !set.has(m.id)), seq: { ...q.seq, clips: q.seq.clips.filter((c) => !set.has(c.mediaId)) } }));
}

export function renameMedia(id: string, name: string) {
  edit('Rename', (p) => ({ ...p, media: p.media.map((m) => (m.id === id ? { ...m, name } : m)) }));
}

export function setMediaMarks(id: string, markIn: number | null | undefined, markOut: number | null | undefined) {
  edit(
    'Source Marks',
    (p) => ({ ...p, media: p.media.map((m) => (m.id === id ? { ...m, ...(markIn !== undefined ? { markIn } : {}), ...(markOut !== undefined ? { markOut } : {}) } : m)) }),
    true,
  );
}

/** Applies new sequence settings (frame-rate change converts every timing). */
export function setSequenceSettings(patch: { name?: string; width?: number; height?: number; fps?: number; bg?: string }) {
  const oldFps = getSeq().fps;
  const changed = edit('Sequence Settings', (p) => {
    let s: Sequence = { ...p.seq };
    if (patch.fps && Math.abs(patch.fps - s.fps) > 1e-6) s = convertFps(s, patch.fps);
    if (patch.name !== undefined) s.name = patch.name;
    if (patch.width) s.width = patch.width;
    if (patch.height) s.height = patch.height;
    if (patch.bg) s.bg = patch.bg;
    return { ...p, seq: s };
  });
  // Keep the playhead on the same moment (frame numbers were re-timed).
  if (changed && patch.fps && Math.abs(patch.fps - oldFps) > 1e-6) transport.seek((transport.frameInt * exactFps(patch.fps)) / exactFps(oldFps));
}

