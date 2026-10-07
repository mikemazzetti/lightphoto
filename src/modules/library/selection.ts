import { select, useCatalog } from '@/state/catalog';
import { getLibraryIds } from './ids';
import { useLibraryUI } from './store';

/** Selection semantics shared by grid, keyboard and menus (Finder/Lightroom hybrid). */

let anchor: string | null = null;
export const setAnchor = (id: string | null) => {
  anchor = id;
};

interface Mods {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

function rangeIds(ids: string[], a: number, b: number) {
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** click = select one · ⌘/Ctrl-click = toggle · Shift-click = range from the anchor (⌘⇧ adds). */
export function clickSelect(ids: string[], index: number, e: Mods) {
  const id = ids[index];
  if (!id) return;
  const s = useCatalog.getState();
  const mod = e.metaKey || e.ctrlKey;
  if (e.shiftKey) {
    const a = anchor && ids.includes(anchor) ? anchor : s.activeId && ids.includes(s.activeId) ? s.activeId : id;
    const range = rangeIds(ids, ids.indexOf(a), index);
    select(mod ? [...new Set([...s.selection, ...range])] : range, id);
    if (!anchor) anchor = a;
    return;
  }
  if (mod) {
    if (s.selection.includes(id)) {
      const sel = s.selection.filter((x) => x !== id);
      select(sel, s.activeId === id ? sel[sel.length - 1] ?? null : s.activeId);
    } else select([...s.selection, id], id);
    anchor = id;
    return;
  }
  select([id], id);
  anchor = id;
}

/** Moves the active photo by `delta` positions in the visible order (Shift extends). */
export function moveActive(delta: number, extend = false) {
  const ids = getLibraryIds();
  if (!ids.length) return;
  const s = useCatalog.getState();
  const i = s.activeId ? ids.indexOf(s.activeId) : -1;
  const j = i < 0 ? (delta < 0 ? ids.length - 1 : 0) : Math.max(0, Math.min(ids.length - 1, i + delta));
  const id = ids[j];
  if (extend) {
    const a = anchor && ids.includes(anchor) ? anchor : s.activeId && i >= 0 ? s.activeId : id;
    anchor = a;
    select(rangeIds(ids, ids.indexOf(a), j), id);
  } else {
    select([id], id);
    anchor = id;
  }
}

export function moveTo(where: 'first' | 'last', extend = false) {
  const ids = getLibraryIds();
  if (!ids.length) return;
  const s = useCatalog.getState();
  const i = s.activeId ? ids.indexOf(s.activeId) : -1;
  if (i < 0 || !extend) {
    const id = where === 'first' ? ids[0] : ids[ids.length - 1];
    select([id], id);
    anchor = id;
    return;
  }
  moveActive(where === 'first' ? -i : ids.length - 1 - i, true);
}

/** Row navigation in the grid (one row = current column count). */
export const moveRow = (dir: 1 | -1, extend = false) => moveActive(dir * Math.max(1, useLibraryUI.getState().cols), extend);

export function selectAll() {
  const ids = getLibraryIds();
  const s = useCatalog.getState();
  select(ids, s.activeId && ids.includes(s.activeId) ? s.activeId : ids[0] ?? null);
}

export function deselectAll() {
  select([], null);
  anchor = null;
}

/**
 * After the filter / source changed: drops photos it hides from the selection (and the active
 * photo), so keyboard actions (rate, flag, delete, paste…) never hit photos the user can't see.
 */
export function pruneSelectionToVisible() {
  const s = useCatalog.getState();
  if (!s.selection.length && !s.activeId) return;
  const visible = new Set(getLibraryIds());
  const sel = s.selection.filter((id) => visible.has(id));
  const active = s.activeId && visible.has(s.activeId) ? s.activeId : sel[0] ?? null;
  if (sel.length !== s.selection.length || active !== s.activeId) select(sel, active);
  if (anchor && !visible.has(anchor)) anchor = null;
}

/** Photos an action applies to: the selection (or the active photo when nothing is selected). */
export function targetIds(): string[] {
  const s = useCatalog.getState();
  const view = useLibraryUI.getState().view;
  // Loupe / survey act on the photo being looked at, like Lightroom.
  if (view !== 'grid') return s.activeId ? [s.activeId] : s.selection.slice(0, 1);
  if (s.selection.length) return s.selection;
  return s.activeId ? [s.activeId] : [];
}

/** Photos a batch action (export, sync, collections, video) applies to, in any view. */
export function selectedIds(): string[] {
  const s = useCatalog.getState();
  if (s.selection.length) return s.selection;
  return s.activeId ? [s.activeId] : [];
}

/** Ensures there is an active photo (first visible) and returns it. */
export function ensureActive(): string | null {
  const s = useCatalog.getState();
  if (s.activeId && s.photos[s.activeId]) return s.activeId;
  const first = (s.selection.length ? s.selection : getLibraryIds())[0] ?? null;
  if (first) select(s.selection.length ? s.selection : [first], first);
  return first;
}
