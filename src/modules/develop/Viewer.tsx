import { memo, useEffect, useRef } from 'react';
import { useKeyHeld } from '@/app/commands';
import { openMenu } from '@/state/app';
import { Button, cx, IconButton, Spinner } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { editInEditor } from './actions';
import { getController, ViewerController } from './controller';
import { exportDialog } from './export';
import { CompareMode, useDevelop } from './store';

function ViewerToolbar() {
  const compare = useDevelop((s) => s.compare);
  const before = useDevelop((s) => s.showBefore);
  const clipping = useDevelop((s) => s.clipping);
  const zoomMode = useDevelop((s) => s.zoomMode);
  const zoomPct = useDevelop((s) => s.zoomPct);
  const info = useDevelop((s) => s.info);
  const tool = useDevelop((s) => s.tool);
  const overlay = useDevelop((s) => s.maskOverlay);
  const hideLeft = useDevelop((s) => s.hideLeft);
  const hideRight = useDevelop((s) => s.hideRight);
  const toolBlocksCompare = tool === 'crop' || tool === 'mask';
  const c = () => getController();
  const setCompare = (m: CompareMode) => useDevelop.setState({ compare: m, showBefore: false });
  const zoomLevels = [25, 50, 100, 200, 400, 800];
  return (
    <div className="toolbar dv-toolbar">
      <IconButton icon="chevronLeft" small title={hideLeft ? 'Show left panels (Tab)' : 'Hide left panels'} onClick={() => useDevelop.setState({ hideLeft: !hideLeft })} style={{ transform: hideLeft ? 'scaleX(-1)' : undefined }} />
      <div className="dv-seg">
        <button type="button" className={cx(compare === 'off' && !before && 'active')} title="Loupe view" onClick={() => setCompare('off')}>
          <Icon name="loupe" size={14} />
        </button>
        <button type="button" className={cx(compare === 'split' && 'active')} title="Before / After split (Y)" disabled={toolBlocksCompare} onClick={() => setCompare('split')}>
          <Icon name="split" size={14} />
        </button>
        <button type="button" className={cx(compare === 'sbs' && 'active')} title="Before / After side by side (Y)" disabled={toolBlocksCompare} onClick={() => setCompare('sbs')}>
          <Icon name="compare" size={14} />
        </button>
      </div>
      <Button small active={before} disabled={toolBlocksCompare} onClick={() => useDevelop.setState({ showBefore: !before, compare: 'off' })} title="Show the unedited photo (\)">
        Before
      </Button>
      <div className="sep-v" />
      <div className="dv-seg">
        {(
          [
            ['fit', 'Fit'],
            ['fill', 'Fill'],
            ['100', '1:1'],
          ] as const
        ).map(([m, l]) => (
          <button key={m} type="button" className={cx(zoomMode === m && 'active')} onClick={() => c()?.applyZoomMode(m)} title={m === 'fit' ? 'Fit (⌘0)' : m === 'fill' ? 'Fill' : '100% (⌘1, Z toggles)'}>
            {l}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="dv-zoompct"
        title="Zoom level"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(
            r.left,
            r.bottom + 4,
            zoomLevels.map((z) => ({ label: `${z}%`, checked: Math.abs(zoomPct - z) < 0.5, onClick: () => c()?.zoomTo(z / 100 / (window.devicePixelRatio || 1), undefined, z === 100 ? '100' : 'custom') })),
          );
        }}
      >
        {Math.round(zoomPct)}%
        <Icon name="chevronDown" size={11} />
      </button>
      <IconButton icon="zoomOut" small title="Zoom out (⌘-)" onClick={() => c()?.zoomStep(-1)} />
      <IconButton icon="zoomIn" small title="Zoom in (⌘=)" onClick={() => c()?.zoomStep(1)} />
      <div className="spacer" />
      {tool === 'mask' && (
        <Button small active={overlay} onClick={() => useDevelop.setState({ maskOverlay: !overlay })} title="Show the selected mask as a red overlay (O)">
          Overlay
        </Button>
      )}
      <Button small active={clipping} onClick={() => useDevelop.setState({ clipping: !clipping })} title="Show clipped shadows (blue) and highlights (red) (J)">
        Clipping
      </Button>
      <IconButton icon="info" small active={info} title="Info overlay (I)" onClick={() => useDevelop.setState({ info: !info })} />
      <div className="sep-v" />
      <Button small icon="editor" onClick={() => void editInEditor()} title="Edit in Editor (⌘E)">
        Edit
      </Button>
      <Button small icon="export" onClick={() => void exportDialog()} title="Export (⇧⌘E)">
        Export
      </Button>
      <IconButton icon="chevronRight" small title={hideRight ? 'Show right panels (Tab)' : 'Hide right panels'} onClick={() => useDevelop.setState({ hideRight: !hideRight })} style={{ transform: hideRight ? 'scaleX(-1)' : undefined }} />
    </div>
  );
}

function StageHud() {
  const status = useDevelop((s) => s.status);
  const creating = useDevelop((s) => s.creating);
  const tool = useDevelop((s) => s.tool);
  const straighten = useDevelop((s) => s.straighten);
  const hint =
    creating === 'linear'
      ? 'Drag to draw a linear gradient — full effect where you start'
      : creating === 'radial'
        ? 'Drag from the centre to draw a radial gradient (Shift: circle)'
        : tool === 'wb'
          ? 'Click a neutral gray or white area to set white balance'
          : straighten
            ? 'Draw a line along something that should be level or vertical'
            : null;
  return (
    <>
      {status.loading && (
        <div className="hud dv-hud-load">
          <Spinner />
          <span>{status.label || 'Loading…'}</span>
        </div>
      )}
      {hint && <div className="hud dv-hud-hint">{hint}</div>}
      {status.error && (
        <div className="dv-error">
          <Icon name="info" size={18} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Couldn’t open this photo</div>
            <div className="muted">{status.error}</div>
          </div>
        </div>
      )}
    </>
  );
}

export const Viewer = memo(function Viewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let ctl: ViewerController;
    try {
      ctl = new ViewerController(hostRef.current!, canvasRef.current!, overlayRef.current!);
    } catch (e) {
      useDevelop.setState((s) => ({ status: { ...s.status, loading: false, error: e instanceof Error ? e.message : String(e) } }));
      return;
    }
    useDevelop.setState({ viewerReady: true });
    return () => {
      useDevelop.setState({ viewerReady: false });
      ctl.dispose();
    };
  }, []);

  useKeyHeld('space', (held) => getController()?.setSpace(held));

  return (
    <div className="dv-viewer">
      <ViewerToolbar />
      <div className="dv-stage" ref={hostRef} onContextMenu={(e) => e.preventDefault()}>
        <canvas ref={canvasRef} className="dv-gl" />
        <canvas ref={overlayRef} className="dv-overlay" />
        <StageHud />
      </div>
    </div>
  );
});
