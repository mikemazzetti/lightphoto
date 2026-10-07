import { defaultSettings, normalizeSettings } from '@/core/develop/settings';
import { uid } from '@/core/util/async';
import type { Clip, Effect, FxType, Lumetri, MediaItem, Motion, Project, Sequence, TitleSpec, Track, TrackKind, Transition, TransitionType } from './types';
import { FX_PARAMS } from './types';

export const DEFAULT_TRACK_HEIGHT = { video: 52, audio: 44 } as const;

export function defaultMotion(): Motion {
  return { x: 0, y: 0, scale: 100, uniform: true, scaleW: 100, rotation: 0, anchorX: 0, anchorY: 0, cropL: 0, cropT: 0, cropR: 0, cropB: 0 };
}

export function defaultTitle(): TitleSpec {
  return {
    text: 'Title',
    font: 'Helvetica Neue, Arial, sans-serif',
    size: 110,
    weight: 700,
    italic: false,
    color: '#ffffff',
    align: 'center',
    x: 0.5,
    y: 0.5,
    lineHeight: 1.15,
    tracking: 0,
    stroke: { on: false, color: '#000000', width: 4 },
    shadow: { on: true, color: '#000000', blur: 12, dx: 0, dy: 4, opacity: 0.6 },
    box: { on: false, color: '#000000', opacity: 0.6, padding: 24 },
  };
}

export function makeTrack(kind: TrackKind, index: number): Track {
  return {
    id: uid('t'),
    kind,
    name: `${kind === 'video' ? 'V' : 'A'}${index + 1}`,
    hidden: false,
    locked: false,
    muted: false,
    solo: false,
    syncLock: true,
    height: DEFAULT_TRACK_HEIGHT[kind],
    volume: 0,
  };
}

export function defaultSequence(): Sequence {
  return {
    name: 'Sequence 01',
    width: 1920,
    height: 1080,
    fps: 30,
    bg: '#000000',
    tracks: [makeTrack('video', 0), makeTrack('video', 1), makeTrack('video', 2), makeTrack('audio', 0), makeTrack('audio', 1), makeTrack('audio', 2)],
    clips: [],
    markers: [],
    inPoint: null,
    outPoint: null,
  };
}

export function defaultProject(): Project {
  return { version: 1, name: 'Untitled Project', media: [], seq: defaultSequence() };
}

export function makeClip(media: MediaItem, trackId: string, start: number, duration: number, inPoint: number, kind: TrackKind): Clip {
  return {
    id: uid('c'),
    mediaId: media.id,
    trackId,
    name: media.name,
    start,
    duration,
    inPoint,
    speed: 1,
    maintainPitch: true,
    enabled: true,
    linkId: null,
    fadeIn: 0,
    fadeOut: 0,
    transIn: null,
    transOut: null,
    motion: defaultMotion(),
    opacity: 100,
    blend: 'normal',
    fit: media.kind === 'video' || media.kind === 'image',
    lumetri: null,
    fx: [],
    title: kind === 'video' && media.kind === 'title' ? structuredClone(media.title ?? defaultTitle()) : undefined,
    color: kind === 'video' && media.kind === 'matte' ? media.color ?? '#000000' : undefined,
    volume: 0,
    pan: 0,
    kf: {},
  };
}

export function makeTransition(type: TransitionType, duration: number): Transition {
  return { type, duration: Math.max(1, Math.round(duration)), align: 'center', direction: 0 };
}

export function makeEffect(type: FxType): Effect {
  const params: Record<string, number | string | boolean> = {};
  for (const p of FX_PARAMS[type]) params[p.key] = p.def;
  if (type === 'tint') {
    params.black = '#000000';
    params.white = '#ffffff';
  }
  if (type === 'blur') params.repeatEdges = true;
  if (type === 'invert') params.channel = 'rgb';
  return { id: uid('fx'), type, enabled: true, params };
}

export function makeLumetri(): Lumetri {
  return { enabled: true, s: defaultSettings(), faded: 0 };
}

