import { api, basename, dirname, extname, FileEntry, FILTERS, kindOf, MediaKind } from '@/platform/api';
import {
  addCollection,
  addEntries,
  addToCollection,
  ColorLabel,
  Collection,
  createVirtualCopy,
  defaultFilter,
  deleteCollection,
  Flag,
  Photo,
  removeFromCollection,
  renameCollection,
  setFilter,
  select,
  useCatalog,
} from '@/state/catalog';
import { errorToast, startTask, toast, useApp } from '@/state/app';
import { readMetadata, type PhotoMeta } from '@/core/image/decode';
import { applyGroups, defaultRawSettings, defaultSettings, DevelopSettings, normalizeSettings, SETTING_GROUPS, SettingGroup } from '@/core/develop/settings';
import { openInEditor, sendToVideo } from '@/app/bridge';
import { confirmDialog, promptDialog } from '@/ui/overlays';
import { patchPhotos, recordCollections, recordCreated, removePhotosUndoable } from './history';
import { ensureActive, selectedIds, targetIds } from './selection';
import { renderFull } from './render';
import { plural } from './util';

// =============================================================================================
// Import

const PHOTO_KINDS: MediaKind[] = ['image', 'raw'];
let picking = false;

function waitLoaded(): Promise<void> {
  if (useCatalog.getState().loaded) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useCatalog.subscribe((s) => {
      if (s.loaded) {
        off();
        resolve();
      }
    });
  });
}

async function statEntries(paths: string[]): Promise<FileEntry[]> {
  const out: FileEntry[] = new Array(paths.length);
  let i = 0;
  const worker = async () => {
    while (i < paths.length) {
      const k = i++;
      const p = paths[k];
      let e: FileEntry | null = null;
      try {
        e = await api.stat(p);
      } catch {
        /* fall through */
      }
      out[k] = e ?? { path: p, name: basename(p), ext: extname(p), kind: kindOf(p), size: 0, mtime: 0 };
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, worker));
  return out;
}

/** Adds entries to the catalog, shows them as "Previous Import" and starts metadata indexing. */
export async function importEntries(entries: FileEntry[]) {
  await waitLoaded();
  const photos = entries.filter((e) => {
    const k = e.kind ?? kindOf(e.path);
    return k === 'image' || k === 'raw';
  });
  if (!photos.length) {
    toast(entries.length ? 'No supported photos found (videos and other files are skipped).' : 'No photos found.', 'warn');
    return;
  }
  const ids = addEntries(photos);
  const skipped = photos.length - ids.length;
  if (!ids.length) {
    toast(`${plural(skipped, 'photo')} already in the catalog.`, 'warn');
    return;
  }
  setFilter({ ...defaultFilter(), source: { type: 'recent' } });
  select([], ids[0]);
  toast(`Imported ${plural(ids.length, 'photo')}${skipped ? ` (${skipped} already in catalog)` : ''}.`, 'success');
  queueMetadata(ids);
}

export async function importFiles() {
  if (picking) return;
  picking = true;
  try {
    const paths = await api.openFiles({ title: 'Add Photos', filters: [FILTERS.photos, FILTERS.raw, FILTERS.images], multi: true });
    if (!paths.length) return;
    const task = startTask('Reading files…');
    try {
      const entries = await statEntries(paths);
      await importEntries(entries);
    } finally {
      task.done();
    }
  } catch (e) {
    errorToast(e, 'Import failed');
  } finally {
    picking = false;
  }
}

export async function importFolder(dir?: string) {
  if (picking) return;
  picking = true;
  try {
    const folder = dir ?? (await api.openFolder('Add Folder'));
    if (!folder) return;
    const task = startTask(`Scanning ${basename(folder)}…`);
    try {
      const entries = await api.list(folder, true, PHOTO_KINDS);
      await importEntries(entries);
    } finally {
      task.done();
    }
  } catch (e) {
    errorToast(e, 'Import failed');
  } finally {
    picking = false;
  }
}

