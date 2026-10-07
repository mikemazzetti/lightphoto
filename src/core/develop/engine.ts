import { caps, GL, RenderTarget, Shader, Texture, TexFormat } from '../gl/gl';
import { bakeToneCurve, LUT_SIZE, toHalf } from './curve';
import { orientedSize, outputSize, outputToSource, toGL } from './geometry';
import { BASE_FS, BLUR_FS, DECODE16_FS, DOWN_FS, LENS_LUT_N, MAIN_FS, MAX_LOCALS, NR_FS, PRESENT_FS } from './shaders';
import { bakeLensLut, LensProfile } from '../image/lensProfile';
import { RAW_TONE_LUT_SIZE, rawToneLut } from './rawTone';
import { curveIsIdentity, DevelopSettings, GradeWheel, LocalAdjustment, Profile } from './settings';
import { rasterizeStrokes, StrokeRasterCache } from './brush';

export const TEMP_SCALE = 1.5;
export const TINT_SCALE = 0.8;

/** 16-bit (or 8-bit) interleaved pixel buffer, e.g. from the RAW decoder. */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint16Array | Uint8Array;
  channels: 3 | 4;
  /** true when samples are linear light; false (default) for sRGB gamma-encoded. */
  linear?: boolean;
  /** Camera-embedded lens corrections read from the RAW file (applied when settings.lens.profile). */
  lens?: LensProfile | null;
  /** 'camera': scene-linear RAW data gets the default camera tone curve at decode (see rawTone.ts). */
  tone?: 'camera';
  /** Capture ISO when known (drives default noise reduction). */
  iso?: number;
}

export type EngineSource = TexImageSource | PixelBuffer;

export interface ViewTransform {
  /** Canvas-pixel offset of the image's top-left corner. */
  x: number;
  y: number;
  /** Canvas pixels per displayed-image pixel (1 = image fills `imgW`×`imgH` canvas px). */
  scale: number;
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  max: number;
  clipHigh: number; // fraction of pixels with a channel at 255
  clipLow: number;
}

const PROFILE_PARAMS: Record<Profile, [number, number, number]> = {
  none: [0, 0, 0],
  color: [0.16, 0.06, 0.04],
  vivid: [0.28, 0.18, 0.12],
  landscape: [0.22, 0.1, 0.16],
  portrait: [0.1, -0.02, -0.04],
  flat: [-0.32, -0.12, 0],
  monochrome: [0.12, 0, 0],
};

const isPixelBuffer = (s: EngineSource): s is PixelBuffer => (s as PixelBuffer).data !== undefined && (s as PixelBuffer).channels !== undefined;

