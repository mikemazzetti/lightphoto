import { api } from '@/platform/api';
import { COLOR_LABELS, LABEL_COLORS, useCatalog } from '@/state/catalog';
import type { MenuItem } from '@/state/app';
import { shortcutLabel } from '@/app/commands';
import { Icon } from '@/ui/Icon';
import {
  addToCollectionUndoable,
  copySettings,
  editInEditor,
  flag,
  label,
  newCollection,
  openInDevelop,
  pasteSettings,
  rate,
  removeFromCatalog,
  removeFromCollectionUndoable,
  resetSettings,
  revealPhoto,
  rotate,
  sendSelectionToVideo,
  syncSettings,
  virtualCopies,
} from './actions';
import { chooseGroups, openExportDialog } from './dialogs';
import { selectedIds, targetIds } from './selection';
import { revealLabel } from './util';

const k = shortcutLabel;
const swatch = (c: string) => <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />;
const LABEL_KEYS: Record<string, string> = { red: '6', yellow: '7', green: '8', blue: '9' };

export async function copySettingsFlow() {
  const groups = await chooseGroups('Copy Settings', 'Copy', 'Choose which develop settings to copy from the active photo.');
  if (groups) copySettings(groups);
}

export async function syncSettingsFlow() {
  const s = useCatalog.getState();
  if (s.selection.length < 2 || !s.activeId) return;
  const src = s.photos[s.activeId];
  const groups = await chooseGroups('Synchronize Settings', 'Synchronize', `Copy the chosen settings from “${src?.name}” (the active photo) to the ${s.selection.length - 1} other selected photos.`);
  if (groups) syncSettings(groups);
}

export function ratingItems(): MenuItem[] {
  const ids = targetIds();
  const photos = useCatalog.getState().photos;
  const cur = ids.length === 1 ? photos[ids[0]]?.rating : -1;
  return [0, 1, 2, 3, 4, 5].map((r) => ({ label: r ? '★'.repeat(r) : 'None', shortcut: String(r), checked: cur === r, onClick: () => rate(r) }));
}

export function flagItems(): MenuItem[] {
  const ids = targetIds();
  const cur = ids.length === 1 ? useCatalog.getState().photos[ids[0]]?.flag : undefined;
  return [
    { label: 'Flagged (Pick)', shortcut: 'P', checked: cur === 'pick', onClick: () => flag('pick') },
    { label: 'Unflagged', shortcut: 'U', checked: cur === null, onClick: () => flag(null) },
    { label: 'Rejected', shortcut: 'X', checked: cur === 'reject', onClick: () => flag('reject') },
  ];
}

export function labelItems(): MenuItem[] {
  const ids = targetIds();
  const cur = ids.length === 1 ? useCatalog.getState().photos[ids[0]]?.label : undefined;
  return [
    ...COLOR_LABELS.map((l) => ({ label: l[0].toUpperCase() + l.slice(1), icon: swatch(LABEL_COLORS[l]), checked: cur === l, shortcut: LABEL_KEYS[l], onClick: () => label(l) })),
    { separator: true },
    { label: 'None', checked: cur === null, onClick: () => label(null) },
  ];
}

export function collectionItems(): MenuItem[] {
  const cols = useCatalog.getState().collections;
  return [
    ...cols.map((c) => ({ label: c.name, onClick: () => addToCollectionUndoable(c.id, selectedIds()) })),
    ...(cols.length ? [{ separator: true } as MenuItem] : []),
    { label: 'New Collection…', onClick: () => void newCollection(selectedIds()) },
  ];
}

/** Context menu for photos (grid cells, filmstrip, loupe). */
export function photoMenu(): MenuItem[] {
  const s = useCatalog.getState();
  const sel = selectedIds();
  const n = sel.length;
  const src = s.filter.source;
  const inCollection = src.type === 'collection' ? s.collections.find((c) => c.id === src.id) : undefined;
  const anyEdited = sel.some((id) => s.photos[id]?.settings);
  return [
    { heading: n > 1 ? `${n} photos` : s.photos[sel[0]]?.name ?? '' },
    { label: 'Open in Develop', shortcut: 'D', icon: <Icon name="develop" size={13} />, onClick: () => openInDevelop() },
    { label: 'Edit in Editor', shortcut: k('mod+e'), icon: <Icon name="editor" size={13} />, onClick: () => void editInEditor() },
    { label: n > 1 ? `Send ${n} Photos to Video` : 'Send to Video', icon: <Icon name="video" size={13} />, onClick: sendSelectionToVideo },
    { separator: true },
    { label: 'Set Rating', submenu: ratingItems() },
    { label: 'Set Flag', submenu: flagItems() },
    { label: 'Set Color Label', submenu: labelItems() },
    { label: 'Add to Collection', submenu: collectionItems() },
    ...(inCollection ? [{ label: `Remove from “${inCollection.name}”`, onClick: () => removeFromCollectionUndoable(inCollection.id, sel) } as MenuItem] : []),
    { separator: true },
    { label: 'Rotate Left', shortcut: k("mod+["), icon: <Icon name="rotateLeft" size={13} />, onClick: () => rotate(-1, sel) },
    { label: 'Rotate Right', shortcut: k("mod+]"), icon: <Icon name="rotateRight" size={13} />, onClick: () => rotate(1, sel) },
    { label: n > 1 ? 'Create Virtual Copies' : 'Create Virtual Copy', shortcut: k("mod+'"), icon: <Icon name="copy" size={13} />, onClick: () => virtualCopies(sel) },
    { separator: true },
    { label: 'Copy Develop Settings…', shortcut: k('shift+mod+c'), onClick: () => void copySettingsFlow() },
    { label: 'Paste Develop Settings', shortcut: k('shift+mod+v'), disabled: !s.clipboard, onClick: () => pasteSettings(sel) },
    { label: 'Sync Settings…', disabled: n < 2, onClick: () => void syncSettingsFlow() },
    { label: 'Reset Develop Settings', disabled: !anyEdited, onClick: () => resetSettings(sel) },
    { separator: true },
    { label: revealLabel, disabled: !api.isElectron, onClick: () => revealPhoto() },
    { label: n > 1 ? `Export ${n} Photos…` : 'Export…', shortcut: k('shift+mod+e'), icon: <Icon name="export" size={13} />, onClick: () => openExportDialog(sel) },
    { separator: true },
    { label: n > 1 ? `Remove ${n} Photos from Catalog…` : 'Remove from Catalog…', danger: true, icon: <Icon name="trash" size={13} />, onClick: () => void removeFromCatalog(sel) },
  ];
}
