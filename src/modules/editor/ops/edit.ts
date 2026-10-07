import type { BlendMode } from '@/core/gl/glsl';
import { toast } from '@/state/app';
import { capturePatch, Doc, layerRect, rasterLayer } from '../model/doc';
import { IDENTITY, Mat2D, matMul, matTranslate, Rect, rectIntersect, rectUnion } from '../model/geom';
import { rasterizeVector, shapeBox, textBox } from '../model/rasterize';
import { Selection } from '../model/selection';
import { ctx2d, makeCanvas, rgbaCss, Surface } from '../model/surface';
import type { Layer, RGBA } from '../model/types';
import { edState } from '../model/store';
import { requireCompositor } from '../render/compositor';
import { CANVAS_BLEND, grayOf, restoreAlpha } from '../paint/stroke';
import { docFromImage, uniqueName } from './docs';
import { commit, deleteLayer, ensureRaster, nextLayerName, pixelTarget, targetToSurface, addLayer } from './layers';

// ---------------------------------------------------------------------------------------------
// Fill / clear / stroke

export async function fillArea(doc: Doc, color: RGBA, opts: { opacity?: number; blend?: BlendMode; preserveTransparency?: boolean; selection?: Selection | null; label?: string } = {}) {
  const t = await pixelTarget(doc, { cover: true });
  if (!t) return;
  const sel = opts.selection === undefined ? doc.selection : opts.selection;
  const docRect = { x: 0, y: 0, w: doc.width, h: doc.height };
  const region = rectIntersect(rectIntersect(sel?.bounds ?? docRect, docRect), { x: t.ox, y: t.oy, w: t.surf.width, h: t.surf.height });
  if (!region) return;
  const lr = { x: region.x - t.ox, y: region.y - t.oy, w: region.w, h: region.h };
  const patch = capturePatch(t.surf, lr);
  const tmp = makeCanvas(region.w, region.h);
  const tc = ctx2d(tmp);
  const g = grayOf(color);
  tc.fillStyle = t.mask ? `rgb(${g},${g},${g})` : rgbaCss(color, 1);
  tc.fillRect(0, 0, region.w, region.h);
  if (sel) {
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(sel.canvas(), sel.bounds.x - region.x, sel.bounds.y - region.y);
  }
  const ctx = t.surf.ctx;
  const lockAlpha = !t.mask && (opts.preserveTransparency || t.layer.lockTransparency);
  const blendOp = CANVAS_BLEND[opts.blend ?? 'normal'] ?? 'source-over';
  ctx.save();
  ctx.globalAlpha = opts.opacity ?? 1;
  ctx.globalCompositeOperation = lockAlpha && blendOp === 'source-over' ? 'source-atop' : blendOp;
  ctx.drawImage(tmp, lr.x, lr.y);
  ctx.restore();
  if (lockAlpha && blendOp !== 'source-over' && patch) restoreAlpha(patch);
  t.surf.touch(lr);
  doc.touchLayer(t.layer, region);
  commit(doc, opts.label ?? 'Fill', { patches: [patch], structural: t.grown });
}

export async function clearSelection(doc: Doc) {
  const l = doc.activeLayer;
  if (!l) return;
  if (!doc.selection) {
    if (doc.editMask) toast('Make a selection to clear part of the mask.', 'warn');
    else deleteLayer(doc);
    return;
  }
  if (doc.editMask && l.mask) {
    await fillArea(doc, edState().bg, { label: 'Clear' });
    return;
  }
  if (l.lockTransparency) {
    await fillArea(doc, edState().bg, { label: 'Clear' });
    return;
  }
  const t = await pixelTarget(doc);
  if (!t) return;
  const sel = doc.selection;
  const region = rectIntersect(sel.bounds, { x: t.ox, y: t.oy, w: t.surf.width, h: t.surf.height });
  if (!region) return;
  const lr = { x: region.x - t.ox, y: region.y - t.oy, w: region.w, h: region.h };
  const patch = capturePatch(t.surf, lr);
  const ctx = t.surf.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sel.canvas(), sel.bounds.x - t.ox, sel.bounds.y - t.oy);
  ctx.restore();
  t.surf.touch(lr);
  doc.touchLayer(t.layer, region);
  commit(doc, 'Clear', { patches: [patch] });
}

export type StrokeLocation = 'inside' | 'center' | 'outside';

