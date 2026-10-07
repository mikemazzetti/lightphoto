import { ReactNode, useMemo, useState } from 'react';
import { api, dirname } from '@/platform/api';
import { Collection, LibraryFilter, setFilter, useCatalog } from '@/state/catalog';
import { openContextMenu, openMenu } from '@/state/app';
import { Icon, IconName } from '@/ui/Icon';
import { cx, IconButton, Panel } from '@/ui/controls';
import {
  addToCollectionUndoable,
  deleteCollectionConfirm,
  importFiles,
  importFolder,
  newCollection,
  removeFolder,
  removeFromCollectionUndoable,
  renameCollectionPrompt,
  syncFolder,
} from './actions';
import { selectedIds } from './selection';
import { togglePanel, useLibraryUI } from './store';
import { DRAG_MIME, fmtInt, folderName, parentPath, revealLabel } from './util';

function sameSource(a: LibraryFilter['source'], b: LibraryFilter['source']) {
  if (a.type !== b.type) return false;
  if (a.type === 'folder' && b.type === 'folder') return a.path === b.path;
  if (a.type === 'collection' && b.type === 'collection') return a.id === b.id;
  return true;
}

function readDragIds(e: React.DragEvent): string[] {
  try {
    const v = JSON.parse(e.dataTransfer.getData(DRAG_MIME));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function SourceRow({
  icon,
  label,
  sub,
  count,
  active,
  onClick,
  onContextMenu,
  dropTarget,
  onDropIds,
  title,
}: {
  icon: IconName;
  label: ReactNode;
  sub?: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  dropTarget?: boolean;
  onDropIds?: (ids: string[]) => void;
  title?: string;
}) {
  const [over, setOver] = useState(false);
  const accepts = (e: React.DragEvent) => !!onDropIds && e.dataTransfer.types.includes(DRAG_MIME);
  return (
    <div
      className={cx('lib-src', active && 'active', over && 'drop')}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onDropIds!(readDragIds(e));
      }}
    >
      <Icon name={icon} size={13} style={{ color: active ? 'var(--accent)' : dropTarget ? 'var(--text-2)' : 'var(--text-3)' }} />
      <span className="ellipsis grow">
        {label}
        {sub && <span className="lib-src-sub"> {sub}</span>}
      </span>
      {count !== undefined && <span className="lib-count">{fmtInt(count)}</span>}
    </div>
  );
}

