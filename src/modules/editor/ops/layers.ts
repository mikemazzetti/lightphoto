import { toast } from '@/state/app';
import { confirmDialog } from '@/ui/overlays';
import type { BlendMode } from '@/core/gl/glsl';
import { baseLayer, capturePatch, copyLayer, Doc, layerRect, PixelPatch, rasterLayer } from '../model/doc';
import { Rect, rectIntersect, rectUnion } from '../model/geom';
import { rasterizeVector } from '../model/rasterize';
import { nextSeq, Surface } from '../model/surface';
import type { AdjustParams, AdjustType, Layer, LayerStyle, RGBA } from '../model/types';
import { edState, touch } from '../model/store';
import { requireCompositor } from '../render/compositor';
import { ADJUST_NAMES, defaultAdjust } from '../render/adjustments';
import { ensureCoversDoc } from '../paint/stroke';

export function commit(doc: Doc, label: string, opts?: Parameters<Doc['commit']>[1]) {
  doc.commit(label, opts);
  touch();
}

export function nextLayerName(doc: Doc, base = 'Layer'): string {
  const names = new Set(doc.layers.map((l) => l.name));
  for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

function insertAbove(doc: Doc, l: Layer, refId?: string) {
  const i = doc.indexOf(refId ?? doc.activeLayerId);
  doc.layers.splice(i < 0 ? doc.layers.length : i + 1, 0, l);
  doc.activeLayerId = l.id;
  doc.editMask = false;
  doc.invalidate();
}

export function newLayer(doc: Doc, name?: string): Layer {
  const l = rasterLayer(name ?? nextLayerName(doc), new Surface(doc.width, doc.height));
  insertAbove(doc, l);
  commit(doc, 'New Layer');
  return l;
}

export function addLayer(doc: Doc, l: Layer, label: string, refId?: string) {
  insertAbove(doc, l, refId);
  commit(doc, label);
}

export function selectLayer(doc: Doc, id: string, mask = false) {
  const l = doc.layer(id);
  if (!l) return;
  doc.activeLayerId = id;
  doc.editMask = mask && !!l.mask;
  touch();
}

/** Applies a metadata patch to a layer (live); pass `label` to record history. */
export function setLayerProps(doc: Doc, id: string, patch: Partial<Layer>, label?: string, mergeKey?: string) {
  const l = doc.layer(id);
  if (!l) return;
  Object.assign(l, patch);
  if ((l.kind === 'text' || l.kind === 'shape') && ('text' in patch || 'shape' in patch || 'xform' in patch)) rasterizeVector(l);
  doc.touchLayer(l);
  if (label) commit(doc, label, { mergeKey });
  else touch();
}

export function renameLayer(doc: Doc, id: string, name: string) {
  const l = doc.layer(id);
  if (!l || !name.trim() || l.name === name) return;
  l.name = name.trim();
  commit(doc, 'Rename Layer');
}

export function duplicateLayer(doc: Doc, id = doc.activeLayerId): Layer | null {
  const src = doc.layer(id);
  if (!src) return null;
  const l = copyLayer(src);
  l.id = baseLayer('raster', '').id;
  l.name = `${src.name} copy`;
  l.v = nextSeq();
  if (src.surf) l.surf = src.surf.clone();
  if (src.mask) l.mask = { ...src.mask, surf: src.mask.surf.clone() };
  insertAbove(doc, l, src.id);
  commit(doc, 'Duplicate Layer');
  return l;
}

export function deleteLayer(doc: Doc, id = doc.activeLayerId) {
  const i = doc.indexOf(id);
  if (i < 0) return;
  if (doc.layers.length === 1) {
    toast('A document needs at least one layer.', 'warn');
    return;
  }
  doc.layers.splice(i, 1);
  // A clipped layer whose base vanished clips to the next base down automatically.
  doc.activeLayerId = doc.layers[Math.max(0, i - 1)].id;
  doc.editMask = false;
  doc.invalidate();
  commit(doc, 'Delete Layer');
}

export function moveLayer(doc: Doc, id: string, toIndex: number) {
  const i = doc.indexOf(id);
  if (i < 0) return;
  toIndex = Math.max(0, Math.min(doc.layers.length - 1, toIndex));
  if (toIndex === i) return;
  const [l] = doc.layers.splice(i, 1);
  doc.layers.splice(toIndex, 0, l);
  doc.invalidate();
  commit(doc, 'Layer Order');
}

export function arrangeLayer(doc: Doc, how: 'front' | 'forward' | 'backward' | 'back') {
  const i = doc.indexOf(doc.activeLayerId);
  if (i < 0) return;
  const to = how === 'front' ? doc.layers.length - 1 : how === 'back' ? 0 : how === 'forward' ? i + 1 : i - 1;
  moveLayer(doc, doc.activeLayerId, to);
}

export function newFillLayer(doc: Doc, color: RGBA): Layer {
  const l = baseLayer('fill', nextLayerName(doc, 'Color Fill'));
  l.fillColor = { ...color, a: 1 };
  maskFromSelection(doc, l);
  insertAbove(doc, l);
  commit(doc, 'New Fill Layer');
  return l;
}

export function newAdjustmentLayer(doc: Doc, type: AdjustType, params?: AdjustParams): Layer {
  const s = edState();
  const l = baseLayer('adjustment', nextLayerName(doc, ADJUST_NAMES[type]));
  l.adjust = params ?? defaultAdjust(type, s.fg, s.bg);
  maskFromSelection(doc, l);
  insertAbove(doc, l);
  commit(doc, `New ${ADJUST_NAMES[type]} Layer`);
  return l;
}

/** Photoshop gives new fill/adjustment layers a mask from the active selection. */
function maskFromSelection(doc: Doc, l: Layer) {
  const sel = doc.selection;
  const surf = Surface.filled(doc.width, doc.height, sel ? '#000' : '#fff');
  if (sel) {
    const img = surf.ctx.getImageData(sel.bounds.x, sel.bounds.y, sel.bounds.w, sel.bounds.h);
    for (let i = 0; i < sel.data.length; i++) img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = sel.data[i];
    surf.ctx.putImageData(img, sel.bounds.x, sel.bounds.y);
  }
  l.mask = { surf, x: 0, y: 0, defaultColor: sel ? 0 : 255, enabled: true, linked: true, density: 1, feather: 0 };
}

export function newTextOrShapeLayer(doc: Doc, l: Layer, label: string) {
  rasterizeVector(l);
  insertAbove(doc, l);
  commit(doc, label);
}

// ---------------------------------------------------------------------------------------------
// Rasterize / merge

export function canRasterize(l: Layer) {
  return l.kind === 'text' || l.kind === 'shape' || l.kind === 'fill';
}

export function rasterizeLayer(doc: Doc, id = doc.activeLayerId, record = true): boolean {
  const l = doc.layer(id);
  if (!l || !canRasterize(l)) return false;
  if (l.kind === 'fill') {
    const c = l.fillColor ?? { r: 0, g: 0, b: 0, a: 1 };
    l.surf = Surface.filled(doc.width, doc.height, `rgb(${c.r},${c.g},${c.b})`);
    l.x = 0;
    l.y = 0;
    l.fillColor = undefined;
  } else if (l.surf) l.surf = l.surf.clone();
  l.kind = 'raster';
  l.text = undefined;
  l.shape = undefined;
  l.xform = null;
  doc.touchLayer(l);
  if (record) commit(doc, 'Rasterize Layer');
  return true;
}

/** Asks to rasterize a text/shape/fill layer before a pixel operation. Resolves true when the layer is (now) raster. */
export async function ensureRaster(doc: Doc, l: Layer): Promise<boolean> {
  if (l.kind === 'raster') return true;
  if (l.kind === 'adjustment') {
    toast('This operation needs a pixel layer — select a normal layer or the layer mask.', 'warn');
    return false;
  }
  const what = l.kind === 'text' ? 'type' : l.kind === 'shape' ? 'shape' : 'fill';
  const ok = await confirmDialog(`This ${what} layer must be rasterized before proceeding. Its ${what === 'type' ? 'text' : 'properties'} will no longer be editable.`, {
    title: 'Rasterize Layer',
    ok: 'Rasterize',
  });
  if (!ok) return false;
  return rasterizeLayer(doc, l.id);
}

/** Reads a render target region into a new Surface. */
export function targetToSurface(rt: { read: (x?: number, y?: number, w?: number, h?: number) => Uint8Array | Float32Array; width: number; height: number }): Surface {
  const px = rt.read() as Uint8Array;
  const img = new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), rt.width, rt.height);
  return Surface.fromImageData(img);
}

