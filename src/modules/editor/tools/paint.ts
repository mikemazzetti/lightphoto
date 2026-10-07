import { toast } from '@/state/app';
import type { RGBA } from '@/core/util/color';
import { bus } from '../model/bus';
import type { Doc } from '../model/doc';
import { ctx2d, makeCanvas } from '../model/surface';
import { edState, setBg, setFg, ToolId, touch } from '../model/store';
import type { Layer } from '../model/types';
import { getCompositor } from '../render/compositor';
import { ensureRaster } from '../ops/layers';
import { lastStrokePoint, StrokeOptions, StrokeSession } from '../paint/stroke';
import type { RetouchTool } from '../paint/retouch';
import type { Tool, ToolEnv, ToolPointer } from './types';
import { strokeHalo } from './types';

// ---------------------------------------------------------------------------------------------
// Colour sampling (Eyedropper tool and Alt+click with painting tools)

export function sampleColor(doc: Doc, x: number, y: number, size: number, all: boolean): RGBA | null {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
  if (all) {
    const c = getCompositor();
    if (!c) return null;
    c.render(doc);
    const px = c.readPixel(x, y, size);
    if (!px) return null;
    return { r: px[0], g: px[1], b: px[2], a: px[3] / 255 };
  }
  const l = doc.activeLayer;
  const src = doc.editMask && l?.mask ? { surf: l.mask.surf, x: l.mask.x, y: l.mask.y } : l?.surf ? { surf: l.surf, x: l.x, y: l.y } : null;
  if (!src) return null;
  const h = Math.floor(size / 2);
  const lx = Math.floor(x) - src.x - h;
  const ly = Math.floor(y) - src.y - h;
  if (lx + size <= 0 || ly + size <= 0 || lx >= src.surf.width || ly >= src.surf.height) return null;
  const d = src.surf.ctx.getImageData(lx, ly, size, size).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < d.length; i += 4) {
    const w = d[i + 3];
    r += d[i] * w;
    g += d[i + 1] * w;
    b += d[i + 2] * w;
    a += w;
  }
  if (a === 0) return null;
  return { r: r / a, g: g / a, b: b / a, a: a / (size * size * 255) };
}

function pickTo(env: ToolEnv, p: ToolPointer, bg: boolean) {
  const o = edState().opts.eyedropper;
  const c = sampleColor(env.doc, p.x, p.y, o.sampleSize, o.sampleAll);
  if (!c) return;
  (bg ? setBg : setFg)({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: 1 });
}

let picking = false;
export const eyedropperTool: Tool = {
  cursor: () => 'crosshair',
  down(env, p) {
    picking = true;
    pickTo(env, p, p.alt);
  },
  move(env, p) {
    if (picking) pickTo(env, p, p.alt);
  },
  up() {
    picking = false;
  },
};

// ---------------------------------------------------------------------------------------------
// Brush-like tools

type BrushKind = 'brush' | 'pencil' | 'eraser' | 'clone' | 'heal' | 'spotHeal' | RetouchTool;

interface CloneSource {
  docId: string;
  x: number;
  y: number;
  /** dst→src offset (aligned mode keeps it across strokes). */
  offset: [number, number] | null;
}
let cloneSource: CloneSource | null = null;
let session: StrokeSession | null = null;
let srcCursor: [number, number] | null = null;
let altPicking = false;

/** The layer/mask a brush tool paints on (or null with a message). */
function paintTarget(doc: Doc): { layer: Layer; target: 'pixels' | 'mask' } | null {
  const l = doc.activeLayer;
  if (!l) return null;
  if (!l.visible) {
    toast('The active layer is hidden.', 'warn');
    return null;
  }
  if (l.mask && (doc.editMask || l.kind === 'adjustment' || l.kind === 'fill')) return { layer: l, target: 'mask' };
  if (l.lockAll || l.lockPixels) {
    toast(`"${l.name}" is locked.`, 'warn');
    return null;
  }
  if (l.kind === 'adjustment') {
    toast('Select a pixel layer or a layer mask to paint.', 'warn');
    return null;
  }
  if (l.kind !== 'raster') {
    void ensureRaster(doc, l).then(() => touch());
    return null;
  }
  return { layer: l, target: 'pixels' };
}

function compositeCanvas(doc: Doc): OffscreenCanvas | null {
  const c = getCompositor();
  if (!c) return null;
  c.render(doc);
  const px = c.readComposite();
  if (!px) return null;
  const canvas = makeCanvas(doc.width, doc.height);
  ctx2d(canvas).putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), doc.width, doc.height), 0, 0);
  return canvas;
}

