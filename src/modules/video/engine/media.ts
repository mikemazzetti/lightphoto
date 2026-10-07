/**
 * Media I/O: probing (mediabunny, falling back to a <video> element), poster frames, filmstrip
 * thumbnails, waveform peaks and audio sources for playback/export. All caches are in memory
 * (module-level) and filled in the background with bounded concurrency.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, EncodedPacketSink, Input, InputAudioTrack, InputVideoTrack, UrlSource } from 'mediabunny';
import { decodeBitmap } from '@/core/image/decode';
import { limit, uid } from '@/core/util/async';
import { api, basename, kindOf, stem } from '@/platform/api';
import { errorToast, startTask, toast } from '@/state/app';
import { snapFps } from '../model/time';
import type { MediaItem } from '../model/types';
import { bumpMediaVersion, edit, getProject, getState, replaceProject } from '../state/store';

// ---------------------------------------------------------------------------------------------
// Inputs

const inputCache = new Map<string, Promise<Input>>();
const INPUT_CACHE_MAX = 24;

async function createInput(path: string): Promise<Input> {
  if (api.isElectron) {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(api.fileUrl(path), { maxCacheSize: 16 * 1024 * 1024 }) });
    try {
      if (await input.canRead()) return input;
    } catch {
      /* fall through */
    }
    input.dispose();
  }
  const blob = await api.readBlob(path);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  if (!(await input.canRead())) {
    input.dispose();
    throw new Error('Unsupported container');
  }
  return input;
}

/** Shared (cached) demuxer for a file. Don't dispose it. */
export function getInput(path: string): Promise<Input> {
  let p = inputCache.get(path);
  if (p) {
    inputCache.delete(path);
    inputCache.set(path, p);
    return p;
  }
  p = createInput(path);
  inputCache.set(path, p);
  p.catch(() => inputCache.delete(path));
  // Evicted inputs are just dropped (not disposed): long-running decodes may still hold them; they
  // are garbage-collected once unreferenced.
  while (inputCache.size > INPUT_CACHE_MAX) inputCache.delete(inputCache.keys().next().value!);
  return p;
}

/** A private Input (caller disposes) — used by export so its decoders don't fight playback. */
export const openInput = (path: string) => createInput(path);

// ---------------------------------------------------------------------------------------------
// Probing

function probeWithElement(path: string, kind: 'video' | 'audio'): Promise<Partial<MediaItem>> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.crossOrigin = 'anonymous';
    el.preload = 'metadata';
    el.muted = true;
    const done = () => {
      el.removeAttribute('src');
      el.load();
    };
    const t = setTimeout(() => {
      done();
      reject(new Error('Timed out reading media metadata'));
    }, 15000);
    el.onloadedmetadata = () => {
      clearTimeout(t);
      const v = el as HTMLVideoElement;
      const w = kind === 'video' ? v.videoWidth : 0;
      const h = kind === 'video' ? v.videoHeight : 0;
      const res: Partial<MediaItem> = {
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        width: w,
        height: h,
        hasVideo: w > 0,
        hasAudio: kind === 'audio' || true,
        fps: w > 0 ? 30 : 0,
        probeFallback: true,
      };
      done();
      resolve(res);
    };
    el.onerror = () => {
      clearTimeout(t);
      done();
      reject(new Error('This file format is not supported.'));
    };
    el.src = api.fileUrl(path);
  });
}