function layersArea(doc: Doc, layers: Layer[]): Rect {
  const docRect = { x: 0, y: 0, w: doc.width, h: doc.height };
  let r: Rect | null = null;
  for (const l of layers) {
    const lr = layerRect(l);
    r = rectUnion(r, lr ?? docRect);
    if (l.kind === 'adjustment' || l.kind === 'fill') r = rectUnion(r, docRect);
  }
  // Keep merges within a sane size around the document.
  const lim = { x: -doc.width, y: -doc.height, w: doc.width * 3, h: doc.height * 3 };
  return rectIntersect(r ?? docRect, lim) ?? docRect;
}

export function mergeDown(doc: Doc) {
  const i = doc.indexOf(doc.activeLayerId);
  if (i <= 0) return;
  const upper = doc.layers[i];
  const lower = doc.layers[i - 1];
  if (!lower.visible || !upper.visible) {
    toast('Both layers must be visible to merge.', 'warn');
    return;
  }
  if (lower.kind === 'adjustment') {
    toast('Cannot merge onto an adjustment layer.', 'warn');
    return;
  }
  const c = requireCompositor();
  const base = copyLayer(lower);
  base.opacity = 1;
  base.blendMode = 'normal';
  base.clip = false;
  const area = layersArea(doc, [lower, upper]);
  const rt = c.renderLayers(doc, [base, upper], area);
  const surf = targetToSurface(rt);
  c.pool.release(rt);
  const merged = rasterLayer(lower.name, surf, area.x, area.y);
  merged.opacity = lower.opacity;
  merged.blendMode = lower.blendMode;
  merged.clip = lower.clip;
  merged.visible = true;
  doc.layers.splice(i - 1, 2, merged);
  doc.activeLayerId = merged.id;
  doc.editMask = false;
  doc.invalidate();
  commit(doc, 'Merge Down');
}

