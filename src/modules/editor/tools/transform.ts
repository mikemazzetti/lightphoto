import { create } from 'zustand';
import { toast } from '@/state/app';
import { bus } from '../model/bus';
import { capturePatch, Doc, layerRect, PixelPatch } from '../model/doc';
import { IDENTITY, Mat2D, matApply, matBounds, matInvert, matMul, matRotate, matScale, matTranslate, Rect, rectIntersect, rectRoundOut, rectUnion } from '../model/geom';
import type { Selection } from '../model/selection';
import { ctx2d, makeCanvas, Surface } from '../model/surface';
import type { Layer } from '../model/types';
import { edState, touch, useEditor } from '../model/store';
import { getCompositor } from '../render/compositor';
import { commit, ensureRaster } from '../ops/layers';
import { offsetLayer, transformLayerBy } from '../ops/edit';
import type { Tool, ToolEnv, ToolPointer } from './types';
import { ACCENT, drawHandle, strokeHalo } from './types';

/** Transform parameters around the base box centre. */
export interface XformParams {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  angle: number; // radians
}

export const useTransformUI = create<XformParams & { active: boolean; w: number; h: number }>(() => ({ active: false, tx: 0, ty: 0, sx: 1, sy: 1, angle: 0, w: 0, h: 0 }));

interface Floating {
  surf: Surface;
  backup: OffscreenCanvas;
  /** Selection bounds ∩ layer (document space). */
  box: Rect;
  /** The selection the pixels were lifted with (the live one may change during the session). */
  sel: Selection;
}

interface Session {
  doc: Doc;
  layer: Layer;
  base: Rect;
  p: XformParams;
  floating: Floating | null;
  drag: null | { kind: 'move' | 'rotate' | 'scale'; hx: number; hy: number; start: XformParams; px: number; py: number; a0: number; aspect: number };
  /** Set when started by the Move tool (commit on pointer-up, no handles). */
  quick: boolean;
}

let S: Session | null = null;

export const transformActive = () => !!S;

function matrixOf(s: Session): Mat2D {
  const { base, p } = s;
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  return matMul(matTranslate(cx + p.tx, cy + p.ty), matMul(matRotate(p.angle), matMul(matScale(p.sx, p.sy), matTranslate(-cx, -cy))));
}

let uiRaf = 0;
function syncUI() {
  if (uiRaf) return;
  uiRaf = requestAnimationFrame(() => {
    uiRaf = 0;
    if (!S) return useTransformUI.setState({ active: false });
    useTransformUI.setState({ active: true, ...S.p, w: S.base.w, h: S.base.h });
  });
}

function updatePreview() {
  if (!S) return;
  const m = matrixOf(S);
  const l = S.layer;
  if (S.floating) S.doc.preview = { layerId: l.id, floating: { surf: S.floating.surf, matrix: matMul(m, matTranslate(S.floating.box.x, S.floating.box.y)) } };
  else S.doc.preview = { layerId: l.id, matrix: matMul(m, matTranslate(l.x, l.y)) };
  S.doc.invalidate();
  bus.requestOverlay();
  syncUI();
}

/** Lifts the selected pixels of a raster layer into a floating surface (leaving a hole). */
function makeFloating(doc: Doc, l: Layer): Floating | null {
  const sel = doc.selection!;
  const surf = l.surf!;
  const box = rectIntersect(sel.bounds, { x: l.x, y: l.y, w: surf.width, h: surf.height });
  if (!box) return null;
  const backup = makeCanvas(surf.width, surf.height);
  ctx2d(backup).drawImage(surf.canvas, 0, 0);
  const f = new Surface(box.w, box.h);
  f.ctx.drawImage(surf.canvas, box.x - l.x, box.y - l.y, box.w, box.h, 0, 0, box.w, box.h);
  f.ctx.globalCompositeOperation = 'destination-in';
  f.ctx.drawImage(sel.canvas(), sel.bounds.x - box.x, sel.bounds.y - box.y);
  f.ctx.globalCompositeOperation = 'source-over';
  surf.ctx.save();
  surf.ctx.globalCompositeOperation = 'destination-out';
  surf.ctx.drawImage(sel.canvas(), sel.bounds.x - l.x, sel.bounds.y - l.y);
  surf.ctx.restore();
  surf.touch();
  return { surf: f, backup, box, sel };
}

