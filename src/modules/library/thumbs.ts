import { useEffect, useState } from 'react';
import { loadThumbnail } from '@/core/image/decode';
import { Photo, settingsHash } from '@/state/catalog';
import { startTask } from '@/state/app';
import { EDITED_THUMB_PX, regenerateEditedThumbnail } from '@/modules/shared/editedThumb';

/**
 * Grid thumbnails. Same lookup as the shared `useThumbnail()` (edited render when the photo has
 * a `thumbVariant`, else the original), plus:
 *  - a resolved-bitmap LRU so remounted cells paint synchronously (no flash when scrolling back),
 *  - deferred requests while the grid is being flung/scrubbed: cells that only exist for a few
 *    frames never enqueue a decode, so the (FIFO) thumbnail queue serves what's on screen.
 */

type ThumbSource = Pick<Photo, 'path' | 'mtime' | 'size' | 'thumbVariant'>;

const resolved = new Map<string, ImageBitmap>();
const RESOLVED_MAX = 600;

const keyOf = (p: ThumbSource, px: number) => `${p.path}|${p.mtime}|${p.size}|${p.thumbVariant ? EDITED_THUMB_PX : px}|${p.thumbVariant ?? ''}`;

function remember(key: string, bmp: ImageBitmap) {
  resolved.delete(key);
  resolved.set(key, bmp);
  if (resolved.size > RESOLVED_MAX) resolved.delete(resolved.keys().next().value!);
}

/** Scroll activity shared by the grid (written) and cells (read). */
export const scrollActivity = { fastUntil: 0 };

export function loadPhotoThumb(p: ThumbSource, px: number): Promise<ImageBitmap> {
  const entry = { path: p.path, mtime: p.mtime, size: p.size };
  const key = keyOf(p, px);
  const hit = resolved.get(key);
  if (hit) return Promise.resolve(hit);
  const load = p.thumbVariant ? loadThumbnail(entry, EDITED_THUMB_PX, p.thumbVariant).catch(() => loadThumbnail(entry, px)) : loadThumbnail(entry, px);
  return load.then((b) => {
    remember(key, b);
    return b;
  });
}

export function peekThumb(p: ThumbSource | undefined, px: number): ImageBitmap | null {
  return p ? resolved.get(keyOf(p, px)) ?? null : null;
}

/**
 * Returns the photo's thumbnail (null while loading). Keeps showing the previous bitmap while a
 * new variant loads. `defer` (ms) delays the request and keeps waiting while the grid scrolls fast.
 */
export function useGridThumb(photo: ThumbSource | undefined, px = 384, defer = 0): ImageBitmap | null {
  const key = photo ? keyOf(photo, px) : '';
  const path = photo?.path ?? '';
  const [state, setState] = useState<{ key: string; path: string; bmp: ImageBitmap | null }>(() => ({ key, path, bmp: key ? resolved.get(key) ?? null : null }));
  useEffect(() => {
    if (!photo || !key) return;
    const hit = resolved.get(key);
    if (hit) {
      setState({ key, path, bmp: hit });
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      if (!alive) return;
      if (defer && performance.now() < scrollActivity.fastUntil) {
        timer = setTimeout(go, 90);
        return;
      }
      loadPhotoThumb(photo, px).then(
        (b) => alive && setState({ key, path, bmp: b }),
        () => {},
      );
    };
    if (defer) timer = setTimeout(go, defer);
    else go();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (state.key === key) return state.bmp;
  // Key changed: use a resolved bitmap if any; keep the old one only for the same file (new edit variant).
  return resolved.get(key) ?? (state.path === path ? state.bmp : null);
}

// ---------------------------------------------------------------------------------------------
// Edited-thumbnail regeneration (deduplicated, one at a time, with title-bar progress)

const pending = new Set<string>();
let running = false;
let total = 0;
let done = 0;
let task: ReturnType<typeof startTask> | null = null;
const attempted = new Set<string>();

export function scheduleThumbRegen(ids: string[]) {
  for (const id of ids) {
    if (!pending.has(id)) total++;
    pending.add(id);
  }
  if (!running) void pump();
}

/** Regenerates a stale edited thumbnail once per settings hash (e.g. edits made before a crash). */
export function healThumb(p: Photo) {
  if (!p.settings) return;
  const hash = settingsHash(p.settings);
  if (p.thumbVariant === hash) return;
  const k = `${p.id}|${hash}`;
  if (attempted.has(k)) return;
  attempted.add(k);
  scheduleThumbRegen([p.id]);
}

async function pump() {
  running = true;
  try {
    while (pending.size) {
      const id = pending.values().next().value!;
      pending.delete(id);
      if (!task && total > 2) task = startTask('Updating previews…', () => pending.clear());
      try {
        await regenerateEditedThumbnail(id);
      } catch {
        /* undecodable file — keep the original thumbnail */
      }
      done++;
      task?.update(Math.min(1, done / Math.max(1, total)), `Updating previews ${Math.min(done, total)}/${total}`);
    }
  } finally {
    running = false;
    task?.done();
    task = null;
    total = done = 0;
  }
}
