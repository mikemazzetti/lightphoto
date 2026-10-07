import { cachedShader, caps, createGL, GL, RenderTarget, Shader, TargetPool, Texture } from '@/core/gl/gl';
import { blendModeId } from '@/core/gl/glsl';
import { bus } from '../model/bus';
import type { Doc, LayerPreview, PreviewProcess } from '../model/doc';
import { IDENTITY, Mat2D, matInvert, matMul, matScale, matToGL, matTranslate, Rect, rectIntersect } from '../model/geom';
import { layerFx } from '../model/rasterize';
import type { Selection } from '../model/selection';
import type { Surface } from '../model/surface';
import type { AdjustParams, Layer, ViewState } from '../model/types';
import { adjustNeedsLut, adjustUniforms, bakeLut } from './adjustments';
import { gaussianBlur } from './filters';
import { ADJ_APPLY_FS, ADJ_LAYER_FS, COPY_AREA_FS, LAYER_FS, PRESENT_FS, SEL_MIX_FS, THUMB_FS } from './shaders';

interface TexEntry {
  tex: Texture;
  version: number;
  used: number;
}

type Pass = (back: RenderTarget, out: RenderTarget) => void;

const ZERO_MAT = matToGL(IDENTITY);

let active: Compositor | null = null;
/** The compositor of the mounted canvas view (null while the editor is unmounted). */
export const getCompositor = () => active;

/**
 * WebGL2 layer compositor.
 *
 * Every pixel surface lives in a GL texture that is re-uploaded only where it changed. Layers
 * are blended bottom→top into ping-pong render targets (scissored to the invalidated region),
 * adjustment layers run as shader passes over the accumulated result, and while a stroke or a
 * live preview is active the composite of everything below the focus layer is cached.
 */
export class Compositor {
  readonly gl: GL;
  readonly pool: TargetPool;
  private texCache = new Map<Surface, TexEntry>();
  private frame = 0;
  private composite: RenderTarget | null = null;
  private ping: RenderTarget | null = null;
  private pong: RenderTarget | null = null;
  private below: RenderTarget | null = null;
  private belowKey = '';
  private selTex: Texture | null = null;
  private selRef: Selection | null | undefined = undefined;
  private selDocKey = '';
  private lutCache = new Map<string, Texture>();
  private procCache = new Map<string, { key: string; out: Texture | RenderTarget }>();
  private dummy: Texture;
  private lastDocId = '';
  private lastVersion = -1;
  private mipmapped = false;
  private compositeVersion = 0;
  private sLayer: Shader;
  private sAdj: Shader;
  private sPresent: Shader;
  lost = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = createGL(canvas, { alpha: false, desynchronized: true });
    this.pool = new TargetPool(this.gl);
    this.sLayer = new Shader(this.gl, LAYER_FS);
    this.sAdj = new Shader(this.gl, ADJ_LAYER_FS);
    this.sPresent = new Shader(this.gl, PRESENT_FS);
    this.dummy = Texture.create(this.gl, 1, 1, { data: new Uint8Array([0, 0, 0, 0]) });
    canvas.addEventListener('webglcontextlost', this.onLost);
    active = this;
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  get maxTextureSize() {
    return caps(this.gl).maxTextureSize;
  }

  // ------------------------------------------------------------------------------------------
  // Textures

  /** GL texture mirroring a surface (uploads only what changed since last time). */
  tex(surf: Surface): Texture {
    const gl = this.gl;
    let e = this.texCache.get(surf);
    if (!e || e.tex.width !== surf.width || e.tex.height !== surf.height) {
      if (e) e.tex.dispose();
      const tex = new Texture(gl, surf.width, surf.height, 'rgba8', 'linear', 'clamp');
      tex.upload(surf.canvas);
      e = { tex, version: surf.version, used: this.frame };
      this.texCache.set(surf, e);
    } else if (e.version !== surf.version) {
      const r = surf.dirty;
      if (!surf.fullDirty && r && surf.uploadedVersion === e.version && r.w * r.h < surf.width * surf.height * 0.6) {
        gl.bindTexture(gl.TEXTURE_2D, e.tex.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, surf.canvas);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      } else {
        e.tex.upload(surf.canvas);
      }
    }
    surf.dirty = null;
    surf.fullDirty = false;
    surf.uploadedVersion = surf.version;
    e.version = surf.version;
    e.used = this.frame;
    return e.tex;
  }

