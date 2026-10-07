import { create } from 'zustand';
import { api, basename, dirname, FileEntry, kindOf } from '@/platform/api';
import { DevelopSettings, normalizeSettings } from '@/core/develop/settings';
import type { PhotoMeta } from '@/core/image/decode';
import { debounce, hashString, uid } from '@/core/util/async';

/**
 * The photo catalog shared by Library and Develop. Persisted (debounced) to the user data
 * folder. Develop settings live here per photo — edits are non-destructive.
 */

export type Flag = 'pick' | 'reject' | null;
export type ColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;
export const COLOR_LABELS: Exclude<ColorLabel, null>[] = ['red', 'yellow', 'green', 'blue', 'purple'];
export const LABEL_COLORS: Record<Exclude<ColorLabel, null>, string> = {
  red: '#e5484d',
  yellow: '#f5d90a',
  green: '#46a758',
  blue: '#3e63dd',
  purple: '#8e4ec6',
};

export interface Photo {
  id: string;
  path: string;
  name: string;
  ext: string;
  kind: 'image' | 'raw';
  size: number;
  mtime: number;
  importedAt: number;
  rating: number; // 0..5
  flag: Flag;
  label: ColorLabel;
  keywords: string[];
  meta?: PhotoMeta;
  /** Present once the photo has been opened in Develop. */
  settings?: DevelopSettings;
  /** Virtual copies share `path` but have their own settings. */
  virtualOf?: string;
  editedAt?: number;
  /** Hash of settings used for the cached edited thumbnail ('' = original). */
  thumbVariant?: string;
}

export interface Collection {
  id: string;
  name: string;
  photoIds: string[];
}

export interface UserPreset {
  id: string;
  name: string;
  group: string;
  settings: Partial<DevelopSettings>;
}

export type SortKey = 'captureTime' | 'importTime' | 'name' | 'rating' | 'editTime' | 'size';

export interface LibraryFilter {
  text: string;
  minRating: number;
  ratingOp: '>=' | '==' | '<=';
  flag: 'all' | 'picked' | 'unflagged' | 'rejected' | 'notRejected';
  label: ColorLabel | 'any';
  kind: 'all' | 'raw' | 'image';
  edited: 'all' | 'edited' | 'unedited';
  /** Folder path or collection id ('' = all photographs). */
  source: { type: 'all' } | { type: 'folder'; path: string } | { type: 'collection'; id: string } | { type: 'recent' };
}

export const defaultFilter = (): LibraryFilter => ({
  text: '',
  minRating: 0,
  ratingOp: '>=',
  flag: 'all',
  label: 'any',
  kind: 'all',
  edited: 'all',
  source: { type: 'all' },
});

interface CatalogState {
  loaded: boolean;
  photos: Record<string, Photo>;
  order: string[];
  folders: string[];
  collections: Collection[];
  presets: UserPreset[];
  selection: string[];
  activeId: string | null;
  filter: LibraryFilter;
  sort: SortKey;
  sortDesc: boolean;
  /** Settings on the "copy settings" clipboard. */
  clipboard: Partial<DevelopSettings> | null;
}

export const useCatalog = create<CatalogState>(() => ({
  loaded: false,
  photos: {},
  order: [],
  folders: [],
  collections: [],
  presets: [],
  selection: [],
  activeId: null,
  filter: defaultFilter(),
  sort: 'captureTime',
  sortDesc: false,
  clipboard: null,
}));

const STORE_KEY = 'catalog-v1';

const persist = debounce(() => {
  const s = useCatalog.getState();
  void api.storeSet(STORE_KEY, {
    photos: s.photos,
    order: s.order,
    folders: s.folders,
    collections: s.collections,
    presets: s.presets,
    sort: s.sort,
    sortDesc: s.sortDesc,
  });
}, 600);

useCatalog.subscribe((s, prev) => {
  if (!s.loaded) return;
  if (s.photos !== prev.photos || s.order !== prev.order || s.folders !== prev.folders || s.collections !== prev.collections || s.presets !== prev.presets || s.sort !== prev.sort || s.sortDesc !== prev.sortDesc) persist();
});

export async function loadCatalog() {
  if (useCatalog.getState().loaded) return;
  const data = await api.storeGet<any>(STORE_KEY);
  if (data) {
    for (const p of Object.values<Photo>(data.photos ?? {})) if (p.settings) p.settings = normalizeSettings(p.settings);
    useCatalog.setState({
      photos: data.photos ?? {},
      order: data.order ?? [],
      folders: data.folders ?? [],
      collections: data.collections ?? [],
      presets: data.presets ?? [],
      sort: data.sort ?? 'captureTime',
      sortDesc: data.sortDesc ?? false,
    });
  }
  useCatalog.setState({ loaded: true });
}

export const flushCatalog = () => persist.flush();

// ---------------------------------------------------------------------------------------------
// Mutations