/** Re-scans a catalog folder (non-recursive) and imports photos that were added on disk. */
export async function syncFolder(folder: string) {
  const task = startTask(`Synchronizing ${basename(folder)}…`);
  try {
    const entries = await api.list(folder, false, PHOTO_KINDS);
    const known = new Set(Object.values(useCatalog.getState().photos).map((p) => p.path));
    const fresh = entries.filter((e) => !known.has(e.path));
    if (!fresh.length) toast('Folder is up to date.');
    else await importEntries(fresh);
  } catch (e) {
    errorToast(e, 'Synchronize failed');
  } finally {
    task.done();
  }
}

// ---- drag & drop of files / folders onto the module

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (es: FsEntry[]) => void, err: (e: unknown) => void): void };
}

/** Browser fallback: walks dropped directories via the (webkit) FileSystem entry API. */
async function walkEntry(entry: FsEntry, out: File[], depth = 0): Promise<void> {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File | null>((res) => entry.file!(res, () => res(null)));
    if (f) out.push(f);
  } else if (entry.isDirectory && entry.createReader && depth < 24) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const e of batch) if (!e.name.startsWith('.')) await walkEntry(e, out, depth + 1);
    }
  }
}

export async function importDropped(dt: DataTransfer) {
  const files = Array.from(dt.files);
  // Capture entries synchronously — DataTransfer items are invalid after the event returns.
  const fsEntries = api.isElectron ? [] : Array.from(dt.items ?? []).map((it) => (it as any).webkitGetAsEntry?.() as FsEntry | null).filter(Boolean) as FsEntry[];
  const task = startTask('Importing dropped items…');
  try {
    const entries: FileEntry[] = [];
    if (api.isElectron) {
      for (const f of files) {
        const p = api.pathForFile(f);
        const st = (await api.stat(p).catch(() => null)) as (FileEntry & { isDir?: boolean }) | null;
        if (st?.isDir) entries.push(...(await api.list(p, true, PHOTO_KINDS)));
        else if (st) entries.push(st);
      }
    } else {
      const all: File[] = [];
      if (fsEntries.length) for (const e of fsEntries) await walkEntry(e, all);
      else all.push(...files);
      for (const f of all) {
        if (!kindOf(f.name)) continue;
        const p = api.pathForFile(f);
        entries.push({ path: p, name: f.name, ext: extname(f.name), kind: kindOf(f.name), size: f.size, mtime: f.lastModified });
      }
    }
    await importEntries(entries);
  } catch (e) {
    errorToast(e, 'Import failed');
  } finally {
    task.done();
  }
}

// =============================================================================================
// Background metadata (EXIF) indexing — bounded concurrency, batched store updates

const metaQueue: string[] = [];
const metaQueued = new Set<string>();
const metaBuffer = new Map<string, PhotoMeta>();
let metaWorkers = 0;
let metaTask: ReturnType<typeof startTask> | null = null;
let metaTotal = 0;
let metaDone = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const META_CONCURRENCY = 4;

function flushMeta() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!metaBuffer.size) return;
  const batch = [...metaBuffer];
  metaBuffer.clear();
  useCatalog.setState((s) => {
    const photos = { ...s.photos };
    for (const [id, meta] of batch) if (photos[id]) photos[id] = { ...photos[id], meta };
    return { photos };
  });
}

async function metaWorker() {
  metaWorkers++;
  try {
    while (metaQueue.length) {
      const id = metaQueue.shift()!;
      metaQueued.delete(id);
      const p = useCatalog.getState().photos[id];
      if (p && !p.meta) {
        const meta = await readMetadata(p.path).catch(() => ({}) as PhotoMeta);
        metaBuffer.set(id, meta);
        if (!flushTimer) flushTimer = setTimeout(flushMeta, metaBuffer.size > 400 ? 0 : 500);
      }
      metaDone++;
      if (metaTask && (metaDone & 15) === 0) metaTask.update(metaDone / metaTotal, `Reading metadata ${metaDone}/${metaTotal}`);
    }
  } finally {
    metaWorkers--;
    if (!metaWorkers) {
      flushMeta();
      metaTask?.done();
      metaTask = null;
      metaTotal = metaDone = 0;
    }
  }
}

