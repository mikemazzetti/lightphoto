import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { stem } from '@/platform/api';
import { COLOR_LABELS, LABEL_COLORS, select, useCatalog } from '@/state/catalog';
import { openContextMenu, openMenu, type MenuItem } from '@/state/app';
import { rafThrottle } from '@/core/util/async';
import { Icon } from '@/ui/Icon';
import { cx } from '@/ui/controls';
import { flag, importFiles, importFolder, label, rate } from './actions';
import { photoMenu } from './menus';
import { clickSelect, deselectAll, selectAll, setAnchor } from './selection';
import { setUI, setView, useLibraryUI } from './store';
import { healThumb, scrollActivity, useGridThumb } from './thumbs';
import { DRAG_MIME } from './util';

const PAD = 10;
const GAP = 6;
const OVERSCAN = 2;

export interface GridGeometry {
  cols: number;
  cell: number;
  rowH: number;
  rows: number;
  height: number;
}

export function gridLayout(width: number, target: number, count: number): GridGeometry {
  const inner = Math.max(1, width - PAD * 2);
  const cols = Math.max(1, Math.floor((inner + GAP) / (target + GAP)));
  const cell = Math.max(40, Math.floor((inner - GAP * (cols - 1)) / cols));
  const rowH = cell + GAP;
  const rows = Math.ceil(count / cols);
  return { cols, cell, rowH, rows, height: rows ? PAD * 2 + rows * rowH - GAP : 0 };
}

/**
 * Virtualised thumbnail grid. Only rows in view (+ overscan) are mounted; cells are memoised and
 * subscribe to their own photo, so a rating change re-renders one cell. Mouse handling is done
 * once on the container with geometric hit-testing (click/⌘/⇧ selection, rubber band, context
 * menu, double-click → loupe); the thumbnail canvas itself is the native drag source.
 */
