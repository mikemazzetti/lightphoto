/**
 * WebGL2 sequence compositor. One instance per GL context (program monitor, export).
 *
 * Per frame: accumulator := background; for each video track bottom→top the clip's source texture
 * is processed in source space (Lumetri via DevelopEngine, effect passes), then placed with its
 * motion transform, crop, opacity and blend mode. Transitions render both sides into layer targets
 * and mix them first. Everything stays on the GPU; the accumulator is RGBA8 premultiplied.
 */
import { DevelopEngine } from '@/core/develop/engine';
import { DevelopSettings, isNeutral } from '@/core/develop/settings';
import { caps, createGL, GL, RenderTarget, Shader, TargetPool, Texture } from '@/core/gl/gl';
import { blendModeId } from '@/core/gl/glsl';
import { hexToRgba } from '@/core/util/color';
import type { LayerEval, TrackPlan } from '../model/evaluate';
import type { Clip, Effect, Lumetri, TransitionType } from '../model/types';
import { BLUR_FS, COMPOSITE_FS, FX_FS, LUMETRI_POST_FS, PRESENT_FS, TRANSITION_FS } from './shaders';
import { renderTitle, titleKey } from './titles';

export type LayerSource =
  | { kind: 'tex'; tex: Texture; w: number; h: number; premul?: boolean }
  | { kind: 'solid'; color: [number, number, number, number]; w: number; h: number };

export interface RenderJob {
  plan: TrackPlan[];
  seqW: number;
  seqH: number;
  /** Render resolution factor (playback resolution / export scaling). */
  scale: number;
  bg: string;
  /** Texture for video / image layers (null = not ready → skipped). */
  source: (layer: LayerEval) => LayerSource | null;
}

const neutralCache = new WeakMap<DevelopSettings, boolean>();
export function lumetriActive(l: Lumetri | null | undefined): l is Lumetri {
  if (!l || !l.enabled) return false;
  if (l.faded > 0) return true;
  let n = neutralCache.get(l.s);
  if (n === undefined) neutralCache.set(l.s, (n = isNeutral(l.s)));
  return !n;
}

const TRANSITION_IDS: Record<TransitionType, number> = { crossDissolve: 0, dipToBlack: 1, dipToWhite: 1, wipe: 2, slide: 3, push: 4 };
const FX_IDS: Record<string, number> = { bw: 1, invert: 2, tint: 3, mirror: 4, hflip: 5, vflip: 6, crop: 7, brightness: 8, posterize: 9, sharpen: 10 };

const hex3 = (h: string): [number, number, number] => {
  const c = hexToRgba(h);
  return [c.r / 255, c.g / 255, c.b / 255];
};

