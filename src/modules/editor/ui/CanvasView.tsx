import { useEffect, useLayoutEffect, useRef } from 'react';
import { errorToast } from '@/state/app';
import { isTyping, useKeyHeld } from '@/app/commands';
import { fitView, syncCanvasSize, ZOOM_STEPS, zoomAt as vpZoomAt } from '@/ui/viewport';
import { bus, setFrameRequester } from '../model/bus';
import type { Doc } from '../model/doc';
import { activeDoc, edState, useEditor } from '../model/store';
import { Compositor } from '../render/compositor';
import { getTool } from '../tools';
import { transformActive, transformTool } from '../tools/transform';
import type { Tool, ToolEnv, ToolPointer } from '../tools/types';
import { viewportSize } from '../ops/docs';
import { dropFiles } from '../io/files';
import { TextEditOverlay } from './TextEditOverlay';

const BG: [number, number, number] = [0.157, 0.157, 0.165];

/** Builds the tool environment for the active document (reads the live view). */
function makeEnv(doc: Doc, size: { w: number; h: number }): ToolEnv {
  const dpr = window.devicePixelRatio || 1;
  const setView = (v: Doc['view']) => {
    doc.view = v;
    doc.fitted = false;
    bus.view.emit();
    bus.requestFrame();
    bus.requestOverlay();
  };
  return {
    doc,
    get view() {
      return doc.view;
    },
    dpr,
    width: size.w,
    height: size.h,
    toScreen: (x, y) => [doc.view.x + x * doc.view.scale, doc.view.y + y * doc.view.scale],
    toImage: (sx, sy) => [(sx - doc.view.x) / doc.view.scale, (sy - doc.view.y) / doc.view.scale],
    zoomAt: (scale, sx, sy) => setView(vpZoomAt(doc.view, scale, sx, sy)),
    zoomStep: (dir, sx, sy) => {
      const cur = doc.view.scale * dpr;
      const next = dir > 0 ? (ZOOM_STEPS.find((z) => z > cur * 1.001) ?? cur * 1.5) : ([...ZOOM_STEPS].reverse().find((z) => z < cur / 1.001) ?? cur / 1.5);
      setView(vpZoomAt(doc.view, next / dpr, sx, sy));
    },
    panBy: (dx, dy) => setView({ ...doc.view, x: doc.view.x + dx, y: doc.view.y + dy }),
    fit: () => {
      doc.view = fitView(doc.width, doc.height, size.w, size.h, 28, false);
      doc.fitted = true;
      bus.view.emit();
      bus.requestFrame();
      bus.requestOverlay();
    },
  };
}

/** Shared view commands (menus / keyboard) operating on the active document. */
export const viewCommands = {
  zoomIn: () => withEnv((env) => env.zoomStep(1, env.width / 2, env.height / 2)),
  zoomOut: () => withEnv((env) => env.zoomStep(-1, env.width / 2, env.height / 2)),
  fit: () => withEnv((env) => env.fit()),
  actual: () => withEnv((env) => env.zoomAt(1 / env.dpr, env.width / 2, env.height / 2)),
  fill: () =>
    withEnv((env) => {
      const s = Math.max(env.width / env.doc.width, env.height / env.doc.height);
      env.zoomAt(s, env.width / 2, env.height / 2);
      env.panBy(env.width / 2 - (env.doc.view.x + (env.doc.width * env.doc.view.scale) / 2), env.height / 2 - (env.doc.view.y + (env.doc.height * env.doc.view.scale) / 2));
    }),
};

function withEnv(fn: (env: ToolEnv) => void) {
  const doc = activeDoc();
  if (doc) fn(makeEnv(doc, { w: viewportSize.w, h: viewportSize.h }));
}

