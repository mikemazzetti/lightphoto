import { createGL } from '@/core/gl/gl';
import { DevelopEngine } from '@/core/develop/engine';
import { defaultRawSettings, DevelopSettings, normalizeSettings } from '@/core/develop/settings';
import { decodeBitmap, decodeImage } from '@/core/image/decode';
import { limit } from '@/core/util/async';
import { Photo, settingsHash } from '@/state/catalog';

/**
 * Off-screen rendering for the Library:
 *  - `loadPreview()` — screen-sized (or full-res, px = 0) previews for Loupe/Survey, rendered
 *    through a single reused DevelopEngine when the photo has develop settings. Requests run one
 *    at a time, newest first, so arrowing through photos never waits behind stale work.
 *  - `renderFull()` — full-resolution pixels for Edit-in-Editor and export.
 */

export function makeEngine(): DevelopEngine {
  const gl = createGL(new OffscreenCanvas(1, 1));
  try {
    return new DevelopEngine(gl);
  } catch (e) {
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // don't leak the context
    throw e;
  }
}

export function destroyEngine(e: DevelopEngine) {
  const gl = e.gl;
  try {
    e.dispose();
  } catch {
    /* already lost */
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}

/** Settings a photo must be rendered with, or null when its pixels can be used as decoded. */
export function renderSettingsFor(photo: Photo, includeEdits = true): DevelopSettings | null {
  if (includeEdits && photo.settings) return normalizeSettings(photo.settings);
  if (photo.kind === 'raw') return defaultRawSettings();
  return null;
}

// ---------------------------------------------------------------------------------------------
// Preview engine (kept while the Library is mounted; freed on unmount)

let engine: DevelopEngine | null = null;
let engineSrc = '';

/** Frees the preview engine's GPU memory and cached previews (call when the Library unmounts). */
export function releasePreviewEngine() {
  // Drop queued work (loupe neighbour prefetches, survey tiles): run after the release it would
  // re-create an engine — an extra WebGL context — and keep decoding (RAWs block Develop's decode
  // queue) while another module is in front.
  for (const job of stack.splice(0)) job.reject(superseded());
  if (engine) destroyEngine(engine);
  engine = null;
  engineSrc = '';
  cache.clear();
  done.clear();
}

const superseded = () => new DOMException('Superseded', 'AbortError');

async function renderPreview(photo: Photo, s: DevelopSettings, px: number): Promise<ImageBitmap> {
  const full = px <= 0;
  const isRaw = photo.kind === 'raw';
  // Decode enough source pixels to cover the crop at the requested size.
  const cropMin = Math.max(0.05, Math.min(s.crop.w, s.crop.h));
  const maxSize = full || isRaw ? undefined : Math.min(16384, Math.ceil(px / cropMin));
  const srcKey = `${photo.path}|${photo.mtime}|${photo.size}|${isRaw ? (full ? 'raw' : 'half') : maxSize ?? 'full'}`;
  const e = (engine ??= makeEngine());
  if (engineSrc !== srcKey) {
    engineSrc = '';
    const dec = await decodeImage(photo.path, { maxSize, rawHalfSize: isRaw && !full });
    if (e !== engine) {
      if (dec.source instanceof ImageBitmap) dec.source.close();
      throw superseded(); // released while decoding
    }
    e.setSource(dec.source);
    if (dec.source instanceof ImageBitmap) dec.source.close();
    engineSrc = srcKey;
  }
  const [w, h] = full ? e.fullSize(s) : e.fitSize(s, px, px);
  const img = e.render(s, w, h).toImageData();
  // Full-res intermediate targets are huge; free them right away.
  if (full) e.trim();
  return createImageBitmap(img);
}

interface Job {
  key: string;
  run: () => Promise<ImageBitmap>;
  resolve: (b: ImageBitmap) => void;
  reject: (e: unknown) => void;
}

const stack: Job[] = [];
let busy = false;
/** ≥ Survey's tile count (12): fewer would cancel some tiles' previews for good. */
const MAX_PENDING = 12;

function pump() {
  if (busy) return;
  const job = stack.pop();
  if (!job) return;
  busy = true;
  job
    .run()
    .then(job.resolve, job.reject)
    .finally(() => {
      busy = false;
      pump();
    });
}

const cache = new Map<string, { p: Promise<ImageBitmap>; full: boolean }>();
const done = new Map<string, ImageBitmap>();
const CACHE_MAX = 10;

function evict(key: string) {
  cache.delete(key);
  done.delete(key);
}

export const previewKey = (photo: Photo, px: number) => `${photo.path}|${photo.mtime}|${photo.size}|${settingsHash(photo.settings)}|${px}`;

/** Common preview sizes, so window resizes reuse cached renders. */
export function previewBucket(needPx: number): number {
  for (const b of [640, 1024, 1536, 2048, 2560, 3200, 4096, 5120]) if (b >= needPx) return b;
  return 6144;
}

/**
 * Preview bitmap with long edge ≤ px (px = 0: full resolution). Unedited non-RAW photos are
 * decoded directly; unedited RAW uses the embedded preview (full-res: a default RAW render).
 */
export function loadPreview(photo: Photo, px: number): Promise<ImageBitmap> {
  const key = previewKey(photo, px);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.p;
  }
  const full = px <= 0;
  const p = new Promise<ImageBitmap>((resolve, reject) => {
    stack.push({
      key,
      resolve,
      reject,
      run: async () => {
        if (!photo.settings) {
          if (photo.kind !== 'raw') return decodeBitmap(photo.path, full ? undefined : px);
          if (!full) return decodeBitmap(photo.path, px);
        }
        const s = photo.settings ? normalizeSettings(photo.settings) : defaultRawSettings();
        return renderPreview(photo, s, px);
      },
    });
    while (stack.length > MAX_PENDING) {
      const old = stack.shift()!;
      evict(old.key);
      old.reject(superseded());
    }
    pump();
  });
  if (full) for (const [k, v] of cache) if (v.full) evict(k); // keep one full-res at most
  cache.set(key, { p, full });
  p.then(
    (b) => cache.has(key) && done.set(key, b),
    () => evict(key),
  );
  while (cache.size > CACHE_MAX) evict(cache.keys().next().value!);
  return p;
}

