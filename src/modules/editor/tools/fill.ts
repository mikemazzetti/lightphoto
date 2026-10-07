import { cachedShader, RenderTarget, Texture } from '@/core/gl/gl';
import { blendModeId } from '@/core/gl/glsl';
import { toast } from '@/state/app';
import { bus } from '../model/bus';
import { capturePatch, Doc } from '../model/doc';
import { rectIntersect } from '../model/geom';
import { Selection } from '../model/selection';
import { edState, GradientOpts, setFg, touch } from '../model/store';
import type { GradientStop, Layer, RGBA } from '../model/types';
import { bakeGradient, reverseStops } from '../render/adjustments';
import { Compositor, getCompositor } from '../render/compositor';
import { GRADIENT_FS } from '../render/shaders';
import { antialiasMask, floodMask } from '../paint/fill';
import { growToDoc } from '../paint/stroke';
import { fillArea } from '../ops/edit';
import { commit, ensureRaster } from '../ops/layers';
import { samplePixels } from '../ops/select';
import { sampleColor } from './paint';
import type { Tool, ToolEnv, ToolPointer } from './types';
import { drawHandle, strokeHalo } from './types';

export function gradientStops(o: GradientOpts, fg: RGBA, bg: RGBA): GradientStop[] {
  let stops: GradientStop[];
  if (o.preset === 'fgbg') stops = [{ pos: 0, color: { ...fg, a: 1 } }, { pos: 1, color: { ...bg, a: 1 } }];
  else if (o.preset === 'fgtrans') stops = [{ pos: 0, color: { ...fg, a: 1 } }, { pos: 1, color: { ...fg, a: 0 } }];
  else if (o.preset === 'bw') stops = [{ pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { pos: 1, color: { r: 255, g: 255, b: 255, a: 1 } }];
  else stops = o.custom;
  return o.reverse ? reverseStops(stops) : stops;
}

export function gradientCss(stops: GradientStop[]) {
  return `linear-gradient(90deg, ${[...stops].sort((a, b) => a.pos - b.pos).map((s) => `rgba(${s.color.r},${s.color.g},${s.color.b},${s.color.a}) ${s.pos * 100}%`).join(', ')})`;
}

interface GradDrag {
  doc: Doc;
  layer: Layer;
  mask: boolean;
  /** Undoes the surface growth when nothing gets drawn. */
  ungrow: (() => void) | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ramp: Texture;
  out: RenderTarget | null;
  moved: boolean;
}
let grad: GradDrag | null = null;

const TYPE_ID = { linear: 0, radial: 1, angle: 2, reflected: 3, diamond: 4 } as const;

function renderGradient(c: Compositor, g: GradDrag, src: Texture | RenderTarget, out: RenderTarget) {
  const o = edState().opts.gradient;
  const surf = g.mask ? g.layer.mask!.surf : g.layer.surf!;
  const ox = g.mask ? g.layer.mask!.x : g.layer.x;
  const oy = g.mask ? g.layer.mask!.y : g.layer.y;
  const doc = g.doc;
  cachedShader(c.gl, 'ed-gradient', GRADIENT_FS).draw(out, {
    uSrc: src,
    uRamp: g.ramp,
    uOrigin: [ox, oy],
    uSize: [surf.width, surf.height],
    uP0: [g.x0, g.y0],
    uP1: [g.x1, g.y1],
    uType: TYPE_ID[o.type],
    uOpacity: o.opacity / 100,
    uBlend: blendModeId(o.blend),
    uDither: o.dither ? 1 : 0,
    uLockAlpha: !g.mask && g.layer.lockTransparency ? 1 : 0,
    uMaskTarget: g.mask ? 1 : 0,
    uSel: doc.selection ? c.selectionTex(doc) : c.dummyTex,
    uSelOn: doc.selection ? 1 : 0,
    uDocSize: [doc.width, doc.height],
  });
}

function constrain(p: ToolPointer, x0: number, y0: number): [number, number] {
  if (!p.shift) return [p.x, p.y];
  const dx = p.x - x0;
  const dy = p.y - y0;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len];
}

function endGradient(apply: boolean) {
  const g = grad;
  grad = null;
  bus.requestOverlay();
  if (!g) return;
  const c = getCompositor();
  const doc = g.doc;
  if (doc.preview?.layerId === g.layer.id) doc.preview = null;
  c?.clearPreviewCache();
  let applied = false;
  if (apply && c && g.moved) {
    const surf = g.mask ? g.layer.mask!.surf : g.layer.surf!;
    const ox = g.mask ? g.layer.mask!.x : g.layer.x;
    const oy = g.mask ? g.layer.mask!.y : g.layer.y;
    const out = c.pool.acquire(surf.width, surf.height);
    renderGradient(c, g, c.tex(surf), out);
    const full = { x: 0, y: 0, w: surf.width, h: surf.height };
    const sel = doc.selection;
    const region = sel ? rectIntersect({ ...sel.bounds, x: sel.bounds.x - ox, y: sel.bounds.y - oy }, full) : full;
    if (region) {
      const px = out.read(region.x, region.y, region.w, region.h) as Uint8Array;
      const patch = capturePatch(surf, region);
      surf.ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), region.w, region.h), region.x, region.y);
      surf.touch(region);
      doc.touchLayer(g.layer);
      commit(doc, 'Gradient', { patches: [patch], structural: !!g.ungrow });
      applied = true;
    }
    c.pool.release(out);
  }
  // Cancelled / plain click: put the original surface back instead of recording the growth.
  if (!applied && g.ungrow) {
    g.ungrow();
    doc.touchLayer(g.layer);
  }
  g.out?.dispose();
  g.ramp.dispose();
  doc.invalidate();
  touch();
}