export class Compositor {
  readonly gl: GL;
  private sComp: Shader;
  private sTrans: Shader;
  private sFx: Shader;
  private sBlur: Shader;
  private sPost: Shader;
  private sPresent: Shader;
  private pool: TargetPool;
  private engine: DevelopEngine | null = null;
  private acc: RenderTarget[] = [];
  private cur = 0;
  private titles = new Map<string, Texture>();
  private images = new Map<string, Texture>();
  private empty: Texture;
  private temps: RenderTarget[] = [];
  private W = 1;
  private H = 1;
  lost = false;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, opts: { preserve?: boolean } = {}) {
    this.gl = createGL(canvas, { alpha: false, preserveDrawingBuffer: opts.preserve ?? false });
    const gl = this.gl;
    this.sComp = new Shader(gl, COMPOSITE_FS);
    this.sTrans = new Shader(gl, TRANSITION_FS);
    this.sFx = new Shader(gl, FX_FS);
    this.sBlur = new Shader(gl, BLUR_FS);
    this.sPost = new Shader(gl, LUMETRI_POST_FS);
    this.sPresent = new Shader(gl, PRESENT_FS);
    this.pool = new TargetPool(gl);
    this.empty = Texture.create(gl, 1, 1, { data: new Uint8Array(4) });
    if ('addEventListener' in canvas)
      (canvas as HTMLCanvasElement).addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
  }

  get maxTextureSize() {
    return caps(this.gl).maxTextureSize;
  }

  /** A blank texture owned by the caller (for video frames). */
  createTexture(): Texture {
    return Texture.create(this.gl, 2, 2, { data: new Uint8Array(16) });
  }

  /** Cached mipmapped texture for a still image. */
  imageTexture(key: string, bmp: ImageBitmap): Texture {
    let t = this.images.get(key);
    if (!t) {
      t = Texture.fromSource(this.gl, bmp, { filter: 'mipmap' });
      this.images.set(key, t);
      if (this.images.size > 48) {
        const [k, v] = this.images.entries().next().value!;
        v.dispose();
        this.images.delete(k);
      }
    }
    return t;
  }

  private titleTexture(clip: Clip, w: number, h: number): Texture | null {
    if (!clip.title) return null;
    const key = clip.id + '|' + titleKey(clip.title, w, h);
    let t = this.titles.get(key);
    if (t) {
      this.titles.delete(key);
      this.titles.set(key, t);
      return t;
    }
    // Drop stale versions of this clip's title.
    for (const [k, v] of this.titles)
      if (k.startsWith(clip.id + '|')) {
        v.dispose();
        this.titles.delete(k);
      }
    const canvas = renderTitle(clip.title, w, h);
    t = Texture.fromSource(this.gl, canvas as TexImageSource, { filter: 'linear' });
    this.titles.set(key, t);
    while (this.titles.size > 32) {
      const [k, v] = this.titles.entries().next().value!;
      v.dispose();
      this.titles.delete(k);
    }
    return t;
  }

  private getEngine(): DevelopEngine {
    if (!this.engine) this.engine = new DevelopEngine(this.gl);
    return this.engine;
  }

  private ensureAcc(W: number, H: number) {
    if (this.acc.length && this.acc[0].width === W && this.acc[0].height === H) return;
    this.acc.forEach((a) => a.dispose());
    this.acc = [new RenderTarget(this.gl, W, H, 'rgba8', 'linear'), new RenderTarget(this.gl, W, H, 'rgba8', 'linear')];
    this.cur = 0;
  }

  private temp(w: number, h: number): RenderTarget {
    const t = this.pool.acquire(w, h, 'rgba8', 'linear');
    this.temps.push(t);
    return t;
  }

  private releaseTemps() {
    for (const t of this.temps) this.pool.release(t);
    this.temps = [];
  }

  /** Renders a frame; returns the accumulator holding the result (valid until the next render). */
  render(job: RenderJob): RenderTarget {
    const W = Math.max(2, Math.round(job.seqW * job.scale));
    const H = Math.max(2, Math.round(job.seqH * job.scale));
    this.W = W;
    this.H = H;
    this.ensureAcc(W, H);
    for (const a of this.acc) a.texture.setFilter('linear');
    const [r, g, b] = hex3(job.bg);
    this.acc[this.cur].clear(r, g, b, 1);
    for (const tp of job.plan) {
      const it = tp.item;
      try {
        if (it.kind === 'layer') this.drawLayer(it.layer, job, null);
        else if (it.kind === 'adjust') this.adjust(it.layer, job);
        else this.transition(it.a, it.b, it.type, it.p, it.direction, job);
      } finally {
        this.releaseTemps();
      }
    }
    return this.acc[this.cur];
  }

  private resolveSource(layer: LayerEval, job: RenderJob): LayerSource | null {
    const k = layer.media.kind;
    if (k === 'title') {
      const t = this.titleTexture(layer.clip, job.seqW, job.seqH);
      return t ? { kind: 'tex', tex: t, w: job.seqW, h: job.seqH } : null;
    }
    if (k === 'matte') {
      const c = hexToRgba(layer.clip.color ?? layer.media.color ?? '#000000');
      return { kind: 'solid', color: [c.r / 255, c.g / 255, c.b / 255, c.a], w: job.seqW, h: job.seqH };
    }
    if (k === 'adjustment' || k === 'audio') return null;
    return job.source(layer);
  }

  private baseScale(layer: LayerEval, w: number, h: number, job: RenderJob) {
    const k = layer.media.kind;
    if (!layer.clip.fit || (k !== 'video' && k !== 'image')) return 1;
    return Math.min(job.seqW / Math.max(1, w), job.seqH / Math.max(1, h));
  }

  /** Column-major mat3 mapping sequence pixels → source uv (inverse motion transform). */
  private matrix(layer: LayerEval, w: number, h: number, job: RenderJob): Float32Array {
    const base = this.baseScale(layer, w, h, job);
    let sx = layer.sx * base;
    let sy = layer.sy * base;
    if (Math.abs(sx) < 1e-6) sx = 1e-6;
    if (Math.abs(sy) < 1e-6) sy = 1e-6;
    const px = job.seqW / 2 + layer.x;
    const py = job.seqH / 2 + layer.y;
    const ax = w / 2 + layer.anchorX;
    const ay = h / 2 + layer.anchorY;
    const th = (-layer.rotation * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const m00 = c / (sx * w);
    const m01 = -s / (sx * w);
    const m02 = ax / w - (c * px - s * py) / (sx * w);
    const m10 = s / (sy * h);
    const m11 = c / (sy * h);
    const m12 = ay / h - (s * px + c * py) / (sy * h);
    return new Float32Array([m00, m10, 0, m01, m11, 0, m02, m12, 1]);
  }

  private identity(job: RenderJob): Float32Array {
    return new Float32Array([1 / job.seqW, 0, 0, 0, 1 / job.seqH, 0, 0, 0, 1]);
  }

  /**
   * Applies Lumetri and the effect stack in source space. `displayScale` = output pixels per logical
   * source pixel; processing happens at (at most) that resolution.
   */
  private process(clip: Clip, src: LayerSource, displayScale: number, jobScale: number): LayerSource {
    const lum = lumetriActive(clip.lumetri) ? clip.lumetri : null;
    const fxs = clip.fx.filter((e) => e.enabled && this.fxIsActive(e));
    if (!lum && !fxs.length) return src;
    const maxT = this.maxTextureSize;
    const texW = src.kind === 'tex' ? src.tex.width : Math.min(maxT, this.W);
    const texH = src.kind === 'tex' ? src.tex.height : Math.min(maxT, this.H);
    const k = Math.min(1, Math.max(0.05, (displayScale * src.w) / Math.max(1, texW)));
    const pw = Math.max(2, Math.min(maxT, Math.round(texW * k)));
    const ph = Math.max(2, Math.min(maxT, Math.round(texH * k)));
    let cur: Texture;
    if (src.kind === 'solid') {
      const t = this.temp(pw, ph);
      t.clear(src.color[0], src.color[1], src.color[2], src.color[3]);
      cur = t.texture;
    } else if (src.premul) {
      // Effects work on straight alpha.
      const t = this.temp(pw, ph);
      this.sFx.draw(t, { uTex: src.tex, uSize: [pw, ph], uType: 11, uP: [0, 0, 0, 0], uP2: [0, 0, 0, 0], uC1: [0, 0, 0], uC2: [1, 1, 1] });
      cur = t.texture;
    } else cur = src.tex;
    if (lum) {
      const eng = this.getEngine();
      eng.setSourceTexture(cur, true);
      const res = eng.render(lum.s, pw, ph);
      const out = this.temp(pw, ph);
      this.sPost.draw(out, { uRes: res, uSrc: cur, uFaded: lum.faded });
      cur = out.texture;
    }
    // Working-texture texels per sequence pixel (pixel-sized parameters are in sequence pixels).
    const tpsp = (pw / Math.max(1, src.w)) * (jobScale / Math.max(1e-6, displayScale));
    for (const e of fxs) cur = this.applyFx(e, cur, pw, ph, tpsp);
    return { kind: 'tex', tex: cur, w: src.w, h: src.h };
  }

  private fxIsActive(e: Effect): boolean {
    const p = e.params;
    switch (e.type) {
      case 'blur':
        return (p.radius as number) > 0.01;
      case 'sharpen':
        return (p.amount as number) > 0;
      case 'invert':
        return (p.mix as number) > 0;
      case 'tint':
        return (p.amount as number) > 0;
      case 'crop':
        return (p.l as number) + (p.t as number) + (p.r as number) + (p.b as number) > 0;
      case 'brightness':
        return !!(p.brightness as number) || !!(p.contrast as number);
    }
    return true;
  }

  private applyFx(e: Effect, tex: Texture, pw: number, ph: number, tpsp: number): Texture {
    const p = e.params;
    const num = (k: string, d = 0) => (typeof p[k] === 'number' ? (p[k] as number) : d);
    if (e.type === 'blur') {
      const sigma = Math.max(0.3, num('radius') * 0.5 * tpsp);
      const step = Math.max(1, sigma / 4);
      const a = this.temp(pw, ph);
      const b = this.temp(pw, ph);
      const repeat = p.repeatEdges !== false ? 1 : 0;
      this.sBlur.draw(a, { uTex: tex, uStep: [step / pw, 0], uSigma: sigma / step, uRepeat: repeat });
      this.sBlur.draw(b, { uTex: a, uStep: [0, step / ph], uSigma: sigma / step, uRepeat: repeat });
      return b.texture;
    }
    const out = this.temp(pw, ph);
    const u: Record<string, any> = { uTex: tex, uSize: [pw, ph], uType: FX_IDS[e.type] ?? 0, uP: [0, 0, 0, 0], uP2: [0, 0, 0, 0], uC1: [0, 0, 0], uC2: [1, 1, 1] };
    switch (e.type) {
      case 'invert':
        u.uP = [num('mix', 100) / 100, 0, 0, 0];
        break;
      case 'tint':
        u.uP = [num('amount', 100) / 100, 0, 0, 0];
        u.uC1 = hex3(String(p.black ?? '#000000'));
        u.uC2 = hex3(String(p.white ?? '#ffffff'));
        break;
      case 'mirror':
        u.uP = [num('center', 50) / 100, (num('angle') * Math.PI) / 180, 0, 0];
        break;
      case 'crop':
        u.uP = [num('l') / 100, num('t') / 100, num('r') / 100, num('b') / 100];
        u.uP2 = [num('feather') * tpsp, 0, 0, 0];
        break;
      case 'brightness':
        u.uP = [num('brightness') / 200, 1 + num('contrast') / 100, 0, 0];
        break;
      case 'posterize':
        u.uP = [num('levels', 6), 0, 0, 0];
        break;
      case 'sharpen':
        u.uP = [num('amount', 50) / 50, 0, 0, 0];
        break;
    }
    this.sFx.draw(out, u);
    return out.texture;
  }

  private cropOf(clip: Clip): [number, number, number, number] {
    const m = clip.motion;
    return [m.cropL / 100, m.cropT / 100, m.cropR / 100, m.cropB / 100];
  }

  /** Effective on-screen scale of a layer's source pixels (for processing resolution). */
  private displayScale(layer: LayerEval, w: number, h: number, job: RenderJob) {
    return this.baseScale(layer, w, h, job) * Math.max(Math.abs(layer.sx), Math.abs(layer.sy)) * job.scale;
  }

  /**
   * Draws a layer onto the accumulator (dst = null) or into `dst` (transparent background, for
   * transitions).
   */
  private drawLayer(layer: LayerEval, job: RenderJob, dst: RenderTarget | null) {
    const src0 = this.resolveSource(layer, job);
    if (!src0) return;
    const src = this.process(layer.clip, src0, this.displayScale(layer, src0.w, src0.h, job), job.scale);
    const M = this.matrix(layer, src.w, src.h, job);
    const solid = src.kind === 'solid';
    const u = {
      uSrc: solid ? this.empty : src.tex,
      uM: M,
      uSeq: [job.seqW, job.seqH],
      uCrop: this.cropOf(layer.clip),
      uOpacity: layer.opacity,
      uBlend: dst ? 0 : blendModeId(layer.clip.blend),
      uPremul: !solid && src.premul ? 1 : 0,
      uSolidOn: solid ? 1 : 0,
      uSolid: solid ? src.color : [0, 0, 0, 0],
    };
    if (dst) {
      this.sComp.draw(dst, { ...u, uAcc: this.empty, uHasAcc: 0 });
      return;
    }
    const from = this.acc[this.cur];
    const to = this.acc[1 - this.cur];
    this.sComp.draw(to, { ...u, uAcc: from, uHasAcc: 1 });
    this.cur = 1 - this.cur;
  }

  private adjust(layer: LayerEval, job: RenderJob) {
    const from = this.acc[this.cur];
    const src: LayerSource = { kind: 'tex', tex: from.texture, w: job.seqW, h: job.seqH, premul: false };
    const out = this.process(layer.clip, src, job.scale, job.scale);
    if (out === src || out.kind !== 'tex') return;
    const to = this.acc[1 - this.cur];
    this.sComp.draw(to, {
      uSrc: out.tex,
      uAcc: from,
      uHasAcc: 1,
      uM: this.identity(job),
      uSeq: [job.seqW, job.seqH],
      uCrop: this.cropOf(layer.clip),
      uOpacity: layer.opacity,
      uBlend: blendModeId(layer.clip.blend),
      uPremul: 0,
      uSolidOn: 0,
      uSolid: [0, 0, 0, 0],
    });
    this.cur = 1 - this.cur;
  }

  private transition(a: LayerEval | null, b: LayerEval | null, type: TransitionType, p: number, direction: number, job: RenderJob) {
    const W = this.W;
    const H = this.H;
    const la = a ? this.temp(W, H) : null;
    const lb = b ? this.temp(W, H) : null;
    if (la) {
      la.clear(0, 0, 0, 0);
      this.drawLayer(a!, job, la);
    }
    if (lb) {
      lb.clear(0, 0, 0, 0);
      this.drawLayer(b!, job, lb);
    }
    const out = this.temp(W, H);
    const rad = (direction * Math.PI) / 180;
    this.sTrans.draw(out, {
      uA: la ?? this.empty,
      uB: lb ?? this.empty,
      uHasA: la ? 1 : 0,
      uHasB: lb ? 1 : 0,
      uType: TRANSITION_IDS[type] ?? 0,
      uP: p,
      uDir: [Math.round(Math.cos(rad) * 1e6) / 1e6, Math.round(Math.sin(rad) * 1e6) / 1e6],
      uColor: type === 'dipToWhite' ? [1, 1, 1] : [0, 0, 0],
      uSoft: 0.004,
    });
    const blendClip = (b ?? a)!.clip;
    const from = this.acc[this.cur];
    const to = this.acc[1 - this.cur];
    this.sComp.draw(to, {
      uSrc: out,
      uAcc: from,
      uHasAcc: 1,
      uM: this.identity(job),
      uSeq: [job.seqW, job.seqH],
      uCrop: [0, 0, 0, 0],
      uOpacity: 1,
      uBlend: blendModeId(blendClip.blend),
      uPremul: 1,
      uSolidOn: 0,
      uSolid: [0, 0, 0, 0],
    });
    this.cur = 1 - this.cur;
  }

  /** Draws a render result into the canvas at `rect` (canvas pixels, top-left origin). */
  present(result: RenderTarget, rect: [number, number, number, number], bg: [number, number, number] = [0.07, 0.07, 0.075]) {
    const gl = this.gl;
    const k = rect[2] / result.width;
    if (k < 0.7) {
      result.texture.setFilter('mipmap');
      result.texture.generateMipmaps();
    } else result.texture.setFilter('linear');
    this.sPresent.draw(null, { uTex: result, uRect: rect, uCanvas: [gl.drawingBufferWidth, gl.drawingBufferHeight], uBg: bg });
  }

  /** Clears the visible canvas. */
  clearScreen(bg: [number, number, number] = [0.07, 0.07, 0.075]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Copies the result 1:1 into the canvas (export: canvas sized to the output). */
  blit(result: RenderTarget) {
    const gl = this.gl;
    result.texture.setFilter('linear');
    this.sPresent.draw(null, { uTex: result, uRect: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight], uCanvas: [gl.drawingBufferWidth, gl.drawingBufferHeight], uBg: [0, 0, 0] });
  }

  dispose() {
    this.engine?.dispose();
    this.pool.dispose();
    this.acc.forEach((a) => a.dispose());
    this.titles.forEach((t) => t.dispose());
    this.images.forEach((t) => t.dispose());
    this.empty.dispose();
    for (const s of [this.sComp, this.sTrans, this.sFx, this.sBlur, this.sPost, this.sPresent]) s.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