function makeBrushTool(kind: BrushKind): Tool {
  const sizeOf = () => {
    const o = edState().opts;
    if (kind === 'brush' || kind === 'pencil' || kind === 'eraser' || kind === 'clone') return o[kind].size;
    if (kind === 'heal' || kind === 'spotHeal') return o.heal.size;
    return o.retouch[kind].size;
  };
  return {
    cursor: (_env, p) => (p?.alt && (kind === 'clone' || kind === 'heal' || kind === 'brush' || kind === 'pencil') ? 'crosshair' : 'none'),
    brushSize: () => sizeOf(),
    down(env, p) {
      const doc = env.doc;
      const s = edState();
      // Alt: eyedropper for painting tools, source point for clone / healing.
      if (p.alt && (kind === 'brush' || kind === 'pencil')) {
        altPicking = true;
        pickTo(env, p, false);
        return;
      }
      if (p.alt && (kind === 'clone' || kind === 'heal')) {
        cloneSource = { docId: doc.id, x: p.x, y: p.y, offset: null };
        toast('Clone source set.', 'info', 1200);
        bus.requestOverlay();
        return;
      }
      const t = paintTarget(doc);
      if (!t) return;
      const base = {
        label: '',
        size: sizeOf(),
        hardness: 1,
        flow: 1,
        opacity: 1,
        spacing: 0.12,
        smoothing: 0,
        pressureSize: false,
        pressureOpacity: false,
        color: s.fg,
        blend: 'normal' as const,
        pencil: false,
        viewScale: env.view.scale,
      };
      let o: StrokeOptions;
      if (kind === 'brush' || kind === 'pencil' || kind === 'eraser' || kind === 'clone') {
        const b = s.opts[kind];
        const pencilish = kind === 'pencil' || (kind === 'eraser' && s.opts.eraser.eraserMode === 'pencil');
        o = {
          ...base,
          kind: kind === 'eraser' ? 'erase' : kind === 'clone' ? 'clone' : 'paint',
          label: kind === 'brush' ? 'Brush Tool' : kind === 'pencil' ? 'Pencil' : kind === 'eraser' ? 'Eraser' : 'Clone Stamp',
          hardness: pencilish ? 1 : b.hardness / 100,
          flow: b.flow / 100,
          opacity: b.opacity / 100,
          spacing: Math.max(0.01, b.spacing / 100),
          smoothing: b.smoothing / 100,
          pressureSize: b.pressureSize,
          pressureOpacity: b.pressureOpacity,
          color: kind === 'eraser' ? s.bg : s.fg,
          blend: b.blend,
          pencil: pencilish,
        };
      } else if (kind === 'heal' || kind === 'spotHeal') {
        const h = s.opts.heal;
        o = { ...base, kind: kind === 'heal' ? 'heal' : 'spotHeal', label: kind === 'heal' ? 'Healing Brush' : 'Spot Healing Brush', hardness: h.hardness / 100, spacing: Math.max(0.05, h.spacing / 100) };
      } else {
        const r = s.opts.retouch[kind];
        o = {
          ...base,
          kind: 'retouch',
          label: { blur: 'Blur Tool', sharpen: 'Sharpen Tool', smudge: 'Smudge Tool', dodge: 'Dodge Tool', burn: 'Burn Tool', sponge: 'Sponge Tool' }[kind],
          hardness: r.hardness / 100,
          spacing: Math.max(0.05, r.spacing / 100),
          retouch: { tool: kind, strength: r.strength / 100, hardness: r.hardness / 100, range: r.range, spongeMode: r.spongeMode, protectTones: r.protectTones },
        };
      }
      if (kind === 'clone' || kind === 'heal') {
        if (!cloneSource || cloneSource.docId !== doc.id) {
          toast(`${navigator.platform.includes('Mac') ? 'Option' : 'Alt'}-click to define a source point first.`, 'warn');
          return;
        }
        const aligned = kind === 'clone' ? s.opts.clone.aligned : s.opts.heal.aligned;
        if (!cloneSource.offset || !aligned) cloneSource.offset = [Math.round(cloneSource.x - p.x), Math.round(cloneSource.y - p.y)];
        const sampleAll = kind === 'clone' ? s.opts.clone.sampleAll : s.opts.heal.sampleAll;
        const srcCanvas = sampleAll ? compositeCanvas(doc) : null;
        const surf = t.target === 'mask' ? t.layer.mask!.surf : t.layer.surf!;
        const ox = t.target === 'mask' ? t.layer.mask!.x : t.layer.x;
        const oy = t.target === 'mask' ? t.layer.mask!.y : t.layer.y;
        o.source = srcCanvas ? { canvas: srcCanvas, x: 0, y: 0, offset: cloneSource.offset } : { canvas: surf.canvas, x: ox, y: oy, offset: cloneSource.offset };
      }
      session = new StrokeSession(doc, t.layer, t.target, o);
      // Source pixels must be read from the (possibly grown) surface.
      if (o.source && !(kind === 'clone' ? s.opts.clone.sampleAll : s.opts.heal.sampleAll)) {
        const l = t.layer;
        o.source.canvas = t.target === 'mask' ? l.mask!.surf.canvas : l.surf!.canvas;
        o.source.x = t.target === 'mask' ? l.mask!.x : l.x;
        o.source.y = t.target === 'mask' ? l.mask!.y : l.y;
      }
      const last = lastStrokePoint.get(doc.id);
      if (p.shift && last) session.lineFrom(last[0], last[1], p.x, p.y, p.pressure);
      else session.addPoints(p.points);
      if (cloneSource?.offset) srcCursor = [p.x + cloneSource.offset[0], p.y + cloneSource.offset[1]];
    },
    move(env, p) {
      if (altPicking) {
        pickTo(env, p, false);
        return;
      }
      if (!session) return;
      session.addPoints(p.points);
      if (cloneSource?.offset && (kind === 'clone' || kind === 'heal')) {
        srcCursor = [p.x + cloneSource.offset[0], p.y + cloneSource.offset[1]];
        bus.requestOverlay();
      }
    },
    up() {
      altPicking = false;
      srcCursor = null;
      const s = session;
      session = null;
      if (s) {
        s.finish();
        touch();
      }
      bus.requestOverlay();
    },
    hover() {
      if (kind === 'clone' || kind === 'heal') bus.requestOverlay();
    },
    key(_env, e) {
      if (e.key === 'Escape' && session) {
        session.cancel();
        session = null;
        return true;
      }
      return false;
    },
    overlay(env, ctx) {
      if ((kind === 'clone' || kind === 'heal') && srcCursor) {
        const [x, y] = env.toScreen(srcCursor[0], srcCursor[1]);
        const r = Math.max(4, (sizeOf() / 2) * env.view.scale);
        strokeHalo(ctx, () => {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.moveTo(x - 5, y);
          ctx.lineTo(x + 5, y);
          ctx.moveTo(x, y - 5);
          ctx.lineTo(x, y + 5);
        });
      } else if ((kind === 'clone' || kind === 'heal') && cloneSource && cloneSource.docId === env.doc.id && !session) {
        const [x, y] = env.toScreen(cloneSource.x, cloneSource.y);
        strokeHalo(ctx, () => {
          ctx.beginPath();
          ctx.moveTo(x - 7, y);
          ctx.lineTo(x + 7, y);
          ctx.moveTo(x, y - 7);
          ctx.lineTo(x, y + 7);
        });
      }
    },
    deactivate() {
      session?.cancel();
      session = null;
      altPicking = false;
    },
    busy: () => !!session,
  };
}

