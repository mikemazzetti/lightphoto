import { IDENTITY, Mat2D, matBounds, matMul, matTranslate, Rect, rectInflate, rectRoundOut } from './geom';
import { bus } from './bus';
import { distanceField } from './selection';
import { ctx2d, makeCanvas, rgbaCss, Surface } from './surface';
import type { Layer, LayerStyle, ShapeProps, TextProps } from './types';

// ---------------------------------------------------------------------------------------------
// Text

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function mctx() {
  if (!measureCtx) measureCtx = ctx2d(makeCanvas(4, 4));
  return measureCtx;
}

export const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
export function cssFamily(f: string) {
  return GENERIC_FAMILIES.has(f) ? f : `"${f.replace(/"/g, '')}"`;
}
export function textFont(t: TextProps, scale = 1) {
  return `${t.italic ? 'italic ' : ''}${t.weight} ${t.size * scale}px ${cssFamily(t.font)}`;
}

export interface TextLayout {
  lines: string[];
  widths: number[];
  boxW: number;
  boxH: number;
  lineH: number;
  ascent: number;
  descent: number;
}

export function layoutText(t: TextProps): TextLayout {
  const ctx = mctx();
  ctx.font = textFont(t);
  (ctx as any).letterSpacing = `${t.tracking}px`;
  const lines = t.text.split('\n');
  const widths = lines.map((l) => ctx.measureText(l).width);
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? t.size * 0.8;
  const descent = m.fontBoundingBoxDescent ?? t.size * 0.2;
  const lineH = t.size * t.lineHeight;
  return { lines, widths, boxW: Math.max(1, ...widths), boxH: Math.max(lineH, lines.length * lineH), lineH, ascent, descent };
}

/** Local (pre-xform) box of a text layer. */
export function textBox(t: TextProps): Rect {
  const L = layoutText(t);
  return { x: t.x, y: t.y, w: L.boxW, h: L.boxH };
}

function drawText(ctx: OffscreenCanvasRenderingContext2D, t: TextProps) {
  const L = layoutText(t);
  ctx.font = textFont(t);
  (ctx as any).letterSpacing = `${t.tracking}px`;
  ctx.fillStyle = rgbaCss(t.color);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  L.lines.forEach((line, i) => {
    const w = L.widths[i];
    const lx = t.align === 'left' ? 0 : t.align === 'center' ? (L.boxW - w) / 2 : L.boxW - w;
    const by = i * L.lineH + (L.lineH - (L.ascent + L.descent)) / 2 + L.ascent;
    ctx.fillText(line, t.x + lx, t.y + by);
  });
}

// ---------------------------------------------------------------------------------------------
// Shapes

export function shapeBox(s: ShapeProps): Rect {
  if (s.type === 'line') return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

export function shapePath(s: ShapeProps): Path2D {
  const p = new Path2D();
  if (s.type === 'rect') p.rect(s.x, s.y, s.w, s.h);
  else if (s.type === 'rounded') p.roundRect(s.x, s.y, s.w, s.h, Math.max(0, Math.min(s.radius, Math.abs(s.w) / 2, Math.abs(s.h) / 2)));
  else if (s.type === 'ellipse') p.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w) / 2, Math.abs(s.h) / 2, 0, 0, Math.PI * 2);
  else {
    p.moveTo(s.x, s.y);
    p.lineTo(s.x + s.w, s.y + s.h);
  }
  return p;
}

function drawShape(ctx: OffscreenCanvasRenderingContext2D, s: ShapeProps) {
  const p = shapePath(s);
  if (s.type !== 'line' && s.fill) {
    ctx.fillStyle = rgbaCss(s.fill);
    ctx.fill(p);
  }
  const stroke = s.type === 'line' ? (s.stroke ?? s.fill) : s.stroke;
  if (stroke && s.strokeWidth > 0) {
    ctx.strokeStyle = rgbaCss(stroke);
    ctx.lineWidth = s.strokeWidth;
    ctx.lineJoin = 'miter';
    ctx.lineCap = s.type === 'line' ? 'round' : 'butt';
    ctx.stroke(p);
  }
}

// ---------------------------------------------------------------------------------------------

/** Renders a text/shape layer's props into its surface (sets surf, x, y). */
export function rasterizeVector(l: Layer) {
  let box: Rect;
  let pad: number;
  if (l.kind === 'text' && l.text) {
    box = textBox(l.text);
    pad = Math.ceil(l.text.size * 0.4) + 2;
  } else if (l.kind === 'shape' && l.shape) {
    box = shapeBox(l.shape);
    pad = Math.ceil(l.shape.strokeWidth) + 2;
  } else return;
  const m: Mat2D = l.xform ?? IDENTITY;
  const r = rectRoundOut(matBounds(m, rectInflate(box, pad)));
  r.w = Math.max(1, Math.min(r.w, 16384));
  r.h = Math.max(1, Math.min(r.h, 16384));
  // Always a fresh surface: older ones may be referenced by undo snapshots.
  const surf = new Surface(r.w, r.h);
  const ctx = surf.ctx;
  ctx.save();
  const t = matMul(matTranslate(-r.x, -r.y), m);
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  if (l.kind === 'text') drawText(ctx, l.text!);
  else drawShape(ctx, l.shape!);
  ctx.restore();
  surf.touch();
  l.surf = surf;
  l.x = r.x;
  l.y = r.y;
}

// ---------------------------------------------------------------------------------------------
// Layer styles (rasterised with Canvas2D / distance fields; cached by content + style)

export interface FxResult {
  below: Surface | null;
  above: Surface | null;
  x: number;
  y: number;
}

const fxCache = new Map<string, FxResult>();

