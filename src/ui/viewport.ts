import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Zoom/pan state for image canvases (Develop, Edit).
 *
 * `scale` is CSS pixels per image pixel. "100%" (actual pixels) means one image pixel per
 * *device* pixel, i.e. scale = 1 / devicePixelRatio — use `zoomPercent()` for display.
 * `x`, `y` are the CSS-pixel position of the image's top-left corner inside the container.
 *
 * Interaction (Figma/Photoshop hybrid): wheel / two-finger scroll pans; ⌘/Ctrl+wheel, pinch,
 * or Alt+wheel zooms at the cursor. Hold Space (or middle mouse) and drag to pan — call
 * `startPan(e)` from your pointerdown handler when appropriate.
 */
export interface ViewState {
  x: number;
  y: number;
  scale: number;
}

export const ZOOM_STEPS = [0.03125, 0.0625, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export function fitView(imgW: number, imgH: number, viewW: number, viewH: number, pad = 24, allowUpscale = false): ViewState {
  const s = Math.min((viewW - pad * 2) / imgW, (viewH - pad * 2) / imgH);
  const scale = Math.max(1e-4, allowUpscale ? s : Math.min(s, 1 / (window.devicePixelRatio || 1)));
  return { scale, x: (viewW - imgW * scale) / 2, y: (viewH - imgH * scale) / 2 };
}

export function zoomAt(v: ViewState, newScale: number, cx: number, cy: number): ViewState {
  const s = Math.min(64, Math.max(0.005, newScale));
  const ix = (cx - v.x) / v.scale;
  const iy = (cy - v.y) / v.scale;
  return { scale: s, x: cx - ix * s, y: cy - iy * s };
}

export const screenToImage = (v: ViewState, sx: number, sy: number): [number, number] => [(sx - v.x) / v.scale, (sy - v.y) / v.scale];
export const imageToScreen = (v: ViewState, ix: number, iy: number): [number, number] => [v.x + ix * v.scale, v.y + iy * v.scale];
export const zoomPercent = (v: ViewState) => v.scale * (window.devicePixelRatio || 1) * 100;

export function useViewport(imgW: number, imgH: number, opts: { pad?: number } = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [view, setViewState] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  const fitMode = useRef(true);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pad = opts.pad ?? 24;

  const setView = useCallback((v: ViewState | ((v: ViewState) => ViewState)) => {
    fitMode.current = false;
    setViewState((prev) => (typeof v === 'function' ? v(prev) : v));
  }, []);

  const fit = useCallback(() => {
    fitMode.current = true;
    if (imgW > 0 && imgH > 0) setViewState(fitView(imgW, imgH, size.w, size.h, pad));
  }, [imgW, imgH, size.w, size.h, pad]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Refit on resize / image change while in fit mode.
  useEffect(() => {
    if (fitMode.current && imgW > 0 && imgH > 0) setViewState(fitView(imgW, imgH, size.w, size.h, pad));
  }, [imgW, imgH, size.w, size.h, pad]);

  const zoomTo = useCallback(
    (scale: number, cx = size.w / 2, cy = size.h / 2) => {
      fitMode.current = false;
      setViewState((v) => zoomAt(v, scale, cx, cy));
    },
    [size.w, size.h],
  );

  const zoomStep = useCallback(
    (dir: 1 | -1, cx = size.w / 2, cy = size.h / 2) => {
      const dpr = window.devicePixelRatio || 1;
      const cur = viewRef.current.scale * dpr;
      const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur * 1.001) ?? cur * 1.5 : [...ZOOM_STEPS].reverse().find((z) => z < cur / 1.001) ?? cur / 1.5;
      zoomTo(next / dpr, cx, cy);
    },
    [zoomTo, size.w, size.h],
  );

  const actualPixels = useCallback((cx?: number, cy?: number) => zoomTo(1 / (window.devicePixelRatio || 1), cx, cy), [zoomTo]);

  // Wheel: pan, or zoom with modifier / pinch.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0025));
        fitMode.current = false;
        setViewState((v) => zoomAt(v, v.scale * k, cx, cy));
      } else {
        fitMode.current = false;
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        setViewState((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Begins a drag-pan from a pointerdown event. */
  const startPan = useCallback((e: React.PointerEvent | PointerEvent) => {
    const el = (e.currentTarget as HTMLElement) ?? containerRef.current;
    const pid = e.pointerId;
    el.setPointerCapture?.(pid);
    let lx = e.clientX;
    let ly = e.clientY;
    fitMode.current = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lx;
      const dy = ev.clientY - ly;
      lx = ev.clientX;
      ly = ev.clientY;
      setViewState((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }, []);

  /** Converts a client (mouse event) position to image pixel coordinates. */
  const clientToImage = useCallback((clientX: number, clientY: number): [number, number] => {
    const r = containerRef.current!.getBoundingClientRect();
    return screenToImage(viewRef.current, clientX - r.left, clientY - r.top);
  }, []);

  return { containerRef, size, view, setView, fit, zoomTo, zoomStep, actualPixels, startPan, clientToImage, isFit: fitMode.current };
}

/** Sizes a canvas's drawing buffer to its CSS box × devicePixelRatio. Returns true if it changed. */
export function syncCanvasSize(canvas: HTMLCanvasElement, cssW: number, cssH: number): boolean {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}