export function CanvasView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const comp = useRef<Compositor | null>(null);
  const size = useRef({ w: 1, h: 1 });
  const space = useRef(false);
  const drag = useRef<null | { tool: Tool; pan: boolean; lastX: number; lastY: number; pointerId: number }>(null);
  const lastPointer = useRef<ToolPointer | null>(null);
  const overlayDirty = useRef(true);
  const presentDirty = useRef(true);
  const lastAntsStep = useRef(-1);
  const raf = useRef(0);
  const antsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCursorEmit = useRef(0);

  const currentTool = (): Tool => (transformActive() ? transformTool : getTool(edState().tool));

  // ------------------------------------------------------------------------------------------
  // Render loop

  const requestFrame = () => {
    presentDirty.current = true;
    if (!raf.current) raf.current = requestAnimationFrame(frame);
  };
  const requestOverlay = () => {
    overlayDirty.current = true;
    if (!raf.current) raf.current = requestAnimationFrame(frame);
  };

  const drawOverlay = (doc: Doc | null) => {
    const c = ovRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!doc) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const env = makeEnv(doc, size.current);
    try {
      getTool(edState().tool).overlay?.(env, ctx);
      if (transformActive()) transformTool.overlay?.(env, ctx);
    } catch (e) {
      console.error(e);
    }
  };

  function frame() {
    raf.current = 0;
    const c = comp.current;
    if (!c) return;
    const doc = activeDoc();
    let changed = false;
    try {
      if (doc) changed = c.render(doc);
    } catch (e) {
      console.error(e);
    }
    const ants = !!doc?.selection;
    const step = Math.floor(performance.now() / 90);
    if (changed || presentDirty.current || (ants && step !== lastAntsStep.current)) {
      presentDirty.current = false;
      lastAntsStep.current = step;
      const s = edState();
      c.present(doc, doc?.view ?? { x: 0, y: 0, scale: 1 }, window.devicePixelRatio || 1, { grid: s.showGrid, ants, time: -step, bg: BG });
    }
    if (overlayDirty.current) {
      overlayDirty.current = false;
      drawOverlay(doc);
    }
    if (changed) bus.rendered.emit();
    if (ants) {
      clearTimeout(antsTimer.current);
      antsTimer.current = setTimeout(() => {
        if (!raf.current) raf.current = requestAnimationFrame(frame);
      }, 90);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Mount: GL + sizing

  useLayoutEffect(() => {
    const host = hostRef.current!;
    const gl = glRef.current!;
    try {
      comp.current = new Compositor(gl);
    } catch (e) {
      errorToast(e, 'Could not start the GPU compositor');
    }
    setFrameRequester(requestFrame, requestOverlay, () => activeDoc()?.invalidate());
    const resize = () => {
      const r = host.getBoundingClientRect();
      size.current = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
      viewportSize.w = size.current.w;
      viewportSize.h = size.current.h;
      syncCanvasSize(gl, r.width, r.height);
      syncCanvasSize(ovRef.current!, r.width, r.height);
      for (const d of edState().docs) {
        if (d.fitted) d.view = fitView(d.width, d.height, size.current.w, size.current.h, 28, false);
      }
      bus.view.emit();
      requestFrame();
      requestOverlay();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      clearTimeout(antsTimer.current);
      setFrameRequester(
        () => {},
        () => {},
      );
      try {
        getTool(edState().tool).deactivate?.(null);
      } catch {
        /* ignore */
      }
      comp.current?.dispose();
      comp.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render on doc switch / grid toggle / tool change.
  const activeId = useEditor((s) => s.activeId);
  const showGrid = useEditor((s) => s.showGrid);
  const tool = useEditor((s) => s.tool);
  useEffect(() => {
    requestFrame();
    requestOverlay();
    updateCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, showGrid, tool]);

  // Brush cursor follows size changes from the keyboard.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (s.opts !== prev.opts) updateBrushCursor();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => bus.view.on(() => updateBrushCursor()), []);

  useKeyHeld('space', (held) => {
    space.current = held;
    updateCursor();
  });

  // ------------------------------------------------------------------------------------------
  // Wheel: pan / zoom

  useEffect(() => {
    const host = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const doc = activeDoc();
      if (!doc) return;
      const env = makeEnv(doc, size.current);
      const r = host.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0025));
        env.zoomAt(doc.view.scale * k, cx, cy);
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        env.panBy(-dx, -dy);
      }
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  // ------------------------------------------------------------------------------------------
  // Tool keys (Enter / Escape / Backspace …) get first dibs.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || useEditor.getState().modal) return;
      // Enter / Escape belong to an open confirm dialog or popover (they listen after us).
      if (document.querySelector('.modal-backdrop, .popover')) return;
      const doc = activeDoc();
      if (!doc) return;
      if (!['Enter', 'Escape', 'Backspace', 'Delete'].includes(e.key)) return;
      const env = makeEnv(doc, size.current);
      const t = transformActive() ? transformTool : getTool(edState().tool);
      if (t.key?.(env, e)) {
        e.preventDefault();
        e.stopPropagation();
        requestOverlay();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ------------------------------------------------------------------------------------------
  // Pointer handling

  const toPointer = (e: PointerEvent | React.PointerEvent | React.MouseEvent, doc: Doc): ToolPointer => {
    const host = hostRef.current!;
    const r = host.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const v = doc.view;
    const ne = ('nativeEvent' in e ? e.nativeEvent : e) as PointerEvent;
    const pen = ne.pointerType === 'pen';
    const pressure = pen ? Math.max(0.02, ne.pressure ?? 1) : 1;
    let pts: { x: number; y: number; p: number }[] = [];
    const co = typeof ne.getCoalescedEvents === 'function' ? ne.getCoalescedEvents() : [];
    if (co.length) pts = co.map((c) => ({ x: (c.clientX - r.left - v.x) / v.scale, y: (c.clientY - r.top - v.y) / v.scale, p: pen ? Math.max(0.02, c.pressure ?? 1) : 1 }));
    const x = (sx - v.x) / v.scale;
    const y = (sy - v.y) / v.scale;
    if (!pts.length) pts = [{ x, y, p: pressure }];
    return { x, y, sx, sy, pressure, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey, button: (e as PointerEvent).button ?? 0, points: pts, pointerType: ne.pointerType ?? 'mouse', t: ne.timeStamp };
  };

  function updateBrushCursor() {
    const el = cursorRef.current;
    const p = lastPointer.current;
    const doc = activeDoc();
    if (!el) return;
    const t = currentTool();
    const size = doc && p && !space.current && !p.alt && !drag.current?.pan && !useEditor.getState().modal ? t.brushSize?.(makeEnv(doc, { w: 0, h: 0 })) : null;
    if (!size || !doc || !p) {
      el.style.display = 'none';
      return;
    }
    const d = Math.max(2, size * doc.view.scale);
    el.style.display = 'block';
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    el.style.transform = `translate(${p.sx - d / 2}px, ${p.sy - d / 2}px)`;
    el.classList.toggle('small', d < 8);
  }

  function updateCursor(p: ToolPointer | null = lastPointer.current) {
    const host = hostRef.current;
    if (!host) return;
    const doc = activeDoc();
    let c = 'default';
    if (!doc) c = 'default';
    else if (drag.current?.pan) c = 'grabbing';
    else if (space.current) c = 'grab';
    else if (useEditor.getState().canvasPick) c = 'crosshair';
    else if (useEditor.getState().modal) c = 'grab';
    else {
      try {
        c = currentTool().cursor(makeEnv(doc, size.current), p);
      } catch {
        c = 'default';
      }
      if (c === 'none' && !p) c = 'crosshair';
    }
    if (host.style.cursor !== c) host.style.cursor = c;
    updateBrushCursor();
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const doc = activeDoc();
    if (!doc) return;
    if (e.button === 2 || !e.isPrimary) return;
    // A second pointer (pen + mouse) never interrupts a drag in progress.
    if (drag.current && drag.current.pointerId !== e.pointerId) return;
    const host = hostRef.current!;
    host.setPointerCapture(e.pointerId);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const p = toPointer(e, doc);
    lastPointer.current = p;
    const modal = useEditor.getState().modal;
    const pick = useEditor.getState().canvasPick;
    if (modal && pick && e.button === 0 && !space.current) {
      pick(p.x, p.y, { shift: p.shift, alt: p.alt });
      return;
    }
    const pan = e.button === 1 || space.current || modal || (edState().tool === 'hand' && !transformActive());
    if (pan) {
      drag.current = { tool: currentTool(), pan: true, lastX: p.sx, lastY: p.sy, pointerId: e.pointerId };
      updateCursor(p);
      return;
    }
    const t = currentTool();
    drag.current = { tool: t, pan: false, lastX: p.sx, lastY: p.sy, pointerId: e.pointerId };
    try {
      t.down?.(makeEnv(doc, size.current), p);
    } catch (err) {
      errorToast(err);
    }
    requestOverlay();
    updateCursor(p);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const doc = activeDoc();
    if (!doc) return;
    const d = drag.current;
    if (d && d.pointerId !== e.pointerId) return;
    const p = toPointer(e, doc);
    lastPointer.current = p;
    if (d?.pan) {
      makeEnv(doc, size.current).panBy(p.sx - d.lastX, p.sy - d.lastY);
      d.lastX = p.sx;
      d.lastY = p.sy;
    } else if (d) {
      try {
        d.tool.move?.(makeEnv(doc, size.current), p);
      } catch (err) {
        console.error(err);
      }
    } else if (!useEditor.getState().modal) {
      currentTool().hover?.(makeEnv(doc, size.current), p);
    }
    updateCursor(p);
    // Status bar: cursor position + colour (throttled GPU read)
    const now = performance.now();
    if (now - lastCursorEmit.current > 50 && !d) {
      lastCursorEmit.current = now;
      const inside = p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height;
      bus.cursor.emit({ x: p.x, y: p.y, rgba: inside ? (comp.current?.readPixel(p.x, p.y) ?? null) : null });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && d.pointerId !== e.pointerId) return;
    drag.current = null;
    const host = hostRef.current!;
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
    const doc = activeDoc();
    if (d && !d.pan && doc) {
      try {
        d.tool.up?.(makeEnv(doc, size.current), toPointer(e, doc));
      } catch (err) {
        errorToast(err);
      }
    }
    requestOverlay();
    updateCursor();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const doc = activeDoc();
    if (!doc || useEditor.getState().modal) return;
    currentTool().dblclick?.(makeEnv(doc, size.current), toPointer(e, doc));
    requestOverlay();
  };

  const onLeave = () => {
    lastPointer.current = null;
    if (cursorRef.current) cursorRef.current.style.display = 'none';
    bus.cursor.emit(null);
  };

  // ------------------------------------------------------------------------------------------
  // Drag & drop

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) void dropFiles(files);
  };

  return (
    <div
      ref={hostRef}
      className="ed-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onPointerLeave={onLeave}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
    >
      <canvas ref={glRef} className="ed-gl" />
      <canvas ref={ovRef} className="ed-overlay" />
      <div ref={cursorRef} className="ed-brush-cursor" />
      <TextEditOverlay />
    </div>
  );
}