  /** Drops textures of surfaces that haven't been used for a while. */
  private gc(keep: Set<Surface>) {
    for (const [s, e] of this.texCache) {
      if (!keep.has(s) && this.frame - e.used > 120) {
        e.tex.dispose();
        this.texCache.delete(s);
      }
    }
  }

  private lut(p: AdjustParams): Texture {
    const key = JSON.stringify(p);
    let t = this.lutCache.get(key);
    if (!t) {
      const data = bakeLut(p) ?? new Uint8Array(256 * 4);
      t = Texture.create(this.gl, 256, 1, { data, filter: 'linear' });
      this.lutCache.set(key, t);
      if (this.lutCache.size > 48) {
        const k = this.lutCache.keys().next().value!;
        this.lutCache.get(k)!.dispose();
        this.lutCache.delete(k);
      }
    }
    return t;
  }

  adjustUniforms(p: AdjustParams) {
    return { ...adjustUniforms(p), uLut: adjustNeedsLut(p) ? this.lut(p) : this.dummy };
  }

  /** Selection as an R8 document-size texture (zero texture when there is no selection). */
  selectionTex(doc: Doc): Texture {
    const gl = this.gl;
    const key = `${doc.id}:${doc.width}x${doc.height}`;
    if (this.selTex && this.selRef === doc.selection && this.selDocKey === key) return this.selTex;
    const sel = doc.selection;
    const w = sel ? doc.width : 1;
    const h = sel ? doc.height : 1;
    if (!this.selTex) this.selTex = new Texture(gl, w, h, 'r8', 'nearest', 'clamp');
    this.selTex.allocate(w, h, sel ? null : new Uint8Array(1));
    if (sel) this.selTex.uploadRegion(sel.bounds.x, sel.bounds.y, sel.bounds.w, sel.bounds.h, sel.data);
    this.selRef = sel;
    this.selDocKey = key;
    return this.selTex;
  }

  // ------------------------------------------------------------------------------------------
  // Render targets

  private ensureTargets(w: number, h: number) {
    const make = (t: RenderTarget | null) => {
      if (t && t.width === w && t.height === h) return t;
      t?.dispose();
      return new RenderTarget(this.gl, w, h, 'rgba8', 'linear');
    };
    this.composite = make(this.composite);
    this.ping = make(this.ping);
    this.pong = make(this.pong);
  }

  // ------------------------------------------------------------------------------------------
  // Layer passes

  private surfMat(surfW: number, surfH: number, toDoc: Mat2D): Float32Array {
    return matToGL(matMul(matScale(1 / surfW, 1 / surfH), matInvert(toDoc)));
  }

  private layerToDoc(l: Layer, pv: LayerPreview | null): Mat2D {
    if (pv?.matrix && pv.layerId === l.id) return pv.matrix;
    return matTranslate(l.x, l.y);
  }

  private maskToDoc(l: Layer, pv: LayerPreview | null): Mat2D {
    const m = l.mask!;
    const base = matTranslate(m.x, m.y);
    if (pv?.matrix && pv.layerId === l.id && m.linked) {
      // Move the mask with the layer: (preview) ∘ inverse(original layer placement) ∘ mask placement
      return matMul(pv.matrix, matMul(matTranslate(-l.x, -l.y), base));
    }
    return base;
  }

