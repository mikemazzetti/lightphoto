import { RenderTarget, Texture } from '@/core/gl/gl';
import { capturePatch, Doc } from '../model/doc';
import { rectIntersect } from '../model/geom';
import type { Surface } from '../model/surface';
import type { AdjustParams, Layer } from '../model/types';
import { touch } from '../model/store';
import { Compositor, requireCompositor } from '../render/compositor';
import { commit, PixelTarget, pixelTarget } from './layers';

/**
 * A GPU pixel process: takes the layer (or mask) texture and returns a processed render
 * target of the same size, acquired from `c.pool` (the caller releases it).
 */
export type ProcessFn = (c: Compositor, src: Texture, w: number, h: number) => RenderTarget;

/**
 * Live preview of a destructive process on the active layer: the compositor runs it over the
 * layer texture every time the key changes (GPU only, no readback) and blends it through the
 * selection. `apply()` reads back only the affected region and records an undo patch.
 */
export class PreviewSession {
  private out: RenderTarget | null = null;
  private fn: ProcessFn | null = null;
  private key = '';
  private closed = false;
  enabled = true;

  private constructor(
    readonly doc: Doc,
    readonly t: PixelTarget,
    readonly opts: { keepAlpha?: boolean; label: string },
  ) {}

  static async start(doc: Doc, opts: { keepAlpha?: boolean; label: string }): Promise<PreviewSession | null> {
    const t = await pixelTarget(doc);
    if (!t) return null;
    return new PreviewSession(doc, t, opts);
  }

  get layer(): Layer {
    return this.t.layer;
  }
  get surface(): Surface {
    return this.t.surf;
  }

  private runMixed(c: Compositor, src: Texture | RenderTarget, fn: ProcessFn, out: RenderTarget) {
    const s = this.t.surf;
    const tex = src instanceof Texture ? src : (src as RenderTarget).texture;
    const p = fn(c, tex, s.width, s.height);
    c.selMix(this.doc, { x: this.t.ox, y: this.t.oy }, src, p, out, { keepAlpha: this.opts.keepAlpha || (!this.t.mask && this.t.layer.lockTransparency) });
    if (p !== out) c.pool.release(p);
  }

  /** Sets (or clears with null) the previewed process. */
  update(key: string, fn: ProcessFn | null) {
    if (this.closed) return;
    this.fn = fn;
    this.key = key;
    const doc = this.doc;
    if (!fn || !this.enabled) {
      if (doc.preview?.layerId === this.t.layer.id) doc.preview = null;
      doc.invalidate();
      return;
    }
    const proc = {
      key,
      run: (src: Texture | RenderTarget) => {
        const c = requireCompositor();
        const s = this.t.surf;
        if (!this.out || this.out.width !== s.width || this.out.height !== s.height) {
          this.out?.dispose();
          this.out = new RenderTarget(c.gl, s.width, s.height, 'rgba8', 'linear');
        }
        this.runMixed(c, src, fn, this.out);
        return this.out;
      },
    };
    doc.preview = this.t.mask ? { layerId: this.t.layer.id, maskProcess: proc } : { layerId: this.t.layer.id, process: proc };
    doc.invalidate();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.update(this.key, this.fn);
  }

  private end() {
    this.closed = true;
    if (this.doc.preview?.layerId === this.t.layer.id) this.doc.preview = null;
    requireCompositor().clearPreviewCache();
    this.out?.dispose();
    this.out = null;
    this.doc.invalidate();
  }

  cancel() {
    if (this.closed) return;
    this.end();
  }

  /** Applies the process for real and records history. */
  apply(fn: ProcessFn | null = this.fn, label = this.opts.label) {
    if (this.closed) return;
    if (!fn) {
      this.end();
      return;
    }
    const c = requireCompositor();
    applyProcess(this.doc, this.t, fn, label, { keepAlpha: this.opts.keepAlpha }, c);
    this.end();
  }
}

/** Runs a process on a target immediately (no preview) and records history. */
export function applyProcess(doc: Doc, t: PixelTarget, fn: ProcessFn, label: string, opts: { keepAlpha?: boolean } = {}, c = requireCompositor()) {
  const s = t.surf;
  const src = c.tex(s);
  const out = c.pool.acquire(s.width, s.height);
  const p = fn(c, src, s.width, s.height);
  c.selMix(doc, { x: t.ox, y: t.oy }, src, p, out, { keepAlpha: opts.keepAlpha || (!t.mask && t.layer.lockTransparency) });
  if (p !== out) c.pool.release(p);
  // Only the selected part of the layer can change.
  const full = { x: 0, y: 0, w: s.width, h: s.height };
  const sel = doc.selection;
  const region = sel ? rectIntersect({ x: sel.bounds.x - t.ox, y: sel.bounds.y - t.oy, w: sel.bounds.w, h: sel.bounds.h }, full) : full;
  if (!region) {
    c.pool.release(out);
    return;
  }
  const px = out.read(region.x, region.y, region.w, region.h) as Uint8Array;
  c.pool.release(out);
  const patch = capturePatch(s, region);
  s.ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), region.w, region.h), region.x, region.y);
  s.touch(region);
  doc.touchLayer(t.layer, { x: region.x + t.ox, y: region.y + t.oy, w: region.w, h: region.h });
  commit(doc, label, { patches: [patch], structural: false });
  touch();
}

/** ProcessFn for an adjustment. */
export const adjustProcess =
  (p: AdjustParams): ProcessFn =>
  (c, src, w, h) =>
    c.applyAdjust(src, p, c.pool.acquire(w, h));

/** Destructive Image ▸ Adjustments without a dialog (Invert, Desaturate, Auto…). */
export async function applyAdjustmentNow(doc: Doc, p: AdjustParams, label: string) {
  const t = await pixelTarget(doc);
  if (!t) return;
  applyProcess(doc, t, adjustProcess(p), label);
}