/** Applies many per-photo patches in a single store update. */
export function patchMany(patches: Record<string, Partial<Photo>>) {
  useCatalog.setState((s) => {
    const photos = { ...s.photos };
    for (const [id, p] of Object.entries(patches)) if (photos[id]) photos[id] = { ...photos[id], ...p };
    return { photos };
  });
}

function patchPhotos(ids: string[], patch: (p: Photo) => Partial<Photo>) {
  useCatalog.setState((s) => {
    const photos = { ...s.photos };
    for (const id of ids) if (photos[id]) photos[id] = { ...photos[id], ...patch(photos[id]) };
    return { photos };
  });
}

/** Adds files to the catalog (skips ones already present). Returns the new photo ids. */
export function addEntries(entries: FileEntry[]): string[] {
  const s = useCatalog.getState();
  const known = new Set(Object.values(s.photos).filter((p) => !p.virtualOf).map((p) => p.path));
  const now = Date.now();
  const added: Photo[] = [];
  for (const e of entries) {
    const kind = e.kind ?? kindOf(e.path);
    if ((kind !== 'image' && kind !== 'raw') || known.has(e.path)) continue;
    known.add(e.path);
    added.push({
      id: uid('p'),
      path: e.path,
      name: e.name || basename(e.path),
      ext: e.ext,
      kind,
      size: e.size,
      mtime: e.mtime,
      importedAt: now,
      rating: 0,
      flag: null,
      label: null,
      keywords: [],
    });
  }
  if (!added.length) return [];
  const folders = new Set(s.folders);
  for (const p of added) folders.add(dirname(p.path));
  useCatalog.setState((st) => {
    const photos = { ...st.photos };
    for (const p of added) photos[p.id] = p;
    return { photos, order: [...st.order, ...added.map((p) => p.id)], folders: [...folders].sort() };
  });
  return added.map((p) => p.id);
}

export function removePhotos(ids: string[]) {
  const set = new Set(ids);
  useCatalog.setState((s) => {
    const photos = { ...s.photos };
    for (const id of ids) delete photos[id];
    const remainingDirs = new Set(Object.values(photos).map((p) => dirname(p.path)));
    return {
      photos,
      order: s.order.filter((id) => !set.has(id)),
      selection: s.selection.filter((id) => !set.has(id)),
      activeId: s.activeId && set.has(s.activeId) ? null : s.activeId,
      collections: s.collections.map((c) => ({ ...c, photoIds: c.photoIds.filter((id) => !set.has(id)) })),
      folders: s.folders.filter((f) => remainingDirs.has(f)),
    };
  });
}

export const setRating = (ids: string[], rating: number) => patchPhotos(ids, () => ({ rating: Math.max(0, Math.min(5, rating)) }));
export const setFlag = (ids: string[], flag: Flag) => patchPhotos(ids, () => ({ flag }));
export const setLabel = (ids: string[], label: ColorLabel) => patchPhotos(ids, (p) => ({ label: p.label === label && ids.length === 1 ? null : label }));
export const setMeta = (id: string, meta: PhotoMeta) => patchPhotos([id], () => ({ meta }));
export const setKeywords = (ids: string[], keywords: string[]) => patchPhotos(ids, () => ({ keywords }));

export const settingsHash = (s: DevelopSettings | undefined) => (s ? hashString(JSON.stringify(s)) : '');

/** Stores develop settings for a photo (thumbVariant is updated separately once a thumbnail is rendered). */
export function setSettings(id: string, settings: DevelopSettings | undefined) {
  patchPhotos([id], () => ({ settings, editedAt: settings ? Date.now() : undefined }));
}
export function setThumbVariant(id: string, variant: string) {
  patchPhotos([id], () => ({ thumbVariant: variant }));
}

export function createVirtualCopy(id: string): string | null {
  const src = useCatalog.getState().photos[id];
  if (!src) return null;
  const copy: Photo = { ...structuredClone(src), id: uid('p'), virtualOf: src.virtualOf ?? src.id, name: `${src.name} (copy)`, importedAt: src.importedAt };
  useCatalog.setState((s) => {
    const i = s.order.indexOf(id);
    const order = [...s.order];
    order.splice(i + 1, 0, copy.id);
    return { photos: { ...s.photos, [copy.id]: copy }, order };
  });
  return copy.id;
}

export function select(ids: string[], active?: string | null) {
  useCatalog.setState((s) => ({ selection: ids, activeId: active === undefined ? (ids.includes(s.activeId ?? '') ? s.activeId : ids[0] ?? null) : active }));
}
export const setActive = (id: string | null) => useCatalog.setState((s) => ({ activeId: id, selection: id && !s.selection.includes(id) ? [id] : s.selection }));
export const setFilter = (patch: Partial<LibraryFilter>) => useCatalog.setState((s) => ({ filter: { ...s.filter, ...patch } }));
export const setSort = (sort: SortKey, sortDesc?: boolean) => useCatalog.setState((s) => ({ sort, sortDesc: sortDesc ?? s.sortDesc }));