export const gradientTool: Tool = {
  cursor: () => 'crosshair',
  down(env, p) {
    const doc = env.doc;
    const c = getCompositor();
    if (!c) return;
    if (grad) endGradient(false);
    if (p.alt) {
      const col = sampleColor(doc, p.x, p.y, 1, true);
      if (col) useFg(col);
      return;
    }
    const l = doc.activeLayer;
    if (!l) return;
    const mask = !!l.mask && (doc.editMask || l.kind === 'adjustment' || l.kind === 'fill');
    if (!mask) {
      if (l.lockAll || l.lockPixels) return void toast(`"${l.name}" is locked.`, 'warn');
      if (l.kind !== 'raster') {
        void ensureRaster(doc, l).then(() => touch());
        return;
      }
    }
    const ungrow = growToDoc(doc, l, mask ? 'mask' : 'pixels');
    const s = edState();
    const stops = gradientStops(s.opts.gradient, s.fg, s.bg);
    const ramp = Texture.create(c.gl, 256, 1, { data: bakeGradient(stops) });
    grad = { doc, layer: l, mask, ungrow, x0: p.x, y0: p.y, x1: p.x, y1: p.y, ramp, out: null, moved: false };
    const g = grad;
    const proc = {
      key: '0',
      run: (src: Texture | RenderTarget) => {
        // No gradient until the pointer has moved (a zero-length one would flood the layer).
        if (!g.moved) return src;
        const surf = g.mask ? g.layer.mask!.surf : g.layer.surf!;
        if (!g.out || g.out.width !== surf.width || g.out.height !== surf.height) {
          g.out?.dispose();
          g.out = new RenderTarget(c.gl, surf.width, surf.height, 'rgba8', 'linear');
        }
        renderGradient(c, g, src, g.out);
        return g.out;
      },
    };
    doc.preview = mask ? { layerId: l.id, maskProcess: proc } : { layerId: l.id, process: proc };
  },
  move(env, p) {
    const g = grad;
    if (!g) return;
    const [x, y] = constrain(p, g.x0, g.y0);
    g.x1 = x;
    g.y1 = y;
    const [sx0, sy0] = env.toScreen(g.x0, g.y0);
    if (Math.hypot(p.sx - sx0, p.sy - sy0) > 2) g.moved = true;
    const pv = g.doc.preview;
    const proc = pv?.process ?? pv?.maskProcess;
    if (proc && g.moved) {
      proc.key = `${g.x1.toFixed(2)},${g.y1.toFixed(2)}`;
      g.doc.invalidate();
    }
    bus.requestOverlay();
  },
  up() {
    endGradient(true);
  },
  key(_env, e) {
    if (e.key === 'Escape' && grad) {
      endGradient(false);
      return true;
    }
    return false;
  },
  overlay(env, ctx) {
    if (!grad || !grad.moved) return;
    const [x0, y0] = env.toScreen(grad.x0, grad.y0);
    const [x1, y1] = env.toScreen(grad.x1, grad.y1);
    strokeHalo(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    });
    drawHandle(ctx, x0, y0, 6);
    drawHandle(ctx, x1, y1, 6);
  },
  deactivate() {
    endGradient(false);
  },
  busy: () => !!grad,
};

function useFg(c: RGBA) {
  setFg({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: 1 });
}

// ---------------------------------------------------------------------------------------------

export const bucketTool: Tool = {
  cursor: () => 'crosshair',
  down(env: ToolEnv, p: ToolPointer) {
    const doc = env.doc;
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    if (p.alt) {
      const col = sampleColor(doc, p.x, p.y, 1, true);
      if (col) useFg(col);
      return;
    }
    const s = edState();
    const o = s.opts.bucket;
    const px = samplePixels(doc, o.sampleAll);
    let m = floodMask(px, doc.width, doc.height, p.x, p.y, o.tolerance, o.contiguous);
    if (o.antialias) m = antialiasMask(m, doc.width, doc.height);
    let sel = Selection.fromFull(doc.width, doc.height, m);
    if (doc.selection) sel = Selection.combine(doc.selection, sel, 'intersect');
    if (!sel) return;
    void fillArea(doc, o.source === 'fg' ? s.fg : s.bg, { opacity: o.opacity / 100, blend: o.blend, selection: sel, label: 'Paint Bucket' });
  },
};