/** Reads EXIF for the given photos in the background (capture-time sort, metadata panel). */
export function queueMetadata(ids: string[]) {
  let added = 0;
  for (const id of ids) {
    if (metaQueued.has(id)) continue;
    metaQueued.add(id);
    metaQueue.push(id);
    added++;
  }
  if (!added) return;
  metaTotal += added;
  if (!metaTask && metaTotal > 8)
    metaTask = startTask('Reading metadata…', () => {
      metaQueue.length = 0;
      metaQueued.clear();
    });
  while (metaWorkers < META_CONCURRENCY && metaWorkers < metaQueue.length) void metaWorker();
}

/** Indexes photos that have never had their metadata read (e.g. an import was interrupted). */
export function ensureMetadata() {
  const photos = useCatalog.getState().photos;
  const missing = Object.keys(photos).filter((id) => !photos[id].meta);
  if (missing.length) queueMetadata(missing);
}

// =============================================================================================
// Rating / flag / label

const flagLabel = (f: Flag) => (f === 'pick' ? 'Flag as Pick' : f === 'reject' ? 'Flag as Rejected' : 'Unflag');

export function rate(rating: number, ids = targetIds()) {
  if (!ids.length) return;
  const n = patchPhotos(`Rating ${rating}`, ids, () => ({ rating }));
  if (n && ids.length > 1) toast(`${rating ? '★'.repeat(rating) : 'No rating'} · ${plural(ids.length, 'photo')}`);
}

export function flag(f: Flag, ids = targetIds()) {
  if (!ids.length) return;
  patchPhotos(flagLabel(f), ids, () => ({ flag: f }));
}

/** Sets a colour label; if every target already has it, it is removed (Lightroom toggle). */
export function label(l: ColorLabel, ids = targetIds()) {
  if (!ids.length) return;
  const photos = useCatalog.getState().photos;
  const all = l !== null && ids.every((id) => photos[id]?.label === l);
  const next = all ? null : l;
  patchPhotos(next ? `Label ${next}` : 'Remove Label', ids, () => ({ label: next }));
}

export function addKeywords(words: string[], ids = targetIds()) {
  const clean = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
  if (!clean.length || !ids.length) return;
  patchPhotos('Add Keywords', ids, (p) => {
    const set = new Set(p.keywords);
    const before = set.size;
    for (const w of clean) set.add(w);
    return set.size === before ? null : { keywords: [...set] };
  });
}

export function removeKeyword(word: string, ids = targetIds()) {
  patchPhotos('Remove Keyword', ids, (p) => (p.keywords.includes(word) ? { keywords: p.keywords.filter((k) => k !== word) } : null));
}

// =============================================================================================
// Develop settings

export const ALL_GROUPS = Object.keys(SETTING_GROUPS) as SettingGroup[];

export function baseSettings(p: Photo): DevelopSettings {
  return p.settings ? normalizeSettings(p.settings) : p.kind === 'raw' ? defaultRawSettings() : defaultSettings();
}

/** Applies `fn` to each photo's settings (creating defaults when missing), in one undo step. */
export function editSettings(label: string, ids: string[], fn: (s: DevelopSettings, p: Photo) => DevelopSettings | null): number {
  if (!ids.length) {
    toast('Select one or more photos first.');
    return 0;
  }
  const now = Date.now();
  return patchPhotos(label, ids, (p) => {
    const base = baseSettings(p);
    const s = fn(base, p);
    if (!s) return null;
    // Don't mark an unedited photo as edited when the result is still its defaults.
    if (!p.settings && JSON.stringify(s) === JSON.stringify(base)) return null;
    return { settings: s, editedAt: now };
  });
}

export function resetSettings(ids = targetIds()) {
  const n = patchPhotos('Reset Settings', ids, (p) => (p.settings ? { settings: undefined, editedAt: undefined } : null));
  toast(n ? `Reset ${plural(n, 'photo')} to original.` : 'Nothing to reset.');
}

export function applyPresetSettings(name: string, preset: Partial<DevelopSettings> | null, ids = targetIds()) {
  if (!preset) return resetSettings(ids);
  const n = editSettings(`Preset: ${name}`, ids, (s) => applyGroups(s, preset, ALL_GROUPS));
  if (n) toast(`Applied “${name}” to ${plural(n, 'photo')}.`);
}