/** Starts Free Transform on the active layer (selected pixels when there is a selection). */
export async function startTransform(doc: Doc, opts: { quick?: boolean } = {}): Promise<boolean> {
  if (S) return true;
  const l = doc.activeLayer;
  if (!l) return false;
  if (l.lockAll || l.lockPosition) {
    toast(`"${l.name}" is locked.`, 'warn');
    return false;
  }
  if (l.kind === 'adjustment' || l.kind === 'fill') {
    toast('Free Transform needs a layer with pixels.', 'warn');
    return false;
  }
  let floating: Floating | null = null;
  let base: Rect | null;
  if (doc.selection && !doc.editMask) {
    if (!(await ensureRaster(doc, l))) return false;
    if (l.lockPixels) {
      toast(`"${l.name}" is locked.`, 'warn');
      return false;
    }
    floating = makeFloating(doc, l);
    if (!floating) {
      toast('The selected area is empty.', 'warn');
      return false;
    }
    base = floating.box;
  } else base = layerRect(l);
  if (!base || base.w < 1 || base.h < 1) return false;
  S = { doc, layer: l, base, p: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 }, floating, drag: null, quick: !!opts.quick };
  if (!opts.quick) useEditor.setState({ session: 'transform' });
  updatePreview();
  return true;
}

export function setTransformParams(patch: Partial<XformParams>) {
  if (!S) return;
  S.p = { ...S.p, ...patch };
  updatePreview();
}

function finish() {
  if (!S) return;
  const doc = S.doc;
  if (doc.preview?.layerId === S.layer.id) doc.preview = null;
  getCompositor()?.clearPreviewCache();
  S = null;
  useEditor.setState({ session: null });
  useTransformUI.setState({ active: false });
  doc.invalidate();
  bus.requestOverlay();
  touch();
}

export function cancelTransform() {
  if (!S) return;
  const { floating, layer } = S;
  if (floating && layer.surf) {
    const ctx = layer.surf.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(floating.backup, 0, 0);
    ctx.restore();
    layer.surf.touch();
  }
  finish();
}

