import { useEffect, useMemo, useRef, useState } from 'react';
import { COLOR_LABELS, defaultFilter, LABEL_COLORS, LibraryFilter, setFilter, setSort, SortKey, useCatalog } from '@/state/catalog';
import { MenuItem, toast } from '@/state/app';
import { debounce } from '@/core/util/async';
import { shortcutLabel } from '@/app/commands';
import { Icon, IconName } from '@/ui/Icon';
import { cx, IconButton } from '@/ui/controls';
import { MenuButton } from '@/ui/overlays';
import { flag, importFiles, importFolder, rate, rotate } from './actions';
import { openExportDialog } from './dialogs';
import { selectedIds, targetIds } from './selection';
import { setUI, setView, THUMB_MAX, THUMB_MIN, useLibraryUI, ViewMode } from './store';
import { fmtInt, hasAttributeFilters, sourceTitle } from './util';

export const SORT_LABELS: Record<SortKey, string> = {
  captureTime: 'Capture Time',
  importTime: 'Import Time',
  name: 'File Name',
  rating: 'Rating',
  editTime: 'Edit Time',
  size: 'File Size',
};

const SOURCE_ICONS: Record<LibraryFilter['source']['type'], IconName> = { all: 'library', recent: 'history', folder: 'folder', collection: 'layers' };

// =============================================================================================
// Top: source title, search, attribute filters