export function addCollection(name: string, photoIds: string[] = []): string {
  const id = uid('c');
  useCatalog.setState((s) => ({ collections: [...s.collections, { id, name, photoIds: [...new Set(photoIds)] }] }));
  return id;
}
export function addToCollection(id: string, photoIds: string[]) {
  useCatalog.setState((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, photoIds: [...new Set([...c.photoIds, ...photoIds])] } : c)) }));
}
export function removeFromCollection(id: string, photoIds: string[]) {
  const set = new Set(photoIds);
  useCatalog.setState((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, photoIds: c.photoIds.filter((p) => !set.has(p)) } : c)) }));
}
export function renameCollection(id: string, name: string) {
  useCatalog.setState((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, name } : c)) }));
}
export function deleteCollection(id: string) {
  useCatalog.setState((s) => ({ collections: s.collections.filter((c) => c.id !== id), filter: s.filter.source.type === 'collection' && s.filter.source.id === id ? { ...s.filter, source: { type: 'all' } } : s.filter }));
}

export function savePreset(name: string, group: string, settings: Partial<DevelopSettings>): string {
  const id = uid('ps');
  useCatalog.setState((s) => ({ presets: [...s.presets, { id, name, group, settings: structuredClone(settings) }] }));
  return id;
}
export function deletePreset(id: string) {
  useCatalog.setState((s) => ({ presets: s.presets.filter((p) => p.id !== id) }));
}

// ---------------------------------------------------------------------------------------------
// Queries

const captureTime = (p: Photo) => p.meta?.dateTaken ?? p.mtime;

export function filterAndSort(s: Pick<CatalogState, 'photos' | 'order' | 'filter' | 'sort' | 'sortDesc' | 'collections'>): string[] {
  const f = s.filter;
  let ids = s.order;
  if (f.source.type === 'collection') {
    const src = f.source;
    ids = s.collections.find((c) => c.id === src.id)?.photoIds ?? [];
  }
  const text = f.text.trim().toLowerCase();
  let latest = 0;
  if (f.source.type === 'recent') for (const id of ids) latest = Math.max(latest, s.photos[id]?.importedAt ?? 0);
  const recentCut = f.source.type === 'recent' ? latest - 60_000 : 0;
  const out = ids.filter((id) => {
    const p = s.photos[id];
    if (!p) return false;
    if (f.source.type === 'folder' && dirname(p.path) !== f.source.path) return false;
    if (f.source.type === 'recent' && p.importedAt < recentCut) return false;
    if (f.ratingOp === '>=' && p.rating < f.minRating) return false;
    if (f.ratingOp === '==' && p.rating !== f.minRating) return false;
    if (f.ratingOp === '<=' && p.rating > f.minRating) return false;
    if (f.flag === 'picked' && p.flag !== 'pick') return false;
    if (f.flag === 'rejected' && p.flag !== 'reject') return false;
    if (f.flag === 'unflagged' && p.flag !== null) return false;
    if (f.flag === 'notRejected' && p.flag === 'reject') return false;
    if (f.label !== 'any' && p.label !== f.label) return false;
    if (f.kind !== 'all' && p.kind !== f.kind) return false;
    if (f.edited === 'edited' && !p.settings) return false;
    if (f.edited === 'unedited' && p.settings) return false;
    if (text) {
      const hay = `${p.name} ${p.path} ${p.keywords.join(' ')} ${p.meta?.model ?? ''} ${p.meta?.lens ?? ''}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
  const dir = s.sortDesc ? -1 : 1;
  const key: Record<SortKey, (p: Photo) => number | string> = {
    captureTime,
    importTime: (p) => p.importedAt,
    name: (p) => p.name.toLowerCase(),
    rating: (p) => p.rating,
    editTime: (p) => p.editedAt ?? 0,
    size: (p) => p.size,
  };
  const k = key[s.sort];
  // Precompute keys and tie-break positions: O(n log n) even for very large catalogs.
  const index = new Map<string, number>();
  s.order.forEach((id, i) => index.set(id, i));
  const keys = new Map<string, number | string>();
  for (const id of out) keys.set(id, k(s.photos[id]));
  return [...out].sort((a, b) => {
    const va = keys.get(a)!;
    const vb = keys.get(b)!;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir || (index.get(a) ?? 0) - (index.get(b) ?? 0);
  });
}

let memo: { key: unknown[]; value: string[] } | null = null;
/** Hook: filtered + sorted photo ids (memoised on the relevant state slices). */
export function useVisibleIds(): string[] {
  return useCatalog((s) => {
    const key = [s.photos, s.order, s.filter, s.sort, s.sortDesc, s.collections];
    if (memo && memo.key.every((k, i) => k === key[i])) return memo.value;
    const value = filterAndSort(s);
    memo = { key, value };
    return value;
  });
}