export function commitTransform() {
  if (!S) return;
  const s = S;
  const m = matrixOf(s);
  const doc = s.doc;
  const l = s.layer;
  const identity = Math.abs(s.p.tx) < 1e-6 && Math.abs(s.p.ty) < 1e-6 && s.p.sx === 1 && s.p.sy === 1 && s.p.angle === 0;
  if (identity) return cancelTransform();
  const pureMove = s.p.sx === 1 && s.p.sy === 1 && s.p.angle === 0 && Number.isInteger(s.p.tx) && Number.isInteger(s.p.ty);
  if (!s.floating) {
    if (pureMove) offsetLayer(l, s.p.tx, s.p.ty);
    else transformLayerBy(doc, l, m, 'high');
    doc.touchLayer(l);
    finish();
    commit(doc, s.quick ? 'Move' : 'Free Transform');
    return;
  }
  // Floating pixels: restore, then cut + draw transformed in one undoable step.
  const f = s.floating;
  const surf = l.surf!;
  const fm = matMul(m, matTranslate(f.box.x, f.box.y));
  const fb = rectRoundOut(matBounds(fm, { x: 0, y: 0, w: f.surf.width, h: f.surf.height }));
  const cur = { x: l.x, y: l.y, w: surf.width, h: surf.height };
  const limit = { x: -doc.width, y: -doc.height, w: doc.width * 3, h: doc.height * 3 };
  const need = rectIntersect(rectUnion(cur, fb), rectUnion(limit, cur))!;
  const sctx = surf.ctx;
  sctx.save();
  sctx.globalCompositeOperation = 'copy';
  sctx.drawImage(f.backup, 0, 0);
  sctx.restore();
  surf.touch();
  const sel = f.sel;
  let target = surf;
  let ox = l.x;
  let oy = l.y;
  let patches: (PixelPatch | null)[] = [];
  const grown = need.w !== cur.w || need.h !== cur.h || need.x !== cur.x || need.y !== cur.y;
  if (grown) {
    target = new Surface(need.w, need.h);
    target.ctx.drawImage(surf.canvas, cur.x - need.x, cur.y - need.y);
    ox = need.x;
    oy = need.y;
  } else {
    const region = rectIntersect(rectUnion(f.box, fb), cur)!;
    patches = [capturePatch(surf, { x: region.x - l.x, y: region.y - l.y, w: region.w, h: region.h })];
  }
  const ctx = target.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sel.canvas(), sel.bounds.x - ox, sel.bounds.y - oy);
  ctx.restore();
  ctx.save();
  const t = matMul(matTranslate(-ox, -oy), fm);
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(f.surf.canvas, 0, 0);
  ctx.restore();
  target.touch();
  if (grown) {
    l.surf = target;
    l.x = ox;
    l.y = oy;
  }
  // The selection follows the pixels.
  doc.selection = pureMove ? sel.translate(s.p.tx, s.p.ty) : sel.remap(doc.width, doc.height, m);
  doc.touchLayer(l);
  finish();
  commit(doc, s.quick ? 'Move' : 'Free Transform', { patches, structural: true });
}

// ---------------------------------------------------------------------------------------------
// Interaction

const HANDLES: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

function corners(s: Session): [number, number][] {
  const m = matrixOf(s);
  const { x, y, w, h } = s.base;
  return HANDLES.map(([hx, hy]) => matApply(m, x + ((hx + 1) / 2) * w, y + ((hy + 1) / 2) * h));
}

function hit(env: ToolEnv, s: Session, sx: number, sy: number): { kind: 'scale'; hx: number; hy: number } | { kind: 'move' } | { kind: 'rotate' } {
  const pts = corners(s).map(([x, y]) => env.toScreen(x, y));
  for (let i = 0; i < pts.length; i++) if (Math.hypot(pts[i][0] - sx, pts[i][1] - sy) < 8) return { kind: 'scale', hx: HANDLES[i][0], hy: HANDLES[i][1] };
  // inside the quad?
  const [ix, iy] = env.toImage(sx, sy);
  const inv = matInvert(matrixOf(s));
  const [lx, ly] = matApply(inv, ix, iy);
  const b = s.base;
  if (lx >= b.x && ly >= b.y && lx <= b.x + b.w && ly <= b.y + b.h) return { kind: 'move' };
  return { kind: 'rotate' };
}

const CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

function handleCursor(s: Session, hx: number, hy: number) {
  const i = HANDLES.findIndex(([x, y]) => x === hx && y === hy);
  // rotate the cursor with the box
  const steps = Math.round((s.p.angle / Math.PI) * 4);
  return CURSORS[(((i + steps) % 8) + 8) % 8];
}

