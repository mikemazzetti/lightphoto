import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatShutter } from '@/core/image/decode';
import { Photo, select, settingsHash, useCatalog } from '@/state/catalog';
import { openContextMenu } from '@/state/app';
import { Spinner } from '@/ui/controls';
import { photoMenu } from './menus';
import { loadPreview, peekPreview, prefetchPreview, previewBucket } from './render';
import { setUI, useLibraryUI } from './store';
import { peekThumb, useGridThumb } from './thumbs';
import { cameraName, clamp, formatDate, fmtAperture, fmtFocal, fmtIso, orientedDims } from './util';

interface ViewState {
  bmp: ImageBitmap | null;
  /** 1 = thumbnail, 2 = screen preview, 3 = full resolution. */
  q: number;
  key: string;
  photoId: string;
  /** View centre in normalised image coordinates (zoomed mode). */
  cx: number;
  cy: number;
  /** Full-resolution size once known. */
  natW: number;
}

const BG = '#0e0e0f';

/**
 * Loupe: the active photo, large. Shows the cached thumbnail immediately, then a screen-sized
 * preview (an engine render when the photo is edited), and the full-resolution image when zoomed
 * to 100%. Drawing and panning are imperative (refs + rAF) — no React renders while dragging.
 */
export function Loupe({ ids }: { ids: string[] }) {
  const activeId = useCatalog((s) => s.activeId);
  const id = activeId && useCatalog.getState().photos[activeId] ? activeId : ids[0];
  const photo = useCatalog((s) => (id ? s.photos[id] : undefined));
  const zoomed = useLibraryUI((s) => s.zoomed);
  const info = useLibraryUI((s) => s.info);
  const thumb = useGridThumb(photo, 384, 0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [natSize, setNatSize] = useState<[number, number] | null>(null);
  const st = useRef<ViewState>({ bmp: null, q: 0, key: '', photoId: '', cx: 0.5, cy: 0.5, natW: 0 });
  const boxRef = useRef(box);
  boxRef.current = box;
  const zoomRef = useRef(zoomed);
  zoomRef.current = zoomed;
  const photoRef = useRef(photo);
  photoRef.current = photo;

  const hash = useMemo(() => settingsHash(photo?.settings), [photo?.settings]);
  const key = photo ? `${photo.id}|${hash}` : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  const dpr = window.devicePixelRatio || 1;
  const fitPx = box.w ? previewBucket(Math.max(box.w, box.h) * dpr) : 0;

  // Make sure something is active (keyboard shortcuts act on it).
  useEffect(() => {
    if (!activeId && ids[0]) select([ids[0]], ids[0]);
  }, [activeId, ids]);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- geometry
  const estimateNat = (): number => {
    const v = st.current;
    if (v.natW) return v.natW;
    const b = v.bmp;
    if (!b) return 0;
    const d = orientedDims(photoRef.current?.meta);
    const cropped = !!photoRef.current?.settings;
    // EXIF sizes can describe an embedded thumbnail (some RAWs): only trust them if plausible.
    if (d && !cropped && d[0] >= b.width && Math.abs(d[0] / d[1] - b.width / b.height) < 0.03) return d[0];
    return Math.max(b.width * 2, 1600);
  };

  const imageRect = () => {
    const v = st.current;
    const b = v.bmp;
    const { w: W, h: H } = boxRef.current;
    if (!b || !W || !H) return null;
    const aspect = b.width / b.height;
    if (!zoomRef.current) {
      const pad = 14;
      // Don't blow small images up beyond one image pixel per CSS pixel.
      const metaW = orientedDims(photoRef.current?.meta)?.[0] ?? 0;
      const nat = v.natW || (metaW >= b.width ? metaW : Infinity);
      const maxW = Math.min(W - pad * 2, (H - pad * 2) * aspect, nat);
      const w = Math.max(1, maxW);
      const h = w / aspect;
      return { x: (W - w) / 2, y: (H - h) / 2, w, h };
    }
    const w = estimateNat() / dpr;
    const h = w / aspect;
    let x = W / 2 - v.cx * w;
    let y = H / 2 - v.cy * h;
    x = w <= W ? (W - w) / 2 : clamp(x, W - w, 0);
    y = h <= H ? (H - h) / 2 : clamp(y, H - h, 0);
    v.cx = (W / 2 - x) / w;
    v.cy = (H / 2 - y) / h;
    return { x, y, w, h };
  };

  const raf = useRef(0);
  const draw = () => {
    raf.current = 0;
    const c = canvasRef.current;
    if (!c) return;
    const { w: W, h: H } = boxRef.current;
    const CW = Math.max(1, Math.round(W * dpr));
    const CH = Math.max(1, Math.round(H * dpr));
    if (c.width !== CW) c.width = CW;
    if (c.height !== CH) c.height = CH;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, CW, CH);
    const r = imageRect();
    const b = st.current.bmp;
    if (!r || !b) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(b, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr);
    } catch {
      /* closed bitmap */
    }
  };
  const scheduleDraw = () => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /** Offers a bitmap for display; better (or newer-settings) images replace worse ones. */
  const offer = (b: ImageBitmap, q: number, forKey: string) => {
    if (forKey !== keyRef.current) return;
    const v = st.current;
    const pid = forKey.slice(0, forKey.indexOf('|'));
    if (v.key === forKey) {
      if (q < v.q) return;
    } else if (v.photoId === pid && v.bmp && q < 2) return; // settings changed: keep the old render until a real preview arrives
    v.bmp = b;
    v.q = q;
    v.key = forKey;
    v.photoId = pid;
    if (q === 3) {
      v.natW = b.width;
      setNatSize([b.width, b.height]);
    }
    scheduleDraw();
  };

  // New photo: reset view, paint whatever is already in memory.
  useLayoutEffect(() => {
    const v = st.current;
    const p = photoRef.current;
    if (!p || v.photoId === p.id) return;
    v.bmp = null;
    v.q = 0;
    v.key = '';
    v.photoId = '';
    v.cx = v.cy = 0.5;
    v.natW = 0;
    setNatSize(null);
    setError('');
    if (zoomRef.current) setUI({ zoomed: false });
    const pre = fitPx ? peekPreview(p, fitPx) : null;
    if (pre) offer(pre, 2, keyRef.current);
    else {
      const t = peekThumb(p, 384);
      if (t) offer(t, 1, keyRef.current);
    }
    scheduleDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id]);

  useEffect(() => {
    if (thumb && photo) offer(thumb, 1, key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumb, key]);

  // Screen-sized preview (+ neighbour prefetch).
  useEffect(() => {
    if (!photo || !fitPx) return;
    let alive = true;
    const k = key;
    const pre = peekPreview(photo, fitPx);
    if (pre) {
      offer(pre, 2, k);
    } else setLoading(true);
    loadPreview(photo, fitPx)
      .then((b) => {
        if (!alive) return;
        offer(b, 2, k);
        setLoading(false);
        const list = ids;
        const i = list.indexOf(photo.id);
        if (i >= 0) {
          const photos = useCatalog.getState().photos;
          // Prefetch order: furthest first (the scheduler is newest-first).
          for (const j of [i + 2, i - 1, i + 1]) if (j >= 0 && j < list.length) prefetchPreview(photos[list[j]], fitPx);
        }
      })
      .catch((e) => {
        if (!alive || (e as DOMException)?.name === 'AbortError') return;
        setLoading(false);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fitPx]);

  // Full resolution when zoomed.
  useEffect(() => {
    if (!zoomed || !photo) return;
    if (st.current.q >= 3 && st.current.key === key) return;
    let alive = true;
    const k = key;
    setLoading(true);
    loadPreview(photo, 0)
      .then((b) => {
        if (!alive) return;
        offer(b, 3, k);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive || (e as DOMException)?.name === 'AbortError') return;
        setLoading(false);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, key]);

  useEffect(scheduleDraw, [box, zoomed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- interaction: click toggles 100% at the point, drag pans, wheel pans when zoomed
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: st.current.cx, cy: st.current.cy, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > 3) {
      d.moved = true;
      wrapRef.current?.classList.add('panning');
    }
    if (!d.moved || !zoomRef.current) return;
    const r = imageRect();
    if (!r) return;
    st.current.cx = d.cx - dx / r.w;
    st.current.cy = d.cy - dy / r.h;
    scheduleDraw();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    wrapRef.current?.classList.remove('panning');
    if (!d || d.moved) return;
    if (zoomRef.current) {
      setUI({ zoomed: false });
      return;
    }
    const r = imageRect();
    const el = wrapRef.current!;
    const rect = el.getBoundingClientRect();
    if (r) {
      st.current.cx = clamp((e.clientX - rect.left - r.x) / r.w, 0, 1);
      st.current.cy = clamp((e.clientY - rect.top - r.y) / r.h, 0, 1);
    }
    setUI({ zoomed: true });
  };

  useEffect(() => {
    const el = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!zoomRef.current) return;
      e.preventDefault();
      const r = imageRect();
      if (!r) return;
      st.current.cx += e.deltaX / r.w;
      st.current.cy += e.deltaY / r.h;
      scheduleDraw();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onContextMenu = (e: React.MouseEvent) => {
    if (!photo) return;
    const s = useCatalog.getState();
    if (!s.selection.includes(photo.id)) select([photo.id], photo.id);
    openContextMenu(e, photoMenu());
  };

  if (!photo) return <div className="lib-loupe" />;

  return (
    <div
      ref={wrapRef}
      className={`lib-loupe ${zoomed ? 'zoomed' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvasRef} className="lib-loupe-canvas" />
      {info !== 0 && <LoupeInfo photo={photo} mode={info} nat={natSize} />}
      <div className="lib-loupe-status">
        {loading && <Spinner />}
        {zoomed && <span className="hud-chip">100%</span>}
        {error && <span className="hud-chip err" title={error}>Preview failed — showing thumbnail</span>}
      </div>
    </div>
  );
}

function LoupeInfo({ photo, mode, nat }: { photo: Photo; mode: 1 | 2; nat: [number, number] | null }) {
  const m = photo.meta;
  const dims = nat ?? orientedDims(m);
  if (mode === 1) {
    return (
      <div className="hud lib-loupe-info">
        <div className="lib-info-title">{photo.name}</div>
        <div>
          {formatDate(m?.dateTaken ?? photo.mtime)}
          {dims && <span className="faint"> · {dims[0]} × {dims[1]}</span>}
        </div>
      </div>
    );
  }
  const parts = [fmtIso(m?.iso), fmtFocal(m?.focalLength), fmtAperture(m?.fNumber), formatShutter(m?.exposureTime)].filter(Boolean);
  return (
    <div className="hud lib-loupe-info">
      <div className="lib-info-title">{photo.name}</div>
      <div>{parts.length ? parts.join('   ') : 'No exposure information'}</div>
      <div className="faint">{[cameraName(m), m?.lens].filter(Boolean).join(' · ') || '—'}</div>
    </div>
  );
}