export function Grid({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const thumbSize = useLibraryUI((s) => s.thumbSize);
  const selection = useCatalog((s) => s.selection);
  const activeId = useCatalog((s) => s.activeId);
  const filter = useCatalog((s) => s.filter);
  const selSet = useMemo(() => new Set(selection), [selection]);
  const geo = useMemo(() => gridLayout(box.w, thumbSize, ids.length), [box.w, thumbSize, ids.length]);
  const [range, setRange] = useState<[number, number]>([0, 0]);

  const geoRef = useRef(geo);
  geoRef.current = geo;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const scrollTopRef = useRef(useLibraryUI.getState().gridScroll);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => {
      ro.disconnect();
      setUI({ gridScroll: scrollTopRef.current });
    };
  }, []);

  useEffect(() => {
    if (useLibraryUI.getState().cols !== geo.cols) setUI({ cols: geo.cols });
  }, [geo.cols]);

  const updateRange = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const g = geoRef.current;
    const top = el.scrollTop;
    const r0 = Math.max(0, Math.floor((top - PAD) / g.rowH) - OVERSCAN);
    const r1 = Math.min(g.rows, Math.ceil((top + el.clientHeight - PAD) / g.rowH) + OVERSCAN);
    setRange((cur) => (cur[0] === r0 && cur[1] === r1 ? cur : [r0, r1]));
  }, []);

  // ---- scroll position: restore on mount, keep the active photo visible, reset on filter change
  const restored = useRef(false);
  const ensureVisible = useCallback((id: string | null, center = false) => {
    const el = ref.current;
    const g = geoRef.current;
    if (!el || !id || !g.rows) return;
    const i = idsRef.current.indexOf(id);
    if (i < 0) return;
    const top = PAD + Math.floor(i / g.cols) * g.rowH;
    const bottom = top + g.cell;
    const h = el.clientHeight;
    if (center) el.scrollTop = Math.max(0, top - (h - g.cell) / 2);
    else if (top < el.scrollTop + 2) el.scrollTop = Math.max(0, top - PAD);
    else if (bottom > el.scrollTop + h - 2) el.scrollTop = bottom - h + PAD;
  }, []);

  // When the layout changes (thumbnail size, panel width), keep the first visible row's photo in place.
  const prevGeo = useRef<GridGeometry | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const pg = prevGeo.current;
    prevGeo.current = geo;
    if (!restored.current && box.h > 0 && geo.height > 0) {
      restored.current = true;
      el.scrollTop = scrollTopRef.current;
      const a = useCatalog.getState().activeId;
      const i = a ? ids.indexOf(a) : -1;
      if (i >= 0) {
        const top = PAD + Math.floor(i / geo.cols) * geo.rowH;
        if (top < el.scrollTop || top + geo.cell > el.scrollTop + el.clientHeight) ensureVisible(a, true);
      }
    } else if (pg && restored.current && (pg.cols !== geo.cols || pg.rowH !== geo.rowH) && el.scrollTop > 0) {
      const row = Math.max(0, Math.floor((el.scrollTop - PAD) / pg.rowH));
      const offset = el.scrollTop - (PAD + row * pg.rowH);
      const anchor = row * pg.cols;
      el.scrollTop = PAD + Math.floor(anchor / geo.cols) * geo.rowH + offset * (geo.rowH / pg.rowH);
    }
    scrollTopRef.current = el.scrollTop;
    updateRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, box.h, updateRange]);

  // Selection changes made by the rubber band must not scroll the view (it fights auto-scroll).
  const quiet = useRef(false);
  useLayoutEffect(() => {
    if (quiet.current) {
      quiet.current = false;
      return;
    }
    if (restored.current && !band.current?.started) ensureVisible(activeId);
  }, [activeId, ensureVisible]);

  const prevFilter = useRef(filter);
  useLayoutEffect(() => {
    if (prevFilter.current === filter) return;
    prevFilter.current = filter;
    const el = ref.current!;
    const a = useCatalog.getState().activeId;
    if (a && idsRef.current.includes(a)) ensureVisible(a, true);
    else el.scrollTop = 0;
    updateRange();
  }, [filter, ensureVisible, updateRange]);

  // ---- hit testing
  const toContent = (clientX: number, clientY: number) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top + el.scrollTop };
  };
  const hitIndex = (clientX: number, clientY: number): number | null => {
    const g = geoRef.current;
    const { x, y } = toContent(clientX, clientY);
    const stride = g.cell + GAP;
    const c = Math.floor((x - PAD) / stride);
    const r = Math.floor((y - PAD) / g.rowH);
    if (c < 0 || r < 0 || c >= g.cols) return null;
    if (x - PAD - c * stride > g.cell || y - PAD - r * g.rowH > g.cell) return null;
    const i = r * g.cols + c;
    return i < idsRef.current.length ? i : null;
  };

  // ---- rubber band
  const band = useRef<{ x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; started: boolean; base: string[]; key: string } | null>(null);
  const suppressClick = useRef(false);
  const autoScroll = useRef(0);

  const idsInRect = (x0: number, y0: number, x1: number, y1: number): string[] => {
    const g = geoRef.current;
    const list = idsRef.current;
    const stride = g.cell + GAP;
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    const c0 = Math.max(0, Math.floor((lx - PAD) / stride));
    const c1 = Math.min(g.cols - 1, Math.floor((hx - PAD) / stride));
    const r0 = Math.max(0, Math.floor((ly - PAD) / g.rowH));
    const r1 = Math.min(g.rows - 1, Math.floor((hy - PAD) / g.rowH));
    const out: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const y = PAD + r * g.rowH;
      if (y > hy || y + g.cell < ly) continue;
      for (let c = c0; c <= c1; c++) {
        const x = PAD + c * stride;
        if (x > hx || x + g.cell < lx) continue;
        const i = r * g.cols + c;
        if (i < list.length) out.push(list[i]);
      }
    }
    return out;
  };

  const applyBand = useMemo(
    () =>
      rafThrottle(() => {
        const b = band.current;
        if (!b) return;
        const hit = idsInRect(b.x0, b.y0, b.x1, b.y1);
        const key = `${hit.length}:${hit[0]}:${hit[hit.length - 1]}`;
        if (key === b.key) return;
        b.key = key;
        const sel = b.base.length ? [...new Set([...b.base, ...hit])] : hit;
        const a = useCatalog.getState().activeId;
        select(sel, a && sel.includes(a) ? a : hit[0] ?? sel[0] ?? null);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const drawBand = () => {
    const b = band.current;
    const d = bandRef.current;
    if (!d) return;
    if (!b || !b.started) {
      d.style.display = 'none';
      return;
    }
    d.style.display = 'block';
    d.style.left = `${Math.min(b.x0, b.x1)}px`;
    d.style.top = `${Math.min(b.y0, b.y1)}px`;
    d.style.width = `${Math.abs(b.x1 - b.x0)}px`;
    d.style.height = `${Math.abs(b.y1 - b.y0)}px`;
  };

  const tickAutoScroll = () => {
    autoScroll.current = 0;
    const b = band.current;
    const el = ref.current;
    if (!b || !el) return;
    const r = el.getBoundingClientRect();
    const edge = 28;
    let dy = 0;
    if (b.cy < r.top + edge) dy = -Math.min(40, (r.top + edge - b.cy) * 0.6);
    else if (b.cy > r.bottom - edge) dy = Math.min(40, (b.cy - (r.bottom - edge)) * 0.6);
    if (!dy) return;
    el.scrollTop += dy;
    const p = toContent(b.cx, b.cy);
    b.x1 = Math.max(0, Math.min(el.clientWidth, p.x));
    b.y1 = Math.max(0, Math.min(geoRef.current.height, p.y));
    drawBand();
    applyBand();
    autoScroll.current = requestAnimationFrame(tickAutoScroll);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('[data-ctl]') || t.getAttribute('draggable') === 'true') return;
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    if (e.clientX - r.left >= el.clientWidth) return; // scrollbar
    const p = toContent(e.clientX, e.clientY);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    band.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, cx: e.clientX, cy: e.clientY, started: false, base: additive ? useCatalog.getState().selection : [], key: '' };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const b = band.current;
    if (!b) return;
    const el = ref.current!;
    const p = toContent(e.clientX, e.clientY);
    b.cx = e.clientX;
    b.cy = e.clientY;
    b.x1 = Math.max(0, Math.min(el.clientWidth, p.x));
    b.y1 = Math.max(0, Math.min(geoRef.current.height, p.y));
    if (!b.started && Math.hypot(b.x1 - b.x0, b.y1 - b.y0) > 4) b.started = true;
    if (!b.started) return;
    drawBand();
    applyBand();
    if (!autoScroll.current) autoScroll.current = requestAnimationFrame(tickAutoScroll);
  };

  const endBand = (e: React.PointerEvent) => {
    const b = band.current;
    if (!b) return;
    if (b.started) {
      suppressClick.current = true;
      applyBand.cancel();
      const hit = idsInRect(b.x0, b.y0, b.x1, b.y1);
      const sel = b.base.length ? [...new Set([...b.base, ...hit])] : hit;
      const a = useCatalog.getState().activeId;
      const nextActive = a && sel.includes(a) ? a : hit[0] ?? sel[0] ?? null;
      quiet.current = nextActive !== a;
      select(sel, nextActive);
      setAnchor(hit[0] ?? null);
    }
    band.current = null;
    cancelAnimationFrame(autoScroll.current);
    autoScroll.current = 0;
    drawBand();
    try {
      ref.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };

  const onClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if ((e.target as HTMLElement).closest('[data-ctl]')) return;
    const i = hitIndex(e.clientX, e.clientY);
    if (i === null) {
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) deselectAll();
      return;
    }
    clickSelect(idsRef.current, i, e);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-ctl]')) return;
    const i = hitIndex(e.clientX, e.clientY);
    if (i === null) return;
    const id = idsRef.current[i];
    const s = useCatalog.getState();
    select(s.selection.includes(id) ? s.selection : [id], id);
    setView('loupe');
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const i = hitIndex(e.clientX, e.clientY);
    if (i === null) {
      const items: MenuItem[] = [
        { label: 'Select All', shortcut: '⌘A', onClick: selectAll },
        { label: 'Select None', shortcut: '⌘D', onClick: deselectAll },
        { separator: true },
        { label: 'Add Photos…', onClick: () => void importFiles() },
        { label: 'Add Folder…', onClick: () => void importFolder() },
      ];
      return openContextMenu(e, items);
    }
    const id = idsRef.current[i];
    if (!useCatalog.getState().selection.includes(id)) {
      select([id], id);
      setAnchor(id);
    }
    openContextMenu(e, photoMenu());
  };

  const onDragStart = (e: React.DragEvent) => {
    const cellEl = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
    if (!cellEl) return;
    const id = cellEl.dataset.id!;
    const s = useCatalog.getState();
    let dragged: string[];
    if (s.selection.includes(id)) {
      const set = new Set(s.selection);
      dragged = idsRef.current.filter((x) => set.has(x));
      const inGrid = new Set(dragged);
      for (const x of s.selection) if (!inGrid.has(x)) dragged.push(x);
    } else {
      dragged = [id];
      select([id], id);
    }
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragged));
    e.dataTransfer.effectAllowed = 'copy';
    if (dragged.length > 1) {
      const ghost = document.createElement('div');
      ghost.className = 'lib-drag-ghost';
      ghost.textContent = `${dragged.length} photos`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 14);
      setTimeout(() => ghost.remove(), 0);
    }
  };

  const lastScroll = useRef({ t: 0, y: 0 });
  const onScroll = () => {
    const el = ref.current!;
    const now = performance.now();
    const prev = lastScroll.current;
    const v = Math.abs(el.scrollTop - prev.y) / Math.max(1, now - prev.t);
    if (v > 2.2) scrollActivity.fastUntil = now + 150;
    lastScroll.current = { t: now, y: el.scrollTop };
    scrollTopRef.current = el.scrollTop;
    updateRange();
  };

  // ---- render
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const head = geo.cell >= 118 ? 20 : 0;
  const foot = geo.cell >= 92 ? 20 : 16;
  const imgW = geo.cell - 12;
  const imgH = geo.cell - head - foot - 6;
  const px = Math.max(imgW, imgH) * dpr > 440 ? 768 : 384;
  const stride = geo.cell + GAP;
  const first = range[0] * geo.cols;
  const last = Math.min(ids.length, range[1] * geo.cols);
  const cells = [];
  for (let i = first; i < last; i++) {
    const id = ids[i];
    const r = Math.floor(i / geo.cols);
    const c = i - r * geo.cols;
    cells.push(
      <GridCell
        key={id}
        id={id}
        index={i}
        x={PAD + c * stride}
        y={PAD + r * geo.rowH}
        cell={geo.cell}
        head={head}
        foot={foot}
        imgW={imgW}
        imgH={imgH}
        px={px}
        selected={selSet.has(id)}
        active={id === activeId}
        multi={selection.length > 1}
      />,
    );
  }

  return (
    <div
      ref={ref}
      className="lib-grid"
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endBand}
      onPointerCancel={endBand}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
    >
      <div className="lib-grid-sizer" style={{ height: geo.height }}>
        {box.w > 0 && cells}
        <div ref={bandRef} className="lib-band" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface CellProps {
  id: string;
  index: number;
  x: number;
  y: number;
  cell: number;
  head: number;
  foot: number;
  imgW: number;
  imgH: number;
  px: number;
  selected: boolean;
  active: boolean;
  multi: boolean;
}