export const transformTool: Tool = {
  cursor(env, p) {
    if (!S || !p) return 'default';
    if (S.drag) return S.drag.kind === 'move' ? 'move' : S.drag.kind === 'rotate' ? 'grabbing' : handleCursor(S, S.drag.hx, S.drag.hy);
    const h = hit(env, S, p.sx, p.sy);
    return h.kind === 'move' ? 'move' : h.kind === 'rotate' ? 'alias' : handleCursor(S, h.hx, h.hy);
  },
  down(env, p) {
    if (!S) return;
    const h = hit(env, S, p.sx, p.sy);
    const c = matApply(matrixOf(S), S.base.x + S.base.w / 2, S.base.y + S.base.h / 2);
    S.drag = {
      kind: h.kind,
      hx: h.kind === 'scale' ? h.hx : 0,
      hy: h.kind === 'scale' ? h.hy : 0,
      start: { ...S.p },
      px: p.x,
      py: p.y,
      a0: Math.atan2(p.y - c[1], p.x - c[0]),
      aspect: Math.abs(S.p.sx / (S.p.sy || 1)),
    };
  },
  move(_env, p) {
    if (!S?.drag) return;
    const d = S.drag;
    const st = d.start;
    const b = S.base;
    if (d.kind === 'move') {
      let dx = p.x - d.px;
      let dy = p.y - d.py;
      if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      S.p = { ...st, tx: st.tx + dx, ty: st.ty + dy };
    } else if (d.kind === 'rotate') {
      const cx = b.x + b.w / 2 + st.tx;
      const cy = b.y + b.h / 2 + st.ty;
      let a = st.angle + Math.atan2(p.y - cy, p.x - cx) - d.a0;
      if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      S.p = { ...st, angle: a };
    } else {
      // local frame of the box at drag start
      const cx = b.x + b.w / 2 + st.tx;
      const cy = b.y + b.h / 2 + st.ty;
      const cos = Math.cos(-st.angle);
      const sin = Math.sin(-st.angle);
      const qx = (p.x - cx) * cos - (p.y - cy) * sin;
      const qy = (p.x - cx) * sin + (p.y - cy) * cos;
      const W = b.w * st.sx;
      const H = b.h * st.sy;
      let nW = W;
      let nH = H;
      let mx = 0;
      let my = 0;
      if (d.hx) {
        const fx = p.alt ? -qx : (-d.hx * W) / 2;
        nW = (qx - fx) * d.hx;
        mx = p.alt ? 0 : (qx + fx) / 2;
      }
      if (d.hy) {
        const fy = p.alt ? -qy : (-d.hy * H) / 2;
        nH = (qy - fy) * d.hy;
        my = p.alt ? 0 : (qy + fy) / 2;
      }
      let nsx = nW / b.w;
      let nsy = nH / b.h;
      if (p.shift) {
        // proportional: corner = the larger change wins; edge = follow that axis
        if (d.hx && d.hy) {
          const k = Math.max(Math.abs(nsx / st.sx), Math.abs(nsy / st.sy));
          nsx = Math.sign(nsx || 1) * Math.abs(st.sx) * k;
          nsy = Math.sign(nsy || 1) * Math.abs(st.sy) * k;
          if (!p.alt) {
            // keep the opposite corner fixed
            mx = (d.hx * (nsx * b.w - W)) / 2;
            my = (d.hy * (nsy * b.h - H)) / 2;
          }
        } else if (d.hx) {
          nsy = Math.sign(st.sy || 1) * Math.abs(nsx) / d.aspect;
        } else if (d.hy) {
          nsx = Math.sign(st.sx || 1) * Math.abs(nsy) * d.aspect;
        }
      }
      if (Math.abs(nsx) < 1e-3) nsx = 1e-3;
      if (Math.abs(nsy) < 1e-3) nsy = 1e-3;
      // move the centre (local → document)
      const ca = Math.cos(st.angle);
      const sa = Math.sin(st.angle);
      S.p = { ...st, sx: nsx, sy: nsy, tx: st.tx + mx * ca - my * sa, ty: st.ty + mx * sa + my * ca };
    }
    updatePreview();
  },
  up() {
    if (!S) return;
    S.drag = null;
    if (S.quick) commitTransform();
  },
  dblclick() {
    if (S && !S.quick) commitTransform();
  },
  key(_env, e) {
    if (!S) return false;
    if (e.key === 'Enter') {
      commitTransform();
      return true;
    }
    if (e.key === 'Escape') {
      cancelTransform();
      return true;
    }
    return false;
  },
  overlay(env, ctx) {
    if (!S || S.quick) return;
    const pts = corners(S).map(([x, y]) => env.toScreen(x, y));
    const quad = [pts[0], pts[2], pts[4], pts[6]];
    strokeHalo(
      ctx,
      () => {
        ctx.beginPath();
        quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
      },
      ACCENT,
    );
    pts.forEach(([x, y]) => drawHandle(ctx, x, y));
    const c = matApply(matrixOf(S), S.base.x + S.base.w / 2, S.base.y + S.base.h / 2);
    const [cx, cy] = env.toScreen(c[0], c[1]);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  },
  busy: () => !!S,
};

