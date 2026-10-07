import { create } from 'zustand';
import { History } from '@/core/util/history';
import { debounce, uid } from '@/core/util/async';
import type { Histogram } from '@/core/develop/engine';
import { defaultRawSettings, defaultSettings, DevelopSettings, LocalType, normalizeSettings } from '@/core/develop/settings';
import { api } from '@/platform/api';
import { Photo, setSettings, useCatalog } from '@/state/catalog';

/**
 * Develop module state. Lives at module level so it survives switching modules (only the active
 * module is mounted): open panels, tool, zoom mode, compare mode, per-photo undo histories and
 * snapshots. The live settings of the photo being edited are kept here and written back to the
 * catalog (debounced) — the viewer subscribes to this store outside React and re-renders on rAF.
 */

export type Tool = 'none' | 'crop' | 'mask' | 'wb';
export type CompareMode = 'off' | 'split' | 'sbs';
export type ZoomMode = 'fit' | 'fill' | '100' | 'custom';
export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';
export type MixerTab = 'hue' | 'sat' | 'lum' | 'all';
export type GradingView = '3way' | 'shadows' | 'midtones' | 'highlights' | 'global';

export interface Snapshot {
  id: string;
  name: string;
  time: number;
  settings: DevelopSettings;
}

export interface BrushOptions {
  /** Diameter as a fraction of the source image width. */
  size: number;
  feather: number;
  flow: number;
  erase: boolean;
}

export interface LoadStatus {
  loading: boolean;
  label: string;
  error: string | null;
  /** True once the full-quality source (not a thumbnail / embedded preview) is on the GPU. */
  full: boolean;
}

export interface DevelopState {
  photoId: string | null;
  settings: DevelopSettings | null;
  /** Default settings for the active photo's kind (RAW defaults include sharpening etc.). */
  defaults: DevelopSettings;
  /** Temporary settings rendered instead of `settings` (preset / snapshot / history hover). */
  preview: DevelopSettings | null;
  previewLabel: string | null;
  prevPhotoId: string | null;

  tool: Tool;
  compare: CompareMode;
  showBefore: boolean;
  splitPos: number;
  clipping: boolean;
  zoomMode: ZoomMode;
  zoomPct: number;
  info: boolean;
  hideLeft: boolean;
  hideRight: boolean;

  maskOverlay: boolean;
  selectedMask: string | null;
  /** Mask row under the pointer in the mask list (its overlay is shown while hovering). */
  hoverMask: string | null;
  creating: LocalType | null;
  brush: BrushOptions;

  cropAspect: string;
  cropPortrait: boolean;
  cropLocked: boolean;
  straighten: boolean;

  panels: Record<string, boolean>;
  /** Panels whose effect is temporarily switched off (preview only). */
  disabledPanels: Record<string, boolean>;
  curveChannel: CurveChannel;
  mixerTab: MixerTab;
  gradingView: GradingView;
  presetFilter: string;

  status: LoadStatus;
  /** Label of the built-in lens profile embedded in the current RAW (null when none / not loaded). */
  lensProfile: string | null;
  histogram: Histogram | null;
  historyTick: number;
  snapshots: Record<string, Snapshot[]>;
  viewerReady: boolean;
}

export const useDevelop = create<DevelopState>(() => ({
  photoId: null,
  settings: null,
  defaults: defaultSettings(),
  preview: null,
  previewLabel: null,
  prevPhotoId: null,

  tool: 'none',
  compare: 'off',
  showBefore: false,
  splitPos: 0.5,
  clipping: false,
  zoomMode: 'fit',
  zoomPct: 100,
  info: false,
  hideLeft: false,
  hideRight: false,

  maskOverlay: true,
  selectedMask: null,
  hoverMask: null,
  creating: null,
  brush: { size: 0.06, feather: 60, flow: 100, erase: false },

  cropAspect: 'Original',
  cropPortrait: false,
  cropLocked: true,
  straighten: false,

  panels: { navigator: true, presets: true, snapshots: false, history: true, histogram: true, basic: true, curve: false, mixer: false, grading: false, detail: false, lens: false, effects: false, transform: false },
  disabledPanels: {},
  curveChannel: 'rgb',
  mixerTab: 'hue',
  gradingView: '3way',
  presetFilter: '',

  status: { loading: false, label: '', error: null, full: false },
  lensProfile: null,
  histogram: null,
  historyTick: 0,
  snapshots: {},
  viewerReady: false,
}));

const get = useDevelop.getState;
const set = useDevelop.setState;

// ---------------------------------------------------------------------------------------------
// Path helpers (structural sharing — untouched branches keep their identity)

export type Path = string;

