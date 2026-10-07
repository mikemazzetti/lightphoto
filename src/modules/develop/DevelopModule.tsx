import { memo, useEffect } from 'react';
import './develop.css';
import { normalizeSettings } from '@/core/develop/settings';
import { useCommands, useKeymap } from '@/app/commands';
import { openContextMenu, useApp } from '@/state/app';
import { setSettings, useCatalog, useVisibleIds } from '@/state/catalog';
import { Button, cx, Spinner } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Filmstrip } from '../shared/Filmstrip';
import { regenerateEditedThumbnail } from '../shared/editedThumb';
import { applyPrevious, autoTone, editInEditor, goToLibrary, navigatePhoto, pasteSettings, resetAll, setTool } from './actions';
import { getController } from './controller';
import { applyCrop, cancelCrop, rotateOrientation, swapAspect } from './cropTool';
import { exportDialog } from './export';
import { deleteMask, startCreate } from './maskTool';
import { BasicPanel, HistogramPanel, ToolStrip } from './panels/Basic';
import { copySettingsDialog, HistoryPanel, NavigatorPanel, PresetsPanel, SnapshotsPanel } from './panels/Left';
import { ColorGradingPanel, ColorMixerPanel, DetailPanel, EffectsPanel, LensPanel, ToneCurvePanel, TransformPanel } from './panels/More';
import { CropPanel, MaskPanel } from './panels/Tools';
import { commitPending, defaultsFor, editCommit, flushSave, loadSnapshots, openPhoto, redo, setPreview, undo, useDevelop } from './store';
import { Viewer } from './Viewer';

/** Paste / reset for photos chosen in the filmstrip (the active one goes through history). */
function applyToPhotos(ids: string[], mode: 'paste' | 'reset') {
  const cat = useCatalog.getState();
  const clip = cat.clipboard;
  const activeId = useDevelop.getState().photoId;
  for (const id of ids) {
    const p = cat.photos[id];
    if (!p) continue;
    if (id === activeId) {
      if (mode === 'paste') pasteSettings();
      else resetAll();
      continue;
    }
    if (mode === 'reset') setSettings(id, undefined);
    else if (clip) setSettings(id, normalizeSettings({ ...(p.settings ? normalizeSettings(p.settings) : defaultsFor(p)), ...structuredClone(clip) }));
    void regenerateEditedThumbnail(id);
  }
}

function filmMenu(e: React.MouseEvent, id: string) {
  const cat = useCatalog.getState();
  const sel = cat.selection.includes(id) ? cat.selection : [id];
  const n = sel.length > 1 ? ` (${sel.length} Photos)` : '';
  openContextMenu(e, [
    { label: `Paste Settings${n}`, disabled: !cat.clipboard, onClick: () => applyToPhotos(sel, 'paste') },
    { label: `Reset Settings${n}`, onClick: () => applyToPhotos(sel, 'reset') },
    { separator: true },
    { label: 'Show in Library', onClick: goToLibrary },
  ]);
}

const RightPanels = memo(function RightPanels() {
  const tool = useDevelop((s) => s.tool);
  return (
    <aside className="sidebar right dv-right">
      <HistogramPanel />
      <ToolStrip />
      <div className="sidebar-scroll">
        {tool === 'crop' && <CropPanel />}
        {tool === 'mask' ? (
          <MaskPanel />
        ) : (
          <>
            <BasicPanel />
            <ToneCurvePanel />
            <ColorMixerPanel />
            <ColorGradingPanel />
            <DetailPanel />
            <LensPanel />
            <EffectsPanel />
            <TransformPanel />
          </>
        )}
      </div>
      <div className="dv-sidebar-foot">
        <Button small onClick={applyPrevious} title="Apply all settings of the previously viewed photo">
          Previous
        </Button>
        <Button small onClick={resetAll} title="Reset all settings (⇧⌘R)">
          Reset
        </Button>
      </div>
    </aside>
  );
});

const LeftPanels = memo(function LeftPanels() {
  const hasClip = useCatalog((s) => !!s.clipboard);
  return (
    <aside className="sidebar left dv-left">
      <div className="sidebar-scroll">
        <NavigatorPanel />
        <PresetsPanel />
        <SnapshotsPanel />
        <HistoryPanel />
      </div>
      <div className="dv-sidebar-foot">
        <Button small icon="copy" onClick={() => void copySettingsDialog()} title="Copy settings… (⇧⌘C)">
          Copy…
        </Button>
        <Button small icon="paste" disabled={!hasClip} onClick={pasteSettings} title="Paste settings (⇧⌘V)">
          Paste
        </Button>
      </div>
    </aside>
  );
});

function onEscape(): boolean {
  const st = useDevelop.getState();
  if (st.creating) useDevelop.setState({ creating: null });
  else if (st.straighten) useDevelop.setState({ straighten: false });
  else if (st.tool === 'crop') cancelCrop();
  else if (st.tool === 'wb' || st.tool === 'mask') useDevelop.setState({ tool: 'none' });
  else if (st.preview) setPreview(null);
  else if (st.showBefore || st.compare !== 'off') useDevelop.setState({ showBefore: false, compare: 'off' });
  else return false;
  return true;
}