  private processed(l: Layer, src: Texture | RenderTarget, proc: PreviewProcess, which: 'px' | 'mask'): Texture | RenderTarget {
    const cacheKey = `${l.id}:${which}`;
    const key = `${proc.key}|${(which === 'px' ? l.surf : l.mask?.surf)?.version}`;
    const hit = this.procCache.get(cacheKey);
    if (hit && hit.key === key) return hit.out;
    const out = proc.run(src, l);
    this.procCache.set(cacheKey, { key, out });
    return out;
  }

  private featherCache = new Map<string, { key: string; rt: RenderTarget }>();

  /** Mask feather (Properties ▸ Feather): a cached Gaussian blur of the mask texture. */
  private featheredMask(layerId: string, surf: Surface, tex: Texture, feather: number): RenderTarget {
    const key = `${surf.id}:${surf.version}:${feather.toFixed(2)}`;
    const hit = this.featherCache.get(layerId);
    if (hit && hit.key === key) return hit.rt;
    if (hit) this.pool.release(hit.rt);
    const rt = gaussianBlur(this, tex, surf.width, surf.height, feather / 2);
    this.featherCache.set(layerId, { key, rt });
    return rt;
  }

  /** Drops feathered masks no layer needs any more (deleted layers, mask disabled / unfeathered). */
  private pruneFeather(layers: Layer[]) {
    const live = new Set<string>();
    for (const l of layers) if (l.mask?.enabled && l.mask.feather > 0.3) live.add(l.id);
    for (const [id, f] of this.featherCache) {
      if (live.has(id)) continue;
      this.pool.release(f.rt);
      this.featherCache.delete(id);
    }
  }

  /** Clears preview caches (call when a preview session ends). */
  clearPreviewCache() {
    this.procCache.clear();
  }

  private maskUniforms(doc: Doc, l: Layer, pv: LayerPreview | null) {
    const m = l.mask;
    if (!m || !m.enabled) return { uMaskOn: 0, uMask: this.dummy, uMaskMat: ZERO_MAT, uMaskDefault: 1, uMaskDensity: 1 };
    let tex: Texture | RenderTarget = this.tex(m.surf);
    if (pv?.layerId === l.id && pv.maskProcess) tex = this.processed(l, tex, pv.maskProcess, 'mask');
    else if (m.feather > 0.3) tex = this.featheredMask(l.id, m.surf, tex, m.feather);
    return {
      uMaskOn: 1,
      uMask: tex,
      uMaskMat: this.surfMat(m.surf.width, m.surf.height, this.maskToDoc(l, pv)),
      uMaskDefault: m.defaultColor / 255,
      uMaskDensity: m.density,
    };
  }

  private strokeUniforms(doc: Doc, l: Layer) {
    const st = doc.stroke;
    if (!st || st.layerId !== l.id) return { uStrokeMode: 0, uStroke: this.dummy, uSel: this.dummy, uSelOn: 0 };
    return {
      uStrokeMode: st.mode === 'paint' ? 1 : 2,
      uStroke: this.tex(st.surf),
      uStrokeOpacity: st.opacity,
      uStrokeBlend: blendModeId(st.blend),
      uStrokeTarget: st.target === 'mask' ? 1 : 0,
      uLockAlpha: st.lockAlpha ? 1 : 0,
      uSel: st.clipToSelection && doc.selection ? this.selectionTex(doc) : this.dummy,
      uSelOn: st.clipToSelection && doc.selection ? 1 : 0,
    };
  }

  /** Base layer of a clipping group (nearest non-clipped layer below index i). */
  private clipBase(layers: Layer[], i: number): Layer | null {
    for (let j = i - 1; j >= 0; j--) if (!layers[j].clip) return layers[j];
    return null;
  }