export function LeftPanel() {
  const order = useCatalog((s) => s.order);
  const folders = useCatalog((s) => s.folders);
  const collections = useCatalog((s) => s.collections);
  const source = useCatalog((s) => s.filter.source);
  const panels = useLibraryUI((s) => s.panels);

  // Folder counts / previous-import count only change when photos are added or removed.
  const { folderCounts, recentCount } = useMemo(() => {
    const photos = useCatalog.getState().photos;
    const counts = new Map<string, number>();
    let latest = 0;
    for (const id of order) {
      const p = photos[id];
      if (!p) continue;
      const d = dirname(p.path);
      counts.set(d, (counts.get(d) ?? 0) + 1);
      if (p.importedAt > latest) latest = p.importedAt;
    }
    let recent = 0;
    for (const id of order) if ((photos[id]?.importedAt ?? 0) >= latest - 60_000) recent++;
    return { folderCounts: counts, recentCount: order.length ? recent : 0 };
  }, [order]);

  const go = (src: LibraryFilter['source']) => setFilter({ source: src });
  const isOpen = (id: string) => panels[id] ?? true;

  const folderMenu = (e: React.MouseEvent, f: string) =>
    openContextMenu(e, [
      { heading: folderName(f) },
      { label: revealLabel, disabled: !api.isElectron, onClick: () => api.reveal(f) },
      { label: 'Synchronize Folder', disabled: !api.isElectron, onClick: () => void syncFolder(f) },
      { separator: true },
      { label: 'Remove Folder from Catalog…', danger: true, onClick: () => void removeFolder(f) },
    ]);

  const collectionMenu = (e: React.MouseEvent, c: Collection) => {
    const sel = selectedIds();
    const viewing = source.type === 'collection' && source.id === c.id;
    openContextMenu(e, [
      { heading: c.name },
      { label: sel.length ? `Add ${sel.length} Selected Photo${sel.length > 1 ? 's' : ''}` : 'Add Selected Photos', disabled: !sel.length, onClick: () => addToCollectionUndoable(c.id, sel) },
      ...(viewing ? [{ label: 'Remove Selected from Collection', disabled: !sel.length, onClick: () => removeFromCollectionUndoable(c.id, sel) }] : []),
      { separator: true },
      { label: 'Rename…', onClick: () => void renameCollectionPrompt(c) },
      { label: 'Delete Collection…', danger: true, onClick: () => void deleteCollectionConfirm(c) },
    ]);
  };

  return (
    <div className="sidebar left lib-left">
      <div className="sidebar-scroll">
        <Panel title="Catalog" open={isOpen('catalog')} onToggle={(o) => togglePanel('catalog', o)}>
          <div className="lib-list">
            <SourceRow icon="library" label="All Photographs" count={order.length} active={source.type === 'all'} onClick={() => go({ type: 'all' })} />
            <SourceRow icon="history" label="Previous Import" count={recentCount} active={source.type === 'recent'} onClick={() => go({ type: 'recent' })} />
          </div>
        </Panel>

        <Panel
          title="Folders"
          open={isOpen('folders')}
          onToggle={(o) => togglePanel('folders', o)}
          right={
            <IconButton
              icon="plus"
              small
              title="Add photos or a folder"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openMenu(r.left, r.bottom + 4, [
                  { label: 'Add Folder…', onClick: () => void importFolder() },
                  { label: 'Add Photos…', onClick: () => void importFiles() },
                ]);
              }}
            />
          }
        >
          <div className="lib-list">
            {!folders.length && <div className="lib-list-empty">No folders yet.</div>}
            {folders.map((f) => (
              <SourceRow
                key={f}
                icon="folder"
                label={folderName(f)}
                sub={parentPath(f) ? `· ${folderName(parentPath(f))}` : undefined}
                title={f}
                count={folderCounts.get(f) ?? 0}
                active={sameSource(source, { type: 'folder', path: f })}
                onClick={() => go({ type: 'folder', path: f })}
                onContextMenu={(e) => folderMenu(e, f)}
              />
            ))}
          </div>
        </Panel>

        <Panel
          title="Collections"
          open={isOpen('collections')}
          onToggle={(o) => togglePanel('collections', o)}
          right={
            <IconButton
              icon="plus"
              small
              title="New collection"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const sel = selectedIds();
                openMenu(r.left, r.bottom + 4, [
                  { label: 'New Collection…', onClick: () => void newCollection() },
                  { label: sel.length ? `New Collection with ${sel.length} Selected…` : 'New Collection from Selection…', disabled: !sel.length, onClick: () => void newCollection(sel) },
                ]);
              }}
            />
          }
        >
          <div className="lib-list">
            {collections.map((c) => (
              <SourceRow
                key={c.id}
                icon="layers"
                label={c.name}
                count={c.photoIds.length}
                active={sameSource(source, { type: 'collection', id: c.id })}
                onClick={() => go({ type: 'collection', id: c.id })}
                onContextMenu={(e) => collectionMenu(e, c)}
                dropTarget
                onDropIds={(ids) => addToCollectionUndoable(c.id, ids)}
              />
            ))}
            <NewCollectionDrop empty={!collections.length} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** "New collection" row; also a drop target that creates a collection from dragged photos. */
function NewCollectionDrop({ empty }: { empty: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx('lib-src lib-src-new', over && 'drop')}
      onClick={() => void newCollection()}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void newCollection(readDragIds(e));
      }}
    >
      <Icon name="plus" size={13} />
      <span className="ellipsis grow">{empty ? 'Create a collection (or drop photos here)' : 'New collection…'}</span>
    </div>
  );
}
