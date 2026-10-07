import { BrushStroke, defaultLocal, DevelopSettings, LocalAdjustment, LocalType } from '@/core/develop/settings';
import { MAX_LOCALS } from '@/core/develop/shaders';
import { toast } from '@/state/app';
import { commit, DevelopState, setLive, useDevelop } from './store';
import type { VPos, ViewerController } from './controller';
import { CURSORS } from './cursors';
import { applyCrop } from './cropTool';

/**
 * Masking tool: on-canvas creation and editing of linear / radial gradients and brush masks
 * (painted with dabs, or filled with lasso outlines).
 * Masks are stored in source-normalised coordinates (they follow crop / rotate); all drawing
 * and hit-testing happens in viewport CSS px through the controller's geometry matrices.
 */

type Pt = [number, number];
type LinHandle = 'pin' | 'line0' | 'line1' | 'rotate';
type RadHandle = 'center' | 'rx' | 'ry' | 'rotate' | 'move';
type HandleHit = { kind: 'linear'; h: LinHandle } | { kind: 'radial'; h: RadHandle };

export const MASK_TYPE_LABEL: Record<LocalType, string> = { linear: 'Linear Gradient', radial: 'Radial Gradient', brush: 'Brush' };

const cur = () => useDevelop.getState().settings!;

export function updateLocal(s: DevelopSettings, id: string, fn: (l: LocalAdjustment) => LocalAdjustment): DevelopSettings {
  return { ...s, locals: s.locals.map((l) => (l.id === id ? fn(l) : l)) };
}

function nextName(s: DevelopSettings, type: LocalType) {
  const n = s.locals.filter((l) => l.type === type).length + 1;
  return `${MASK_TYPE_LABEL[type]} ${n}`;
}

const newId = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------------------------
// Coordinate helpers

function srcNToCss(c: ViewerController, x: number, y: number): Pt {
  const [u, v] = c.srcToOut(x, y);
  return c.fromOut(u, v);
}
function cssToSrcN(c: ViewerController, p: { cx: number; cy: number }): Pt {
  const [u, v] = c.toOut(p.cx, p.cy);
  return c.outToSrc(u, v);
}
function cssToSrcPx(c: ViewerController, p: { cx: number; cy: number }): Pt {
  const [x, y] = cssToSrcN(c, p);
  return [x * c.srcW, y * c.srcH];
}
const srcPxToCss = (c: ViewerController, x: number, y: number) => srcNToCss(c, x / c.srcW, y / c.srcH);
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const P = (p: { cx: number; cy: number }): Pt => [p.cx, p.cy];

function linearCss(c: ViewerController, l: LocalAdjustment) {
  const g = l.linear!;
  const a = srcNToCss(c, g.x0, g.y0);
  const b = srcNToCss(c, g.x1, g.y1);
  const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const len = dist(a, b) || 1;
  const dir: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  return { a, b, m, dir, len };
}

function radialCss(c: ViewerController, l: LocalAdjustment) {
  const g = l.radial!;
  const W = c.srcW;
  const H = c.srcH;
  const cx = g.cx * W;
  const cy = g.cy * H;
  const ang = (g.angle * Math.PI) / 180;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const rx = g.rx * W;
  const ry = g.ry * H;
  const pt = (t: number, k = 1): Pt => {
    const ex = rx * k * Math.cos(t);
    const ey = ry * k * Math.sin(t);
    return srcPxToCss(c, cx + ca * ex - sa * ey, cy + sa * ex + ca * ey);
  };
  return { center: srcPxToCss(c, cx, cy), pt, cxPx: cx, cyPx: cy, ang, rx, ry };
}

function pinPos(c: ViewerController, l: LocalAdjustment): Pt | null {
  if (l.type === 'linear' && l.linear) return linearCss(c, l).m;
  if (l.type === 'radial' && l.radial) return radialCss(c, l).center;
  const p = l.strokes?.[0]?.points[0];
  return p ? srcNToCss(c, p[0], p[1]) : null;
}