/** The preview if it has already finished loading (for synchronous first paint). */
export function peekPreview(photo: Photo, px: number): ImageBitmap | null {
  return done.get(previewKey(photo, px)) ?? null;
}

/** Fire-and-forget preview warm-up (neighbours in the loupe). */
export function prefetchPreview(photo: Photo | undefined, px: number) {
  if (photo) loadPreview(photo, px).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Full-resolution rendering (Edit in Editor / export). Serialised: these are memory-heavy.

const fullQueue = limit(1);

/**
 * Full-res pixels of a photo. With `engine` given it is reused (caller owns it); otherwise a
 * temporary one is created and destroyed. `longEdge` > 0 renders directly at that size.
 */
export function renderFull(photo: Photo, opts: { includeEdits?: boolean; longEdge?: number; engine?: DevelopEngine } = {}): Promise<ImageData | ImageBitmap> {
  return fullQueue(async () => {
    const s = renderSettingsFor(photo, opts.includeEdits ?? true);
    const longEdge = opts.longEdge ?? 0;
    if (!s) {
      const dec = await decodeImage(photo.path, { maxSize: longEdge > 0 ? longEdge : undefined });
      return dec.source as ImageBitmap;
    }
    const own = !opts.engine;
    const e = opts.engine ?? makeEngine();
    try {
      const isRaw = photo.kind === 'raw';
      const cropMin = Math.max(0.05, Math.min(s.crop.w, s.crop.h));
      const maxSize = !isRaw && longEdge > 0 ? Math.min(16384, Math.ceil((longEdge * 1.25) / cropMin)) : undefined;
      const dec = await decodeImage(photo.path, { maxSize });
      try {
        e.setSource(dec.source);
      } finally {
        if (dec.source instanceof ImageBitmap) dec.source.close();
      }
      const [w, h] = longEdge > 0 ? e.fitSize(s, longEdge, longEdge) : e.fullSize(s);
      const img = e.render(s, w, h).toImageData();
      e.trim();
      return img;
    } finally {
      if (own) destroyEngine(e);
    }
  });
}