/** Bounds of the transformed content (document space) — for the options bar. */
export function transformInfo() {
  if (!S) return null;
  return { base: S.base, p: S.p, matrix: matrixOf(S) };
}

// ---------------------------------------------------------------------------------------------
// Move tool

let moveDrag: null | { doc: Doc; layer: Layer; x0: number; y0: number; dx: number; dy: number } = null;

function pickLayerAt(doc: Doc, x: number, y: number): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible || !l.surf || l.kind === 'adjustment') continue;
    const lx = Math.floor(x - l.x);
    const ly = Math.floor(y - l.y);
    if (lx < 0 || ly < 0 || lx >= l.surf.width || ly >= l.surf.height) continue;
    const a = l.surf.ctx.getImageData(lx, ly, 1, 1).data[3];
    if (a > 10) return l;
  }
  return null;
}

/** Ends a Move-tool drag, recording it when the layer actually moved. */
function endMoveDrag() {
  const d = moveDrag;
  moveDrag = null;
  if (!d || (!d.dx && !d.dy)) return;
  if (d.layer.kind === 'text' || d.layer.kind === 'shape') d.doc.touchLayer(d.layer);
  commit(d.doc, 'Move');
}

export const moveTool: Tool = {
  cursor: () => (moveDrag ? 'move' : 'default'),
  down(env, p) {
    const doc = env.doc;
    if (edState().opts.move.autoSelect || p.mod) {
      const hitL = pickLayerAt(doc, p.x, p.y);
      if (hitL && hitL.id !== doc.activeLayerId) {
        doc.activeLayerId = hitL.id;
        doc.editMask = false;
        touch();
      }
    }
    const l = doc.activeLayer;
    if (!l) return;
    if (l.lockAll || l.lockPosition) {
      toast(`"${l.name}" is locked.`, 'warn');
      return;
    }
    if (doc.selection && l.kind === 'raster' && !doc.editMask) {
      // Move selected pixels: a quick floating transform.
      void startTransform(doc, { quick: true }).then((ok) => {
        if (!ok || !S) return;
        S.drag = { kind: 'move', hx: 0, hy: 0, start: { ...S.p }, px: p.x, py: p.y, a0: 0, aspect: 1 };
      });
      return;
    }
    if (l.kind === 'adjustment' || (l.kind === 'fill' && !l.mask)) return;
    moveDrag = { doc, layer: l, x0: p.x, y0: p.y, dx: 0, dy: 0 };
  },
  move(env, p) {
    if (S?.quick) {
      transformTool.move!(env, { ...p, x: Math.round(p.x - (S.drag?.px ?? p.x)) + (S.drag?.px ?? p.x), y: Math.round(p.y - (S.drag?.py ?? p.y)) + (S.drag?.py ?? p.y) });
      return;
    }
    const d = moveDrag;
    if (!d) return;
    let dx = Math.round(p.x - d.x0);
    let dy = Math.round(p.y - d.y0);
    if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    if (dx === d.dx && dy === d.dy) return;
    offsetLayer(d.layer, dx - d.dx, dy - d.dy);
    d.dx = dx;
    d.dy = dy;
    d.doc.touchLayer(d.layer);
  },
  up(env, p) {
    if (S?.quick) {
      transformTool.up!(env, p);
      return;
    }
    endMoveDrag();
  },
  deactivate() {
    endMoveDrag();
  },
  busy: () => !!moveDrag,
};

export { IDENTITY };