function pinHit(c: ViewerController, p: VPos, locals: LocalAdjustment[], except?: string | null) {
  for (let i = locals.length - 1; i >= 0; i--) {
    const l = locals[i];
    if (l.id === except) continue;
    const q = pinPos(c, l);
    if (q && dist(q, P(p)) <= 8) return l;
  }
  return null;
}

function insideRadial(c: ViewerController, l: LocalAdjustment, p: VPos) {
  const r = radialCss(c, l);
  const [x, y] = cssToSrcPx(c, p);
  const dx = x - r.cxPx;
  const dy = y - r.cyPx;
  const ca = Math.cos(r.ang);
  const sa = Math.sin(r.ang);
  const ex = ca * dx + sa * dy;
  const ey = -sa * dx + ca * dy;
  return (ex / Math.max(1e-6, r.rx)) ** 2 + (ey / Math.max(1e-6, r.ry)) ** 2;
}

function hit(c: ViewerController, p: VPos, l: LocalAdjustment): HandleHit | null {
  const q = P(p);
  if (l.type === 'linear' && l.linear) {
    const g = linearCss(c, l);
    if (dist(q, g.m) <= 9) return { kind: 'linear', h: 'pin' };
    const along = (o: Pt) => Math.abs((q[0] - o[0]) * g.dir[0] + (q[1] - o[1]) * g.dir[1]);
    if (along(g.a) <= 6) return { kind: 'linear', h: 'line0' };
    if (along(g.b) <= 6) return { kind: 'linear', h: 'line1' };
    if (along(g.m) <= 6) return { kind: 'linear', h: 'rotate' };
    return null;
  }
  if (l.type === 'radial' && l.radial) {
    const r = radialCss(c, l);
    if (dist(q, r.center) <= 9) return { kind: 'radial', h: 'center' };
    if (dist(q, r.pt(0)) <= 7 || dist(q, r.pt(Math.PI)) <= 7) return { kind: 'radial', h: 'rx' };
    if (dist(q, r.pt(Math.PI / 2)) <= 7 || dist(q, r.pt((3 * Math.PI) / 2)) <= 7) return { kind: 'radial', h: 'ry' };
    const e = insideRadial(c, l, p);
    // Near the outline (in normalised ellipse units, scaled by the on-screen radius).
    const rad = Math.max(8, Math.min(dist(r.center, r.pt(0)), dist(r.center, r.pt(Math.PI / 2))));
    if (Math.abs(Math.sqrt(e) - 1) * rad <= 7) return { kind: 'radial', h: 'rotate' };
    if (e < 1) return { kind: 'radial', h: 'move' };
  }
  return null;
}

const HANDLE_CURSOR: Record<string, string> = { pin: 'move', center: 'move', move: 'move', line0: 'ns-resize', line1: 'ns-resize', rx: 'ew-resize', ry: 'ns-resize', rotate: CURSORS.rotate };