export function mergeVisible(doc: Doc) {
  const vis = doc.layers.filter((l) => l.visible);
  if (vis.length < 2) return;
  const c = requireCompositor();
  const area = { x: 0, y: 0, w: doc.width, h: doc.height };
  const rt = c.renderLayers(doc, vis, area);
  const surf = targetToSurface(rt);
  c.pool.release(rt);
  const bottom = vis[0];
  const merged = rasterLayer(bottom.name, surf, 0, 0);
  const at = doc.layers.indexOf(bottom);
  doc.layers = doc.layers.filter((l) => !l.visible || l === bottom);
  doc.layers.splice(doc.layers.indexOf(bottom), 1, merged);
  void at;
  doc.activeLayerId = merged.id;
  doc.editMask = false;
  doc.invalidate();
  commit(doc, 'Merge Visible');
}

export async function flattenImage(doc: Doc) {
  const hidden = doc.layers.filter((l) => !l.visible).length;
  if (hidden && !(await confirmDialog('Discard hidden layers?', { title: 'Flatten Image', ok: 'Discard' }))) return;
  const c = requireCompositor();
  const area = { x: 0, y: 0, w: doc.width, h: doc.height };
  const rt = c.renderLayers(
    doc,
    doc.layers.filter((l) => l.visible),
    area,
    [1, 1, 1, 1],
  );
  const surf = targetToSurface(rt);
  c.pool.release(rt);
  const l = rasterLayer('Background', surf);
  doc.layers = [l];
  doc.activeLayerId = l.id;
  doc.editMask = false;
  doc.invalidate();
  commit(doc, 'Flatten Image');
}

/** Renders all visible layers (the flattened image) into a new canvas. */
export function flattenToCanvas(doc: Doc, background?: [number, number, number, number]): OffscreenCanvas {
  const c = requireCompositor();
  const rt = c.renderLayers(
    doc,
    doc.layers.filter((l) => l.visible),
    { x: 0, y: 0, w: doc.width, h: doc.height },
    background,
  );
  const surf = targetToSurface(rt);
  c.pool.release(rt);
  return surf.canvas;
}

// ---------------------------------------------------------------------------------------------
// Masks