export async function probe(path: string): Promise<Omit<MediaItem, 'id'>> {
  const k = kindOf(path);
  const name = basename(path);
  if (k === 'image' || k === 'raw') {
    const bmp = await loadImage(path);
    return { kind: 'image', name, path, duration: 0, width: bmp.width, height: bmp.height, fps: 0, hasVideo: true, hasAudio: false };
  }
  if (k !== 'video' && k !== 'audio') throw new Error('Unsupported file type');
  try {
    const input = await getInput(path);
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    if (!vt && !at) throw new Error('No audio or video tracks');
    let duration = (await input.getDurationFromMetadata().catch(() => null)) ?? 0;
    if (!duration || !Number.isFinite(duration)) duration = await input.computeDuration();
    const item: Omit<MediaItem, 'id'> = {
      kind: vt ? 'video' : 'audio',
      name,
      path,
      duration,
      width: 0,
      height: 0,
      fps: 0,
      hasVideo: !!vt,
      hasAudio: !!at,
    };
    if (vt) {
      item.width = await vt.getDisplayWidth();
      item.height = await vt.getDisplayHeight();
      item.videoCodec = (await vt.getCodec()) ?? undefined;
      try {
        const stats = await vt.computePacketStats(90);
        item.fps = snapFps(stats.averagePacketRate);
      } catch {
        item.fps = 30;
      }
      if (!item.fps) item.fps = 30;
    }
    if (at) {
      item.audioCodec = (await at.getCodec()) ?? undefined;
      item.sampleRate = await at.getSampleRate();
      item.channels = await at.getNumberOfChannels();
    }
    return item;
  } catch (e) {
    // mediabunny can't parse it — try the browser's own demuxer.
    const r = await probeWithElement(path, k);
    return { kind: r.hasVideo ? 'video' : 'audio', name, path, duration: r.duration ?? 0, width: r.width ?? 0, height: r.height ?? 0, fps: r.fps ?? 0, hasVideo: !!r.hasVideo, hasAudio: !!r.hasAudio, probeFallback: true };
  }
}

// ---------------------------------------------------------------------------------------------
// Images (stills on the timeline)

const imageCache = new Map<string, Promise<ImageBitmap>>();
export const IMAGE_MAX = 4096;

export function loadImage(path: string): Promise<ImageBitmap> {
  let p = imageCache.get(path);
  if (!p) {
    p = decodeBitmap(path, IMAGE_MAX);
    imageCache.set(path, p);
    p.catch(() => imageCache.delete(path));
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Posters, filmstrips, waveforms

export interface Filmstrip {
  /** Seconds between frames. */
  interval: number;
  frames: (ImageBitmap | null)[];
  width: number;
  height: number;
}
export interface Peaks {
  /** Buckets per second of levels[0]; each next level is 10× coarser. */
  rate: number;
  levels: Float32Array[];
  duration: number;
}

export const posters = new Map<string, ImageBitmap>();
export const filmstrips = new Map<string, Filmstrip>();
export const peaks = new Map<string, Peaks>();
const pending = new Set<string>();
const bg = limit(2);
const FILM_H = 72;

let bumpTimer: ReturnType<typeof setTimeout> | null = null;
function bumpSoon() {
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    bumpMediaVersion();
  }, 120);
}

/** Starts background analysis for an item (idempotent). */
export function analyze(m: MediaItem) {
  if (!m.path || m.missing) return;
  if (m.kind === 'video' && m.hasVideo && !pending.has('p' + m.id) && !posters.has(m.id)) {
    pending.add('p' + m.id);
    void bg(() => makePoster(m)).finally(() => pending.delete('p' + m.id));
  }
  if (m.kind === 'image' && !posters.has(m.id) && !pending.has('p' + m.id)) {
    pending.add('p' + m.id);
    void loadImage(m.path)
      .then(async (b) => {
        const k = 200 / Math.max(b.width, b.height);
        posters.set(m.id, await createImageBitmap(b, { resizeWidth: Math.max(1, Math.round(b.width * k)), resizeHeight: Math.max(1, Math.round(b.height * k)), resizeQuality: 'medium' }));
        bumpSoon();
      })
      .catch(() => {})
      .finally(() => pending.delete('p' + m.id));
  }
  if ((m.kind === 'video' || m.kind === 'audio') && m.hasAudio && !peaks.has(m.id) && !pending.has('w' + m.id)) {
    pending.add('w' + m.id);
    void bg(() => makePeaks(m)).finally(() => pending.delete('w' + m.id));
  }
  if (m.kind === 'video' && m.hasVideo && !filmstrips.has(m.id) && !pending.has('f' + m.id)) {
    pending.add('f' + m.id);
    void bg(() => makeFilmstrip(m)).finally(() => pending.delete('f' + m.id));
  }
}