export function styleActive(s: LayerStyle | null | undefined): boolean {
  return !!s && (!!s.dropShadow?.enabled || !!s.outerGlow?.enabled || !!s.stroke?.enabled);
}

const lastFx = new Map<number, { time: number; res: FxResult; styleKey: string; version: number; lx: number; ly: number }>();
let fxTimer: ReturnType<typeof setTimeout> | undefined;

export function layerFx(l: Layer): FxResult | null {
  if (!l.surf || !styleActive(l.style)) return null;
  const styleKey = JSON.stringify(l.style);
  const key = `${l.surf.id}:${l.surf.version}:${l.x}:${l.y}:${styleKey}`;
  const hit = fxCache.get(key);
  if (hit) return hit;
  const prev = lastFx.get(l.surf.id);
  if (prev && prev.styleKey === styleKey) {
    // Same pixels, layer moved: effects just translate.
    if (prev.version === l.surf.version) {
      const res = { ...prev.res, x: prev.res.x + (l.x - prev.lx), y: prev.res.y + (l.y - prev.ly) };
      fxCache.set(key, res);
      return res;
    }
    // Pixels changing continuously (retouch strokes): reuse the previous effects for a moment
    // instead of recomputing distance fields every frame.
    if (performance.now() - prev.time < 250) {
      clearTimeout(fxTimer);
      fxTimer = setTimeout(() => bus.invalidate(), 260);
      return { ...prev.res, x: prev.res.x + (l.x - prev.lx), y: prev.res.y + (l.y - prev.ly) };
    }
  }
  // Drop stale entries of this surface.
  for (const k of fxCache.keys()) if (k.startsWith(`${l.surf.id}:`)) fxCache.delete(k);
  const res = renderFx(l.surf, l.style!, l.x, l.y);
  fxCache.set(key, res);
  lastFx.set(l.surf.id, { time: performance.now(), res, styleKey, version: l.surf.version, lx: l.x, ly: l.y });
  if (lastFx.size > 64) lastFx.delete(lastFx.keys().next().value!);
  if (fxCache.size > 64) fxCache.delete(fxCache.keys().next().value!);
  return res;
}

function renderFx(surf: Surface, s: LayerStyle, lx: number, ly: number): FxResult {
  const ds = s.dropShadow?.enabled ? s.dropShadow : null;
  const og = s.outerGlow?.enabled ? s.outerGlow : null;
  const st = s.stroke?.enabled ? s.stroke : null;
  let pad = 2;
  if (ds) pad = Math.max(pad, ds.distance + ds.size * 1.5 + 2);
  if (og) pad = Math.max(pad, og.size * 1.5 + 2);
  if (st) pad = Math.max(pad, st.size + 2);
  pad = Math.ceil(pad);
  const W = surf.width + pad * 2;
  const H = surf.height + pad * 2;
  const below = new Surface(W, H);
  const bctx = below.ctx;
  const BIG = W + H + 100;
  const shadowPass = (color: { r: number; g: number; b: number }, opacity: number, blur: number, dx: number, dy: number, times = 1) => {
    bctx.save();
    bctx.shadowColor = rgbaCss(color, opacity);
    bctx.shadowBlur = Math.max(0, blur);
    bctx.shadowOffsetX = dx + BIG;
    bctx.shadowOffsetY = dy;
    for (let i = 0; i < times; i++) bctx.drawImage(surf.canvas, pad - BIG, pad);
    bctx.restore();
  };
  if (ds) {
    const a = (ds.angle * Math.PI) / 180;
    const blur = ds.size * (1 - ds.spread / 100);
    shadowPass(ds.color, ds.opacity, blur, -Math.cos(a) * ds.distance, Math.sin(a) * ds.distance, ds.spread > 50 ? 2 : 1);
  }
  if (og) shadowPass(og.color, og.opacity, og.size * (1 - og.spread / 100), 0, 0, 2);
  let above: Surface | null = null;
  if (st && st.size > 0) {
    const img = surf.ctx.getImageData(0, 0, surf.width, surf.height);
    const w = W;
    const h = H;
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < surf.height; y++) {
      for (let x = 0; x < surf.width; x++) alpha[(y + pad) * w + x + pad] = img.data[(y * surf.width + x) * 4 + 3];
    }
    const out = new ImageData(w, h);
    const outside = st.position === 'outside' ? st.size : st.position === 'center' ? st.size / 2 : 0;
    const inside = st.position === 'inside' ? st.size : st.position === 'center' ? st.size / 2 : 0;
    const dOut = outside > 0 ? distanceField(alpha, w, h, true, false) : null;
    const dIn = inside > 0 ? distanceField(alpha, w, h, false, true) : null;
    const { r, g, b } = st.color;
    for (let i = 0; i < alpha.length; i++) {
      let v = 0;
      if (dOut && alpha[i] < 128) v = Math.max(v, Math.min(1, Math.max(0, outside + 0.5 - Math.sqrt(dOut[i]))));
      if (dIn && alpha[i] >= 128) v = Math.max(v, Math.min(1, Math.max(0, inside + 0.5 - Math.sqrt(dIn[i]) + 1)));
      if (dOut && !dIn && alpha[i] >= 128) v = Math.max(v, 1 - alpha[i] / 255);
      if (v > 0) {
        const j = i * 4;
        out.data[j] = r;
        out.data[j + 1] = g;
        out.data[j + 2] = b;
        out.data[j + 3] = v * st.opacity * 255;
      }
    }
    const strokeSurf = new Surface(w, h);
    strokeSurf.ctx.putImageData(out, 0, 0);
    if (st.position === 'outside') bctx.drawImage(strokeSurf.canvas, 0, 0);
    else above = strokeSurf;
  }
  below.touch();
  return { below, above, x: lx - pad, y: ly - pad };
}
