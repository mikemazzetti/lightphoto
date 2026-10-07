import { toast } from '@/state/app';
import type { Doc } from '../model/doc';
import { rectIntersect } from '../model/geom';
import { Selection, SelectionMode } from '../model/selection';
import { requireCompositor } from '../render/compositor';
import { colorRangeMask, floodMask, antialiasMask } from '../paint/fill';
import { commit } from './layers';

export function setSelection(doc: Doc, sel: Selection | null, label: string) {
  if (sel === doc.selection) return;
  if (doc.selection) doc.lastSelection = doc.selection;
  doc.selection = sel;
  doc.invalidate();
  commit(doc, label);
}

export function applySelection(doc: Doc, shape: Selection | null, mode: SelectionMode, label?: string) {
  const next = Selection.combine(doc.selection, shape, mode);
  setSelection(doc, next, label ?? (mode === 'new' ? 'Rectangular Marquee' : mode === 'add' ? 'Add to Selection' : mode === 'subtract' ? 'Subtract from Selection' : 'Intersect Selection'));
}

export function selectAll(doc: Doc) {
  setSelection(doc, Selection.all(doc.width, doc.height), 'Select All');
}

export function deselect(doc: Doc) {
  if (!doc.selection) return;
  setSelection(doc, null, 'Deselect');
}

export function reselect(doc: Doc) {
  if (!doc.lastSelection) return;
  const s = doc.lastSelection;
  if (s.docW !== doc.width || s.docH !== doc.height) return;
  setSelection(doc, s, 'Reselect');
}

export function inverseSelection(doc: Doc) {
  const inv = doc.selection ? doc.selection.invert() : Selection.all(doc.width, doc.height);
  setSelection(doc, inv, 'Select Inverse');
}

export type ModifyKind = 'expand' | 'contract' | 'feather' | 'border' | 'smooth';

export function modifySelection(doc: Doc, kind: ModifyKind, amount: number) {
  const s = doc.selection;
  if (!s) return;
  let r: Selection | null = s;
  if (kind === 'expand') r = s.expand(amount);
  else if (kind === 'contract') r = s.contract(amount);
  else if (kind === 'feather') r = s.feather(amount);
  else if (kind === 'border') r = s.border(amount);
  else r = s.smooth(amount);
  if (!r) toast('No pixels are more than 50% selected. The selection edges will not be visible.', 'warn');
  setSelection(doc, r, { expand: 'Expand', contract: 'Contract', feather: 'Feather', border: 'Border', smooth: 'Smooth' }[kind]);
}

/** Selection from a layer's (or its mask's) transparency. */
export function selectionFromLayer(doc: Doc, id = doc.activeLayerId, mode: SelectionMode = 'new', fromMask = false) {
  const l = doc.layer(id);
  if (!l) return;
  const src = fromMask ? l.mask : l.surf ? { surf: l.surf, x: l.x, y: l.y } : null;
  if (!src) {
    applySelection(doc, Selection.all(doc.width, doc.height), mode, 'Load Selection');
    return;
  }
  const r = rectIntersect({ x: src.x, y: src.y, w: src.surf.width, h: src.surf.height }, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (!r) {
    applySelection(doc, null, mode, 'Load Selection');
    return;
  }
  const img = src.surf.ctx.getImageData(r.x - src.x, r.y - src.y, r.w, r.h).data;
  const d = new Uint8Array(r.w * r.h);
  for (let i = 0; i < d.length; i++) d[i] = fromMask ? img[i * 4] : img[i * 4 + 3];
  applySelection(doc, Selection.fromRegion(doc.width, doc.height, r, d), mode, 'Load Selection');
}

/** RGBA pixels of the document composite or of the active layer (its mask while editing it), in document space. */
export function samplePixels(doc: Doc, all: boolean): Uint8ClampedArray | Uint8Array {
  if (all) {
    const c = requireCompositor();
    c.render(doc);
    return c.readComposite() ?? new Uint8Array(doc.width * doc.height * 4);
  }
  const l = doc.activeLayer;
  const out = new Uint8ClampedArray(doc.width * doc.height * 4);
  const mask = doc.editMask ? l?.mask : null;
  if (mask) {
    // Outside its canvas the mask is its default colour (opaque gray, like the mask pixels).
    const v = mask.defaultColor;
    for (let i = 0; i < out.length; i += 4) {
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  const src = mask ? { surf: mask.surf, x: mask.x, y: mask.y } : l?.surf ? { surf: l.surf, x: l.x, y: l.y } : null;
  if (!src) return out;
  const r = rectIntersect({ x: src.x, y: src.y, w: src.surf.width, h: src.surf.height }, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (!r) return out;
  const img = src.surf.ctx.getImageData(r.x - src.x, r.y - src.y, r.w, r.h).data;
  for (let y = 0; y < r.h; y++) out.set(img.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * doc.width + r.x) * 4);
  return out;
}

export function magicWand(doc: Doc, x: number, y: number, opts: { tolerance: number; contiguous: boolean; sampleAll: boolean; antialias: boolean; mode: SelectionMode }) {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const px = samplePixels(doc, opts.sampleAll);
  let m = floodMask(px, doc.width, doc.height, x, y, opts.tolerance, opts.contiguous);
  if (opts.antialias) m = antialiasMask(m, doc.width, doc.height);
  applySelection(doc, Selection.fromFull(doc.width, doc.height, m), opts.mode, 'Magic Wand');
}

export function colorRangeSelection(px: Uint8ClampedArray | Uint8Array, w: number, h: number, samples: [number, number, number][], fuzziness: number, invert: boolean): Selection | null {
  return Selection.fromFull(w, h, colorRangeMask(px, w, h, samples, fuzziness, invert));
}
