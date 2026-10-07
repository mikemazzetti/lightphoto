import type { BlendMode } from '@/core/gl/glsl';
import { capturePatch, Doc, PixelPatch } from '../model/doc';
import { Rect, rectInflate, rectIntersect, rectRoundOut, rectTranslate, rectUnion } from '../model/geom';
import { makeCanvas, ctx2d, Surface } from '../model/surface';
import type { Layer, RGBA } from '../model/types';
import { getDab } from './dab';
import { findSpotSource, healRegion } from './heal';
import { RetouchParams, retouchDab, SmudgeState } from './retouch';

export type StrokeKind = 'paint' | 'erase' | 'clone' | 'heal' | 'spotHeal' | 'retouch';

export interface StrokeOptions {
  kind: StrokeKind;
  label: string;
  size: number;
  hardness: number; // 0..1
  flow: number; // 0..1
  opacity: number; // 0..1
  spacing: number; // fraction of diameter
  smoothing: number; // 0..1
  pressureSize: boolean;
  pressureOpacity: boolean;
  color: RGBA;
  blend: BlendMode;
  pencil: boolean;
  /** Canvas pixels per image pixel (smoothing is defined in screen space). */
  viewScale: number;
  /** Clone / healing source: pixels in document space and the dst→src offset. */
  source?: { canvas: OffscreenCanvas; x: number; y: number; offset: [number, number] };
  retouch?: RetouchParams;
}

/** Map of Photoshop blend modes to Canvas2D composite operations (for committing strokes). */
export const CANVAS_BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

/** Grows a layer's surface (or mask) so it covers the whole document. Returns true if it changed. */
export function ensureCoversDoc(doc: Doc, l: Layer, target: 'pixels' | 'mask'): boolean {
  const docRect = { x: 0, y: 0, w: doc.width, h: doc.height };
  if (target === 'mask') {
    const m = l.mask;
    if (!m) return false;
    const cur = { x: m.x, y: m.y, w: m.surf.width, h: m.surf.height };
    const need = rectUnion(cur, docRect)!;
    if (need.w === cur.w && need.h === cur.h) return false;
    const s = new Surface(need.w, need.h);
    s.ctx.fillStyle = m.defaultColor ? '#fff' : '#000';
    s.ctx.fillRect(0, 0, need.w, need.h);
    s.ctx.drawImage(m.surf.canvas, cur.x - need.x, cur.y - need.y);
    l.mask = { ...m, surf: s, x: need.x, y: need.y };
    return true;
  }
  if (!l.surf) return false;
  const cur = { x: l.x, y: l.y, w: l.surf.width, h: l.surf.height };
  const need = rectUnion(cur, docRect)!;
  if (need.w === cur.w && need.h === cur.h) return false;
  const s = new Surface(need.w, need.h);
  s.ctx.drawImage(l.surf.canvas, cur.x - need.x, cur.y - need.y);
  l.surf = s;
  l.x = need.x;
  l.y = need.y;
  return true;
}

/** Like ensureCoversDoc, but returns a function that undoes the growth (null when nothing changed). */
export function growToDoc(doc: Doc, l: Layer, target: 'pixels' | 'mask'): (() => void) | null {
  const { surf, x, y, mask } = l;
  if (!ensureCoversDoc(doc, l, target)) return null;
  return () => {
    if (target === 'mask') l.mask = mask;
    else {
      l.surf = surf;
      l.x = x;
      l.y = y;
    }
  };
}

/**
 * Puts back the alpha held by `patch` (captured before drawing). Canvas2D can't apply a blend
 * mode and keep the destination alpha (Lock Transparency) in one draw.
 */
export function restoreAlpha(patch: PixelPatch) {
  const { surf, x, y, data } = patch;
  const img = surf.ctx.getImageData(x, y, data.width, data.height);
  const d = img.data;
  const a = data.data;
  for (let i = 3; i < d.length; i += 4) d[i] = a[i];
  surf.ctx.putImageData(img, x, y);
}

export const grayOf = (c: RGBA) => Math.round(0.299 * c.r + 0.587 * c.g + 0.114 * c.b);

/** Last stroke end per document (shift-click draws a straight line from here). */
export const lastStrokePoint = new Map<string, [number, number]>();

