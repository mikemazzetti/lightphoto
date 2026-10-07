import { useEffect, useReducer, useRef, useState } from 'react';
import { ColorPickerBody } from '@/ui/ColorPicker';
import { cx, Slider } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { hexToRgba, rgbaToCss, rgbaToHex, rgbToHsv, hsvToRgb } from '@/core/util/color';
import { zoomPercent } from '@/ui/viewport';
import { bus } from '../../model/bus';
import { persistPrefs, setBg, setFg, touch, useActiveDoc, useEditor } from '../../model/store';
import { getCompositor } from '../../render/compositor';
import { A, readyForHistory } from '../../actions';
import { viewCommands } from '../CanvasView';
import { viewportSize } from '../../ops/docs';
import { EdIcon } from '../icons';

// ---------------------------------------------------------------------------------------------
// Color

export function ColorPanel() {
  const fg = useEditor((s) => s.fg);
  const bg = useEditor((s) => s.bg);
  const [which, setWhich] = useState<'fg' | 'bg'>('fg');
  const cur = which === 'fg' ? fg : bg;
  const set = which === 'fg' ? setFg : setBg;
  const [h, s, v] = rgbToHsv(cur.r, cur.g, cur.b);
  return (
    <div className="ed-color-panel">
      <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div className="ed-colors big">
          <button type="button" className={cx('ed-color bg', which === 'bg' && 'sel')} style={{ background: rgbaToCss(bg) }} title="Background" onClick={() => setWhich('bg')} />
          <button type="button" className={cx('ed-color fg', which === 'fg' && 'sel')} style={{ background: rgbaToCss(fg) }} title="Foreground" onClick={() => setWhich('fg')} />
          <button type="button" className="ed-color-swap" title="Switch colors (X)" onClick={A.swapColors}>
            <EdIcon name="swap" size={11} />
          </button>
          <button type="button" className="ed-color-reset" title="Default colors (D)" onClick={A.resetColors}>
            <span />
            <span />
          </button>
        </div>
        <div className="col grow" style={{ gap: 2 }}>
          <Slider label="R" labelWidth={14} value={Math.round(cur.r)} min={0} max={255} gradient={`linear-gradient(90deg, rgb(0,${cur.g},${cur.b}), rgb(255,${cur.g},${cur.b}))`} onChange={(x) => set({ ...cur, r: x })} />
          <Slider label="G" labelWidth={14} value={Math.round(cur.g)} min={0} max={255} gradient={`linear-gradient(90deg, rgb(${cur.r},0,${cur.b}), rgb(${cur.r},255,${cur.b}))`} onChange={(x) => set({ ...cur, g: x })} />
          <Slider label="B" labelWidth={14} value={Math.round(cur.b)} min={0} max={255} gradient={`linear-gradient(90deg, rgb(${cur.r},${cur.g},0), rgb(${cur.r},${cur.g},255))`} onChange={(x) => set({ ...cur, b: x })} />
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="faint mono" style={{ fontSize: 10.5 }}>
          H {Math.round(h)}° S {Math.round(s * 100)}% B {Math.round(v * 100)}%
        </span>
        <span className="spacer" />
        <input
          className="input mono"
          style={{ width: 76 }}
          key={rgbaToHex(cur)}
          defaultValue={rgbaToHex(cur)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            if (/^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) set(hexToRgba(e.target.value));
          }}
        />
      </div>
      <ColorPickerBody value={cur} alpha={false} onChange={set} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Swatches

export function SwatchesPanel() {
  const swatches = useEditor((s) => s.swatches);
  const fg = useEditor((s) => s.fg);
  return (
    <div className="ed-swatches">
      <div className="ed-swatch-grid">
        {swatches.map((c, i) => (
          <button
            key={`${c}${i}`}
            type="button"
            className="ed-swatch"
            title={`${c} — click: foreground · ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}-click: background · ${navigator.platform.includes('Mac') ? '⌥' : 'Alt'}-click: delete`}
            style={{ background: c }}
            onClick={(e) => {
              if (e.altKey) {
                useEditor.setState({ swatches: swatches.filter((_, j) => j !== i) });
                persistPrefs();
              } else if (e.metaKey || e.ctrlKey) setBg(hexToRgba(c));
              else setFg(hexToRgba(c));
            }}
          />
        ))}
        <button
          type="button"
          className="ed-swatch add"
          title="Add the foreground color"
          onClick={() => {
            useEditor.setState({ swatches: [...swatches, rgbaToHex(fg)] });
            persistPrefs();
          }}
        >
          <Icon name="plus" size={12} />
        </button>
      </div>
      <div className="faint" style={{ fontSize: 10.5 }}>
        Click: foreground · {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}-click: background · {navigator.platform.includes('Mac') ? '⌥' : 'Alt'}-click: delete
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Navigator

export function NavigatorPanel() {
  const doc = useActiveDoc();
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const img = useRef<ImageData | null>(null);
  const W = 236;
  const H = 150;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const redraw = () => {
      const c = getCompositor();
      const cv = ref.current;
      if (!c || !cv) return;
      const im = c.thumbnail(W * (window.devicePixelRatio || 1), H * (window.devicePixelRatio || 1));
      if (!im) return;
      img.current = im;
      cv.width = im.width;
      cv.height = im.height;
      cv.getContext('2d')!.putImageData(im, 0, 0);
      force();
    };
    const schedule = () => {
      clearTimeout(timer);
      const wait = Math.max(0, 250 - (performance.now() - last));
      timer = setTimeout(() => {
        last = performance.now();
        redraw();
      }, wait);
    };
    const off1 = bus.rendered.on(schedule);
    const off2 = bus.view.on(force);
    schedule();
    return () => {
      off1();
      off2();
      clearTimeout(timer);
    };
  }, [doc?.id]);

  if (!doc) return <div className="ed-panel-empty">No document</div>;
  const k = Math.min(W / doc.width, H / doc.height);
  const tw = doc.width * k;
  const th = doc.height * k;
  const v = doc.view;
  const vx = (-v.x / v.scale) * k;
  const vy = (-v.y / v.scale) * k;
  const vw = (viewportSize.w / v.scale) * k;
  const vh = (viewportSize.h / v.scale) * k;
  const pct = zoomPercent(v);

  const drag = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const go = (cx: number, cy: number) => {
      const ix = ((cx - r.left - (W - tw) / 2) / k) * v.scale;
      const iy = ((cy - r.top - (H - th) / 2) / k) * v.scale;
      doc.view = { ...doc.view, x: viewportSize.w / 2 - ix, y: viewportSize.h / 2 - iy };
      doc.fitted = false;
      bus.view.emit();
      bus.requestFrame();
      bus.requestOverlay();
    };
    go(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => go(ev.clientX, ev.clientY);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div className="ed-nav">
      <div className="ed-nav-view" style={{ width: W, height: H }} onPointerDown={drag}>
        <canvas ref={ref} style={{ width: tw, height: th, left: (W - tw) / 2, top: (H - th) / 2 }} />
        <div ref={boxRef} className="ed-nav-box" style={{ left: (W - tw) / 2 + vx, top: (H - th) / 2 + vy, width: vw, height: vh }} />
      </div>
      <div className="row">
        <button type="button" className="icon-btn small" title="Zoom out" onClick={viewCommands.zoomOut}>
          <Icon name="zoomOut" size={14} />
        </button>
        <Slider
          label={`${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`}
          labelWidth={44}
          value={Math.log2(pct / 100)}
          min={-5}
          max={5}
          step={0.01}
          precision={2}
          onChange={(x) => {
            const dpr = window.devicePixelRatio || 1;
            const scale = 2 ** x / dpr;
            const cx = viewportSize.w / 2;
            const cy = viewportSize.h / 2;
            const ix = (cx - doc.view.x) / doc.view.scale;
            const iy = (cy - doc.view.y) / doc.view.scale;
            doc.view = { scale, x: cx - ix * scale, y: cy - iy * scale };
            doc.fitted = false;
            bus.view.emit();
            bus.requestFrame();
            bus.requestOverlay();
          }}
        />
        <button type="button" className="icon-btn small" title="Zoom in" onClick={viewCommands.zoomIn}>
          <Icon name="zoomIn" size={14} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// History

const mb = (b: number) => (b > 1048576 * 1024 ? `${(b / 1073741824).toFixed(1)} GB` : `${(b / 1048576).toFixed(b > 1048576 * 10 ? 0 : 1)} MB`);

export function HistoryPanel() {
  const doc = useActiveDoc();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector('.current');
    el?.scrollIntoView({ block: 'nearest' });
  });
  if (!doc) return <div className="ed-panel-empty">No document</div>;
  const goto = (i: number) => {
    if (!readyForHistory()) return;
    doc.goto(i);
    touch();
  };
  return (
    <div className="ed-history">
      <div className="ed-history-list" ref={listRef}>
        <div className={cx('ed-hist', doc.index === 0 && 'current')} onClick={() => goto(0)}>
          <Icon name="image" size={13} />
          <span className="ellipsis">{doc.initialLabel}</span>
        </div>
        {doc.steps.map((s, i) => (
          <div key={i} className={cx('ed-hist', doc.index === i + 1 && 'current', i + 1 > doc.index && 'future')} onClick={() => goto(i + 1)} title={`${s.label} · ${mb(s.bytes)}`}>
            <Icon name="history" size={13} />
            <span className="ellipsis">{s.label}</span>
          </div>
        ))}
      </div>
      <div className="ed-history-foot faint">
        {doc.steps.length} states · {mb(doc.historyBytes)}
        <span className="spacer" />
        <button type="button" className="icon-btn small" title="Step backward" disabled={!doc.canUndo} onClick={A.stepBackward}>
          <Icon name="undo" size={13} />
        </button>
        <button type="button" className="icon-btn small" title="Step forward" disabled={!doc.canRedo} onClick={A.stepForward}>
          <Icon name="redo" size={13} />
        </button>
      </div>
    </div>
  );
}

export { hsvToRgb };