async function videoTrackOf(m: MediaItem): Promise<InputVideoTrack | null> {
  if (m.probeFallback) return null;
  const input = await getInput(m.path!);
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) return null;
  return vt;
}

/** Grabs one frame with a throwaway <video> element (fallback for files mediabunny can't decode). */
function grabWithElement(m: MediaItem, t: number, h: number): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.preload = 'auto';
    const cleanup = () => {
      v.removeAttribute('src');
      v.load();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, 15000);
    v.onloadeddata = () => {
      v.currentTime = Math.min(t, Math.max(0, (v.duration || 0) - 0.05));
    };
    v.onseeked = async () => {
      clearTimeout(timer);
      try {
        const w = Math.round((v.videoWidth / Math.max(1, v.videoHeight)) * h);
        resolve(await createImageBitmap(v, { resizeWidth: Math.max(1, w), resizeHeight: h, resizeQuality: 'medium' }));
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('decode error'));
    };
    v.src = api.fileUrl(m.path!);
  });
}

async function makePoster(m: MediaItem) {
  const t = Math.min(1, m.duration * 0.1);
  try {
    const vt = await videoTrackOf(m);
    if (vt) {
      const sink = new CanvasSink(vt, { height: 120, fit: 'contain' });
      const first = await vt.getFirstTimestamp();
      const c = await sink.getCanvas(first + t);
      if (c) {
        posters.set(m.id, await createImageBitmap(c.canvas));
        bumpSoon();
        return;
      }
    }
    posters.set(m.id, await grabWithElement(m, t, 120));
    bumpSoon();
  } catch (e) {
    console.warn('poster failed', m.name, e);
  }
}

async function makeFilmstrip(m: MediaItem) {
  const dur = Math.max(0.04, m.duration);
  const interval = dur <= 30 ? 0.5 : dur <= 120 ? 1 : dur / 160;
  const n = Math.max(1, Math.ceil(dur / interval));
  const w = Math.max(16, Math.round((m.width / Math.max(1, m.height)) * FILM_H));
  const strip: Filmstrip = { interval, frames: new Array(n).fill(null), width: w, height: FILM_H };
  filmstrips.set(m.id, strip);
  try {
    const vt = await videoTrackOf(m);
    if (!vt) {
      // Element fallback: a handful of frames only.
      const k = Math.min(n, 12);
      for (let i = 0; i < k; i++) {
        const idx = Math.floor((i / k) * n);
        strip.frames[idx] = await grabWithElement(m, idx * interval, FILM_H).catch(() => null);
        bumpSoon();
      }
      return;
    }
    const sink = new CanvasSink(vt, { width: w, height: FILM_H, fit: 'cover', poolSize: 2 });
    const first = await vt.getFirstTimestamp();
    let times = Array.from({ length: n }, (_, i) => first + i * interval + 0.001);
    if (dur > 60) {
      // Long files: one decode per thumbnail by snapping to key frames.
      const ps = new EncodedPacketSink(vt);
      const snapped: number[] = [];
      for (const t of times) {
        const kp = await ps.getKeyPacket(t, { metadataOnly: true }).catch(() => null);
        snapped.push(kp ? Math.max(kp.timestamp, snapped[snapped.length - 1] ?? -Infinity) + 0.0001 : t);
      }
      times = snapped;
    }
    let i = 0;
    let lastBump = performance.now();
    for await (const c of sink.canvasesAtTimestamps(times)) {
      if (c) strip.frames[i] = await createImageBitmap(c.canvas);
      i++;
      if (performance.now() - lastBump > 400) {
        lastBump = performance.now();
        bumpSoon();
      }
    }
    // Fill holes with neighbours.
    for (let j = 1; j < n; j++) if (!strip.frames[j]) strip.frames[j] = strip.frames[j - 1];
    bumpSoon();
  } catch (e) {
    console.warn('filmstrip failed', m.name, e);
  }
}

const PEAK_RATE = 100;