/** Picks the chosen groups out of `s` (deep-copied) — the shape stored on the clipboard. */
export function pickGroups(s: DevelopSettings, groups: SettingGroup[]): Partial<DevelopSettings> {
  const out: Record<string, unknown> = {};
  for (const g of groups) for (const k of SETTING_GROUPS[g]) out[k] = structuredClone(s[k]);
  return out as Partial<DevelopSettings>;
}

export function copySettings(groups: SettingGroup[]) {
  const id = ensureActive();
  const p = id ? useCatalog.getState().photos[id] : undefined;
  if (!p) return toast('Select a photo to copy its settings.');
  useCatalog.setState({ clipboard: pickGroups(baseSettings(p), groups) });
  toast(`Copied ${plural(groups.length, 'setting group')} from ${p.name}.`, 'success');
}

export function pasteSettings(ids = targetIds()) {
  const clip = useCatalog.getState().clipboard;
  if (!clip) return toast('Copy settings first (⇧⌘C).');
  const n = editSettings('Paste Settings', ids, (s) => applyGroups(s, clip, ALL_GROUPS));
  if (n) toast(`Pasted settings to ${plural(n, 'photo')}.`);
}

/** Copies the chosen groups from the active photo to the other selected photos. */
export function syncSettings(groups: SettingGroup[]) {
  const s = useCatalog.getState();
  const src = s.activeId ? s.photos[s.activeId] : undefined;
  if (!src) return;
  const others = s.selection.filter((id) => id !== src.id);
  const from = baseSettings(src);
  const n = editSettings('Sync Settings', others, (st) => applyGroups(st, from, groups));
  toast(n ? `Synced ${plural(n, 'photo')} with ${src.name}.` : 'Settings already in sync.');
}

/** Rotates by ±90° (develop orientation; the crop rectangle rotates with the frame). */
export function rotate(dir: 1 | -1, ids = targetIds()) {
  editSettings(dir > 0 ? 'Rotate Right' : 'Rotate Left', ids, (s) => {
    const c = s.crop;
    const crop = dir > 0 ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
    // Flips apply after the orientation, so a single mirror reverses the visual rotation direction
    // (same rule as Develop's rotateOrientation).
    const od = s.flipH !== s.flipV ? -dir : dir;
    return { ...s, orientation: (((s.orientation + (od > 0 ? 90 : 270)) % 360) as DevelopSettings['orientation']), crop };
  });
}

// =============================================================================================
// Catalog structure

export function virtualCopies(ids = targetIds()) {
  const created: string[] = [];
  for (const id of ids) {
    const c = createVirtualCopy(id);
    if (c) created.push(c);
  }
  if (!created.length) return;
  recordCreated('Create Virtual Copy', created);
  select(created, created[0]);
  toast(`Created ${plural(created.length, 'virtual copy', 'virtual copies')}.`);
}

export async function removeFromCatalog(ids = targetIds()) {
  if (!ids.length) return;
  const ok = await confirmDialog(
    <>
      Remove {plural(ids.length, 'photo')} from the catalog?
      <div className="muted" style={{ marginTop: 8 }}>
        The files on disk are not deleted or modified — only their catalog entries (ratings, keywords, develop settings, collection membership) are removed. You can undo this with ⌘Z.
      </div>
    </>,
    { title: 'Remove from Catalog', ok: 'Remove', danger: true },
  );
  if (!ok) return;
  removePhotosUndoable(ids);
  toast(`Removed ${plural(ids.length, 'photo')} from the catalog. Files on disk are untouched.`);
}

/** Delete key: removes from the viewed collection, otherwise from the catalog (with confirmation). */
export function deleteKey() {
  const ids = targetIds();
  if (!ids.length) return;
  const src = useCatalog.getState().filter.source;
  if (src.type === 'collection') return removeFromCollectionUndoable(src.id, ids);
  void removeFromCatalog(ids);
}