/**
 * One brush stroke. Paint-like kinds stamp into the document's stroke buffer, which the
 * compositor shows live on top of the layer at the stroke opacity (Photoshop's flow vs opacity);
 * the buffer is merged into the layer on finish. Retouch kinds modify the layer in place.
 */
export class StrokeSession {
  private surf: Surface;
  private ox: number;
  private oy: number;
  private grown: boolean;
  /** Undoes the surface growth (cancel). */
  private ungrow: (() => void) | null;
  private dirty: Rect | null = null;
  private frameDirty: Rect | null = null;
  private started = false;
  private sx = 0;
  private sy = 0;
  private sp = 1;
  private rawX = 0;
  private rawY = 0;
  private rawP = 1;
  private rem = 0;
  private dabColor: RGBA;
  private tmp: OffscreenCanvas | null = null;
  private backup: OffscreenCanvas | null = null;
  private smudge: SmudgeState = { buf: null, size: 0 };
  private pendingRetouch: [number, number, number][] = [];
  private finished = false;

  constructor(
    readonly doc: Doc,
    readonly layer: Layer,
    readonly target: 'pixels' | 'mask',
    readonly o: StrokeOptions,
  ) {
    this.ungrow = growToDoc(doc, layer, target);
    this.grown = !!this.ungrow;
    if (target === 'mask') {
      this.surf = layer.mask!.surf;
      this.ox = layer.mask!.x;
      this.oy = layer.mask!.y;
    } else {
      this.surf = layer.surf!;
      this.ox = layer.x;
      this.oy = layer.y;
    }
    // Colour stamped into the buffer.
    let c = o.color;
    if (target === 'mask') {
      const g = grayOf(c);
      c = { r: g, g, b: g, a: 1 };
    }
    if (o.kind === 'spotHeal') c = { r: 20, g: 20, b: 20, a: 1 };
    this.dabColor = c;
    if (o.kind === 'retouch') {
      this.backup = makeCanvas(this.surf.width, this.surf.height);
      ctx2d(this.backup).drawImage(this.surf.canvas, 0, 0);
    } else {
      const eraseMask = o.kind === 'erase' && target === 'mask';
      doc.stroke = {
        surf: doc.strokeSurf,
        layerId: layer.id,
        target,
        mode: o.kind === 'erase' && !eraseMask && !layer.lockTransparency ? 'erase' : 'paint',
        opacity: o.kind === 'spotHeal' ? 0.45 : o.opacity,
        blend: o.kind === 'paint' ? o.blend : 'normal',
        lockAlpha: target === 'pixels' && layer.lockTransparency,
        clipToSelection: !!doc.selection,
      };
    }
  }

  private diameter(p: number) {
    return Math.max(this.o.pencil ? 1 : 0.5, this.o.size * (this.o.pressureSize ? Math.max(0.05, p) : 1));
  }

  private stamp(x: number, y: number, p: number) {
    const d = this.diameter(p);
    const flow = this.o.flow * (this.o.pressureOpacity ? p : 1);
    if (this.o.kind === 'retouch') {
      this.pendingRetouch.push([x, y, d / 2]);
      const r = rectRoundOut({ x: x - d / 2 - 2, y: y - d / 2 - 2, w: d + 4, h: d + 4 });
      this.dirty = rectUnion(this.dirty, r);
      return;
    }
    const ctx = this.doc.strokeSurf.ctx;
    let r: Rect;
    if (this.o.kind === 'clone' || this.o.kind === 'heal') {
      const src = this.o.source;
      if (!src) return;
      const D = Math.max(1, Math.ceil(d) + 2);
      const ix = Math.round(x - D / 2);
      const iy = Math.round(y - D / 2);
      if (!this.tmp || this.tmp.width < D) this.tmp = makeCanvas(D, D);
      const t = ctx2d(this.tmp);
      t.save();
      t.globalCompositeOperation = 'copy';
      t.drawImage(src.canvas, ix + src.offset[0] - src.x, iy + src.offset[1] - src.y, D, D, 0, 0, D, D);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(getDab(this.o.size, this.o.hardness, { r: 0, g: 0, b: 0 }), 0, 0, D, D);
      t.restore();
      ctx.globalAlpha = flow;
      ctx.drawImage(this.tmp, 0, 0, D, D, ix, iy, D, D);
      ctx.globalAlpha = 1;
      r = { x: ix, y: iy, w: D, h: D };
    } else {
      const dab = getDab(this.o.pencil ? d : this.o.size, this.o.hardness, this.dabColor, this.o.pencil);
      ctx.globalAlpha = flow;
      if (this.o.pencil) {
        const D = dab.width;
        const ix = Math.round(x - D / 2);
        const iy = Math.round(y - D / 2);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(dab, ix, iy);
        ctx.imageSmoothingEnabled = true;
        r = { x: ix, y: iy, w: D, h: D };
      } else {
        const k = d / this.o.size;
        const D = dab.width * k;
        ctx.drawImage(dab, x - D / 2, y - D / 2, D, D);
        r = rectRoundOut({ x: x - D / 2 - 1, y: y - D / 2 - 1, w: D + 2, h: D + 2 });
      }
      ctx.globalAlpha = 1;
    }
    this.dirty = rectUnion(this.dirty, r);
    this.frameDirty = rectUnion(this.frameDirty, r);
  }