export async function strokeSelection(doc: Doc, width: number, color: RGBA, location: StrokeLocation, opacity = 1, blend: BlendMode = 'normal') {
  const s = doc.selection;
  if (!s) {
    toast('Stroke needs an active selection.', 'warn');
    return;
  }
  let ring: Selection | null = null;
  if (location === 'inside') {
    const inner = s.contract(width);
    ring = inner ? Selection.combine(s, inner, 'subtract') : s;
  } else if (location === 'outside') {
    const outer = s.expand(width);
    ring = outer ? Selection.combine(outer, s, 'subtract') : null;
  } else {
    const outer = s.expand(width / 2);
    const inner = s.contract(width / 2);
    ring = outer ? (inner ? Selection.combine(outer, inner, 'subtract') : outer) : null;
  }
  if (!ring) return;
  await fillArea(doc, color, { opacity, blend, selection: ring, label: 'Stroke' });
}

// ---------------------------------------------------------------------------------------------
// Clipboard

interface ClipData {
  surf: Surface;
  x: number;
  y: number;
  /** Recognises our own copy when it comes back through the system clipboard. */
  print: Uint8ClampedArray;
}
let clipboard: ClipData | null = null;

/** A cheap image fingerprint: 8×8 point samples (premultiplied RGBA). */
function fingerprint(src: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
  const N = 8;
  const ctx = ctx2d(makeCanvas(N, N), true);
  ctx.imageSmoothingEnabled = false;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ctx.drawImage(src, Math.floor(((i + 0.5) * w) / N), Math.floor(((j + 0.5) * h) / N), 1, 1, i, j, 1, 1);
  const d = ctx.getImageData(0, 0, N, N).data;
  for (let k = 0; k < d.length; k += 4) for (let c = 0; c < 3; c++) d[k + c] = (d[k + c] * d[k + 3]) / 255;
  return d;
}

/** PNG round trips may shift values slightly. */
const samePrint = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 3);

export const hasInternalClipboard = () => !!clipboard;

