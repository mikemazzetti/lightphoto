import { useEffect, useRef, useState } from 'react';
import { defaultFilter, select, setActive, setFilter, useCatalog } from '@/state/catalog';
import { openContextMenu } from '@/state/app';
import { isTyping, useCommands, useKeymap } from '@/app/commands';
import { Filmstrip } from '@/modules/shared/Filmstrip';
import { Icon } from '@/ui/Icon';
import { Button, Spinner } from '@/ui/controls';
import {
  deleteKey,
  editInEditor,
  ensureMetadata,
  flag,
  importDropped,
  importFiles,
  importFolder,
  label,
  openInDevelop,
  pasteSettings,
  rate,
  rotate,
  virtualCopies,
} from './actions';
import { openExportDialog } from './dialogs';
import { Grid } from './Grid';
import { redo, undo } from './history';
import { useLibraryIds } from './ids';
import { LeftPanel } from './LeftPanel';
import { Loupe } from './Loupe';
import { copySettingsFlow, photoMenu } from './menus';
import { RightPanel } from './RightPanel';
import { releasePreviewEngine } from './render';
import { deselectAll, moveActive, moveRow, moveTo, pruneSelectionToVisible, selectAll, selectedIds } from './selection';
import { setUI, setView, THUMB_MAX, THUMB_MIN, useLibraryUI } from './store';
import { Survey } from './Survey';
import { FilterBar, switchView, ViewToolbar } from './Toolbars';
import { DRAG_MIME, hasAttributeFilters } from './util';
import './library.css';

/** Library workspace (Lightroom Classic "Library" module). */
export default function LibraryModule() {
  const loaded = useCatalog((s) => s.loaded);
  const total = useCatalog((s) => s.order.length);
  const ids = useLibraryIds();
  const view = useLibraryUI((s) => s.view);
  const left = useLibraryUI((s) => s.left);
  const right = useLibraryUI((s) => s.right);
  const filmstrip = useLibraryUI((s) => s.filmstrip);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (loaded) ensureMetadata();
  }, [loaded]);
  useEffect(() => () => releasePreviewEngine(), []);

  // Filter / source changes hide photos: keep the selection to what is visible.
  const filter = useCatalog((s) => s.filter);
  const prevFilter = useRef(filter);
  useEffect(() => {
    if (prevFilter.current === filter) return;
    prevFilter.current = filter;
    pruneSelectionToVisible();
  }, [filter]);

  useLibraryShortcuts();

  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(DRAG_MIME);

  return (
    <div
      className="lib-root"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDropping(false);
        }
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        void importDropped(e.dataTransfer);
      }}
    >
      <div className="lib-main">
        {left && <LeftPanel />}
        <div className="lib-center">
          <FilterBar count={ids.length} />
          <div className="lib-view">
            {!loaded ? (
              <div className="empty-state">
                <Spinner />
              </div>
            ) : total === 0 ? (
              <EmptyCatalog />
            ) : view === 'survey' ? (
              <Survey />
            ) : ids.length === 0 ? (
              <NoMatches />
            ) : view === 'loupe' ? (
              <Loupe ids={ids} />
            ) : (
              <Grid ids={ids} />
            )}
          </div>
          <ViewToolbar />
        </div>
        {right && <RightPanel />}
      </div>
      {filmstrip && total > 0 && (
        <Filmstrip
          ids={ids}
          height={88}
          onDoubleClick={(id) => {
            setActive(id);
            setView('loupe');
          }}
          onContextMenu={(e, id) => {
            const s = useCatalog.getState();
            if (!s.selection.includes(id)) select([id], id);
            openContextMenu(e, photoMenu());
          }}
        />
      )}
      {dropping && (
        <div className="lib-drop">
          <Icon name="import" size={28} />
          <div>Drop photos or folders to import</div>
        </div>
      )}
    </div>
  );
}

function EmptyCatalog() {
  return (
    <div className="empty-state lib-empty">
      <div className="lib-empty-icon">
        <Icon name="import" size={34} />
      </div>
      <h2>Import your photos</h2>
      <p>Add photos or a whole folder (RAW, JPEG, TIFF, PNG, HEIC, PSD…). Files stay where they are — the catalog only references them.</p>
      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        <Button variant="primary" icon="folderPlus" onClick={() => void importFolder()}>
          Add Folder…
        </Button>
        <Button icon="image" onClick={() => void importFiles()}>
          Add Photos…
        </Button>
      </div>
      <p className="faint" style={{ fontSize: 11 }}>
        …or drag files and folders anywhere into this window.
      </p>
    </div>
  );
}