  private segment(x0: number, y0: number, p0: number, x1: number, y1: number, p1: number) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len <= 0) return;
    let travelled = 0;
    while (this.rem <= len - travelled) {
      travelled += this.rem;
      const t = travelled / len;
      const p = p0 + (p1 - p0) * t;
      this.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p);
      this.rem = Math.max(0.5, this.diameter(p) * this.o.spacing);
    }
    this.rem -= len - travelled;
  }

  /** Feeds raw input samples (image coordinates). */
  addPoints(pts: { x: number; y: number; p: number }[]) {
    if (this.finished) return;
    const R = (this.o.smoothing * 36) / Math.max(1e-3, this.o.viewScale);
    for (const q of pts) {
      this.rawX = q.x;
      this.rawY = q.y;
      this.rawP = q.p;
      if (!this.started) {
        this.started = true;
        this.sx = q.x;
        this.sy = q.y;
        this.sp = q.p;
        this.stamp(q.x, q.y, q.p);
        this.rem = Math.max(0.5, this.diameter(q.p) * this.o.spacing);
        continue;
      }
      let nx = q.x;
      let ny = q.y;
      if (R > 0.5) {
        const d = Math.hypot(q.x - this.sx, q.y - this.sy);
        if (d <= R) continue;
        nx = this.sx + ((q.x - this.sx) * (d - R)) / d;
        ny = this.sy + ((q.y - this.sy) * (d - R)) / d;
      }
      this.segment(this.sx, this.sy, this.sp, nx, ny, q.p);
      this.sx = nx;
      this.sy = ny;
      this.sp = q.p;
    }
    this.flush();
  }

  /** Straight line from (x0,y0) to the first point (shift-click). */
  lineFrom(x0: number, y0: number, x1: number, y1: number, p: number) {
    this.started = true;
    this.sx = x0;
    this.sy = y0;
    this.sp = p;
    this.stamp(x0, y0, p);
    this.rem = Math.max(0.5, this.diameter(p) * this.o.spacing);
    this.segment(x0, y0, p, x1, y1, p);
    this.sx = x1;
    this.sy = y1;
    this.rawX = x1;
    this.rawY = y1;
    this.flush();
  }

  private flush() {
    if (this.o.kind === 'retouch') {
      this.flushRetouch();
      return;
    }
    if (this.frameDirty) {
      this.doc.strokeSurf.touch(this.frameDirty);
      this.doc.invalidate(this.frameDirty);
      this.frameDirty = null;
    }
  }

  private flushRetouch() {
    if (!this.pendingRetouch.length || !this.o.retouch) return;
    const surfRect = { x: 0, y: 0, w: this.surf.width, h: this.surf.height };
    let box: Rect | null = null;
    for (const [x, y, r] of this.pendingRetouch) box = rectUnion(box, rectRoundOut({ x: x - this.ox - r - 2, y: y - this.oy - r - 2, w: r * 2 + 4, h: r * 2 + 4 }));
    const reg = rectIntersect(box, surfRect);
    const dabs = this.pendingRetouch;
    this.pendingRetouch = [];
    if (!reg) return;
    const img = this.surf.ctx.getImageData(reg.x, reg.y, reg.w, reg.h);
    const sel = this.doc.selection;
    const selFn = sel ? (x: number, y: number) => sel.valueAt(x + reg.x + this.ox, y + reg.y + this.oy) / 255 : null;
    for (const [x, y, r] of dabs) retouchDab(img, x - this.ox - reg.x, y - this.oy - reg.y, r, this.o.retouch, selFn, this.smudge);
    this.surf.ctx.putImageData(img, reg.x, reg.y);
    this.surf.touch(reg);
    this.doc.touchLayer(this.layer, rectTranslate(reg, this.ox, this.oy));
  }

  /** Commits the stroke into the layer and records history. */
  finish(): boolean {
    if (this.finished) return false;
    // catch-up (smoothing lag)
    if (this.started && (this.sx !== this.rawX || this.sy !== this.rawY)) this.segment(this.sx, this.sy, this.sp, this.rawX, this.rawY, this.rawP);
    this.flush();
    this.finished = true;
    lastStrokePoint.set(this.doc.id, [this.rawX, this.rawY]);
    const doc = this.doc;
    const surfDoc = { x: this.ox, y: this.oy, w: this.surf.width, h: this.surf.height };
    // Retouch dabs write anywhere on the (possibly larger) surface; stroke buffers are document-sized.
    const r = this.o.kind === 'retouch' ? rectIntersect(this.dirty, surfDoc) : rectIntersect(this.dirty, rectIntersect(surfDoc, { x: 0, y: 0, w: doc.width, h: doc.height }));
    if (this.o.kind === 'retouch') {
      const patches: PixelPatch[] = [];
      if (r && this.backup) {
        const lr = rectTranslate(r, -this.ox, -this.oy);
        patches.push({ surf: this.surf, x: lr.x, y: lr.y, data: ctx2d(this.backup).getImageData(lr.x, lr.y, lr.w, lr.h) });
      }
      this.backup = null;
      if (patches.length) doc.commit(this.o.label, { patches, structural: this.grown });
      else this.revertGrowth();
      return true;
    }
    const strokeSurf = doc.strokeSurf;
    let patch: PixelPatch | null = null;
    if (r) {
      const lr = rectTranslate(r, -this.ox, -this.oy);
      if (this.o.kind === 'heal' || this.o.kind === 'spotHeal') patch = this.commitHeal(r);
      else {
        patch = capturePatch(this.surf, lr);
        const sctx = strokeSurf.ctx;
        if (doc.selection) {
          // Clip the stroke to the selection.
          const sel = doc.selection;
          sctx.save();
          sctx.beginPath();
          sctx.rect(r.x, r.y, r.w, r.h);
          sctx.clip();
          sctx.globalCompositeOperation = 'destination-in';
          sctx.drawImage(sel.canvas(), sel.bounds.x, sel.bounds.y);
          sctx.restore();
          // everything outside the selection bounds
          const outside = [
            { x: r.x, y: r.y, w: r.w, h: Math.max(0, sel.bounds.y - r.y) },
            { x: r.x, y: sel.bounds.y + sel.bounds.h, w: r.w, h: Math.max(0, r.y + r.h - sel.bounds.y - sel.bounds.h) },
            { x: r.x, y: r.y, w: Math.max(0, sel.bounds.x - r.x), h: r.h },
            { x: sel.bounds.x + sel.bounds.w, y: r.y, w: Math.max(0, r.x + r.w - sel.bounds.x - sel.bounds.w), h: r.h },
          ];
          for (const o of outside) if (o.w > 0 && o.h > 0) sctx.clearRect(o.x, o.y, o.w, o.h);
        }
        const ctx = this.surf.ctx;
        ctx.save();
        ctx.globalAlpha = doc.stroke?.opacity ?? this.o.opacity;
        const mode = doc.stroke?.mode ?? 'paint';
        const blendOp = CANVAS_BLEND[doc.stroke?.blend ?? 'normal'] ?? 'source-over';
        const lockAlpha = mode !== 'erase' && !!doc.stroke?.lockAlpha;
        if (mode === 'erase') ctx.globalCompositeOperation = 'destination-out';
        else if (lockAlpha && blendOp === 'source-over') ctx.globalCompositeOperation = 'source-atop';
        else ctx.globalCompositeOperation = blendOp;
        ctx.drawImage(strokeSurf.canvas, r.x, r.y, r.w, r.h, lr.x, lr.y, r.w, r.h);
        ctx.restore();
        if (lockAlpha && blendOp !== 'source-over' && patch) restoreAlpha(patch);
        this.surf.touch(lr);
      }
      strokeSurf.ctx.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
      strokeSurf.touch(rectInflate(r, 2));
    }
    doc.stroke = null;
    if (!patch) {
      doc.invalidate(r);
      this.revertGrowth();
      return true;
    }
    doc.touchLayer(this.layer, r);
    doc.commit(this.o.label, { patches: [patch], structural: this.grown });
    return true;
  }

  /** Nothing is recorded: the layer goes back to its original (ungrown) surface. */
  private revertGrowth() {
    if (!this.ungrow) return;
    this.ungrow();
    this.ungrow = null;
    this.doc.touchLayer(this.layer);
  }

  private commitHeal(r: Rect): PixelPatch | null {
    const doc = this.doc;
    const margin = Math.ceil(this.o.size * 0.35) + 6;
    const surfDoc = { x: this.ox, y: this.oy, w: this.surf.width, h: this.surf.height };
    const R = rectIntersect(rectInflate(r, margin), rectIntersect(surfDoc, { x: 0, y: 0, w: doc.width, h: doc.height }));
    if (!R) return null;
    const lr = rectTranslate(R, -this.ox, -this.oy);
    const cov = doc.strokeSurf.ctx.getImageData(R.x, R.y, R.w, R.h).data;
    const alpha = new Float32Array(R.w * R.h);
    const sel = doc.selection;
    for (let i = 0; i < alpha.length; i++) {
      let a = cov[i * 4 + 3] / 255;
      if (a > 0 && sel) a *= sel.valueAt(R.x + (i % R.w), R.y + Math.floor(i / R.w)) / 255;
      alpha[i] = a;
    }
    const dst = this.surf.ctx.getImageData(lr.x, lr.y, lr.w, lr.h);
    let src: Uint8ClampedArray | null = null;
    if (this.o.kind === 'heal' && this.o.source) {
      const s = this.o.source;
      const c = makeCanvas(R.w, R.h);
      const cctx = ctx2d(c, true);
      cctx.drawImage(s.canvas, R.x + s.offset[0] - s.x, R.y + s.offset[1] - s.y, R.w, R.h, 0, 0, R.w, R.h);
      src = cctx.getImageData(0, 0, R.w, R.h).data;
    } else {
      // Spot healing: search the neighbourhood for a matching patch.
      const reach = Math.max(R.w, R.h) * 2.6 + this.o.size;
      const area = rectIntersect(rectRoundOut(rectInflate(R, reach)), surfDoc)!;
      const la = rectTranslate(area, -this.ox, -this.oy);
      const big = this.surf.ctx.getImageData(la.x, la.y, la.w, la.h).data;
      const off = findSpotSource(big, area, R, alpha, this.o.size);
      if (!off) return null;
      src = new Uint8ClampedArray(R.w * R.h * 4);
      for (let y = 0; y < R.h; y++) {
        const s0 = ((R.y + off[1] - area.y + y) * area.w + (R.x + off[0] - area.x)) * 4;
        src.set(big.subarray(s0, s0 + R.w * 4), y * R.w * 4);
      }
    }
    if (!src) return null;
    const healed = healRegion(dst.data, src, alpha, R.w, R.h);
    const patch: PixelPatch = { surf: this.surf, x: lr.x, y: lr.y, data: dst };
    this.surf.ctx.putImageData(new ImageData(healed as Uint8ClampedArray<ArrayBuffer>, R.w, R.h), lr.x, lr.y);
    this.surf.touch(lr);
    doc.touchLayer(this.layer, R);
    return patch;
  }

  cancel() {
    if (this.finished) return;
    this.finished = true;
    const doc = this.doc;
    if (this.o.kind === 'retouch') {
      if (this.backup) {
        this.surf.ctx.save();
        this.surf.ctx.globalCompositeOperation = 'copy';
        this.surf.ctx.drawImage(this.backup, 0, 0);
        this.surf.ctx.restore();
        this.surf.touch();
      }
    } else if (this.dirty) {
      doc.strokeSurf.ctx.clearRect(this.dirty.x - 2, this.dirty.y - 2, this.dirty.w + 4, this.dirty.h + 4);
      doc.strokeSurf.touch(rectInflate(this.dirty, 2));
    }
    this.revertGrowth();
    doc.stroke = null;
    doc.invalidate();
  }
}
