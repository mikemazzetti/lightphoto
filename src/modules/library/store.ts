import { create } from 'zustand';
import { api } from '@/platform/api';
import { debounce } from '@/core/util/async';
import type { ExportFormat } from '@/core/image/encode';
import type { SettingGroup } from '@/core/develop/settings';

/**
 * Library view state. Module-level so it survives the module being unmounted when the user
 * switches to Develop/Edit/Video; the persistent subset is also saved to the user store.
 */

export type ViewMode = 'grid' | 'loupe' | 'survey';
export type InfoMode = 0 | 1 | 2;

export interface ExportPrefs {
  format: ExportFormat;
  quality: number;
  longEdge: number;
  dir: string;
  template: string;
  includeEdits: boolean;
  onExists: 'suffix' | 'overwrite' | 'skip';
}

export interface LibraryUI {
  view: ViewMode;
  thumbSize: number;
  left: boolean;
  right: boolean;
  filmstrip: boolean;
  filterBar: boolean;
  info: InfoMode;
  panels: Record<string, boolean>;
  exportPrefs: ExportPrefs;
  copyGroups: SettingGroup[];
  // ---- runtime only (not persisted)
  /** Columns of the grid as currently laid out (for ↑/↓ navigation). */
  cols: number;
  /** Loupe is at 100%. */
  zoomed: boolean;
  /** Last grid scroll offset, restored when returning from loupe. */
  gridScroll: number;
}

export const THUMB_MIN = 72;
export const THUMB_MAX = 380;

const PERSISTED = ['view', 'thumbSize', 'left', 'right', 'filmstrip', 'filterBar', 'info', 'panels', 'exportPrefs', 'copyGroups'] as const;

export const DEFAULT_COPY_GROUPS: SettingGroup[] = ['whiteBalance', 'basicTone', 'presence', 'toneCurve', 'colorMixer', 'treatment', 'colorGrading', 'detail', 'optics', 'effects'];

export const useLibraryUI = create<LibraryUI>(() => ({
  view: 'grid',
  thumbSize: 168,
  left: true,
  right: true,
  filmstrip: true,
  filterBar: true,
  info: 1,
  panels: {},
  exportPrefs: {
    format: 'jpeg',
    quality: 90,
    longEdge: 0,
    dir: '',
    template: '{name}',
    includeEdits: true,
    onExists: 'suffix',
  },
  copyGroups: DEFAULT_COPY_GROUPS,
  cols: 1,
  zoomed: false,
  gridScroll: 0,
}));

const STORE_KEY = 'library-ui-v1';
let loaded = false;

async function loadPrefs() {
  if (loaded) return;
  loaded = true;
  try {
    const d = await api.storeGet<Partial<LibraryUI>>(STORE_KEY);
    if (!d || typeof d !== 'object') return;
    const patch: Partial<LibraryUI> = {};
    for (const k of PERSISTED) if (d[k] !== undefined) (patch as any)[k] = d[k];
    if (patch.exportPrefs) patch.exportPrefs = { ...useLibraryUI.getState().exportPrefs, ...patch.exportPrefs };
    if (patch.view === 'survey') patch.view = 'grid';
    useLibraryUI.setState(patch);
  } catch {
    /* ignore corrupt prefs */
  }
}
void loadPrefs();

const persist = debounce(() => {
  const s = useLibraryUI.getState();
  const out: Record<string, unknown> = {};
  for (const k of PERSISTED) out[k] = s[k];
  void api.storeSet(STORE_KEY, out);
}, 800);

useLibraryUI.subscribe((s, prev) => {
  if (PERSISTED.some((k) => s[k] !== prev[k])) persist();
});

export const setUI = (patch: Partial<LibraryUI>) => useLibraryUI.setState(patch);

export function setView(view: ViewMode) {
  useLibraryUI.setState({ view, zoomed: false });
}

export function togglePanel(id: string, open: boolean) {
  useLibraryUI.setState((s) => ({ panels: { ...s.panels, [id]: open } }));
}
