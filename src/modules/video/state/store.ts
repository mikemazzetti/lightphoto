/**
 * Module-level video project store. Survives module unmounts (only the active module is mounted),
 * so the bin, sequence, selection and undo history persist while the user visits other modules.
 */
import { create } from 'zustand';
import { History } from '@/core/util/history';
import { api } from '@/platform/api';
import { defaultProject, normalizeProject } from '../model/defaults';
import { isFree } from '../model/ops';
import type { Clip, MediaItem, Project } from '../model/types';
import { transport } from './transport';

export type Tool = 'select' | 'ripple' | 'razor' | 'slip' | 'hand';
export type FocusPanel = 'source' | 'effectControls' | 'program' | 'timeline' | 'project' | 'effects';
export type TopLeftTab = 'source' | 'effectControls';
export type BottomLeftTab = 'project' | 'effects' | 'history';

export interface GapSel {
  trackId: string;
  start: number;
  end: number;
}
export interface TransitionSel {
  clipId: string;
  edge: 'in' | 'out';
}

export interface VideoState {
  project: Project;
  /** Selected clip ids. */
  selection: string[];
  gap: GapSel | null;
  transition: TransitionSel | null;
  selectedTracks: string[];
  tool: Tool;
  snapping: boolean;
  linkedSelection: boolean;
  /** Timeline zoom: pixels per frame. */
  zoom: number;
  scrollX: number;
  scrollY: number;
  sourceId: string | null;
  focus: FocusPanel;
  topLeftTab: TopLeftTab;
  bottomLeftTab: BottomLeftTab;
  loop: boolean;
  safeMargins: boolean;
  /** Program playback resolution factor. */
  playbackRes: 1 | 0.5 | 0.25;
  /** 0 = fit, else percent. */
  monitorZoom: number;
  binView: 'list' | 'grid';
  binFilter: string;
  binSelection: string[];
  filePath: string | null;
  /** Project identity at last save (for dirty tracking). */
  savedProject: Project | null;
  /** Throttled mirror of transport.frame for React views. */
  playhead: number;
  playing: boolean;
  historyIndex: number;
  historyLen: number;
  /** Bumped when media caches (thumbnails, waveforms) change. */
  mediaVersion: number;
  restored: boolean;
}

export const history = new History<Project>(150);

const initialProject = defaultProject();
history.reset(initialProject, 'New Project');

export const useVideo = create<VideoState>(() => ({
  project: initialProject,
  selection: [],
  gap: null,
  transition: null,
  selectedTracks: [],
  tool: 'select',
  snapping: true,
  linkedSelection: true,
  zoom: 4,
  scrollX: 0,
  scrollY: 0,
  sourceId: null,
  focus: 'timeline',
  topLeftTab: 'effectControls',
  bottomLeftTab: 'project',
  loop: false,
  safeMargins: false,
  playbackRes: 1,
  monitorZoom: 0,
  binView: 'list',
  binFilter: '',
  binSelection: [],
  filePath: null,
  savedProject: initialProject,
  playhead: 0,
  playing: false,
  historyIndex: 0,
  historyLen: 1,
  mediaVersion: 0,
  restored: false,
}));

export const getState = () => useVideo.getState();
export const getProject = () => useVideo.getState().project;
export const getSeq = () => useVideo.getState().project.seq;

// ---------------------------------------------------------------------------------------------
// Media lookup (memoised per media array identity)

let mediaMapCache: { arr: MediaItem[]; map: Map<string, MediaItem> } | null = null;
export function mediaMap(p: Project = getProject()): Map<string, MediaItem> {
  if (mediaMapCache?.arr === p.media) return mediaMapCache.map;
  const map = new Map(p.media.map((m) => [m.id, m]));
  mediaMapCache = { arr: p.media, map };
  return map;
}
export const mediaLookup = (p: Project = getProject()) => {
  const m = mediaMap(p);
  return (id: string) => m.get(id);
};

let clipMapCache: { arr: Clip[]; map: Map<string, Clip> } | null = null;
export function clipMap(p: Project = getProject()): Map<string, Clip> {
  if (clipMapCache?.arr === p.seq.clips) return clipMapCache.map;
  const map = new Map(p.seq.clips.map((c) => [c.id, c]));
  clipMapCache = { arr: p.seq.clips, map };
  return map;
}

// ---------------------------------------------------------------------------------------------
// Editing with undo

let liveKey: string | null = null;

function syncHistoryState() {
  useVideo.setState({ historyIndex: history.index, historyLen: history.entries.length });
}

/** Applies an edit and records an undo step. `merge` coalesces with the previous step of the same label. */
export function edit(label: string, fn: (p: Project) => Project, merge = false): boolean {
  const cur = getProject();
  const next = fn(cur);
  if (next === cur) return false;
  liveKey = null;
  // Never coalesce into an entry that has a redo branch after it: History.push's merge path replaces the
  // entry in place without discarding that branch, so a later redo would resurrect a stale state.
  history.push(next, label, merge && !history.canRedo);
  useVideo.setState({ project: next });
  validateSelection();
  syncHistoryState();
  return true;
}

/**
 * Continuous edit (slider drags): the first call pushes an undo step, following calls with the
 * same key replace it until endLiveEdit().
 */
export function liveEdit(key: string, label: string, fn: (p: Project) => Project) {
  const cur = getProject();
  const next = fn(cur);
  if (next === cur) return;
  if (liveKey === key && history.index > 0) history.entries[history.index] = { label, state: next, time: Date.now() };
  else history.push(next, label);
  liveKey = key;
  useVideo.setState({ project: next });
  syncHistoryState();
}
export function endLiveEdit() {
  liveKey = null;
}