export type MaskMode = 'reveal' | 'hide' | 'selection' | 'hideSelection';

export function addMask(doc: Doc, mode: MaskMode, id = doc.activeLayerId) {
  const l = doc.layer(id);
  if (!l) return;
  if (l.mask) {
    toast('The layer already has a mask.', 'warn');
    return;
  }
  const sel = doc.selection;
  if ((mode === 'selection' || mode === 'hideSelection') && !sel) mode = mode === 'selection' ? 'reveal' : 'hide';
  const fillWhite = mode === 'reveal' || mode === 'hideSelection';
  const surf = Surface.filled(doc.width, doc.height, fillWhite ? '#fff' : '#000');
  if (sel && (mode === 'selection' || mode === 'hideSelection')) {
    const img = surf.ctx.getImageData(sel.bounds.x, sel.bounds.y, sel.bounds.w, sel.bounds.h);
    for (let i = 0; i < sel.data.length; i++) {
      const v = mode === 'selection' ? sel.data[i] : 255 - sel.data[i];
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    }
    surf.ctx.putImageData(img, sel.bounds.x, sel.bounds.y);
  }
  l.mask = { surf, x: 0, y: 0, defaultColor: fillWhite ? 255 : 0, enabled: true, linked: true, density: 1, feather: 0 };
  doc.editMask = true;
  doc.touchLayer(l);
  commit(doc, 'Add Layer Mask');
}

export function deleteMask(doc: Doc, id = doc.activeLayerId) {
  const l = doc.layer(id);
  if (!l?.mask) return;
  l.mask = null;
  doc.editMask = false;
  doc.touchLayer(l);
  commit(doc, 'Delete Layer Mask');
}

export function toggleMaskEnabled(doc: Doc, id = doc.activeLayerId) {
  const l = doc.layer(id);
  if (!l?.mask) return;
  l.mask = { ...l.mask, enabled: !l.mask.enabled };
  doc.touchLayer(l);
  commit(doc, l.mask.enabled ? 'Enable Layer Mask' : 'Disable Layer Mask');
}

export function toggleMaskLink(doc: Doc, id = doc.activeLayerId) {
  const l = doc.layer(id);
  if (!l?.mask) return;
  l.mask = { ...l.mask, linked: !l.mask.linked };
  commit(doc, l.mask.linked ? 'Link Layer Mask' : 'Unlink Layer Mask');
}

/** Bakes the mask into the layer's alpha. */
export async function applyMask(doc: Doc, id = doc.activeLayerId) {
  const l = doc.layer(id);
  if (!l?.mask) return;
  if (l.kind !== 'raster') {
    if (!(await ensureRaster(doc, l))) return;
  }
  const m = l.mask!;
  const surf = l.surf!.clone();
  const img = surf.ctx.getImageData(0, 0, surf.width, surf.height);
  const mimg = m.surf.ctx.getImageData(0, 0, m.surf.width, m.surf.height);
  const dens = m.density;
  for (let y = 0; y < surf.height; y++) {
    const my = y + l.y - m.y;
    for (let x = 0; x < surf.width; x++) {
      const mx = x + l.x - m.x;
      const mv = mx >= 0 && my >= 0 && mx < m.surf.width && my < m.surf.height ? mimg.data[(my * m.surf.width + mx) * 4] : m.defaultColor;
      const k = 1 - dens * (1 - mv / 255);
      const i = (y * surf.width + x) * 4 + 3;
      img.data[i] = img.data[i] * k;
    }
  }
  surf.ctx.putImageData(img, 0, 0);
  l.surf = surf;
  l.mask = null;
  doc.editMask = false;
  doc.touchLayer(l);
  commit(doc, 'Apply Layer Mask');
}

export function toggleClip(doc: Doc, id = doc.activeLayerId) {
  const i = doc.indexOf(id);
  if (i <= 0) {
    toast('Clipping masks need a layer below.', 'warn');
    return;
  }
  const l = doc.layers[i];
  l.clip = !l.clip;
  doc.touchLayer(l);
  commit(doc, l.clip ? 'Create Clipping Mask' : 'Release Clipping Mask');
}