  private clipUniforms(doc: Doc, layers: Layer[], i: number, pv: LayerPreview | null) {
    const off = { uClipOn: 0, uClip: this.dummy, uClipMask: this.dummy, uClipMaskOn: 0, uClipSolid: 0 };
    if (!layers[i].clip) return off;
    const base = this.clipBase(layers, i);
    if (!base) return off;
    const u: Record<string, unknown> = { ...off, uClipOn: 1 };
    if (base.surf) {
      u.uClip = this.tex(base.surf);
      u.uClipMat = this.surfMat(base.surf.width, base.surf.height, this.layerToDoc(base, pv));
    } else u.uClipSolid = 1;
    if (base.mask?.enabled) {
      u.uClipMaskOn = 1;
      u.uClipMask = this.tex(base.mask.surf);
      u.uClipMaskMat = this.surfMat(base.mask.surf.width, base.mask.surf.height, this.maskToDoc(base, pv));
      u.uClipMaskDefault = base.mask.defaultColor / 255;
      u.uClipMaskDensity = base.mask.density;
    }
    return u;
  }

  /** Builds the passes for layers[from..] (skipping hidden ones). */
  private buildPasses(doc: Doc, layers: Layer[], from: number, area: Rect, opts: { previews: boolean }): Pass[] {
    const passes: Pass[] = [];
    const pv = opts.previews ? doc.preview : null;
    const common = { uArea: [area.x, area.y, area.w, area.h], uDocSize: [doc.width, doc.height] };
    for (let i = from; i < layers.length; i++) {
      const l = layers[i];
      if (!l.visible) continue;
      if (pv?.hide && pv.layerId === l.id) continue;
      if (l.clip) {
        const base = this.clipBase(layers, i);
        if (base && !base.visible) continue;
      }
      const stroke = opts.previews ? this.strokeUniforms(doc, l) : { uStrokeMode: 0, uStroke: this.dummy, uSel: this.dummy, uSelOn: 0 };
      if (l.kind === 'adjustment' && l.adjust) {
        const adj = l.adjust;
        const mu = this.maskUniforms(doc, l, pv);
        const cu = this.clipUniforms(doc, layers, i, pv);
        passes.push((back, out) => {
          this.sAdj.draw(out, {
            ...common,
            uBack: back,
            ...mu,
            ...cu,
            ...stroke,
            ...this.adjustUniforms(adj),
            uOpacity: l.opacity,
            uMode: blendModeId(l.blendMode),
          });
        });
        continue;
      }
      // Layer effects below the content.
      const fx = l.surf ? layerFx(l) : null;
      // Mask / clip uniforms are resolved now (outside the scissored passes) since mask
      // previews may run GPU processing.
      const mu = this.maskUniforms(doc, l, pv);
      const cu = this.clipUniforms(doc, layers, i, pv);
      const drawSurface = (surf: Surface, toDoc: Mat2D, opacity: number, mode: number, withMask: boolean, tex?: Texture | RenderTarget, st?: Record<string, unknown>) => {
        const src = tex ?? this.tex(surf);
        passes.push((back, out) => {
          this.sLayer.draw(out, {
            ...common,
            uBack: back,
            uSolid: 0,
            uSrc: src,
            uSrcMat: this.surfMat(surf.width, surf.height, toDoc),
            ...(withMask ? mu : { uMaskOn: 0, uMask: this.dummy }),
            ...(withMask ? cu : { uClipOn: 0, uClip: this.dummy, uClipMask: this.dummy }),
            ...(st ?? { uStrokeMode: 0, uStroke: this.dummy, uSel: this.dummy, uSelOn: 0 }),
            uOpacity: opacity,
            uMode: mode,
            uKnockMaskView: 0,
          });
        });
      };
      if (fx?.below) drawSurface(fx.below, matTranslate(fx.x, fx.y), l.opacity, 0, false);
      if (l.kind === 'fill') {
        const c = l.fillColor ?? { r: 0, g: 0, b: 0, a: 1 };
        passes.push((back, out) => {
          this.sLayer.draw(out, {
            ...common,
            uBack: back,
            uSolid: 1,
            uSolidColor: [c.r / 255, c.g / 255, c.b / 255, c.a],
            uSrc: this.dummy,
            ...mu,
            ...cu,
            ...stroke,
            uOpacity: l.opacity * l.fillOpacity,
            uMode: blendModeId(l.blendMode),
            uKnockMaskView: 0,
          });
        });
      } else if (l.surf) {
        const surf = l.surf;
        let tex: Texture | RenderTarget | undefined;
        if (pv?.layerId === l.id && pv.process) tex = this.processed(l, this.tex(surf), pv.process, 'px');
        drawSurface(surf, this.layerToDoc(l, pv), l.opacity * l.fillOpacity, blendModeId(l.blendMode), true, tex, stroke);
      }
      if (pv?.floating && pv.layerId === l.id) drawSurface(pv.floating.surf, pv.floating.matrix, l.opacity * l.fillOpacity, blendModeId(l.blendMode), false);
      if (fx?.above) drawSurface(fx.above, matTranslate(fx.x, fx.y), l.opacity, 0, false);
    }
    return passes;
  }

