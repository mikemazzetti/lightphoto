import { dirname } from '@/platform/api';
import { Collection, Photo, removePhotos, useCatalog } from '@/state/catalog';
import { toast } from '@/state/app';
import { scheduleThumbRegen } from './thumbs';

/**
 * Library undo/redo plus batched catalog mutations.
 *
 * All multi-photo edits go through `patchPhotos()`, which applies every change in ONE store
 * update (the shared per-photo mutations copy the whole photo map each call, which is O(n²) for
 * big selections) and records a field-level undo entry. Undo only reverts a field if it still
 * holds the value we wrote, so later edits made elsewhere (e.g. in Develop) are never clobbered.
 */

interface Entry {
  label: string;
  undo: () => void;
  redo: () => void;
}

const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
const MAX = 100;

export function pushHistory(e: Entry) {
  undoStack.push(e);
  if (undoStack.length > MAX) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  const e = undoStack.pop();
  if (!e) return toast('Nothing to undo');
  e.undo();
  redoStack.push(e);
  toast(`Undo ${e.label}`);
}

export function redo() {
  const e = redoStack.pop();
  if (!e) return toast('Nothing to redo');
  e.redo();
  undoStack.push(e);
  toast(`Redo ${e.label}`);
}

// ---------------------------------------------------------------------------------------------
// Photo field patches

type Patch = Partial<Photo>;
interface Change {
  id: string;
  before: Patch;
  after: Patch;
}

const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && JSON.stringify(a) === JSON.stringify(b));

function applyChanges(changes: Change[], dir: 'before' | 'after') {
  const from = dir === 'before' ? 'after' : 'before';
  const touched: string[] = [];
  const src = useCatalog.getState().photos;
  let photos: Record<string, Photo> | null = null;
  for (const c of changes) {
    const p = src[c.id];
    if (!p) continue;
    const next: Patch = {};
    let any = false;
    for (const k of Object.keys(c[dir]) as (keyof Photo)[]) {
      // Skip fields that were changed by someone else since.
      if (!same(p[k], c[from][k])) continue;
      (next as any)[k] = c[dir][k];
      any = true;
    }
    if (!any) continue;
    photos ??= { ...src };
    photos[c.id] = { ...p, ...next };
    if ('settings' in next) touched.push(c.id);
  }
  if (photos) useCatalog.setState({ photos });
  if (touched.length) scheduleThumbRegen(touched);
}

/**
 * Applies `fn(photo)` to each id in a single store update. Returning null skips the photo.
 * Records an undo entry (unless `record` is false). Returns the number of photos changed.
 */
export function patchPhotos(label: string, ids: string[], fn: (p: Photo) => Patch | null, opts: { record?: boolean } = {}): number {
  const changes: Change[] = [];
  const regen: string[] = [];
  const src = useCatalog.getState().photos;
  let photos: Record<string, Photo> | null = null;
  for (const id of ids) {
    const p = src[id];
    if (!p) continue;
    const patch = fn(p);
    if (!patch) continue;
    const before: Patch = {};
    let changed = false;
    for (const k of Object.keys(patch) as (keyof Photo)[]) {
      (before as any)[k] = p[k];
      if (!same(p[k], patch[k])) changed = true;
    }
    if (!changed) continue;
    photos ??= { ...src };
    photos[id] = { ...p, ...patch };
    changes.push({ id, before, after: patch });
    if ('settings' in patch) regen.push(id);
  }
  if (!photos || !changes.length) return 0;
  useCatalog.setState({ photos });
  if (opts.record !== false) pushHistory({ label, undo: () => applyChanges(changes, 'before'), redo: () => applyChanges(changes, 'after') });
  if (regen.length) scheduleThumbRegen(regen);
  return changes.length;
}

// ---------------------------------------------------------------------------------------------
// Collections

/** Runs a collection mutation and records the whole collections array for undo. */
export function recordCollections(label: string, mutate: () => void) {
  const before = useCatalog.getState().collections;
  mutate();
  const after = useCatalog.getState().collections;
  if (before === after) return;
  pushHistory({
    label,
    undo: () => useCatalog.setState({ collections: before }),
    redo: () => useCatalog.setState({ collections: after }),
  });
}

// ---------------------------------------------------------------------------------------------
// Removing / restoring photos

interface Snapshot {
  photos: Photo[];
  order: string[];
  collections: Collection[];
}

function snapshot(ids: string[]): Snapshot {
  const s = useCatalog.getState();
  return { photos: ids.map((id) => s.photos[id]).filter(Boolean), order: s.order, collections: s.collections };
}

/** Puts previously removed photos back (catalog order and collection membership restored). */
function restore(snap: Snapshot) {
  useCatalog.setState((s) => {
    const photos = { ...s.photos };
    const back = new Set<string>();
    for (const p of snap.photos) {
      if (photos[p.id]) continue;
      photos[p.id] = p;
      back.add(p.id);
    }
    if (!back.size) return {};
    const current = new Set(s.order);
    const order = snap.order.filter((id) => current.has(id) || back.has(id));
    const inOrder = new Set(order);
    for (const id of s.order) if (!inOrder.has(id)) order.push(id);
    const membership = new Map(snap.collections.map((c) => [c.id, c.photoIds.filter((id) => back.has(id))]));
    const collections = s.collections.map((c) => {
      const add = membership.get(c.id);
      return add?.length ? { ...c, photoIds: [...new Set([...c.photoIds, ...add])] } : c;
    });
    const folders = new Set(s.folders);
    for (const id of back) folders.add(dirname(photos[id].path));
    return { photos, order, collections, folders: [...folders].sort() };
  });
}

export function removePhotosUndoable(ids: string[], label = 'Remove from Catalog') {
  if (!ids.length) return;
  const snap = snapshot(ids);
  removePhotos(ids);
  pushHistory({ label, undo: () => restore(snap), redo: () => removePhotos(snap.photos.map((p) => p.id)) });
}

/** Records the creation of new photos (e.g. virtual copies) so it can be undone. */
export function recordCreated(label: string, ids: string[]) {
  if (!ids.length) return;
  const snap = snapshot(ids);
  pushHistory({ label, undo: () => removePhotos(ids), redo: () => restore(snap) });
}