async function writeSystemClipboard(c: OffscreenCanvas) {
  try {
    const blob = await c.convertToBlob({ type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch {
    /* system clipboard unavailable — the internal one still works */
  }
}

export async function copyPixels(doc: Doc, merged = false, cut = false): Promise<boolean> {
  const sel = doc.selection;
  const docRect = { x: 0, y: 0, w: doc.width, h: doc.height };
  let surf: Surface;
  let region: Rect;
  if (merged) {
    region = sel?.bounds ?? docRect;
    const c = requireCompositor();
    const rt = c.renderLayers(
      doc,
      doc.layers.filter((l) => l.visible),
      region,
    );
    surf = targetToSurface(rt);
    c.pool.release(rt);
  } else {
    const l = doc.activeLayer;
    if (!l) return false;
    const src = doc.editMask && l.mask ? { surf: l.mask.surf, x: l.mask.x, y: l.mask.y } : l.surf ? { surf: l.surf, x: l.x, y: l.y } : null;
    if (!src) {
      toast('Nothing to copy on this layer.', 'warn');
      return false;
    }
    const r = rectIntersect(sel?.bounds ?? docRect, { x: src.x, y: src.y, w: src.surf.width, h: src.surf.height });
    if (!r) {
      toast('The selected area is empty.', 'warn');
      return false;
    }
    region = r;
    surf = new Surface(r.w, r.h);
    surf.ctx.drawImage(src.surf.canvas, r.x - src.x, r.y - src.y, r.w, r.h, 0, 0, r.w, r.h);
  }
  if (sel) {
    surf.ctx.globalCompositeOperation = 'destination-in';
    surf.ctx.drawImage(sel.canvas(), sel.bounds.x - region.x, sel.bounds.y - region.y);
    surf.ctx.globalCompositeOperation = 'source-over';
  }
  clipboard = { surf, x: region.x, y: region.y, print: fingerprint(surf.canvas, surf.width, surf.height) };
  void writeSystemClipboard(surf.canvas);
  if (cut && !merged) {
    if (sel) await clearSelection(doc);
    else toast('Copied the whole layer (Cut needs a selection).', 'info');
  }
  return true;
}

/** Centre of the visible part of the document (where pastes land). */
function viewCenter(doc: Doc, w: number, h: number, viewW: number, viewH: number): [number, number] {
  const v = doc.view;
  let cx = (viewW / 2 - v.x) / v.scale;
  let cy = (viewH / 2 - v.y) / v.scale;
  cx = Math.max(0, Math.min(doc.width, cx));
  cy = Math.max(0, Math.min(doc.height, cy));
  return [Math.round(cx - w / 2), Math.round(cy - h / 2)];
}

export function pasteSurface(doc: Doc | null, surf: Surface, opts: { x?: number; y?: number; name?: string; viewW: number; viewH: number }) {
  if (!doc) {
    docFromImage(uniqueName(opts.name ?? 'Pasted'), surf.canvas);
    return;
  }
  const [x, y] = opts.x !== undefined && opts.y !== undefined ? [opts.x, opts.y] : viewCenter(doc, surf.width, surf.height, opts.viewW, opts.viewH);
  const l = rasterLayer(opts.name ?? nextLayerName(doc), surf, x, y);
  addLayer(doc, l, 'Paste');
}

/** Paste from the internal clipboard (true if it was used). Pass the system clipboard image to use ours only when it matches. */
export function pasteInternal(doc: Doc | null, inPlace: boolean, viewW: number, viewH: number, system?: ImageBitmap): boolean {
  if (!clipboard) return false;
  if (system && (system.width !== clipboard.surf.width || system.height !== clipboard.surf.height || !samePrint(clipboard.print, fingerprint(system, system.width, system.height)))) return false;
  const surf = clipboard.surf.clone();
  const fits = doc && clipboard.x + surf.width > 0 && clipboard.y + surf.height > 0 && clipboard.x < doc.width && clipboard.y < doc.height;
  pasteSurface(doc, surf, { x: inPlace && fits ? clipboard.x : undefined, y: inPlace && fits ? clipboard.y : undefined, viewW, viewH });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Layer transforms (flip / rotate)

function vectorBox(l: Layer): Rect | null {
  if (l.kind === 'text' && l.text) return textBox(l.text);
  if (l.kind === 'shape' && l.shape) return shapeBox(l.shape);
  return null;
}

/** Applies an affine transform (document space) to a whole layer. Raster layers are resampled. */
export function transformLayerBy(doc: Doc, l: Layer, m: Mat2D, quality: ImageSmoothingQuality | 'none' = 'high') {
  if (l.kind === 'text' || l.kind === 'shape') {
    l.xform = matMul(m, l.xform ?? IDENTITY);
    rasterizeVector(l);
  } else if (l.surf) {
    const { surf, x, y } = transformSurface(l.surf, l.x, l.y, m, quality);
    l.surf = surf;
    l.x = x;
    l.y = y;
  }
  if (l.mask && l.mask.linked) {
    const r = transformSurface(l.mask.surf, l.mask.x, l.mask.y, m, quality, l.mask.defaultColor);
    l.mask = { ...l.mask, surf: r.surf, x: r.x, y: r.y };
  }
  doc.touchLayer(l);
}

/** Resamples a surface placed at (x, y) through a document-space transform. */
export function transformSurface(src: Surface, x: number, y: number, m: Mat2D, quality: ImageSmoothingQuality | 'none' = 'high', fill?: number): { surf: Surface; x: number; y: number } {
  const full = matMul(m, matTranslate(x, y));
  const pts = [
    [0, 0],
    [src.width, 0],
    [0, src.height],
    [src.width, src.height],
  ].map(([px, py]) => [full[0] * px + full[2] * py + full[4], full[1] * px + full[3] * py + full[5]]);
  const x0 = Math.floor(Math.min(...pts.map((p) => p[0])) + 1e-6);
  const y0 = Math.floor(Math.min(...pts.map((p) => p[1])) + 1e-6);
  const x1 = Math.ceil(Math.max(...pts.map((p) => p[0])) - 1e-6);
  const y1 = Math.ceil(Math.max(...pts.map((p) => p[1])) - 1e-6);
  const w = Math.max(1, Math.min(16384, x1 - x0));
  const h = Math.max(1, Math.min(16384, y1 - y0));
  const out = new Surface(w, h);
  const ctx = out.ctx;
  if (fill !== undefined) {
    ctx.fillStyle = fill ? '#fff' : '#000';
    ctx.fillRect(0, 0, w, h);
  }
  const t = matMul(matTranslate(-x0, -y0), full);
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  if (quality === 'none') ctx.imageSmoothingEnabled = false;
  else ctx.imageSmoothingQuality = quality;
  ctx.drawImage(src.canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { surf: out, x: x0, y: y0 };
}

/** Rotation/flip matrices about a point. */
export function aboutPoint(cx: number, cy: number, m: Mat2D): Mat2D {
  return matMul(matTranslate(cx, cy), matMul(m, matTranslate(-cx, -cy)));
}

function layerCenter(l: Layer): [number, number] {
  const vb = vectorBox(l);
  if (vb) {
    const m = l.xform ?? IDENTITY;
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2;
    return [m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]];
  }
  const r = layerRect(l);
  return r ? [r.x + r.w / 2, r.y + r.h / 2] : [0, 0];
}

export async function flipOrRotateLayer(doc: Doc, op: 'flipH' | 'flipV' | 'rot90' | 'rot-90' | 'rot180') {
  const l = doc.activeLayer;
  if (!l) return;
  if (l.lockAll || l.lockPosition) {
    toast(`"${l.name}" is locked.`, 'warn');
    return;
  }
  if (l.kind === 'fill' || l.kind === 'adjustment') {
    toast('This layer has no pixels to transform.', 'warn');
    return;
  }
  let [cx, cy] = layerCenter(l);
  // Keep pixel alignment for 90° rotations of raster layers.
  if (l.kind === 'raster' && l.surf && (op === 'rot90' || op === 'rot-90')) {
    cx = l.x + l.surf.width / 2;
    cy = l.y + l.surf.height / 2;
    // Integer bounds need cx + cy and cx − cy to be integers: with w − h odd, shift cx or cy by ½
    // (chosen so that ⟳ then ⟲, or four turns, land back on the same pixels).
    if ((l.surf.width - l.surf.height) % 2 !== 0) {
      const k = Math.sign(l.surf.width - l.surf.height) / 2;
      if (op === 'rot90') cx += k;
      else cy -= k;
    }
  }
  const m: Mat2D =
    op === 'flipH' ? [-1, 0, 0, 1, 0, 0] : op === 'flipV' ? [1, 0, 0, -1, 0, 0] : op === 'rot90' ? [0, 1, -1, 0, 0, 0] : op === 'rot-90' ? [0, -1, 1, 0, 0, 0] : [-1, 0, 0, -1, 0, 0];
  transformLayerBy(doc, l, aboutPoint(cx, cy, m), 'none');
  commit(doc, { flipH: 'Flip Horizontal', flipV: 'Flip Vertical', rot90: 'Rotate 90° Clockwise', 'rot-90': 'Rotate 90° Counter Clockwise', rot180: 'Rotate 180°' }[op]);
}

// ---------------------------------------------------------------------------------------------
// Moving

/** Moves a whole layer (and its linked mask / vector props). */
export function offsetLayer(l: Layer, dx: number, dy: number) {
  l.x += dx;
  l.y += dy;
  if (l.mask?.linked) l.mask = { ...l.mask, x: l.mask.x + dx, y: l.mask.y + dy };
  if (l.kind === 'text' || l.kind === 'shape') {
    if (l.xform) l.xform = [l.xform[0], l.xform[1], l.xform[2], l.xform[3], l.xform[4] + dx, l.xform[5] + dy];
    else if (l.text) l.text = { ...l.text, x: l.text.x + dx, y: l.text.y + dy };
    else if (l.shape) l.shape = { ...l.shape, x: l.shape.x + dx, y: l.shape.y + dy };
  }
}

export function nudgeLayer(doc: Doc, dx: number, dy: number) {
  const l = doc.activeLayer;
  if (!l) return;
  if (l.lockAll || l.lockPosition) {
    toast(`"${l.name}" is locked.`, 'warn');
    return;
  }
  offsetLayer(l, dx, dy);
  doc.touchLayer(l);
  commit(doc, 'Nudge', { mergeKey: `nudge:${l.id}` });
}

/** Moves the selected pixels of the active raster layer by (dx, dy), together with the selection. */
export async function moveSelectedPixels(doc: Doc, dx: number, dy: number) {
  const sel = doc.selection;
  if (!sel) return nudgeLayer(doc, dx, dy);
  const l = doc.activeLayer;
  if (!l) return;
  if (!(await ensureRaster(doc, l))) return;
  if (l.lockAll || l.lockPixels || l.lockPosition) {
    toast(`"${l.name}" is locked.`, 'warn');
    return;
  }
  const surf = l.surf!;
  const src = rectIntersect(sel.bounds, { x: l.x, y: l.y, w: surf.width, h: surf.height });
  if (!src) return;
  const dst = { ...src, x: src.x + dx, y: src.y + dy };
  const all = rectIntersect(rectUnion(src, dst), { x: l.x, y: l.y, w: surf.width, h: surf.height })!;
  const lr = { x: all.x - l.x, y: all.y - l.y, w: all.w, h: all.h };
  const patch = capturePatch(surf, lr);
  const float = makeCanvas(src.w, src.h);
  const fc = ctx2d(float);
  fc.drawImage(surf.canvas, src.x - l.x, src.y - l.y, src.w, src.h, 0, 0, src.w, src.h);
  fc.globalCompositeOperation = 'destination-in';
  fc.drawImage(sel.canvas(), sel.bounds.x - src.x, sel.bounds.y - src.y);
  const ctx = surf.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sel.canvas(), sel.bounds.x - l.x, sel.bounds.y - l.y);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(float, dst.x - l.x, dst.y - l.y);
  ctx.restore();
  surf.touch(lr);
  doc.selection = sel.translate(dx, dy);
  doc.touchLayer(l, all);
  commit(doc, 'Move', { patches: [patch], mergeKey: `movesel:${l.id}` });
}

export function nudgeSelection(doc: Doc, dx: number, dy: number) {
  if (!doc.selection) return;
  doc.selection = doc.selection.translate(dx, dy);
  doc.invalidate();
  commit(doc, 'Nudge Selection', { mergeKey: 'nudgesel' });
}