/** Converts an HSV-wheel hue/sat/lum into OKLab (a, b, L) offsets for colour grading. */
export function wheelToLab(w: GradeWheel, strength = 0.07): [number, number, number] {
  if (!w.sat && !w.lum) return [0, 0, 0];
  // Direction of a fully-saturated sRGB colour at this hue, in OKLab.
  const h = (((w.hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const len = Math.hypot(A, B) || 1;
  const k = (w.sat / 100) * strength;
  return [(A / len) * k, (B / len) * k, (w.lum / 100) * 0.12];
}

interface Pyramid {
  levels: RenderTarget[]; // levels[0] = base
}

/**
 * GPU develop pipeline.
 *
 *   source ─▶ base (geometry, lens) ─▶ pyramid ─▶ blurs (texture / clarity / dehaze)
 *                     └─▶ NR ─▶ blurS (sharpen)
 *   all ─▶ MAIN (tone, colour, grading, masks, effects) ─▶ result (RGBA8, display sRGB)
 *
 * Geometry-dependent passes are cached, so dragging a tone/colour slider re-runs only MAIN.
 * One engine per WebGL context; the canvas you pass to the constructor's context is what
 * `present()` draws to.
 */
export class DevelopEngine {
  private srcTex: Texture | null = null;
  private lens: LensProfile | null = null;
  private lensTex: Texture | null = null;
  private toneTex: Texture | null = null;
  private srcOwned = true;
  private srcIsSrgbData = false;
  private srcVersion = 0;
  private srcW = 0;
  private srcH = 0;

  private sBase: Shader;
  private sDown: Shader;
  private sBlur: Shader;
  private sNR: Shader;
  private sMain: Shader;
  private sPresent: Shader;
  private sDecode16: Shader | null = null;

  private base: RenderTarget | null = null;
  private pyr: Pyramid | null = null;
  private blurT: RenderTarget | null = null;
  private blurC: RenderTarget | null = null;
  private blurH: RenderTarget | null = null;
  private nr: RenderTarget | null = null;
  private blurS: RenderTarget | null = null;
  private result: RenderTarget | null = null;
  private neutralResult: RenderTarget | null = null;
  private tmp: RenderTarget[] = [];

  private geomKey = '';
  private blurKeys = { T: '', C: '', H: '' };
  private useT = false;
  private useC = false;
  private useH = false;
  private nrKey = '';
  private sharpKey = '';
  private curveKey = '';
  private curveTex: Texture;
  private maskTex: WebGLTexture | null = null;
  private maskSize: [number, number] = [0, 0];
  private maskCache = new Map<string, StrokeRasterCache>();
  private maskLayerOf = new Map<string, number>();
  private fmt: TexFormat;
  private lastScale = 1;
  private lastRenderSize: [number, number] = [0, 0];

  constructor(readonly gl: GL) {
    this.fmt = caps(gl).floatRT ? 'rgba16f' : 'rgba8';
    this.sBase = new Shader(gl, BASE_FS);
    this.sDown = new Shader(gl, DOWN_FS);
    this.sBlur = new Shader(gl, BLUR_FS);
    this.sNR = new Shader(gl, NR_FS);
    this.sMain = new Shader(gl, MAIN_FS);
    this.sPresent = new Shader(gl, PRESENT_FS);
    this.curveTex = Texture.create(gl, LUT_SIZE, 1, { format: this.fmt === 'rgba16f' ? 'rgba16f' : 'rgba8' });
    this.ensureMaskTexture(4, 4);
  }

  get sourceWidth() {
    return this.srcW;
  }
  get sourceHeight() {
    return this.srcH;
  }
  get hasSource() {
    return !!this.srcTex;
  }

  // ------------------------------------------------------------------------------------------
  // Source

  /**
   * Sets the image to develop. DOM sources (ImageBitmap, canvas, img, video) are stored as
   * sRGB with mipmaps; PixelBuffers (16-bit RAW) are converted to linear half-float.
   */
  setSource(src: EngineSource) {
    const gl = this.gl;
    this.releaseSource();
    const max = caps(gl).maxTextureSize;
    if (isPixelBuffer(src)) {
      const { width, height } = src;
      if (width > max || height > max) throw new Error(`Image exceeds the GPU texture limit (${max}px).`);
      if (src.data instanceof Uint8Array) {
        const rgba = src.channels === 4 ? src.data : expandRGB8(src.data, width, height);
        this.srcTex = Texture.create(gl, width, height, { format: 'srgb8', filter: 'mipmap', data: rgba });
      } else {
        const raw = Texture.create(gl, width, height, { format: src.channels === 4 ? 'rgba16ui' : 'rgb16ui', filter: 'nearest', data: src.data });
        const lin = new RenderTarget(gl, width, height, this.fmt, 'mipmap');
        if (!this.sDecode16) this.sDecode16 = new Shader(gl, DECODE16_FS);
        const toneOn = !!src.linear && src.tone === 'camera';
        if (toneOn && !this.toneTex) this.toneTex = Texture.create(gl, RAW_TONE_LUT_SIZE, 1, { format: 'r16f', data: toHalf(rawToneLut()) });
        this.sDecode16.draw(lin, { uSrc: raw, uLinearInput: src.linear ? 1 : 0, uToneOn: toneOn ? 1 : 0, uTone: this.toneTex ?? this.curveTex });
        lin.texture.generateMipmaps();
        raw.dispose();
        gl.deleteFramebuffer(lin.fbo);
        this.srcTex = lin.texture;
      }
      this.srcW = width;
      this.srcH = height;
    } else {
      const t = Texture.fromSource(gl, src, { format: 'srgb8', filter: 'mipmap' });
      if (t.width > max || t.height > max) {
        t.dispose();
        throw new Error(`Image exceeds the GPU texture limit (${max}px).`);
      }
      this.srcTex = t;
      this.srcW = t.width;
      this.srcH = t.height;
    }
    this.srcOwned = true;
    this.srcIsSrgbData = false;
    this.setLens(isPixelBuffer(src) ? src.lens ?? null : null);
    this.srcVersion++;
  }

  /** The built-in lens profile of the current source (RAW files that embed one), if any. */
  get lensProfile(): LensProfile | null {
    return this.lens;
  }

  private setLens(p: LensProfile | null) {
    if (p === this.lens) return;
    this.lens = p;
    if (!p) return;
    const data = toHalf(bakeLensLut(p, LENS_LUT_N));
    if (!this.lensTex) this.lensTex = Texture.create(this.gl, LENS_LUT_N, 1, { format: 'rgba16f', data });
    else this.lensTex.allocate(LENS_LUT_N, 1, data);
  }

  /**
   * Fast path for video: re-uploads a frame into the existing source texture (no mipmaps when
   * the frame is already at or below the output size).
   */
  setFrame(src: TexImageSource, mipmaps = false) {
    if (!this.srcTex || !this.srcOwned || this.srcTex.format !== 'srgb8' || (this.srcTex.filter === 'mipmap') !== mipmaps) {
      this.releaseSource();
      this.srcTex = Texture.fromSource(this.gl, src, { format: 'srgb8', filter: mipmaps ? 'mipmap' : 'linear' });
      this.srcOwned = true;
    } else {
      this.srcTex.upload(src);
    }
    this.srcW = this.srcTex.width;
    this.srcH = this.srcTex.height;
    this.srcIsSrgbData = false;
    this.setLens(null);
    this.srcVersion++;
  }

  /**
   * Uses an existing texture (not owned) as source, e.g. a composited video frame or an editor
   * layer. Set `srgbData` when it is an RGBA8 texture holding sRGB-encoded values.
   */
  setSourceTexture(tex: Texture, srgbData = true) {
    this.releaseSource();
    this.srcTex = tex;
    this.srcOwned = false;
    this.srcIsSrgbData = srgbData && tex.format !== 'srgb8';
    this.srcW = tex.width;
    this.srcH = tex.height;
    this.setLens(null);
    this.srcVersion++;
  }

  private releaseSource() {
    if (this.srcTex && this.srcOwned) this.srcTex.dispose();
    this.srcTex = null;
  }

  // ------------------------------------------------------------------------------------------
  // Rendering

  /** Full-resolution output size for these settings. */
  fullSize(s: DevelopSettings): [number, number] {
    return outputSize(this.srcW, this.srcH, s);
  }

  /** Output size that fits within maxW×maxH (never upscales past full resolution). */
  fitSize(s: DevelopSettings, maxW: number, maxH: number): [number, number] {
    const [fw, fh] = this.fullSize(s);
    const k = Math.min(1, maxW / fw, maxH / fh);
    return [Math.max(1, Math.round(fw * k)), Math.max(1, Math.round(fh * k))];
  }

  private rt(cur: RenderTarget | null, w: number, h: number, fmt: TexFormat = this.fmt): RenderTarget {
    if (cur && cur.width === w && cur.height === h && cur.texture.format === fmt) return cur;
    cur?.dispose();
    return new RenderTarget(this.gl, w, h, fmt, 'linear');
  }

  private blur(src: RenderTarget, sigma: number, out: RenderTarget | null, tmpIndex: number): RenderTarget {
    const w = src.width;
    const h = src.height;
    this.tmp[tmpIndex] = this.rt(this.tmp[tmpIndex] ?? null, w, h);
    out = this.rt(out, w, h);
    this.sBlur.draw(this.tmp[tmpIndex], { uSrc: src, uDir: [1 / w, 0], uSigma: sigma });
    this.sBlur.draw(out, { uSrc: this.tmp[tmpIndex], uDir: [0, 1 / h], uSigma: sigma });
    return out;
  }

  /** Gaussian blur of `sigma` working-res pixels, computed at a suitable pyramid level. */
  private blurAt(sigmaPx: number, out: RenderTarget | null, tmpIndex: number): RenderTarget {
    const levels = this.pyr!.levels;
    let lvl = 0;
    while (lvl < levels.length - 1 && sigmaPx / 2 ** (lvl + 1) >= 2) lvl++;
    return this.blur(levels[lvl], sigmaPx / 2 ** lvl, out, tmpIndex);
  }

  private ensureGeometry(s: DevelopSettings, w: number, h: number) {
    const lensOn = !!this.lens && s.lens.profile !== false;
    const key = JSON.stringify([this.srcVersion, w, h, s.orientation, s.flipH, s.flipV, s.angle, s.crop, s.lens.distortion, s.lens.vignette, lensOn]);
    if (key === this.geomKey && this.base) return;
    this.geomKey = key;
    this.nrKey = '';
    this.sharpKey = '';
    const gl = this.gl;
    this.base = this.rt(this.base, w, h);
    this.sBase.draw(this.base, {
      uSrc: this.srcTex!,
      uGeom: toGL(outputToSource(this.srcW, this.srcH, s)),
      uSrcSize: [this.srcW, this.srcH],
      uDistortion: (s.lens.distortion / 100) * 0.22,
      uLensVig: s.lens.vignette / 100,
      uSrcIsSrgbData: this.srcIsSrgbData ? 1 : 0,
      uLensOn: lensOn ? 1 : 0,
      uLensLut: this.lensTex ?? this.curveTex,
    });
    // Pyramid: base, /2, /4 … down to ~32px.
    const levels = this.pyr?.levels ?? [];
    const next: RenderTarget[] = [this.base];
    let lw = w;
    let lh = h;
    let i = 1;
    while (Math.max(lw, lh) > 48 && i < 8) {
      lw = Math.max(1, Math.ceil(lw / 2));
      lh = Math.max(1, Math.ceil(lh / 2));
      const t = this.rt(levels[i] && levels[i] !== this.base ? levels[i] : null, lw, lh);
      const prev = next[i - 1];
      this.sDown.draw(t, { uSrc: prev, uSrcTexel: [1 / prev.width, 1 / prev.height] });
      next.push(t);
      i++;
    }
    for (let j = i; j < levels.length; j++) if (levels[j] !== this.base) levels[j]?.dispose();
    this.pyr = { levels: next };
    this.blurKeys = { T: '', C: '', H: '' };
    void gl;
  }

  /**
   * Local-contrast blurs are only built when an adjustment reads them (texture / clarity /
   * highlights / shadows / dehaze / colour NR / sharpen masking) — skipping them roughly halves
   * the cost of a geometry change, which matters for video where every frame is a new source.
   */
  private ensureBlurs(s: DevelopSettings) {
    const local = (k: 'texture' | 'clarity' | 'highlights' | 'shadows' | 'dehaze') => s.locals.some((l) => l.enabled && l[k] !== 0);
    const masking = s.sharpening.amount > 0 && s.sharpening.masking > 0;
    this.useT = s.texture !== 0 || local('texture') || s.noise.color > 0 || masking;
    this.useC = s.clarity !== 0 || s.highlights !== 0 || s.shadows !== 0 || local('clarity') || local('highlights') || local('shadows') || masking;
    this.useH = s.dehaze !== 0 || local('dehaze');
    const L = Math.max(this.base!.width, this.base!.height);
    if (this.useT && this.blurKeys.T !== this.geomKey) {
      this.blurT = this.blurAt(L * 0.0028, this.blurT, 0);
      this.blurKeys.T = this.geomKey;
    }
    if (this.useC && this.blurKeys.C !== this.geomKey) {
      this.blurC = this.blurAt(L * 0.016, this.blurC, 1);
      this.blurKeys.C = this.geomKey;
    }
    if (this.useH && this.blurKeys.H !== this.geomKey) {
      this.blurH = this.blurAt(L * 0.06, this.blurH, 2);
      this.blurKeys.H = this.geomKey;
    }
  }

  private ensureNR(s: DevelopSettings, scale: number) {
    const key = JSON.stringify([this.geomKey, s.noise.luminance, s.noise.color]);
    if (key === this.nrKey && this.nr) return;
    this.nrKey = key;
    this.sharpKey = '';
    const base = this.base!;
    if (s.noise.luminance <= 0 && s.noise.color <= 0) {
      if (this.nr && this.nr !== base) this.nr.dispose();
      this.nr = base;
      return;
    }
    if (this.nr === base) this.nr = null;
    this.nr = this.rt(this.nr, base.width, base.height);
    this.sNR.draw(this.nr, {
      uBase: base,
      uBlur: this.useT && this.blurT ? this.blurT : base,
      uTexel: [1 / base.width, 1 / base.height],
      uLumNR: s.noise.luminance / 100,
      uColNR: s.noise.color / 100,
      uScale: scale,
    });
  }

  private ensureSharpen(s: DevelopSettings, scale: number) {
    // No sharpening: skip the full-resolution blur (MAIN then reads the NR image, which it ignores).
    if (s.sharpening.amount <= 0) return;
    const sigma = Math.max(0.45, s.sharpening.radius * scale);
    const key = JSON.stringify([this.nrKey, sigma.toFixed(3)]);
    if (key === this.sharpKey && this.blurS) return;
    this.sharpKey = key;
    this.blurS = this.blur(this.nr!, sigma, this.blurS, 3);
  }

  private ensureCurve(s: DevelopSettings) {
    const key = JSON.stringify(s.curve);
    if (key === this.curveKey) return;
    this.curveKey = key;
    const lut = bakeToneCurve(s.curve);
    if (this.curveTex.format === 'rgba16f') this.curveTex.allocate(LUT_SIZE, 1, toHalf(lut));
    else this.curveTex.allocate(LUT_SIZE, 1, Uint8Array.from(lut, (v) => Math.round(v * 255)));
  }

  private ensureMaskTexture(w: number, h: number) {
    const gl = this.gl;
    if (this.maskTex && this.maskSize[0] === w && this.maskSize[1] === h) return;
    if (this.maskTex) gl.deleteTexture(this.maskTex);
    this.maskTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, MAX_LOCALS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maskSize = [w, h];
    this.maskCache.clear();
    this.maskLayerOf.clear();
  }

  /** Rasterises brush strokes (incrementally) and uploads them into the mask texture array. */
  private syncBrushMasks(locals: LocalAdjustment[]) {
    const brushes = locals.filter((l) => l.type === 'brush' && l.enabled).slice(0, MAX_LOCALS);
    if (!brushes.length) return;
    const long = 2048;
    const ar = this.srcW / Math.max(1, this.srcH);
    const mw = ar >= 1 ? long : Math.round(long * ar);
    const mh = ar >= 1 ? Math.round(long / ar) : long;
    this.ensureMaskTexture(mw, mh);
    const gl = this.gl;
    const used = new Set<number>();
    for (const l of brushes) {
      const layer = this.maskLayerOf.get(l.id);
      if (layer !== undefined) used.add(layer);
    }
    for (const l of brushes) {
      let layer = this.maskLayerOf.get(l.id);
      if (layer === undefined) {
        layer = [...Array(MAX_LOCALS).keys()].find((k) => !used.has(k)) ?? 0;
        used.add(layer);
        this.maskLayerOf.set(l.id, layer);
      }
      let cache = this.maskCache.get(l.id);
      // A fresh cache must always be uploaded: the layer may still hold a deleted mask's pixels.
      let fresh = false;
      if (!cache) {
        this.maskCache.set(l.id, (cache = new StrokeRasterCache(mw, mh)));
        fresh = true;
      }
      if (rasterizeStrokes(cache, l.strokes ?? [], this.srcW) || fresh) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
        const d = cache.takeDirty();
        if (fresh || !d || d === 'all') {
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, mw, mh, 1, gl.RED, gl.UNSIGNED_BYTE, cache.canvas as unknown as TexImageSource);
        } else {
          // Incremental stroke: upload just the touched rectangle (red channel).
          const px = cache.ctx.getImageData(d.x, d.y, d.w, d.h).data;
          const r8 = new Uint8Array(d.w * d.h);
          for (let i = 0, j = 0; i < r8.length; i++, j += 4) r8[i] = px[j];
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, d.x, d.y, layer, d.w, d.h, 1, gl.RED, gl.UNSIGNED_BYTE, r8);
        }
      }
    }
    for (const id of [...this.maskLayerOf.keys()]) {
      if (!brushes.some((b) => b.id === id)) {
        this.maskLayerOf.delete(id);
        this.maskCache.delete(id);
      }
    }
  }

  /**
   * Renders `s` at `width`×`height` (output aspect; use fitSize()). Returns the internal result
   * target (RGBA8, sRGB-encoded, rows top-first). Don't dispose it — it's reused.
   * `neutral` renders geometry only (for before/after).
   */
  render(
    s: DevelopSettings,
    width: number,
    height: number,
    opts: {
      neutral?: boolean;
      seed?: number;
      /** Tints the mask of this local adjustment (by id) — Develop's mask overlay. */
      maskOverlay?: string | null;
      /** Overlay colour (linear-ish display RGB) and opacity. Defaults to translucent red. */
      maskOverlayColor?: [number, number, number, number];
    } = {},
  ): RenderTarget {
    if (!this.srcTex) throw new Error('DevelopEngine: no source set');
    const gl = this.gl;
    const [fw] = this.fullSize(s);
    const scale = width / fw;
    this.lastScale = scale;
    this.lastRenderSize = [width, height];
    this.ensureGeometry(s, width, height);
    this.ensureBlurs(s);
    this.ensureNR(s, scale);
    this.ensureSharpen(s, scale);
    this.ensureCurve(s);
    this.syncBrushMasks(s.locals);

    const target = opts.neutral ? (this.neutralResult = this.rt(this.neutralResult, width, height, 'rgba8')) : (this.result = this.rt(this.result, width, height, 'rgba8'));
    const u = this.uniforms(s, width, height, scale, opts.seed ?? 0);
    u.uNeutral = opts.neutral ? 1 : 0;
    // Always set (uniform state persists per program, so a stale overlay must not leak into later renders).
    u.uOverlay = opts.maskOverlay ? s.locals.filter((l) => l.enabled).slice(0, MAX_LOCALS).findIndex((l) => l.id === opts.maskOverlay) : -1;
    u.uOverlayColor = opts.maskOverlayColor ?? [1, 0.12, 0.12, 0.5];
    this.sMain.draw(target, u);
    void gl;
    return target;
  }

  private uniforms(s: DevelopSettings, width: number, height: number, scale: number, seed: number): Record<string, any> {
    const locals = s.locals.filter((l) => l.enabled).slice(0, MAX_LOCALS);
    const LT = new Int32Array(MAX_LOCALS);
    const LG = new Float32Array(MAX_LOCALS * 4);
    const LG2 = new Float32Array(MAX_LOCALS * 4);
    const LA = new Float32Array(MAX_LOCALS * 4);
    const LB = new Float32Array(MAX_LOCALS * 4);
    const LC = new Float32Array(MAX_LOCALS * 4);
    const LAmt = new Float32Array(MAX_LOCALS);
    locals.forEach((l, i) => {
      LT[i] = l.type === 'linear' ? 0 : l.type === 'radial' ? 1 : 2;
      if (l.type === 'linear' && l.linear) LG.set([l.linear.x0, l.linear.y0, l.linear.x1, l.linear.y1], i * 4);
      if (l.type === 'radial' && l.radial) {
        LG.set([l.radial.cx, l.radial.cy, l.radial.rx, l.radial.ry], i * 4);
        LG2.set([(l.radial.angle * Math.PI) / 180, l.radial.feather / 100], i * 4);
      }
      LG2[i * 4 + 2] = this.maskLayerOf.get(l.id) ?? 0;
      LG2[i * 4 + 3] = l.invert ? 1 : 0;
      LA.set([l.exposure, l.contrast, l.highlights, l.shadows], i * 4);
      LB.set([l.whites, l.blacks, l.temperature, l.tint], i * 4);
      LC.set([l.saturation, l.clarity, l.dehaze, l.texture], i * 4);
      LAmt[i] = l.amount / 100;
    });
    const bw = s.treatment === 'bw' || s.profile === 'monochrome';
    const g = s.grading;
    return {
      uImg: this.nr!,
      uBlurS: s.sharpening.amount > 0 && this.blurS ? this.blurS : this.nr!,
      // Unused blurs bind the image itself, making their detail terms exactly zero.
      uBlurT: this.useT ? this.blurT! : this.nr!,
      uBlurC: this.useC ? this.blurC! : this.nr!,
      uBlurH: this.useH ? this.blurH! : this.nr!,
      uCurve: this.curveTex,
      uCurveOn: curveIsIdentity(s.curve) ? 0 : 1,
      uMasks: { tex: this.maskTex!, array: true },
      uGeom: toGL(outputToSource(this.srcW, this.srcH, s)),
      uSrcAspect: this.srcW / Math.max(1, this.srcH),
      uOutSize: [width, height],
      uScale: scale,
      uTempScale: TEMP_SCALE,
      uTintScale: TINT_SCALE,
      uTemp: s.temperature,
      uTint: s.tint,
      uExposure: s.exposure,
      uContrast: s.contrast,
      uHighlights: s.highlights,
      uShadows: s.shadows,
      uWhites: s.whites,
      uBlacks: s.blacks,
      uTexture: s.texture,
      uClarity: s.clarity,
      uDehaze: s.dehaze,
      uVibrance: s.vibrance,
      uSaturation: s.saturation,
      uProfile: PROFILE_PARAMS[s.profile] ?? [0, 0, 0],
      uHslH: s.hsl.hue,
      uHslS: s.hsl.sat,
      uHslL: s.hsl.lum,
      uBW: bw ? 1 : 0,
      uBwMix: s.bwMix,
      uGS: wheelToLab(g.shadows),
      uGM: wheelToLab(g.midtones),
      uGH: wheelToLab(g.highlights),
      uGG: wheelToLab(g.global),
      uGBlend: g.blending / 100,
      uGBalance: g.balance / 100,
      uSharp: [s.sharpening.amount / 100, s.sharpening.detail / 100, s.sharpening.masking / 100, 0],
      uVig: [s.vignette.amount / 100, s.vignette.midpoint / 100, s.vignette.roundness / 100, s.vignette.feather / 100],
      uVigHL: s.vignette.highlights / 100,
      uGrain: [s.grain.amount / 100, s.grain.size / 100, s.grain.roughness / 100],
      uSeed: seed,
      uLocalN: locals.length,
      uLType: LT,
      uLGeom: LG,
      uLGeom2: LG2,
      uLA: LA,
      uLB: LB,
      uLC: LC,
      uLAmt: LAmt,
    };
  }

  /** The most recent render() output. */
  get lastResult(): RenderTarget | null {
    return this.result;
  }
  get lastNeutral(): RenderTarget | null {
    return this.neutralResult;
  }
  get renderScale() {
    return this.lastScale;
  }

  /**
   * Draws a result to the context's canvas. `imgW`/`imgH` is the displayed image size in canvas
   * pixels at view.scale = 1 (usually the result's own size).
   */
  present(
    tex: RenderTarget | Texture,
    view: ViewTransform,
    opts: { imgW?: number; imgH?: number; background?: [number, number, number]; clipping?: boolean; split?: number; before?: RenderTarget | Texture | null; nearest?: boolean } = {},
  ) {
    const gl = this.gl;
    const w = tex instanceof RenderTarget ? tex.width : tex.width;
    const h = tex instanceof RenderTarget ? tex.height : tex.height;
    this.sPresent.draw(null, {
      uTex: tex,
      uTex2: opts.before ?? tex,
      uCanvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      uImgSize: [opts.imgW ?? w, opts.imgH ?? h],
      uView: [view.x, view.y, view.scale],
      uBg: opts.background ?? [0.11, 0.11, 0.11],
      uClip: opts.clipping ? 1 : 0,
      uSplit: opts.split ?? -1,
      uNearest: opts.nearest ? 1 : 0,
    });
  }

  /** 256-bin histograms of the last result (computed on a ≤256px downsample). */
  histogram(target: RenderTarget | null = this.result): Histogram {
    const r = new Uint32Array(256);
    const g = new Uint32Array(256);
    const b = new Uint32Array(256);
    const l = new Uint32Array(256);
    if (!target) return { r, g, b, l, max: 1, clipHigh: 0, clipLow: 0 };
    const k = Math.min(1, 256 / Math.max(target.width, target.height));
    const w = Math.max(1, Math.round(target.width * k));
    const h = Math.max(1, Math.round(target.height * k));
    this.tmp[7] = this.rt(this.tmp[7] ?? null, w, h, 'rgba8');
    this.sDown.draw(this.tmp[7], { uSrc: target, uSrcTexel: [0.5 / w, 0.5 / h] });
    const px = this.tmp[7].read() as Uint8Array;
    let hiClip = 0;
    let loClip = 0;
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i];
      const G = px[i + 1];
      const B = px[i + 2];
      r[R]++;
      g[G]++;
      b[B]++;
      l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
      if (R >= 254 || G >= 254 || B >= 254) hiClip++;
      if (R <= 1 && G <= 1 && B <= 1) loClip++;
    }
    let max = 1;
    for (let i = 1; i < 255; i++) max = Math.max(max, r[i], g[i], b[i]);
    const n = px.length / 4;
    return { r, g, b, l, max, clipHigh: hiClip / n, clipLow: loClip / n };
  }

  /**
   * Average linear RGB of the *base* image (before any adjustment) around output uv — feed to
   * whiteBalanceFrom() for the WB eyedropper.
   */
  sampleBase(u: number, v: number, radius = 3): [number, number, number] {
    const base = this.base;
    if (!base) return [0.5, 0.5, 0.5];
    const cx = Math.round(u * (base.width - 1));
    const cy = Math.round(v * (base.height - 1));
    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const x1 = Math.min(base.width - 1, cx + radius);
    const y1 = Math.min(base.height - 1, cy + radius);
    const data = base.read(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    let r = 0;
    let g = 0;
    let b = 0;
    const n = data.length / 4;
    const scale = data instanceof Uint8Array ? 1 / 255 : 1;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    return [(r / n) * scale, (g / n) * scale, (b / n) * scale];
  }

  /** Mean linear RGB of the whole base image (gray-world). */
  averageBase(): [number, number, number] {
    const levels = this.pyr?.levels;
    if (!levels) return [0.5, 0.5, 0.5];
    const t = levels[levels.length - 1];
    const data = t.read();
    let r = 0;
    let g = 0;
    let b = 0;
    const scale = data instanceof Uint8Array ? 1 / 255 : 1;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    const n = data.length / 4;
    return [(r / n) * scale, (g / n) * scale, (b / n) * scale];
  }

  /** Renders at full (or capped) resolution and returns ImageData. Disposes nothing. */
  renderImageData(s: DevelopSettings, maxW = Infinity, maxH = Infinity, seed = 0): ImageData {
    const [w, h] = Number.isFinite(maxW) || Number.isFinite(maxH) ? this.fitSize(s, maxW, maxH) : this.fullSize(s);
    return this.render(s, w, h, { seed }).toImageData();
  }

  /** Frees the large intermediate targets (keeps the source) — call after a full-res export. */
  trim() {
    for (const t of [this.base, this.blurT, this.blurC, this.blurH, this.blurS, this.result, this.neutralResult, ...this.tmp]) t?.dispose();
    if (this.nr && this.nr !== this.base) this.nr.dispose();
    this.pyr?.levels.slice(1).forEach((t) => t.dispose());
    this.base = this.blurT = this.blurC = this.blurH = this.blurS = this.result = this.neutralResult = this.nr = null;
    this.pyr = null;
    this.tmp = [];
    this.geomKey = this.nrKey = this.sharpKey = '';
    this.blurKeys = { T: '', C: '', H: '' };
  }

  dispose() {
    this.trim();
    this.releaseSource();
    this.curveTex.dispose();
    this.lensTex?.dispose();
    this.toneTex?.dispose();
    if (this.maskTex) this.gl.deleteTexture(this.maskTex);
    for (const s of [this.sBase, this.sDown, this.sBlur, this.sNR, this.sMain, this.sPresent, this.sDecode16]) s?.dispose();
  }

  get lastSize() {
    return this.lastRenderSize;
  }
  orientedSourceSize(s: DevelopSettings): [number, number] {
    return orientedSize(this.srcW, this.srcH, s.orientation);
  }
}