export async function removeFolder(folder: string) {
  const photos = useCatalog.getState().photos;
  const ids = Object.keys(photos).filter((id) => dirname(photos[id].path) === folder);
  const ok = await confirmDialog(
    <>
      Remove the folder “{basename(folder)}” and its {plural(ids.length, 'photo')} from the catalog?
      <div className="muted" style={{ marginTop: 8 }}>
        Files on disk are not deleted.
      </div>
    </>,
    { title: 'Remove Folder', ok: 'Remove', danger: true },
  );
  if (!ok) return;
  const s = useCatalog.getState();
  if (s.filter.source.type === 'folder' && s.filter.source.path === folder) setFilter({ source: { type: 'all' } });
  removePhotosUndoable(ids, 'Remove Folder');
  // Folders without photos are pruned by removePhotos; an empty folder entry needs explicit removal.
  useCatalog.setState((st) => ({ folders: st.folders.filter((f) => f !== folder) }));
}

// ---- collections

export async function newCollection(withIds: string[] = []): Promise<string | null> {
  const name = (await promptDialog('New Collection', 'Untitled Collection', { label: withIds.length ? `${plural(withIds.length, 'photo')} will be added.` : undefined, ok: 'Create' }))?.trim();
  if (!name) return null;
  let id = '';
  recordCollections('New Collection', () => {
    id = addCollection(name, withIds);
  });
  toast(`Created collection “${name}”.`, 'success');
  return id;
}

export async function renameCollectionPrompt(c: Collection) {
  const name = (await promptDialog('Rename Collection', c.name, { ok: 'Rename' }))?.trim();
  if (name && name !== c.name) recordCollections('Rename Collection', () => renameCollection(c.id, name));
}

export async function deleteCollectionConfirm(c: Collection) {
  const ok = await confirmDialog(`Delete the collection “${c.name}”? The photos stay in the catalog.`, { title: 'Delete Collection', ok: 'Delete', danger: true });
  if (ok) recordCollections('Delete Collection', () => deleteCollection(c.id));
}

export function addToCollectionUndoable(cid: string, ids: string[]) {
  const c = useCatalog.getState().collections.find((x) => x.id === cid);
  if (!c || !ids.length) return;
  const have = new Set(c.photoIds);
  const fresh = ids.filter((id) => !have.has(id));
  if (!fresh.length) return toast(`Already in “${c.name}”.`);
  recordCollections('Add to Collection', () => addToCollection(cid, fresh));
  toast(`Added ${plural(fresh.length, 'photo')} to “${c.name}”.`);
}

export function removeFromCollectionUndoable(cid: string, ids: string[]) {
  const c = useCatalog.getState().collections.find((x) => x.id === cid);
  if (!c || !ids.length) return;
  recordCollections('Remove from Collection', () => removeFromCollection(cid, ids));
  toast(`Removed ${plural(ids.length, 'photo')} from “${c.name}”.`);
}

// =============================================================================================
// Hand-offs

export function openInDevelop(id?: string) {
  if (id) {
    const s = useCatalog.getState();
    select(s.selection.includes(id) ? s.selection : [id], id);
  }
  if (!ensureActive()) return toast('Import photos first.');
  useApp.getState().setModule('develop');
}

export async function editInEditor() {
  const id = ensureActive();
  const p = id ? useCatalog.getState().photos[id] : undefined;
  if (!p) return toast('Select a photo to edit.');
  const task = startTask(`Preparing ${p.name}…`);
  try {
    const image = await renderFull(p, { includeEdits: true });
    openInEditor({ name: p.name, image, path: p.path });
  } catch (e) {
    errorToast(e, `Could not open ${p.name} in the Editor`);
  } finally {
    task.done();
  }
}

export function sendSelectionToVideo() {
  const photos = useCatalog.getState().photos;
  const paths = [...new Set(selectedIds().map((id) => photos[id]?.path).filter(Boolean))] as string[];
  if (!paths.length) return toast('Select photos to send to Video.');
  sendToVideo(paths);
}

export function revealPhoto(id?: string) {
  const pid = id ?? useCatalog.getState().activeId;
  const p = pid ? useCatalog.getState().photos[pid] : undefined;
  if (p) api.reveal(p.path);
}