const GridCell = memo(function GridCell({ id, index, x, y, cell, head, foot, imgW, imgH, px, selected, active, multi }: CellProps) {
  const photo = useCatalog((s) => s.photos[id]);
  const bmp = useGridThumb(photo, px, 60);

  useEffect(() => {
    if (!photo?.settings) return;
    const t = setTimeout(() => healThumb(photo), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.settings, photo?.thumbVariant]);

  if (!photo) return null;
  // Controls act on the whole selection when this cell is part of it.
  const targets = () => (selected && multi ? useCatalog.getState().selection : [id]);
  const isRaw = photo.kind === 'raw';
  const small = cell < 92;

  const labelMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ids = targets();
    openMenu(r.left, r.bottom + 2, [
      ...COLOR_LABELS.map((l) => ({
        label: l[0].toUpperCase() + l.slice(1),
        checked: photo.label === l,
        icon: <span style={{ width: 10, height: 10, borderRadius: 2, background: LABEL_COLORS[l], display: 'inline-block' }} />,
        onClick: () => label(l, ids),
      })),
      { separator: true },
      { label: 'None', checked: !photo.label, onClick: () => label(null, ids) },
    ]);
  };

  return (
    <div
      className={cx('lib-cell', selected && 'sel', active && 'active', photo.flag === 'reject' && 'rejected', small && 'small')}
      style={{ transform: `translate(${x}px, ${y}px)`, width: cell, height: cell, ...(photo.label ? ({ '--lbl': LABEL_COLORS[photo.label] } as React.CSSProperties) : null) }}
      data-id={id}
    >
      {cell >= 118 && <span className="lib-cell-num">{index + 1}</span>}
      {head > 0 && (
        <div className="lib-cell-head" style={{ height: head }}>
          <span className="lib-cell-name ellipsis" title={photo.path}>
            {stem(photo.path)}
          </span>
          <span className={cx('lib-badge', isRaw && 'raw')}>{(photo.ext || '').toUpperCase()}</span>
        </div>
      )}
      <div className="lib-cell-img" style={{ top: head + 4, height: imgH, left: 6, width: imgW }}>
        {bmp ? <CellThumb bmp={bmp} boxW={imgW} boxH={imgH} /> : <div className="lib-cell-ph">{small ? '' : (photo.ext || '').toUpperCase()}</div>}
      </div>
      <div className="lib-cell-foot" style={{ height: foot }} onMouseDown={(e) => e.preventDefault() /* keep focus off the tiny controls */}>
        <button
          type="button"
          data-ctl
          className={cx('lib-ctl lib-flag', photo.flag && 'on', photo.flag === 'reject' && 'reject')}
          title={photo.flag === 'pick' ? 'Picked (P) — click to unflag' : photo.flag === 'reject' ? 'Rejected (X) — click to unflag' : 'Flag as Pick (P)'}
          onClick={(e) => {
            e.stopPropagation();
            flag(photo.flag ? null : 'pick', targets());
          }}
        >
          <Icon name={photo.flag === 'reject' ? 'reject' : photo.flag === 'pick' ? 'flagFill' : 'flag'} size={small ? 10 : 12} />
        </button>
        <div className="lib-stars" data-ctl>
          {[1, 2, 3, 4, 5].map((r) => (
            <button
              key={r}
              type="button"
              className={cx('lib-star', r <= photo.rating && 'on')}
              title={`${r} star${r > 1 ? 's' : ''} (${r})`}
              onClick={(e) => {
                e.stopPropagation();
                rate(photo.rating === r ? 0 : r, targets());
              }}
            >
              {r <= photo.rating ? <Icon name="starFill" size={small ? 8 : 10} /> : <span className="lib-dot" />}
            </button>
          ))}
        </div>
        <div className="lib-cell-badges">
          {photo.virtualOf && !small && <span title="Virtual copy"><Icon name="copy" size={10} /></span>}
          {photo.settings && <span className="lib-edited" title="Has develop adjustments"><Icon name="sliders" size={10} /></span>}
          {small && isRaw && <span className="lib-badge raw tiny">RAW</span>}
        </div>
        <button type="button" data-ctl className={cx('lib-ctl lib-label', photo.label && 'on')} title="Color label (6–9)" onClick={labelMenu}>
          <span />
        </button>
      </div>
    </div>
  );
});

/** Draws a thumbnail at exact device-pixel size, letterboxed inside the cell's image box. */
function CellThumb({ bmp, boxW, boxH }: { bmp: ImageBitmap; boxW: number; boxH: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const k = Math.min(boxW / bmp.width, boxH / bmp.height);
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(bmp, 0, 0, W, H);
    } catch {
      /* bitmap was closed */
    }
  }, [bmp, w, h]);
  return <canvas ref={ref} className="lib-thumb" draggable style={{ width: w, height: h }} />;
}