export function getIn(obj: unknown, path: Path): unknown {
  let o: any = obj;
  for (const k of path.split('.')) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

export function setIn<T>(obj: T, path: Path | string[], value: unknown): T {
  const keys = typeof path === 'string' ? path.split('.') : path;
  if (!keys.length) return value as T;
  const [k, ...rest] = keys;
  const src = obj as any;
  const copy = Array.isArray(src) ? src.slice() : { ...src };
  copy[k] = setIn(src?.[k], rest, value);
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Defaults & histories

export const defaultsFor = (photo: Pick<Photo, 'kind'> | undefined): DevelopSettings =>
  photo?.kind === 'raw' ? defaultRawSettings() : defaultSettings();

const histories = new Map<string, History<DevelopSettings>>();

export function historyOf(photoId: string | null): History<DevelopSettings> | null {
  return photoId ? histories.get(photoId) ?? null : null;
}

const bumpHistory = () => set((s) => ({ historyTick: s.historyTick + 1 }));

function sameSettings(a: DevelopSettings | null | undefined, b: DevelopSettings | null | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------
// Saving to the catalog

/** Photo whose live settings changed since the last catalog write. */
let dirtyFor: string | null = null;

function saveNow() {
  const { photoId, settings, defaults } = get();
  if (!photoId || !settings || dirtyFor !== photoId) return;
  dirtyFor = null;
  const photo = useCatalog.getState().photos[photoId];
  if (!photo) return;
  // Settings equal to the import defaults are stored as "unedited" so Library filters/badges stay honest.
  const isDefault = settings.locals.length === 0 && sameSettings(settings, defaults);
  if (isDefault) {
    if (photo.settings !== undefined) setSettings(photoId, undefined);
    return;
  }
  if (photo.settings !== settings) setSettings(photoId, settings);
}

const saveDebounced = debounce(saveNow, 350);
export const scheduleSave = () => {
  dirtyFor = get().photoId;
  saveDebounced();
};
export const flushSave = () => {
  if (dirtyFor) saveDebounced.flush();
  else saveDebounced.cancel();
};

// ---------------------------------------------------------------------------------------------
// Editing

/** Replaces the live settings (no history entry). */
export function setLive(next: DevelopSettings) {
  if (next === get().settings) return;
  set({ settings: next });
  scheduleSave();
}

/** Live edit through a mutator returning new settings. */
export function editLive(fn: (s: DevelopSettings) => DevelopSettings) {
  const s = get().settings;
  if (!s) return;
  setLive(fn(s));
}

/** Sets one value by dotted path (e.g. 'grading.shadows.hue', 'hsl.sat.3') — live. */
export function setPath(path: Path, value: unknown) {
  const s = get().settings;
  if (!s || getIn(s, path) === value) return;
  setLive(setIn(s, path, value));
}

/** Records the current live settings as a history step (no-op if nothing changed). */
export function commit(label: string) {
  const { photoId, settings } = get();
  if (!photoId || !settings) return;
  let h = histories.get(photoId);
  if (!h) {
    h = new History<DevelopSettings>(300);
    h.reset(settings, 'Open');
    histories.set(photoId, h);
    bumpHistory();
    return;
  }
  if (h.current === settings) return;
  h.push(settings, label);
  bumpHistory();
  scheduleSave();
}

/**
 * Records live changes that are not in the history yet (open crop session, a drag interrupted by a
 * photo / module switch) before leaving the photo: they get saved to the catalog, so the photo's
 * history must contain them too.
 */
export function commitPending() {
  const { photoId, settings, tool } = get();
  const h = historyOf(photoId);
  if (h && settings && h.current !== settings && !sameSettings(h.current, settings)) commit(tool === 'crop' ? 'Crop & Straighten' : 'Edit');
}

/** Live edit + commit in one go. */
export function editCommit(fn: (s: DevelopSettings) => DevelopSettings, label: string) {
  editLive(fn);
  commit(label);
}

export function undo() {
  const h = historyOf(get().photoId);
  const s = h?.undo();
  if (!s) return false;
  set({ settings: s, preview: null, previewLabel: null });
  bumpHistory();
  scheduleSave();
  return true;
}

export function redo() {
  const h = historyOf(get().photoId);
  const s = h?.redo();
  if (!s) return false;
  set({ settings: s, preview: null, previewLabel: null });
  bumpHistory();
  scheduleSave();
  return true;
}

export function gotoHistory(i: number) {
  const h = historyOf(get().photoId);
  const s = h?.goto(i);
  if (!s) return;
  set({ settings: s, preview: null, previewLabel: null });
  bumpHistory();
  scheduleSave();
}

/** Drops all history steps but the current one. */
export function clearHistory() {
  const { photoId, settings } = get();
  if (!photoId || !settings) return;
  const h = new History<DevelopSettings>(300);
  h.reset(settings, 'Cleared');
  histories.set(photoId, h);
  bumpHistory();
}

export function setPreview(s: DevelopSettings | null, label: string | null = null) {
  if (get().preview === s) return;
  set({ preview: s, previewLabel: s ? label : null });
}

// ---------------------------------------------------------------------------------------------
// Opening photos

/**
 * Makes `id` the photo being edited: flushes the previous photo's settings, loads the new one's
 * settings (or the kind's defaults) and its undo history. `force` re-reads the catalog even when
 * the id is unchanged (e.g. after returning from Library, where settings may have been pasted).
 */
export function openPhoto(id: string | null, force = false) {
  flushSave();
  const st = get();
  if (id === st.photoId && !force) return;
  const leaving = st.photoId && st.photoId !== id ? st.photoId : null;
  if (leaving) {
    commitPending();
    flushSave();
  }
  if (!id) {
    set({ photoId: null, settings: null, preview: null, previewLabel: null, histogram: null });
    return;
  }
  const photo = useCatalog.getState().photos[id];
  if (!photo) {
    set({ photoId: null, settings: null, preview: null, previewLabel: null });
    return;
  }
  const defaults = defaultsFor(photo);
  const initial = photo.settings ? normalizeSettings(photo.settings) : defaults;
  let h = histories.get(id);
  if (!h) {
    h = new History<DevelopSettings>(300);
    h.reset(initial, photo.settings ? 'Open' : 'Import');
    histories.set(id, h);
  } else if (h.current !== photo.settings && !sameSettings(h.current, initial)) {
    h.push(initial, photo.settings ? 'Settings Changed in Library' : 'Reset in Library');
  }
  set({
    photoId: id,
    settings: h.current ?? initial,
    defaults,
    preview: null,
    previewLabel: null,
    prevPhotoId: leaving ?? st.prevPhotoId,
    tool: st.tool === 'crop' || st.tool === 'wb' ? 'none' : st.tool,
    straighten: false,
    selectedMask: null,
    hoverMask: null,
    creating: null,
    showBefore: false,
    histogram: leaving ? null : st.histogram,
    historyTick: st.historyTick + 1,
  });
}

// ---------------------------------------------------------------------------------------------
// UI helpers

export const setPanelOpen = (id: string, open: boolean) => set((s) => ({ panels: { ...s.panels, [id]: open } }));
export const setPanelDisabled = (id: string, disabled: boolean) => set((s) => ({ disabledPanels: { ...s.disabledPanels, [id]: disabled } }));

// ---------------------------------------------------------------------------------------------
// Snapshots (per photo, persisted)

const SNAP_KEY = 'develop-snapshots';
let snapshotsLoaded = false;

export async function loadSnapshots() {
  if (snapshotsLoaded) return;
  snapshotsLoaded = true;
  try {
    const data = await api.storeGet<Record<string, Snapshot[]>>(SNAP_KEY);
    if (data && typeof data === 'object') {
      const out: Record<string, Snapshot[]> = {};
      for (const [k, list] of Object.entries(data)) if (Array.isArray(list)) out[k] = list.map((x) => ({ ...x, settings: normalizeSettings(x.settings) }));
      set((s) => ({ snapshots: { ...out, ...s.snapshots } }));
    }
  } catch {
    /* non-fatal */
  }
}

const persistSnapshots = debounce(() => {
  if (!snapshotsLoaded) return;
  void api.storeSet(SNAP_KEY, get().snapshots);
}, 500);

function updateSnapshots(photoId: string, fn: (list: Snapshot[]) => Snapshot[]) {
  set((s) => ({ snapshots: { ...s.snapshots, [photoId]: fn(s.snapshots[photoId] ?? []) } }));
  persistSnapshots();
}

export function addSnapshot(name: string) {
  const { photoId, settings } = get();
  if (!photoId || !settings) return;
  updateSnapshots(photoId, (l) => [...l, { id: uid('snap'), name, time: Date.now(), settings }]);
}
export function deleteSnapshot(id: string) {
  const { photoId } = get();
  if (photoId) updateSnapshots(photoId, (l) => l.filter((x) => x.id !== id));
}
export function renameSnapshot(id: string, name: string) {
  const { photoId } = get();
  if (photoId) updateSnapshots(photoId, (l) => l.map((x) => (x.id === id ? { ...x, name } : x)));
}
export function updateSnapshot(id: string) {
  const { photoId, settings } = get();
  if (photoId && settings) updateSnapshots(photoId, (l) => l.map((x) => (x.id === id ? { ...x, settings, time: Date.now() } : x)));
}