export const PAINT_TOOLS: Partial<Record<ToolId, Tool>> = {
  brush: makeBrushTool('brush'),
  pencil: makeBrushTool('pencil'),
  eraser: makeBrushTool('eraser'),
  clone: makeBrushTool('clone'),
  heal: makeBrushTool('heal'),
  spotHeal: makeBrushTool('spotHeal'),
  blur: makeBrushTool('blur'),
  sharpen: makeBrushTool('sharpen'),
  smudge: makeBrushTool('smudge'),
  dodge: makeBrushTool('dodge'),
  burn: makeBrushTool('burn'),
  sponge: makeBrushTool('sponge'),
};

/** Brush size of the current tool (for [ / ] shortcuts). */
export function brushOptsKey(tool: ToolId): { key: 'brush' | 'pencil' | 'eraser' | 'clone' | 'heal'; retouch?: undefined } | { key: 'retouch'; retouch: RetouchTool } | null {
  if (tool === 'brush' || tool === 'pencil' || tool === 'eraser' || tool === 'clone') return { key: tool };
  if (tool === 'heal' || tool === 'spotHeal') return { key: 'heal' };
  if (tool === 'blur' || tool === 'sharpen' || tool === 'smudge' || tool === 'dodge' || tool === 'burn' || tool === 'sponge') return { key: 'retouch', retouch: tool };
  return null;
}