function NoMatches() {
  const filter = useCatalog((s) => s.filter);
  const attr = hasAttributeFilters(filter);
  return (
    <div className="empty-state">
      <Icon name="filter" size={30} />
      <h2>No photos match</h2>
      <p>{attr ? 'No photos in this source match the current filters.' : 'This source has no photos.'}</p>
      <div className="row" style={{ gap: 8 }}>
        {attr && <Button onClick={() => setFilter({ ...defaultFilter(), source: filter.source })}>Clear Filters</Button>}
        {filter.source.type !== 'all' && <Button onClick={() => setFilter({ source: { type: 'all' } })}>Show All Photographs</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Keyboard & native menu

function zoomStep(dir: 1 | -1) {
  const ui = useLibraryUI.getState();
  if (ui.view === 'loupe') return setUI({ zoomed: dir > 0 });
  setUI({ thumbSize: Math.max(THUMB_MIN, Math.min(THUMB_MAX, Math.round(ui.thumbSize * (dir > 0 ? 1.2 : 1 / 1.2)))) });
}

/** In survey, arrows move the active photo within the surveyed set. */
function moveInSurvey(delta: number) {
  const s = useCatalog.getState();
  if (s.selection.length < 2) return;
  const i = s.activeId ? s.selection.indexOf(s.activeId) : -1;
  const j = (i + delta + s.selection.length) % s.selection.length;
  setActive(s.selection[j]);
}

function useLibraryShortcuts() {
  const view = () => useLibraryUI.getState().view;
  const nav = (dx: number, extend: boolean) => {
    const v = view();
    if (v === 'survey') return moveInSurvey(dx);
    moveActive(dx, extend);
  };
  const navRow = (dir: 1 | -1, extend: boolean): boolean | void => {
    if (view() !== 'grid') return false;
    moveRow(dir, extend);
  };
  const toggleZoom = (): boolean | void => {
    const v = view();
    if (v === 'grid') {
      if (!useCatalog.getState().activeId) return false;
      setView('loupe');
      setUI({ zoomed: true });
      return;
    }
    if (v !== 'loupe') return false;
    setUI({ zoomed: !useLibraryUI.getState().zoomed });
  };
  const togglePanels = () => {
    const ui = useLibraryUI.getState();
    const anyOpen = ui.left || ui.right;
    setUI({ left: !anyOpen, right: !anyOpen });
  };

  useCommands({
    'library:importFiles': () => importFiles(),
    'library:importFolder': () => importFolder(),
    'file:open': () => importFiles(),
    'file:export': () => openExportDialog(selectedIds()),
    'edit:selectAll': () => selectAll(),
    'edit:deselect': () => deselectAll(),
    'edit:undo': () => undo(),
    'edit:redo': () => redo(),
    'view:zoomIn': () => zoomStep(1),
    'view:zoomOut': () => zoomStep(-1),
    'view:fit': () => setUI({ zoomed: false }),
    'view:actual': () => {
      if (view() === 'grid') setView('loupe');
      setUI({ zoomed: true });
    },
  });

  useKeymap({
    // views
    g: () => switchView('grid'),
    e: () => switchView('loupe'),
    n: () => switchView('survey'),
    enter: () => (view() === 'grid' && useCatalog.getState().activeId ? setView('loupe') : false),
    escape: () => (view() !== 'grid' ? setView('grid') : false),
    d: () => openInDevelop(),
    i: () => setUI({ info: ((useLibraryUI.getState().info + 1) % 3) as 0 | 1 | 2 }),
    z: () => toggleZoom(),
    // Always consumed so Space never re-activates a focused toolbar button.
    space: () => {
      if (view() === 'loupe') toggleZoom();
    },
    tab: () => togglePanels(),
    'shift+tab': () => {
      const ui = useLibraryUI.getState();
      const anyOpen = ui.left || ui.right || ui.filmstrip;
      setUI({ left: !anyOpen, right: !anyOpen, filmstrip: !anyOpen });
    },
    f6: () => setUI({ filmstrip: !useLibraryUI.getState().filmstrip }),
    f7: () => setUI({ left: !useLibraryUI.getState().left }),
    f8: () => setUI({ right: !useLibraryUI.getState().right }),
    '\\': () => setUI({ filterBar: !useLibraryUI.getState().filterBar }),
    '=': () => zoomStep(1),
    '-': () => zoomStep(-1),
    // rating / flags / labels
    '0': () => rate(0),
    '1': () => rate(1),
    '2': () => rate(2),
    '3': () => rate(3),
    '4': () => rate(4),
    '5': () => rate(5),
    p: () => flag('pick'),
    x: () => flag('reject'),
    u: () => flag(null),
    '6': () => label('red'),
    '7': () => label('yellow'),
    '8': () => label('green'),
    '9': () => label('blue'),
    // navigation
    arrowleft: () => nav(-1, false),
    arrowright: () => nav(1, false),
    'shift+arrowleft': () => nav(-1, true),
    'shift+arrowright': () => nav(1, true),
    arrowup: () => navRow(-1, false),
    arrowdown: () => navRow(1, false),
    'shift+arrowup': () => navRow(-1, true),
    'shift+arrowdown': () => navRow(1, true),
    home: () => moveTo('first'),
    end: () => moveTo('last'),
    'shift+home': () => moveTo('first', true),
    'shift+end': () => moveTo('last', true),
    // catalog
    delete: () => deleteKey(),
    backspace: () => deleteKey(),
    "mod+'": () => virtualCopies(),
    'mod+[': () => rotate(-1),
    'mod+]': () => rotate(1),
    'shift+mod+c': () => void copySettingsFlow(),
    // ⇧⌘V is "paste and match style" in the search / keyword fields: don't paste develop settings.
    'shift+mod+v': () => (isTyping(document.activeElement) ? false : pasteSettings()),
    'mod+e': () => void editInEditor(),
    'shift+mod+e': 'file:export',
    'shift+mod+i': 'library:importFiles',
    'mod+a': 'edit:selectAll',
    'mod+d': 'edit:deselect',
    'mod+z': 'edit:undo',
    'shift+mod+z': 'edit:redo',
    'mod+y': 'edit:redo',
    'mod+=': 'view:zoomIn',
    'mod+-': 'view:zoomOut',
    'mod+0': 'view:fit',
    'mod+1': 'view:actual',
  });
}