/** Replaces the project without an undo step (loading, media metadata refresh). */
export function replaceProject(p: Project, opts: { resetHistory?: boolean; label?: string; saved?: boolean; filePath?: string | null } = {}) {
  if (opts.resetHistory) history.reset(p, opts.label ?? 'Open');
  else history.entries[history.index] = { ...history.entries[history.index], state: p };
  const patch: Partial<VideoState> = { project: p };
  if (opts.saved) patch.savedProject = p;
  if (opts.filePath !== undefined) patch.filePath = opts.filePath;
  if (opts.resetHistory) Object.assign(patch, { selection: [], gap: null, transition: null, binSelection: [] });
  useVideo.setState(patch);
  validateSelection();
  syncHistoryState();
}

export function undo() {
  liveKey = null;
  const p = history.undo();
  if (!p) return;
  useVideo.setState({ project: p });
  validateSelection();
  syncHistoryState();
}
export function redo() {
  liveKey = null;
  const p = history.redo();
  if (!p) return;
  useVideo.setState({ project: p });
  validateSelection();
  syncHistoryState();
}
export function gotoHistory(i: number) {
  liveKey = null;
  const p = history.goto(i);
  if (!p) return;
  useVideo.setState({ project: p });
  validateSelection();
  syncHistoryState();
}

function validateSelection() {
  const s = getState();
  const ids = clipMap(s.project);
  const sel = s.selection.filter((id) => ids.has(id));
  // A selected transition must still exist on that clip edge (splits/undo can remove it).
  const tc = s.transition && ids.get(s.transition.clipId);
  const tr = tc && (s.transition!.edge === 'in' ? tc.transIn : tc.transOut) ? s.transition : null;
  const trackIds = new Set(s.project.seq.tracks.map((t) => t.id));
  const tracks = s.selectedTracks.filter((t) => trackIds.has(t));
  // A selected gap must still be empty, else Ripple Delete would shift the other tracks out of sync.
  const gap = s.gap && trackIds.has(s.gap.trackId) && s.gap.end > s.gap.start && isFree(s.project.seq.clips, s.gap.trackId, s.gap.start, s.gap.end) ? s.gap : null;
  const mids = mediaMap(s.project);
  const bin = s.binSelection.filter((id) => mids.has(id));
  const src = s.sourceId && mids.has(s.sourceId) ? s.sourceId : null;
  if (sel.length !== s.selection.length || tr !== s.transition || gap !== s.gap || tracks.length !== s.selectedTracks.length || bin.length !== s.binSelection.length || src !== s.sourceId)
    useVideo.setState({ selection: sel, transition: tr, gap, selectedTracks: tracks, binSelection: bin, sourceId: src });
}

// ---------------------------------------------------------------------------------------------
// Playhead mirror (throttled during playback)

let lastMirror = 0;
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
transport.subscribe(() => {
  const now = performance.now();
  const s = getState();
  const f = transport.frameInt;
  const apply = () => {
    mirrorTimer = null;
    lastMirror = performance.now();
    const st = getState();
    if (st.playhead !== transport.frameInt || st.playing !== transport.playing) useVideo.setState({ playhead: transport.frameInt, playing: transport.playing });
  };
  if (!transport.playing) {
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = null;
    if (s.playhead !== f || s.playing) useVideo.setState({ playhead: f, playing: false });
    return;
  }
  if (!s.playing) useVideo.setState({ playing: true });
  if (now - lastMirror > 200) apply();
  else if (!mirrorTimer) mirrorTimer = setTimeout(apply, 200);
});

// ---------------------------------------------------------------------------------------------
// Dirty tracking + autosave

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastDirty = false;
useVideo.subscribe((s, prev) => {
  if (s.project === prev.project && s.savedProject === prev.savedProject) return;
  const dirty = s.project !== s.savedProject;
  if (dirty !== lastDirty) {
    lastDirty = dirty;
    api.setDirty(dirty);
  }
  if (!s.restored || s.project === prev.project) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    const st = getState();
    void api.storeSet('video-project', { project: st.project, filePath: st.filePath, saved: st.project === st.savedProject });
  }, 1200);
});

export function flushAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = null;
  const st = getState();
  if (!st.restored) return;
  void api.storeSet('video-project', { project: st.project, filePath: st.filePath, saved: st.project === st.savedProject });
}

let restoring: Promise<void> | null = null;
/** Restores the autosaved project once per session. */
export function restoreAutosave(): Promise<void> {
  if (restoring) return restoring;
  restoring = (async () => {
    try {
      const saved = await api.storeGet<{ project: unknown; filePath: string | null; saved?: boolean }>('video-project');
      // Only restore if the user hasn't started working in the meantime.
      if (saved?.project && getProject() === initialProject) {
        const p = normalizeProject(saved.project);
        // The autosave is the user's work in progress: it isn't "unsaved" in this session until edited.
        replaceProject(p, { resetHistory: true, label: 'Restore', filePath: saved.filePath ?? null, saved: true });
      }
    } catch (e) {
      console.warn('video autosave restore failed', e);
    } finally {
      useVideo.setState({ restored: true });
    }
  })();
  return restoring;
}

export const bumpMediaVersion = () => useVideo.setState((s) => ({ mediaVersion: s.mediaVersion + 1 }));