function finishPeaks(base: Float32Array, duration: number): Peaks {
  const levels = [base];
  let cur = base;
  while (cur.length > 64) {
    const n = Math.ceil(cur.length / 10);
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let mx = 0;
      const e = Math.min(cur.length, (i + 1) * 10);
      for (let j = i * 10; j < e; j++) if (cur[j] > mx) mx = cur[j];
      next[i] = mx;
    }
    levels.push(next);
    cur = next;
  }
  return { rate: PEAK_RATE, levels, duration };
}

function accumulate(out: Float32Array, buf: AudioBuffer, t0: number) {
  const sr = buf.sampleRate;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const len = buf.length;
  const step = sr / PEAK_RATE;
  let i = 0;
  while (i < len) {
    const tt = t0 + i / sr;
    const b = Math.floor(tt * PEAK_RATE);
    const bEnd = Math.min(len, Math.ceil(((b + 1) / PEAK_RATE - t0) * sr));
    const stop = Math.max(i + 1, Math.min(bEnd, i + Math.ceil(step)));
    let mx = 0;
    for (const ch of chans)
      for (let j = i; j < stop; j++) {
        const v = ch[j] < 0 ? -ch[j] : ch[j];
        if (v > mx) mx = v;
      }
    if (b >= 0 && b < out.length && mx > out[b]) out[b] = mx;
    i = stop;
  }
}

async function makePeaks(m: MediaItem) {
  const dur = Math.max(0.01, m.duration);
  const out = new Float32Array(Math.ceil(dur * PEAK_RATE) + 1);
  try {
    const prov = await getAudioProvider(m);
    if (prov.kind === 'none') return;
    let lastBump = performance.now();
    for await (const { buffer, timestamp } of audioChunks(prov, 0, dur + 1)) {
      accumulate(out, buffer, timestamp);
      if (performance.now() - lastBump > 500) {
        lastBump = performance.now();
        peaks.set(m.id, { rate: PEAK_RATE, levels: [out], duration: dur });
        bumpSoon();
      }
    }
    peaks.set(m.id, finishPeaks(out, dur));
    bumpSoon();
  } catch (e) {
    console.warn('waveform failed', m.name, e);
  }
}

// ---------------------------------------------------------------------------------------------
// Audio sources

export type AudioProvider = { kind: 'sink'; path: string } | { kind: 'buffer'; buffer: AudioBuffer } | { kind: 'none' };

const audioProviders = new Map<string, Promise<AudioProvider>>();

async function decodeWhole(path: string): Promise<AudioBuffer | null> {
  const st = await api.stat(path).catch(() => null);
  if (st && st.size > 400 * 1024 * 1024) return null;
  const data = await api.readFile(path);
  const ctx = new OfflineAudioContext(2, 1, 48000);
  return ctx.decodeAudioData(data);
}

/** How the audio of a media item can be decoded (streaming via mediabunny, or a fully decoded buffer). */
export function getAudioProvider(m: MediaItem): Promise<AudioProvider> {
  if (!m.path || !m.hasAudio) return Promise.resolve({ kind: 'none' });
  // Keyed by file (not item id): undoing a relink / Replace Footage must not keep playing the other file.
  let p = audioProviders.get(m.path);
  if (p) return p;
  p = (async (): Promise<AudioProvider> => {
    if (!m.probeFallback) {
      try {
        const input = await getInput(m.path!);
        const at = await input.getPrimaryAudioTrack();
        if (at && (await at.canDecode())) return { kind: 'sink', path: m.path! };
      } catch {
        /* fall back */
      }
    }
    try {
      const buf = await decodeWhole(m.path!);
      if (buf) return { kind: 'buffer', buffer: buf };
    } catch {
      /* no audio */
    }
    return { kind: 'none' };
  })();
  audioProviders.set(m.path, p);
  return p;
}

export interface AudioChunk {
  buffer: AudioBuffer;
  /** Source time (seconds) of the first sample. */
  timestamp: number;
}

/** Decoded audio covering [start, end) seconds of the source, in order. */
export async function* audioChunks(p: AudioProvider, start: number, end: number): AsyncGenerator<AudioChunk> {
  if (p.kind === 'buffer') {
    yield { buffer: p.buffer, timestamp: 0 };
    return;
  }
  if (p.kind !== 'sink') return;
  const input = await getInput(p.path);
  const track: InputAudioTrack | null = await input.getPrimaryAudioTrack();
  if (!track) return;
  const sink = new AudioBufferSink(track);
  for await (const w of sink.buffers(Math.max(0, start), end)) yield { buffer: w.buffer, timestamp: w.timestamp };
}