export function setLayerStyle(doc: Doc, id: string, style: LayerStyle | null, label = 'Layer Style') {
  const l = doc.layer(id);
  if (!l) return;
  l.style = style;
  doc.touchLayer(l);
  commit(doc, label);
}

export function setBlendMode(doc: Doc, id: string, mode: BlendMode) {
  setLayerProps(doc, id, { blendMode: mode }, 'Blending Change');
}

// ---------------------------------------------------------------------------------------------
// Layer via copy / cut

export async function layerViaCopy(doc: Doc, cut = false) {
  const l = doc.activeLayer;
  if (!l) return;
  const sel = doc.selection;
  if (!sel) {
    if (!cut) duplicateLayer(doc);
    else toast('Layer via Cut needs a selection.', 'warn');
    return;
  }
  if (!(await ensureRaster(doc, l))) return;
  const src = l.surf!;
  const r = rectIntersect(sel.bounds, { x: l.x, y: l.y, w: src.width, h: src.height });
  if (!r) {
    toast('The selected area is empty.', 'warn');
    return;
  }
  const surf = new Surface(r.w, r.h);
  surf.ctx.drawImage(src.canvas, r.x - l.x, r.y - l.y, r.w, r.h, 0, 0, r.w, r.h);
  surf.ctx.globalCompositeOperation = 'destination-in';
  surf.ctx.drawImage(sel.canvas(), sel.bounds.x - r.x, sel.bounds.y - r.y);
  surf.ctx.globalCompositeOperation = 'source-over';
  let patch: PixelPatch | null = null;
  if (cut && !l.lockPixels && !l.lockAll) {
    const lr = { x: r.x - l.x, y: r.y - l.y, w: r.w, h: r.h };
    patch = capturePatch(src, lr);
    src.ctx.save();
    src.ctx.globalCompositeOperation = 'destination-out';
    src.ctx.drawImage(sel.canvas(), sel.bounds.x - l.x, sel.bounds.y - l.y);
    src.ctx.restore();
    src.touch(lr);
    doc.touchLayer(l, r);
  }
  const nl = rasterLayer(nextLayerName(doc), surf, r.x, r.y);
  insertAbove(doc, nl, l.id);
  commit(doc, cut ? 'Layer via Cut' : 'Layer via Copy', { patches: [patch] });
}

// ---------------------------------------------------------------------------------------------
// Pixel target helpers

export interface PixelTarget {
  layer: Layer;
  surf: Surface;
  ox: number;
  oy: number;
  mask: boolean;
}

/** Resolves the active layer's editable pixels (or its mask); prompts to rasterize; checks locks. */
export async function pixelTarget(doc: Doc, opts: { cover?: boolean } = {}): Promise<(PixelTarget & { grown: boolean }) | null> {
  const l = doc.activeLayer;
  if (!l) return null;
  if (!l.visible) {
    toast('The active layer is hidden.', 'warn');
    return null;
  }
  if (doc.editMask && l.mask) {
    const grown = opts.cover ? ensureCoversDoc(doc, l, 'mask') : false;
    return { layer: l, surf: l.mask.surf, ox: l.mask.x, oy: l.mask.y, mask: true, grown };
  }
  if (l.lockAll || l.lockPixels) {
    toast(`"${l.name}" is locked.`, 'warn');
    return null;
  }
  if (!(await ensureRaster(doc, l))) return null;
  const grown = opts.cover ? ensureCoversDoc(doc, l, 'pixels') : false;
  return { layer: l, surf: l.surf!, ox: l.x, oy: l.y, mask: false, grown };
}

/** Synchronous variant for pointer handlers: null (with a toast) when not directly paintable. */
export function pixelTargetSync(doc: Doc): PixelTarget | null {
  const l = doc.activeLayer;
  if (!l) return null;
  if (doc.editMask && l.mask) return { layer: l, surf: l.mask.surf, ox: l.mask.x, oy: l.mask.y, mask: true };
  if (!l.visible) {
    toast('The active layer is hidden.', 'warn');
    return null;
  }
  if (l.lockAll || l.lockPixels) {
    toast(`"${l.name}" is locked.`, 'warn');
    return null;
  }
  if (l.kind !== 'raster') {
    void ensureRaster(doc, l);
    return null;
  }
  return { layer: l, surf: l.surf!, ox: l.x, oy: l.y, mask: false };
}