export function hoverCursor(c: ViewerController, p: VPos, st: DevelopState): string | null {
  if (st.creating) return 'crosshair';
  const s = st.settings!;
  const sel = s.locals.find((l) => l.id === st.selectedMask);
  if (pinHit(c, p, s.locals, sel?.id)) return 'pointer';
  if (sel?.type === 'brush') return st.brush.mode === 'lasso' ? 'crosshair' : 'none';
  if (sel) {
    const h = hit(c, p, sel);
    if (h) {
      if (h.h === 'line0' || h.h === 'line1') {
        const g = linearCss(c, sel);
        return Math.abs(g.dir[0]) > Math.abs(g.dir[1]) ? 'ew-resize' : 'ns-resize';
      }
      return HANDLE_CURSOR[h.h];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Pointer

/** Returns true when the event was consumed by the mask tool. */
export function pointerDown(c: ViewerController, e: PointerEvent, p: VPos, st: DevelopState): boolean {
  const s = st.settings!;
  if (st.creating === 'linear' || st.creating === 'radial') {
    createDrag(c, e, p, st.creating);
    return true;
  }
  const sel = s.locals.find((l) => l.id === st.selectedMask);
  const other = pinHit(c, p, s.locals, sel?.id);
  if (other) {
    useDevelop.setState({ selectedMask: other.id });
    return true;
  }
  if (sel?.type === 'brush') {
    if (st.brush.mode === 'lasso') lasso(c, e, p, sel, st);
    else paint(c, e, p, sel, st);
    return true;
  }
  if (sel) {
    const h = hit(c, p, sel);
    if (h) {
      dragHandle(c, e, p, sel, h);
      return true;
    }
  }
  return false;
}

function linearGeom(c: ViewerController, a: VPos | Pt, b: VPos | Pt): LocalAdjustment['linear'] {
  const pa = Array.isArray(a) ? { cx: a[0], cy: a[1] } : a;
  const pb = Array.isArray(b) ? { cx: b[0], cy: b[1] } : b;
  const [x0, y0] = cssToSrcN(c, pa);
  const [x1, y1] = cssToSrcN(c, pb);
  return { x0, y0, x1, y1 };
}

function radialGeom(c: ViewerController, center: VPos, corner: VPos, circle: boolean, feather: number): LocalAdjustment['radial'] {
  const [u0, v0] = c.toOut(center.cx, center.cy);
  const [u1, v1] = c.toOut(corner.cx, corner.cy);
  // Output pixels are source pixels (the geometry is a similarity), so radii carry over directly.
  let rx = Math.abs(u1 - u0) * c.dispW;
  let ry = Math.abs(v1 - v0) * c.dispH;
  if (circle) rx = ry = Math.max(rx, ry);
  rx = Math.max(rx, 4);
  ry = Math.max(ry, 4);
  const [sx0, sy0] = c.outToSrc(u0, v0);
  const [sx1, sy1] = c.outToSrc(u0 + 1e-3, v0);
  const angle = (Math.atan2((sy1 - sy0) * c.srcH, (sx1 - sx0) * c.srcW) * 180) / Math.PI;
  return { cx: sx0, cy: sy0, rx: rx / c.srcW, ry: ry / c.srcH, angle, feather };
}

function createDrag(c: ViewerController, e: PointerEvent, p: VPos, type: 'linear' | 'radial') {
  if (cur().locals.length >= MAX_LOCALS) {
    toast(`A photo can have up to ${MAX_LOCALS} masks.`, 'warn');
    useDevelop.setState({ creating: null });
    return;
  }
  const id = newId();
  let created = false;
  const add = (geom: Partial<LocalAdjustment>) => {
    const s = cur();
    const l: LocalAdjustment = { ...defaultLocal(type, id), name: nextName(s, type), ...geom };
    setLive({ ...s, locals: [...s.locals, l] });
    useDevelop.setState({ selectedMask: id, creating: null });
    created = true;
  };
  c.drag(
    e,
    (ev) => {
      const q = c.pos(ev);
      if (!created && dist(P(q), P(p)) < 4) return;
      const geom: Partial<LocalAdjustment> = type === 'linear' ? { linear: linearGeom(c, p, q) } : { radial: radialGeom(c, p, q, ev.shiftKey, 50) };
      if (!created) add(geom);
      else setLive(updateLocal(cur(), id, (l) => ({ ...l, ...geom })));
    },
    () => {
      if (!created) {
        // Plain click: a default-sized mask at the click point.
        const k = Math.min(c.dispW, c.dispH) * c.view.scale;
        if (type === 'linear') add({ linear: linearGeom(c, P(p), [p.cx, p.cy + k * 0.25]) });
        else add({ radial: radialGeom(c, p, { cx: p.cx + k * 0.22, cy: p.cy + k * 0.22, half: p.half }, true, 50) });
      }
      commit(`New ${MASK_TYPE_LABEL[type]}`);
    },
    'create',
  );
}

function rot(p: Pt, o: Pt, a: number): Pt {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const dx = p[0] - o[0];
  const dy = p[1] - o[1];
  return [o[0] + ca * dx - sa * dy, o[1] + sa * dx + ca * dy];
}

function dragHandle(c: ViewerController, e: PointerEvent, p: VPos, l0: LocalAdjustment, h: HandleHit) {
  const id = l0.id;
  const start = cssToSrcN(c, p);
  const label = h.kind === 'linear' ? 'Edit Linear Gradient' : 'Edit Radial Gradient';
  c.drag(
    e,
    (ev) => {
      const q = c.pos(ev);
      let next: LocalAdjustment = l0;
      if (h.kind === 'linear' && l0.linear) {
        const g = linearCss(c, l0);
        if (h.h === 'pin') {
          const [x, y] = cssToSrcN(c, q);
          const dx = x - start[0];
          const dy = y - start[1];
          const L = l0.linear;
          next = { ...l0, linear: { x0: L.x0 + dx, y0: L.y0 + dy, x1: L.x1 + dx, y1: L.y1 + dy } };
        } else if (h.h === 'rotate') {
          const a0 = Math.atan2(p.cy - g.m[1], p.cx - g.m[0]);
          const a1 = Math.atan2(q.cy - g.m[1], q.cx - g.m[0]);
          let da = a1 - a0;
          if (ev.shiftKey) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
          next = { ...l0, linear: linearGeom(c, rot(g.a, g.m, da), rot(g.b, g.m, da)) };
        } else {
          // Move one outer line along the gradient direction (keeps the angle).
          const o = h.h === 'line0' ? g.a : g.b;
          const t = (q.cx - p.cx) * g.dir[0] + (q.cy - p.cy) * g.dir[1];
          const moved: Pt = [o[0] + g.dir[0] * t, o[1] + g.dir[1] * t];
          if (ev.altKey) {
            // Symmetric about the centre line.
            const other = h.h === 'line0' ? g.b : g.a;
            const mirrored: Pt = [other[0] - g.dir[0] * t, other[1] - g.dir[1] * t];
            next = { ...l0, linear: h.h === 'line0' ? linearGeom(c, moved, mirrored) : linearGeom(c, mirrored, moved) };
          } else next = { ...l0, linear: h.h === 'line0' ? linearGeom(c, moved, g.b) : linearGeom(c, g.a, moved) };
        }
      } else if (h.kind === 'radial' && l0.radial) {
        const R = l0.radial;
        const r = radialCss(c, l0);
        if (h.h === 'center' || h.h === 'move') {
          const [x, y] = cssToSrcN(c, q);
          next = { ...l0, radial: { ...R, cx: R.cx + x - start[0], cy: R.cy + y - start[1] } };
        } else if (h.h === 'rotate') {
          const [px0, py0] = cssToSrcPx(c, p);
          const [px1, py1] = cssToSrcPx(c, q);
          const a0 = Math.atan2(py0 - r.cyPx, px0 - r.cxPx);
          const a1 = Math.atan2(py1 - r.cyPx, px1 - r.cxPx);
          let angle = R.angle + ((a1 - a0) * 180) / Math.PI;
          if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
          next = { ...l0, radial: { ...R, angle } };
        } else {
          const [x, y] = cssToSrcPx(c, q);
          const dx = x - r.cxPx;
          const dy = y - r.cyPx;
          const ca = Math.cos(r.ang);
          const sa = Math.sin(r.ang);
          if (h.h === 'rx') {
            const nr = Math.max(3, Math.abs(ca * dx + sa * dy));
            const k = nr / Math.max(1e-6, r.rx);
            next = { ...l0, radial: { ...R, rx: nr / c.srcW, ry: ev.shiftKey ? (r.ry * k) / c.srcH : R.ry } };
          } else {
            const nr = Math.max(3, Math.abs(-sa * dx + ca * dy));
            const k = nr / Math.max(1e-6, r.ry);
            next = { ...l0, radial: { ...R, ry: nr / c.srcH, rx: ev.shiftKey ? (r.rx * k) / c.srcW : R.rx } };
          }
        }
      }
      setLive(updateLocal(cur(), id, () => next));
    },
    () => commit(label),
    h.h,
  );
}

function paint(c: ViewerController, e: PointerEvent, p: VPos, sel: LocalAdjustment, st: DevelopState) {
  const erase = st.brush.erase || e.altKey;
  const pt = cssToSrcN(c, p);
  // The stroke's points array is appended in place while painting (it is not in history yet), so
  // the engine rasterises incrementally; the containing arrays are copied to signal the change.
  const stroke: BrushStroke = { points: [pt], size: st.brush.size, feather: st.brush.feather, flow: st.brush.flow, erase };
  const id = sel.id;
  setLive(updateLocal(cur(), id, (l) => ({ ...l, strokes: [...(l.strokes ?? []), stroke] })));
  const minStep = Math.max(0.75, st.brush.size * c.srcW * 0.05);
  let last: Pt = [pt[0] * c.srcW, pt[1] * c.srcH];
  c.drag(
    e,
    (ev) => {
      const evs = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
      let added = false;
      for (const ce of evs.length ? evs : [ev]) {
        const q = c.pos(ce);
        const s2 = cssToSrcN(c, q);
        const px: Pt = [s2[0] * c.srcW, s2[1] * c.srcH];
        if (dist(px, last) >= minStep) {
          stroke.points.push(s2);
          last = px;
          added = true;
        }
      }
      c.hover = c.pos(ev);
      c.altHeld = erase;
      if (added) setLive(updateLocal(cur(), id, (l) => ({ ...l, strokes: (l.strokes ?? []).slice() })));
      else c.requestOverlay();
    },
    () => commit(erase ? 'Brush Erase' : 'Brush Stroke'),
    'paint',
  );
}

/** Outline being drawn (viewport CSS px), for the overlay. */
let lassoDraft: { css: Pt[]; erase: boolean; closing: boolean } | null = null;

const polygonArea = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

/**
 * Lasso: drag an outline around an area. It closes and fills as soon as the pointer comes back
 * near its start (or on release). Alt / Erase subtracts the area from the mask instead.
 */
function lasso(c: ViewerController, e: PointerEvent, p: VPos, sel: LocalAdjustment, st: DevelopState) {
  const erase = st.brush.erase || e.altKey;
  const { feather, flow } = st.brush;
  const id = sel.id;
  const src: Pt[] = [cssToSrcN(c, p)];
  const css: Pt[] = [P(p)];
  lassoDraft = { css, erase, closing: false };
  let travelled = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    lassoDraft = null;
    if (css.length >= 3 && polygonArea(css) >= 64) {
      const stroke: BrushStroke = { points: src, size: 0, feather, flow, erase, fill: true };
      setLive(updateLocal(cur(), id, (l) => ({ ...l, strokes: [...(l.strokes ?? []), stroke] })));
      commit(erase ? 'Lasso Subtract' : 'Lasso');
    }
    c.requestOverlay();
  };
  c.drag(
    e,
    (ev) => {
      if (done) return;
      const evs = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
      for (const ce of evs.length ? evs : [ev]) {
        const q = c.pos(ce);
        const d = dist(P(q), css[css.length - 1]);
        if (d < 2) continue;
        travelled += d;
        css.push(P(q));
        src.push(cssToSrcN(c, q));
      }
      c.hover = c.pos(ev);
      // Wrapping back to the start closes the shape immediately.
      const near = travelled > 80 && css.length > 8 && dist(css[css.length - 1], css[0]) < 14;
      if (lassoDraft) lassoDraft.closing = near;
      if (near) finish();
      else c.requestOverlay();
    },
    finish,
    'lasso',
  );
}

/** Lasso button / L key: lasso into the selected brush mask, or start a new one. */
export function startLasso() {
  if (useDevelop.getState().tool === 'crop') applyCrop();
  const st = useDevelop.getState();
  const s = st.settings;
  if (!s) return;
  const sel = s.locals.find((l) => l.id === st.selectedMask);
  useDevelop.setState((x) => ({ brush: { ...x.brush, mode: 'lasso', erase: false } }));
  if (sel?.type === 'brush' && st.tool === 'mask') return;
  if (s.locals.length >= MAX_LOCALS) {
    toast(`A photo can have up to ${MAX_LOCALS} masks.`, 'warn');
    return;
  }
  const n = s.locals.filter((l) => l.name.startsWith('Lasso')).length + 1;
  const l: LocalAdjustment = { ...defaultLocal('brush', newId()), name: `Lasso ${n}` };
  setLive({ ...s, locals: [...s.locals, l] });
  useDevelop.setState({ tool: 'mask', selectedMask: l.id, creating: null });
  commit('New Lasso Mask');
}

// ---------------------------------------------------------------------------------------------
// Drawing

function line(ctx: CanvasRenderingContext2D, o: Pt, d: Pt, L: number) {
  ctx.moveTo(o[0] - d[0] * L, o[1] - d[1] * L);
  ctx.lineTo(o[0] + d[0] * L, o[1] + d[1] * L);
}

function strokeTwice(ctx: CanvasRenderingContext2D, width = 1.25, color = '#fff') {
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function knob(ctx: CanvasRenderingContext2D, p: Pt, r: number, fill: string) {
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

export function draw(c: ViewerController, ctx: CanvasRenderingContext2D, st: DevelopState) {
  const s = st.settings!;
  const [ix0, iy0] = c.fromOut(0, 0);
  const [ix1, iy1] = c.fromOut(1, 1);
  const sel = s.locals.find((l) => l.id === st.selectedMask);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ix0, iy0, ix1 - ix0, iy1 - iy0);
  ctx.clip();
  const L = Math.hypot(c.vw, c.vh) * 2;

  if (sel?.type === 'linear' && sel.linear) {
    const g = linearCss(c, sel);
    const perp: Pt = [-g.dir[1], g.dir[0]];
    ctx.setLineDash([]);
    ctx.beginPath();
    line(ctx, g.a, perp, L);
    line(ctx, g.b, perp, L);
    strokeTwice(ctx, 1);
    ctx.beginPath();
    line(ctx, g.m, perp, L);
    strokeTwice(ctx, 1.5);
  } else if (sel?.type === 'radial' && sel.radial) {
    const r = radialCss(c, sel);
    const ring = (k: number) => {
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const q = r.pt((i / 96) * Math.PI * 2, k);
        if (i === 0) ctx.moveTo(q[0], q[1]);
        else ctx.lineTo(q[0], q[1]);
      }
    };
    ring(1);
    strokeTwice(ctx, 1.5);
    const inner = Math.max(0.001, 1 - sel.radial.feather / 100);
    if (inner < 0.995) {
      ctx.setLineDash([4, 4]);
      ring(inner);
      strokeTwice(ctx, 1, 'rgba(255,255,255,0.8)');
      ctx.setLineDash([]);
    }
    for (const t of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const q = r.pt(t);
      ctx.beginPath();
      ctx.rect(q[0] - 3.5, q[1] - 3.5, 7, 7);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
    }
  }
  ctx.restore();

  // Pins for every mask (click to select).
  for (const l of s.locals) {
    const q = pinPos(c, l);
    if (!q) continue;
    const isSel = l.id === st.selectedMask;
    ctx.globalAlpha = l.enabled ? 1 : 0.5;
    knob(ctx, q, isSel ? 6 : 5, isSel ? '#3d8bfd' : 'rgba(30,30,32,0.85)');
    if (isSel) knob(ctx, q, 2, '#fff');
    ctx.globalAlpha = 1;
  }

  // Lasso outline in progress.
  if (lassoDraft && lassoDraft.css.length > 1) {
    const { css, erase, closing } = lassoDraft;
    ctx.beginPath();
    css.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    strokeTwice(ctx, 1.5, erase ? '#ff9a9a' : '#fff');
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(css[css.length - 1][0], css[css.length - 1][1]);
    ctx.lineTo(css[0][0], css[0][1]);
    strokeTwice(ctx, 1, 'rgba(255,255,255,0.7)');
    ctx.setLineDash([]);
    knob(ctx, css[0], closing ? 7 : 5, closing ? '#30a46c' : 'rgba(30,30,32,0.85)');
  }

  // Brush cursor.
  if (sel?.type === 'brush' && st.brush.mode !== 'lasso' && c.hover && !st.creating) {
    const p = c.hover;
    const d = st.brush.size * c.srcW * c.view.scale;
    const inner = d * (1 - st.brush.feather / 100);
    const erase = st.brush.erase || c.altHeld;
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, Math.max(1, d / 2), 0, Math.PI * 2);
    strokeTwice(ctx, 1, erase ? '#ff9a9a' : '#fff');
    if (inner > 2 && inner < d - 1) {
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, inner / 2, 0, Math.PI * 2);
      strokeTwice(ctx, 1, 'rgba(255,255,255,0.6)');
    }
    ctx.beginPath();
    ctx.moveTo(p.cx - 4, p.cy);
    ctx.lineTo(p.cx + 4, p.cy);
    ctx.moveTo(p.cx, p.cy - 4);
    ctx.lineTo(p.cx, p.cy + 4);
    strokeTwice(ctx, 1, erase ? '#ff9a9a' : '#fff');
    if (erase) {
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.fillStyle = '#ff9a9a';
      ctx.fillText('−', p.cx + d / 2 + 4, p.cy - d / 2);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Panel actions

export function startCreate(type: LocalType) {
  if (useDevelop.getState().tool === 'crop') applyCrop();
  const st = useDevelop.getState();
  const s = st.settings;
  if (!s) return;
  if (s.locals.length >= MAX_LOCALS) {
    toast(`A photo can have up to ${MAX_LOCALS} masks.`, 'warn');
    return;
  }
  if (type === 'brush') {
    const l: LocalAdjustment = { ...defaultLocal('brush', newId()), name: nextName(s, 'brush') };
    setLive({ ...s, locals: [...s.locals, l] });
    useDevelop.setState({ tool: 'mask', selectedMask: l.id, creating: null });
    commit('New Brush Mask');
    return;
  }
  useDevelop.setState({ tool: 'mask', creating: st.creating === type ? null : type });
}

export function deleteMask(id: string) {
  const st = useDevelop.getState();
  const s = st.settings;
  if (!s) return;
  const i = s.locals.findIndex((l) => l.id === id);
  if (i < 0) return;
  const locals = s.locals.filter((l) => l.id !== id);
  setLive({ ...s, locals });
  if (st.selectedMask === id) useDevelop.setState({ selectedMask: locals[Math.min(i, locals.length - 1)]?.id ?? null });
  commit('Delete Mask');
}

export function duplicateMask(id: string) {
  const s = useDevelop.getState().settings;
  if (!s) return;
  if (s.locals.length >= MAX_LOCALS) {
    toast(`A photo can have up to ${MAX_LOCALS} masks.`, 'warn');
    return;
  }
  const src = s.locals.find((l) => l.id === id);
  if (!src) return;
  const copy: LocalAdjustment = { ...structuredClone(src), id: newId(), name: `${src.name} Copy` };
  const i = s.locals.indexOf(src);
  const locals = [...s.locals];
  locals.splice(i + 1, 0, copy);
  setLive({ ...s, locals });
  useDevelop.setState({ selectedMask: copy.id });
  commit('Duplicate Mask');
}

export function patchMask(id: string, patch: Partial<LocalAdjustment>, label?: string) {
  const s = useDevelop.getState().settings;
  if (!s) return;
  setLive(updateLocal(s, id, (l) => ({ ...l, ...patch })));
  if (label) commit(label);
}

export function moveMask(id: string, dir: -1 | 1) {
  const s = useDevelop.getState().settings;
  if (!s) return;
  const i = s.locals.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.locals.length) return;
  const locals = [...s.locals];
  [locals[i], locals[j]] = [locals[j], locals[i]];
  setLive({ ...s, locals });
  commit('Reorder Masks');
}