// ---------------------------------------------------------------------------------------------
// Import

const importQueue = limit(3);
export const SUPPORTED_KINDS = new Set(['video', 'audio', 'image', 'raw']);

/** Imports files into the bin (one undo step). Returns the new/existing items in order. */
export async function importPaths(paths: string[]): Promise<MediaItem[]> {
  const unique = [...new Set(paths)];
  const supported = unique.filter((p) => SUPPORTED_KINDS.has(kindOf(p) ?? ''));
  const skipped = unique.length - supported.length;
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's' : ''} skipped (unsupported type)`, 'warn');
  if (!supported.length) return [];
  const existing = new Map(getProject().media.filter((m) => m.path).map((m) => [m.path!, m]));
  const task = startTask(`Importing ${supported.length} file${supported.length > 1 ? 's' : ''}…`);
  let done = 0;
  const results = await Promise.all(
    supported.map((path) =>
      importQueue(async () => {
        const ex = existing.get(path);
        if (ex && !ex.missing) return ex;
        if (ex) {
          // Re-importing an offline file that is back on disk brings the existing item online.
          await relinkMedia(ex.id, path);
          return getProject().media.find((m) => m.id === ex.id) ?? ex;
        }
        try {
          const info = await probe(path);
          const st = await api.stat(path).catch(() => null);
          const item: MediaItem = { ...info, id: uid('m'), size: st?.size, mtime: st?.mtime };
          return item;
        } catch (e) {
          errorToast(e, `Couldn't import ${basename(path)}`);
          return null;
        } finally {
          done++;
          task.update(done / supported.length);
        }
      }),
    ),
  );
  task.done();
  const items = results.filter((x): x is MediaItem => !!x);
  const fresh = items.filter((m) => !existing.has(m.path!));
  if (fresh.length) edit(fresh.length === 1 ? `Import ${fresh[0].name}` : `Import ${fresh.length} items`, (p) => ({ ...p, media: [...p.media, ...fresh] }));
  for (const m of fresh) analyze(m);
  return items;
}

/** Points an item at a new file (relink / replace footage). */
export async function relinkMedia(id: string, path: string) {
  try {
    const info = await probe(path);
    const st = await api.stat(path).catch(() => null);
    posters.delete(id);
    filmstrips.delete(id);
    peaks.delete(id);
    audioProviders.delete(path);
    edit('Link Media', (p) => ({
      ...p,
      media: p.media.map((m) => (m.id === id ? { ...m, ...info, name: m.name === basename(m.path ?? '') ? info.name : m.name, id, missing: false, size: st?.size, mtime: st?.mtime } : m)),
    }));
    const m = getProject().media.find((x) => x.id === id);
    if (m) analyze(m);
  } catch (e) {
    errorToast(e, 'Relink failed');
  }
}

/** Checks which media files are missing on disk (after opening a project). */
export async function checkMissing() {
  const p = getProject();
  const updates = new Map<string, boolean>();
  await Promise.all(
    p.media
      .filter((m) => m.path)
      .map(async (m) => {
        const st = await api.stat(m.path!).catch(() => null);
        const missing = !st;
        if (!!m.missing !== missing) updates.set(m.id, missing);
      }),
  );
  if (updates.size) {
    const st = getState();
    const cur = st.project;
    // Offline flags are derived state: don't make a just-opened/saved project look edited.
    replaceProject({ ...cur, media: cur.media.map((m) => (updates.has(m.id) ? { ...m, missing: updates.get(m.id) } : m)) }, { saved: cur === st.savedProject });
    const n = [...updates.values()].filter(Boolean).length;
    if (n) toast(`${n} media file${n > 1 ? 's are' : ' is'} offline — right-click › Link Media… to relink.`, 'warn', 6000);
  }
  for (const m of getProject().media) analyze(m);
}

export const displayName = (path: string) => stem(path);