export function FilterBar({ count }: { count: number }) {
  const filter = useCatalog((s) => s.filter);
  const collections = useCatalog((s) => s.collections);
  const total = useCatalog((s) => s.order.length);
  const selCount = useCatalog((s) => s.selection.length);
  const hasActive = useCatalog((s) => !!s.activeId);
  const open = useLibraryUI((s) => s.filterBar);
  const [text, setText] = useState(filter.text);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(filter.text);
  const commit = useMemo(() => debounce((t: string) => setFilter({ text: t }), 160), []);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setText((latest.current = filter.text));
  }, [filter.text]);
  // Don't lose a pending search when the module unmounts.
  useEffect(
    () => () => {
      commit.cancel();
      if (latest.current !== useCatalog.getState().filter.text) setFilter({ text: latest.current });
    },
    [commit],
  );
  const active = hasAttributeFilters(filter);

  return (
    <>
      <div className="toolbar lib-topbar">
        <MenuButton
          className="btn small primary lib-import-btn"
          title="Import photos into the catalog"
          items={() => [
            { label: 'Add Photos…', shortcut: shortcutLabel('shift+mod+i'), icon: <Icon name="image" size={13} />, onClick: () => void importFiles() },
            { label: 'Add Folder…', icon: <Icon name="folderPlus" size={13} />, onClick: () => void importFolder() },
          ]}
        >
          <Icon name="import" size={13} />
          Import
        </MenuButton>
        <button type="button" className="btn small" disabled={!selCount && !hasActive} title={`Export selected photos (${shortcutLabel('shift+mod+e')})`} onClick={() => openExportDialog(selectedIds())}>
          <Icon name="export" size={13} />
          Export
        </button>
        <span className="sep-v" />
        <div className="lib-source-title">
          <Icon name={SOURCE_ICONS[filter.source.type]} size={14} />
          <span className="ellipsis lib-source-name">{sourceTitle(filter, collections)}</span>
          <span className="faint lib-source-count">
            {count === total || filter.source.type !== 'all' ? fmtInt(count) : `${fmtInt(count)} of ${fmtInt(total)}`} photo{count === 1 ? '' : 's'}
            {selCount ? ` · ${fmtInt(selCount)} selected` : ''}
          </span>
        </div>
        <div className="spacer" />
        <div className="lib-search">
          <Icon name="search" size={13} />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search name, keyword, camera…"
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText((latest.current = e.target.value));
              commit(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation(); // Esc belongs to the field (else it also leaves Loupe / Survey)
                setText((latest.current = ''));
                commit.flush('');
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Enter') {
                commit.flush((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
        <IconButton icon="filter" small active={open || active} title="Attribute filters (rating, flag, label, type)" onClick={() => setUI({ filterBar: !open })} />
        {active && (
          <button
            type="button"
            className="btn small ghost"
            title="Clear all filters"
            onClick={() => {
              setText((latest.current = ''));
              commit.cancel();
              setFilter({ ...defaultFilter(), source: filter.source });
            }}
          >
            Clear
          </button>
        )}
      </div>
      {open && <AttributeBar filter={filter} />}
    </>
  );
}

function AttributeBar({ filter: f }: { filter: LibraryFilter }) {
  const opLabel = f.ratingOp === '>=' ? '≥' : f.ratingOp === '<=' ? '≤' : '=';
  return (
    <div className="lib-attrbar">
      <span className="lib-attr-label">Rating</span>
      <MenuButton
        className="btn small ghost lib-op"
        title="Rating comparison"
        items={() => [
          { label: '≥  Rating is greater than or equal to', checked: f.ratingOp === '>=', onClick: () => setFilter({ ratingOp: '>=' }) },
          { label: '=  Rating is equal to', checked: f.ratingOp === '==', onClick: () => setFilter({ ratingOp: '==' }) },
          { label: '≤  Rating is less than or equal to', checked: f.ratingOp === '<=', onClick: () => setFilter({ ratingOp: '<=' }) },
        ]}
      >
        {opLabel}
      </MenuButton>
      <div className="lib-stars filter">
        {[1, 2, 3, 4, 5].map((r) => (
          <button key={r} type="button" className={cx('lib-star', r <= f.minRating && 'on')} title={`${opLabel} ${r} star${r > 1 ? 's' : ''}`} onClick={() => setFilter({ minRating: f.minRating === r ? 0 : r })}>
            {r <= f.minRating ? <Icon name="starFill" size={11} /> : <Icon name="star" size={11} />}
          </button>
        ))}
      </div>

      <span className="sep-v" />
      <span className="lib-attr-label">Flag</span>
      <IconButton icon="flagFill" small size={13} active={f.flag === 'picked'} title="Picked only" onClick={() => setFilter({ flag: f.flag === 'picked' ? 'all' : 'picked' })} />
      <IconButton icon="flag" small size={13} active={f.flag === 'unflagged'} title="Unflagged only" onClick={() => setFilter({ flag: f.flag === 'unflagged' ? 'all' : 'unflagged' })} />
      <IconButton icon="reject" small size={13} active={f.flag === 'rejected'} title="Rejected only" onClick={() => setFilter({ flag: f.flag === 'rejected' ? 'all' : 'rejected' })} />
      <IconButton icon="eyeOff" small size={13} active={f.flag === 'notRejected'} title="Hide rejected" onClick={() => setFilter({ flag: f.flag === 'notRejected' ? 'all' : 'notRejected' })} />

      <span className="sep-v" />
      <span className="lib-attr-label">Color</span>
      {COLOR_LABELS.map((l) => (
        <button key={l} type="button" className={cx('lib-swatch', f.label === l && 'on')} style={{ background: LABEL_COLORS[l] }} title={`${l[0].toUpperCase()}${l.slice(1)} label`} onClick={() => setFilter({ label: f.label === l ? 'any' : l })} />
      ))}
      <button type="button" className={cx('lib-swatch none', f.label === null && 'on')} title="No label" onClick={() => setFilter({ label: f.label === null ? 'any' : null })} />

      <span className="sep-v" />
      <select className="select lib-mini-select" value={f.kind} title="File type" onChange={(e) => {
          setFilter({ kind: e.target.value as LibraryFilter['kind'] });
          e.currentTarget.blur(); // a focused <select> would swallow the Library shortcuts
        }}>
        <option value="all">All types</option>
        <option value="raw">RAW</option>
        <option value="image">Non-RAW</option>
      </select>
      <select className="select lib-mini-select" value={f.edited} title="Develop state" onChange={(e) => {
          setFilter({ edited: e.target.value as LibraryFilter['edited'] });
          e.currentTarget.blur();
        }}>
        <option value="all">Edited & unedited</option>
        <option value="edited">Edited</option>
        <option value="unedited">Unedited</option>
      </select>
    </div>
  );
}

// =============================================================================================
// Bottom: view modes, sort, quick flag/rating, thumbnail size

export function switchView(v: ViewMode) {
  if (v === 'survey') {
    const n = useCatalog.getState().selection.length;
    if (n < 2) {
      toast('Select two or more photos to survey (⌘/Ctrl-click).');
      return;
    }
  }
  setView(v);
}

export function ViewToolbar() {
  const view = useLibraryUI((s) => s.view);
  const thumbSize = useLibraryUI((s) => s.thumbSize);
  const zoomed = useLibraryUI((s) => s.zoomed);
  const info = useLibraryUI((s) => s.info);
  const left = useLibraryUI((s) => s.left);
  const right = useLibraryUI((s) => s.right);
  const filmstrip = useLibraryUI((s) => s.filmstrip);
  const filterBar = useLibraryUI((s) => s.filterBar);
  const sort = useCatalog((s) => s.sort);
  const sortDesc = useCatalog((s) => s.sortDesc);
  const active = useCatalog((s) => (s.activeId ? s.photos[s.activeId] : undefined));
  const hasPhotos = useCatalog((s) => s.order.length > 0);

  const sortItems = (): MenuItem[] => [
    { heading: 'Sort by' },
    ...(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ label: SORT_LABELS[k], checked: sort === k, onClick: () => setSort(k) })),
    { separator: true },
    { label: 'Ascending', checked: !sortDesc, onClick: () => setSort(sort, false) },
    { label: 'Descending', checked: sortDesc, onClick: () => setSort(sort, true) },
  ];

  const moreItems = (): MenuItem[] => [
    { label: 'Add Photos…', shortcut: shortcutLabel('shift+mod+i'), onClick: () => void importFiles() },
    { label: 'Add Folder…', onClick: () => void importFolder() },
    { label: 'Export Selected…', shortcut: shortcutLabel('shift+mod+e'), disabled: !selectedIds().length, onClick: () => openExportDialog(selectedIds()) },
    { separator: true },
    { label: 'Show Left Panel', shortcut: 'F7', checked: left, onClick: () => setUI({ left: !left }) },
    { label: 'Show Right Panel', shortcut: 'F8', checked: right, onClick: () => setUI({ right: !right }) },
    { label: 'Show Filmstrip', shortcut: 'F6', checked: filmstrip, onClick: () => setUI({ filmstrip: !filmstrip }) },
    { label: 'Show Filter Bar', shortcut: '\\', checked: filterBar, onClick: () => setUI({ filterBar: !filterBar }) },
    { separator: true },
    { heading: 'Loupe info (I)' },
    { label: 'Off', checked: info === 0, onClick: () => setUI({ info: 0 }) },
    { label: 'File name & date', checked: info === 1, onClick: () => setUI({ info: 1 }) },
    { label: 'Exposure & camera', checked: info === 2, onClick: () => setUI({ info: 2 }) },
  ];

  const rating = active?.rating ?? 0;
  return (
    <div className="toolbar lib-bottombar">
      <div className="lib-seg">
        <IconButton icon="grid" small active={view === 'grid'} title="Grid (G)" onClick={() => switchView('grid')} />
        <IconButton icon="loupe" small active={view === 'loupe'} title="Loupe (E)" onClick={() => switchView('loupe')} />
        <IconButton icon="compare" small active={view === 'survey'} title="Survey (N)" onClick={() => switchView('survey')} />
      </div>
      <span className="sep-v" />
      <span className="faint lib-tb-label">Sort</span>
      <MenuButton className="btn small ghost" items={sortItems} title="Sort order">
        {SORT_LABELS[sort]}
        <Icon name="chevronDown" size={11} />
      </MenuButton>
      <IconButton icon={sortDesc ? 'chevronDown' : 'chevronUp'} small size={13} title={sortDesc ? 'Descending — click for ascending' : 'Ascending — click for descending'} onClick={() => setSort(sort, !sortDesc)} />
      <span className="sep-v" />
      <IconButton icon="flagFill" small size={13} disabled={!active} active={active?.flag === 'pick'} title="Flag as Pick (P)" onClick={() => flag(active?.flag === 'pick' ? null : 'pick', targetIds())} />
      <IconButton icon="reject" small size={13} disabled={!active} active={active?.flag === 'reject'} title="Reject (X)" onClick={() => flag(active?.flag === 'reject' ? null : 'reject', targetIds())} />
      <div className="lib-stars toolbar-stars">
        {[1, 2, 3, 4, 5].map((r) => (
          <button key={r} type="button" disabled={!active} className={cx('lib-star', r <= rating && 'on')} title={`Rate ${r} (${r})`} onClick={() => rate(rating === r ? 0 : r, targetIds())}>
            {r <= rating ? <Icon name="starFill" size={11} /> : <Icon name="star" size={11} />}
          </button>
        ))}
      </div>
      <span className="sep-v" />
      <IconButton icon="rotateLeft" small size={13} disabled={!active} title={`Rotate left (${shortcutLabel('mod+[')})`} onClick={() => rotate(-1, targetIds())} />
      <IconButton icon="rotateRight" small size={13} disabled={!active} title={`Rotate right (${shortcutLabel('mod+]')})`} onClick={() => rotate(1, targetIds())} />
      <div className="spacer" />
      {view === 'grid' && hasPhotos && (
        <div className="lib-thumbsize" title="Thumbnail size (⌘+ / ⌘−)">
          <Icon name="image" size={11} />
          <input type="range" className="lib-range" min={THUMB_MIN} max={THUMB_MAX} value={thumbSize} onChange={(e) => setUI({ thumbSize: +e.target.value })} />
          <Icon name="image" size={15} />
        </div>
      )}
      {view === 'loupe' && (
        <div className="lib-seg">
          <button type="button" className={cx('btn small ghost', !zoomed && 'active')} onClick={() => setUI({ zoomed: false })} title="Fit (⌘0)">
            Fit
          </button>
          <button type="button" className={cx('btn small ghost', zoomed && 'active')} onClick={() => setUI({ zoomed: true })} title="100% (Z)">
            100%
          </button>
        </div>
      )}
      <MenuButton className="icon-btn small" items={moreItems} title="View options">
        <Icon name="more" size={14} />
      </MenuButton>
    </div>
  );
}