const MEDIA_KINDS = new Set(['video', 'audio', 'image', 'title', 'matte', 'adjustment']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Keyframe lists must be arrays of numeric {t, v}, sorted by time. */
function normalizeKf(kf: unknown): Clip['kf'] {
  const out: Clip['kf'] = {};
  if (!isObj(kf)) return out;
  for (const [k, v] of Object.entries(kf)) {
    if (!Array.isArray(v)) continue;
    const list = v.filter((x: any) => isObj(x) && finite(x.t) && finite(x.v)).sort((a: any, b: any) => a.t - b.t);
    if (list.length) out[k] = list;
  }
  return out;
}

/** Repairs older / partial / hand-edited project JSON (drops entries that would break the engine). */
export function normalizeProject(p: any): Project {
  const d = defaultProject();
  if (!isObj(p)) return d;
  const ps = isObj(p.seq) ? p.seq : {};
  const seq: Sequence = { ...d.seq, ...ps };
  if (!finite(seq.fps) || seq.fps <= 0) seq.fps = d.seq.fps;
  if (!finite(seq.width) || seq.width < 2) seq.width = d.seq.width;
  if (!finite(seq.height) || seq.height < 2) seq.height = d.seq.height;
  if (typeof seq.bg !== 'string') seq.bg = d.seq.bg;
  seq.inPoint = finite(seq.inPoint) ? Math.max(0, Math.round(seq.inPoint)) : null;
  seq.outPoint = finite(seq.outPoint) ? Math.max(0, Math.round(seq.outPoint)) : null;
  const rawTracks = Array.isArray(ps.tracks) ? ps.tracks.filter((t: any) => isObj(t) && typeof t.id === 'string') : [];
  seq.tracks = (rawTracks.length ? rawTracks : d.seq.tracks).map((t: any, i: number) => ({ ...makeTrack(t.kind === 'audio' ? 'audio' : 'video', i), ...t, kind: t.kind === 'audio' ? 'audio' : 'video' }));
  if (!seq.tracks.some((t) => t.kind === 'video')) seq.tracks.unshift(makeTrack('video', 0));
  if (!seq.tracks.some((t) => t.kind === 'audio')) seq.tracks.push(makeTrack('audio', 0));
  seq.tracks = [...seq.tracks.filter((t) => t.kind === 'video'), ...seq.tracks.filter((t) => t.kind === 'audio')];
  const trackIds = new Set(seq.tracks.map((t) => t.id));
  const media: MediaItem[] = (Array.isArray(p.media) ? p.media : [])
    .filter((m: any) => isObj(m) && typeof m.id === 'string' && MEDIA_KINDS.has(m.kind))
    .map((m: any) => ({ ...m, name: typeof m.name === 'string' ? m.name : 'Untitled', duration: finite(m.duration) ? Math.max(0, m.duration) : 0, width: finite(m.width) ? m.width : 0, height: finite(m.height) ? m.height : 0, fps: finite(m.fps) ? m.fps : 0 }));
  const seen = new Set<string>();
  seq.clips = (Array.isArray(ps.clips) ? ps.clips : [])
    .filter((c: any) => {
      // Timing must be numeric (NaN would poison every edit/render) and ids unique (selection, voices).
      if (!isObj(c) || typeof c.id !== 'string' || seen.has(c.id) || typeof c.mediaId !== 'string' || !trackIds.has(c.trackId) || !finite(c.start) || !finite(c.duration)) return false;
      seen.add(c.id);
      return true;
    })
    .map((c: any) => ({
      ...makeClipShell(),
      ...c,
      name: typeof c.name === 'string' ? c.name : '',
      start: Math.max(0, Math.round(c.start)),
      duration: Math.max(1, Math.round(c.duration)),
      inPoint: finite(c.inPoint) ? Math.max(0, c.inPoint) : 0,
      speed: finite(c.speed) && c.speed > 0 ? c.speed : 1,
      fadeIn: finite(c.fadeIn) ? Math.max(0, Math.round(c.fadeIn)) : 0,
      fadeOut: finite(c.fadeOut) ? Math.max(0, Math.round(c.fadeOut)) : 0,
      transIn: isObj(c.transIn) && finite(c.transIn.duration) ? { ...c.transIn, duration: Math.max(1, Math.round(c.transIn.duration)) } : null,
      transOut: isObj(c.transOut) && finite(c.transOut.duration) ? { ...c.transOut, duration: Math.max(1, Math.round(c.transOut.duration)) } : null,
      motion: { ...defaultMotion(), ...(isObj(c.motion) ? c.motion : {}) },
      lumetri: isObj(c.lumetri) ? { enabled: c.lumetri.enabled ?? true, faded: c.lumetri.faded ?? 0, s: normalizeSettings(c.lumetri.s) } : null,
      fx: Array.isArray(c.fx) ? c.fx.filter((e: any) => isObj(e) && typeof e.id === 'string' && Object.hasOwn(FX_PARAMS, e.type) && isObj(e.params)) : [],
      kf: normalizeKf(c.kf),
    }));
  seq.markers = Array.isArray(ps.markers) ? ps.markers.filter((m: any) => isObj(m) && typeof m.id === 'string' && finite(m.frame)) : [];
  return { version: 1, name: typeof p.name === 'string' ? p.name : d.name, media, seq };
}

function makeClipShell(): Omit<Clip, 'id' | 'mediaId' | 'trackId' | 'name' | 'start' | 'duration' | 'inPoint'> {
  return {
    speed: 1,
    maintainPitch: true,
    enabled: true,
    linkId: null,
    fadeIn: 0,
    fadeOut: 0,
    transIn: null,
    transOut: null,
    motion: defaultMotion(),
    opacity: 100,
    blend: 'normal',
    fit: true,
    lumetri: null,
    fx: [],
    volume: 0,
    pan: 0,
    kf: {},
  };
}

export const RESOLUTION_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '3840 × 2160 (4K UHD)', w: 3840, h: 2160 },
  { label: '2560 × 1440 (QHD)', w: 2560, h: 1440 },
  { label: '1920 × 1080 (Full HD)', w: 1920, h: 1080 },
  { label: '1280 × 720 (HD)', w: 1280, h: 720 },
  { label: '1080 × 1920 (Vertical)', w: 1080, h: 1920 },
  { label: '1080 × 1350 (Portrait 4:5)', w: 1080, h: 1350 },
  { label: '1080 × 1080 (Square)', w: 1080, h: 1080 },
];