function expandRGB8(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
    out[j] = src[i];
    out[j + 1] = src[i + 1];
    out[j + 2] = src[i + 2];
    out[j + 3] = 255;
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// White balance / auto tone helpers

/** Temperature/tint that neutralise the given linear RGB (eyedropper or gray-world). */
export function whiteBalanceFrom(rgb: [number, number, number]): { temperature: number; tint: number } {
  const [r, g, b] = rgb.map((v) => Math.max(v, 1e-5)) as [number, number, number];
  // Shader: wb = (2^(kT/2), 2^(-kN), 2^(-kT/2)). Equalising r and b gives kT = log2(b/r);
  // r and b then sit at sqrt(r*b), and green is balanced against that.
  const temperature = (100 * Math.log2(b / r)) / TEMP_SCALE;
  const tint = (-100 * Math.log2(Math.sqrt(r * b) / g)) / TINT_SCALE;
  const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));
  return { temperature: clamp(temperature), tint: clamp(tint) };
}

/** Lightroom-style "Auto" tone from a neutral-render histogram. */
export function autoTone(hist: Histogram): Partial<DevelopSettings> {
  const total = hist.l.reduce((a, b) => a + b, 0) || 1;
  const pct = (p: number) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist.l[i];
      if (acc / total >= p) return i / 255;
    }
    return 1;
  };
  const p01 = pct(0.005);
  const p50 = pct(0.5);
  const p995 = pct(0.995);
  const clampR = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
  const exposure = Math.max(-2, Math.min(2, 2.2 * Math.log2(0.46 / Math.max(p50, 0.02)) * 0.7));
  const ev = Math.round(exposure * 100) / 100;
  const after = (x: number) => Math.min(1, x * 2 ** (ev / 2.2));
  const whites = clampR((0.97 - after(p995)) * 250, -40, 60);
  const blacks = clampR((0.02 - after(p01)) * 600, -60, 30);
  const spread = after(p995) - after(p01);
  const contrast = clampR((0.85 - spread) * 60, -20, 30);
  const highlights = clampR(-hist.clipHigh * 900 - (after(p995) > 0.95 ? 20 : 0), -80, 0);
  const shadows = clampR((0.3 - after(pct(0.2))) * 150, 0, 60);
  return { exposure: ev, contrast, highlights, shadows, whites, blacks, vibrance: 10 };
}