export default function DevelopModule() {
  const loaded = useCatalog((s) => s.loaded);
  const activeId = useCatalog((s) => (s.activeId && s.photos[s.activeId] ? s.activeId : null));
  const ids = useVisibleIds();
  const viewerReady = useDevelop((s) => s.viewerReady);
  const hideLeft = useDevelop((s) => s.hideLeft);
  const hideRight = useDevelop((s) => s.hideRight);

  useEffect(() => {
    void loadSnapshots();
    return () => {
      if (useDevelop.getState().tool === 'crop') applyCrop();
      commitPending();
      setPreview(null);
      flushSave();
    };
  }, []);

  // Follow the catalog's active photo (filmstrip, ←/→, Library). Re-read settings on (re)mount.
  useEffect(() => {
    if (!loaded) return;
    openPhoto(activeId, true);
  }, [loaded, activeId]);
  useEffect(() => {
    if (!loaded || !activeId || !viewerReady) return;
    const p = useCatalog.getState().photos[activeId];
    if (p) getController()?.load(p);
  }, [loaded, activeId, viewerReady]);

  const ctl = () => getController();
  useCommands({
    'edit:undo': () => void undo(),
    'edit:redo': () => void redo(),
    'file:export': () => void exportDialog(),
    'view:zoomIn': () => ctl()?.zoomStep(1),
    'view:zoomOut': () => ctl()?.zoomStep(-1),
    'view:fit': () => ctl()?.applyZoomMode('fit'),
    'view:actual': () => ctl()?.applyZoomMode('100'),
  });

  const inMask = () => useDevelop.getState().tool === 'mask';
  const brushSel = () => {
    const st = useDevelop.getState();
    return st.tool === 'mask' && st.settings?.locals.find((l) => l.id === st.selectedMask)?.type === 'brush';
  };
  const resizeBrush = (k: number) => {
    if (!brushSel()) return false;
    useDevelop.setState((s) => ({ brush: { ...s.brush, size: Math.min(0.4, Math.max(0.002, s.brush.size * k)) } }));
    getController()?.requestOverlay();
  };
  useKeymap({
    '\\': () => {
      const st = useDevelop.getState();
      if (st.tool === 'crop' || st.tool === 'mask') return false;
      useDevelop.setState({ showBefore: !st.showBefore, compare: 'off' });
    },
    y: () => {
      const st = useDevelop.getState();
      if (st.tool === 'crop' || st.tool === 'mask') return false;
      useDevelop.setState({ compare: st.compare === 'off' ? 'split' : st.compare === 'split' ? 'sbs' : 'off', showBefore: false });
    },
    j: () => useDevelop.setState((s) => ({ clipping: !s.clipping })),
    r: () => setTool('crop'),
    w: () => setTool('wb'),
    'shift+m': () => setTool('mask'),
    m: () => startCreate('linear'),
    'shift+r': () => startCreate('radial'),
    k: () => {
      if (brushSel()) return;
      startCreate('brush');
    },
    o: () => {
      if (!inMask()) return false;
      useDevelop.setState((s) => ({ maskOverlay: !s.maskOverlay }));
    },
    '[': () => resizeBrush(1 / 1.15),
    ']': () => resizeBrush(1.15),
    delete: () => {
      const st = useDevelop.getState();
      if (st.tool !== 'mask' || !st.selectedMask) return false;
      deleteMask(st.selectedMask);
    },
    backspace: () => {
      const st = useDevelop.getState();
      if (st.tool !== 'mask' || !st.selectedMask) return false;
      deleteMask(st.selectedMask);
    },
    x: () => {
      if (useDevelop.getState().tool !== 'crop') return false;
      swapAspect();
    },
    enter: () => {
      if (useDevelop.getState().tool !== 'crop') return false;
      applyCrop();
    },
    escape: () => onEscape(),
    'shift+a': () => autoTone(),
    i: () => useDevelop.setState((s) => ({ info: !s.info })),
    tab: () => {
      const st = useDevelop.getState();
      const hide = !(st.hideLeft && st.hideRight);
      useDevelop.setState({ hideLeft: hide, hideRight: hide });
    },
    z: () => ctl()?.toggleZoom(),
    arrowleft: () => navigatePhoto(-1),
    arrowright: () => navigatePhoto(1),
    'mod+shift+c': () => void copySettingsDialog(),
    'mod+shift+v': () => pasteSettings(),
    'mod+shift+r': () => resetAll(),
    'mod+e': () => void editInEditor(),
    'mod+shift+e': 'file:export',
    'mod+z': 'edit:undo',
    'mod+shift+z': 'edit:redo',
    'ctrl+y': 'edit:redo',
    'mod+0': 'view:fit',
    'mod+1': 'view:actual',
    'mod+=': 'view:zoomIn',
    'mod+-': 'view:zoomOut',
    'mod+[': () => editCommit((s) => rotateOrientation(s, -1), 'Rotate Left'),
    'mod+]': () => editCommit((s) => rotateOrientation(s, 1), 'Rotate Right'),
  });

  if (!loaded)
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );

  if (!activeId)
    return (
      <div className="empty-state">
        <Icon name="develop" size={40} style={{ opacity: 0.35 }} />
        <h2>No photo selected</h2>
        <p>Choose a photo in the Library (or in the filmstrip below) to start developing it.</p>
        <Button variant="primary" icon="library" onClick={() => useApp.getState().setModule('library')}>
          Go to Library
        </Button>
        {ids.length > 0 && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
            <Filmstrip ids={ids} onContextMenu={filmMenu} />
          </div>
        )}
      </div>
    );

  return (
    <div className={cx('dv-root', hideLeft && 'no-left', hideRight && 'no-right')}>
      {!hideLeft && <LeftPanels />}
      <main className="dv-center">
        <Viewer />
      </main>
      {!hideRight && <RightPanels />}
      <div className="dv-film">
        <Filmstrip ids={ids} onContextMenu={filmMenu} />
      </div>
    </div>
  );
}