  private runPasses(passes: Pass[], init: RenderTarget | null, out: RenderTarget, ping: RenderTarget, pong: RenderTarget, scissor: Rect | null) {
    const gl = this.gl;
    if (scissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(scissor.x, scissor.y, scissor.w, scissor.h);
    }
    try {
      if (!passes.length) {
        if (init) cachedShader(gl, 'ed-copy', COPY_AREA_FS).draw(out, { uSrc: init, uSrcRect: [0, 0, 1, 1] });
        else out.clear(0, 0, 0, 0);
        return;
      }
      let back: RenderTarget;
      if (init) back = init;
      else {
        ping.clear(0, 0, 0, 0);
        back = ping;
      }
      passes.forEach((p, k) => {
        const target = k === passes.length - 1 ? out : back === ping ? pong : ping;
        p(back, target);
        back = target;
      });
    } finally {
      if (scissor) gl.disable(gl.SCISSOR_TEST);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Composite

  /** Brings the document composite up to date. Returns true when it changed. */
  render(doc: Doc): boolean {
    if (this.lost) return false;
    this.frame++;
    const gl = this.gl;
    const switched = doc.id !== this.lastDocId || !this.composite || this.composite.width !== doc.width || this.composite.height !== doc.height;
    if (!switched && doc.renderVersion === this.lastVersion) return false;
    this.ensureTargets(doc.width, doc.height);
    let rect: Rect | null = { x: 0, y: 0, w: doc.width, h: doc.height };
    if (!switched && !doc.dirtyAll && doc.dirtyRect) rect = rectIntersect(doc.dirtyRect, rect);
    doc.dirtyAll = false;
    doc.dirtyRect = null;
    this.lastDocId = doc.id;
    this.lastVersion = doc.renderVersion;
    if (switched) {
      this.belowKey = '';
      this.procCache.clear();
      this.pruneFeather(doc.layers);
    }
    if (!rect) return false;
    const area = { x: 0, y: 0, w: doc.width, h: doc.height };
    const layers = doc.layers;
    // Below-cache: while a stroke / preview is live on layer k, cache the composite of [0, k).
    const focusId = doc.stroke?.layerId ?? doc.preview?.layerId ?? null;
    const k = focusId ? layers.findIndex((l) => l.id === focusId) : -1;
    let init: RenderTarget | null = null;
    let from = 0;
    if (k > 0) {
      const key = `${doc.id}:${doc.width}x${doc.height}|` + layers.slice(0, k).map((l) => `${l.id}:${l.v}:${l.surf?.version ?? 0}:${l.mask?.surf.version ?? 0}`).join(',');
      if (key !== this.belowKey || !this.below || this.below.width !== doc.width || this.below.height !== doc.height) {
        if (!this.below || this.below.width !== doc.width || this.below.height !== doc.height) {
          this.below?.dispose();
          this.below = new RenderTarget(gl, doc.width, doc.height, 'rgba8', 'linear');
        }
        const p = this.buildPasses(doc, layers.slice(0, k), 0, area, { previews: false });
        this.runPasses(p, null, this.below, this.ping!, this.pong!, null);
        this.belowKey = key;
      }
      init = this.below;
      from = k;
    } else if (!focusId && this.below) {
      this.below.dispose();
      this.below = null;
      this.belowKey = '';
    }
    const passes = this.buildPasses(doc, layers, from, area, { previews: true });
    this.runPasses(passes, init, this.composite!, this.ping!, this.pong!, rect);
    this.compositeVersion++;
    this.mipmapped = false;
    if (this.frame % 60 === 0) {
      const keep = new Set<Surface>();
      for (const l of layers) {
        if (l.surf) keep.add(l.surf);
        if (l.mask) keep.add(l.mask.surf);
      }
      if (doc.stroke) keep.add(doc.stroke.surf);
      this.gc(keep);
      this.pruneFeather(layers);
    }
    return true;
  }

  get compositeTarget(): RenderTarget | null {
    return this.composite;
  }

  /**
   * Renders an arbitrary list of layers (no previews/strokes) over `area` into a pooled target.
   * Used by merge / flatten / copy merged / sampling. Release the result with `pool.release`.
   */
  renderLayers(doc: Doc, layers: Layer[], area: Rect, background?: [number, number, number, number]): RenderTarget {
    const out = this.pool.acquire(area.w, area.h);
    const a = this.pool.acquire(area.w, area.h);
    const b = this.pool.acquire(area.w, area.h);
    let init: RenderTarget | null = null;
    if (background) {
      a.clear(...background);
      init = a;
    }
    const passes = this.buildPasses(doc, layers, 0, area, { previews: false });
    if (init && passes.length) {
      // runPasses ping-pongs away from init; give it a different scratch pair.
      const c = this.pool.acquire(area.w, area.h);
      this.runPasses(passes, init, out, b, c, null);
      this.pool.release(c);
    } else this.runPasses(passes, init, out, a, b, null);
    this.pool.release(a);
    this.pool.release(b);
    return out;
  }

  /** Reads the current composite (or a region) as RGBA bytes. */
  readComposite(r?: Rect): Uint8Array | null {
    if (!this.composite) return null;
    const rr = r ?? { x: 0, y: 0, w: this.composite.width, h: this.composite.height };
    return this.composite.read(rr.x, rr.y, rr.w, rr.h) as Uint8Array;
  }

  readPixel(x: number, y: number, size = 1): [number, number, number, number] | null {
    if (!this.composite) return null;
    const h = Math.floor(size / 2);
    const r = rectIntersect({ x: Math.floor(x) - h, y: Math.floor(y) - h, w: size, h: size }, { x: 0, y: 0, w: this.composite.width, h: this.composite.height });
    if (!r) return null;
    const d = this.composite.read(r.x, r.y, r.w, r.h) as Uint8Array;
    let R = 0;
    let G = 0;
    let B = 0;
    let A = 0;
    const n = r.w * r.h;
    for (let i = 0; i < d.length; i += 4) {
      R += d[i];
      G += d[i + 1];
      B += d[i + 2];
      A += d[i + 3];
    }
    return [R / n, G / n, B / n, A / n];
  }

  // ------------------------------------------------------------------------------------------
  // Present

  present(doc: Doc | null, view: ViewState, dpr: number, opts: { grid: boolean; ants: boolean; time: number; bg: [number, number, number] }) {
    if (this.lost) return;
    const gl = this.gl;
    if (!doc || !this.composite) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(opts.bg[0], opts.bg[1], opts.bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const s = view.scale * dpr;
    const wantMip = s < 0.5;
    if (wantMip) {
      if (this.composite.texture.filter !== 'mipmap') this.composite.texture.setFilter('mipmap');
      if (!this.mipmapped) {
        this.composite.texture.generateMipmaps();
        this.mipmapped = true;
      }
    } else if (this.composite.texture.filter === 'mipmap') this.composite.texture.setFilter('linear');
    const ants = opts.ants && !!doc.selection;
    this.sPresent.draw(null, {
      uImg: this.composite,
      uSel: ants ? this.selectionTex(doc) : this.dummy,
      uDocSize: [doc.width, doc.height],
      uView: [view.x * dpr, view.y * dpr, s],
      uCanvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      uTime: opts.time,
      uAnts: ants ? 1 : 0,
      uGrid: opts.grid ? 1 : 0,
      uNearest: s >= 2 ? 1 : 0,
      uBg: opts.bg,
      uDpr: dpr,
    });
  }

  /** Small preview of the composite (navigator), composited over a checkerboard. */
  thumbnail(maxW: number, maxH: number): ImageData | null {
    if (!this.composite) return null;
    const c = this.composite;
    const k = Math.min(maxW / c.width, maxH / c.height, 1);
    const w = Math.max(1, Math.round(c.width * k));
    const h = Math.max(1, Math.round(c.height * k));
    if (c.texture.filter !== 'mipmap') c.texture.setFilter('mipmap');
    if (!this.mipmapped) c.texture.generateMipmaps();
    this.mipmapped = true;
    const t = this.pool.acquire(w, h);
    cachedShader(this.gl, 'ed-thumb', THUMB_FS).draw(t, { uSrc: c, uBg: [1, 1, 1], uChecker: 1, uSize: [w, h] });
    const img = t.toImageData();
    this.pool.release(t);
    return img;
  }

  // ------------------------------------------------------------------------------------------
  // Helpers for filters / adjustments

  /** Applies an adjustment to a texture (alpha preserved). */
  applyAdjust(src: Texture | RenderTarget, p: AdjustParams, out?: RenderTarget): RenderTarget {
    const w = src instanceof RenderTarget ? src.width : src.width;
    const h = src instanceof RenderTarget ? src.height : src.height;
    const o = out ?? this.pool.acquire(w, h);
    cachedShader(this.gl, 'ed-adjapply', ADJ_APPLY_FS).draw(o, { uSrc: src, ...this.adjustUniforms(p) });
    return o;
  }

  /** Mixes processed pixels with the original through the document selection. */
  selMix(doc: Doc, l: { x: number; y: number }, orig: Texture | RenderTarget, proc: Texture | RenderTarget, out: RenderTarget, opts: { keepAlpha?: boolean; amount?: number; useSelection?: boolean } = {}) {
    const useSel = (opts.useSelection ?? true) && !!doc.selection;
    cachedShader(this.gl, 'ed-selmix', SEL_MIX_FS).draw(out, {
      uOrig: orig,
      uProc: proc,
      uSel: useSel ? this.selectionTex(doc) : this.dummy,
      uSelOn: useSel ? 1 : 0,
      uOrigin: [l.x, l.y],
      uSize: [out.width, out.height],
      uDocSize: [doc.width, doc.height],
      uKeepAlpha: opts.keepAlpha ? 1 : 0,
      uAmount: opts.amount ?? 1,
    });
  }

  get dummyTex() {
    return this.dummy;
  }

  dispose() {
    if (active === this) active = null;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    for (const e of this.texCache.values()) e.tex.dispose();
    this.texCache.clear();
    for (const t of this.lutCache.values()) t.dispose();
    this.lutCache.clear();
    this.procCache.clear();
    for (const f of this.featherCache.values()) f.rt.dispose();
    this.featherCache.clear();
    for (const t of [this.composite, this.ping, this.pong, this.below]) t?.dispose();
    this.composite = this.ping = this.pong = this.below = null;
    this.selTex?.dispose();
    this.pool.dispose();
    this.dummy.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export function requireCompositor(): Compositor {
  const c = getCompositor();
  if (!c) throw new Error('The editor canvas is not ready.');
  return c;
}

export { bus };
