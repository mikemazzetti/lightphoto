import type { BrushStroke } from './settings';

/** Holds a mask canvas plus how much of the stroke list has already been drawn into it. */
export class StrokeRasterCache {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  strokes = 0; // fully drawn strokes
  points = 0; // points drawn of the stroke at index `strokes`
  lastSig = '';
  /** Stroke objects already rasterised (identity check catches history jumps between equal-length lists). */
  refs: BrushStroke[] = [];
  /** Pixels changed since the last takeDirty(): a rect, 'all' (after a reset) or null. */
  dirty: { x0: number; y0: number; x1: number; y1: number } | 'all' | null = 'all';
  constructor(readonly width: number, readonly height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    // CPU-backed: incremental uploads read back only the dirty rect.
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.reset();
  }
  reset() {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.strokes = 0;
    this.points = 0;
    this.refs = [];
    this.dirty = 'all';
  }
  /** Grows the dirty region (pixel coords). */
  mark(x0: number, y0: number, x1: number, y1: number) {
    const d = this.dirty;
    if (d === 'all') return;
    if (!d) this.dirty = { x0, y0, x1, y1 };
    else {
      d.x0 = Math.min(d.x0, x0);
      d.y0 = Math.min(d.y0, y0);
      d.x1 = Math.max(d.x1, x1);
      d.y1 = Math.max(d.y1, y1);
    }
  }
  /** Returns and clears the dirty region, clamped to whole pixels inside the canvas. */
  takeDirty(): { x: number; y: number; w: number; h: number } | 'all' | null {
    const d = this.dirty;
    this.dirty = null;
    if (!d || d === 'all') return d;
    const x = Math.max(0, Math.floor(d.x0));
    const y = Math.max(0, Math.floor(d.y0));
    const w = Math.min(this.width, Math.ceil(d.x1)) - x;
    const h = Math.min(this.height, Math.ceil(d.y1)) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
}

const dabCache = new Map<string, OffscreenCanvas>();
/** Soft round dab, white (or black for erase) with a radial falloff controlled by feather. */
export function dab(feather: number, erase: boolean): OffscreenCanvas {
  const key = `${Math.round(feather)}|${erase}`;
  let c = dabCache.get(key);
  if (c) return c;
  const S = 128;
  c = new OffscreenCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const col = erase ? '0,0,0' : '255,255,255';
  const hard = Math.max(0, Math.min(0.99, 1 - feather / 100));
  g.addColorStop(0, `rgba(${col},1)`);
  g.addColorStop(hard, `rgba(${col},1)`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  dabCache.set(key, c);
  return c;
}

function drawSegment(cache: StrokeRasterCache, s: BrushStroke, from: number, srcW: number) {
  const { ctx, width, height } = cache;
  const d = Math.max(1, s.size * width);
  const spacing = Math.max(0.75, d * 0.12);
  const img = dab(s.feather, s.erase);
  ctx.globalAlpha = Math.max(0.01, Math.min(1, s.flow / 100));
  const pts = s.points;
  const stamp = (x: number, y: number) => {
    const px = x * width - d / 2;
    const py = y * height - d / 2;
    ctx.drawImage(img, px, py, d, d);
    cache.mark(px - 1, py - 1, px + d + 1, py + d + 1);
  };
  if (from === 0 && pts.length) stamp(pts[0][0], pts[0][1]);
  for (let i = Math.max(1, from); i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const dx = (x1 - x0) * width;
    const dy = (y1 - y0) * height;
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.floor(len / spacing));
    for (let k = 1; k <= n; k++) stamp(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
  }
  void srcW;
}

/**
 * Draws any strokes/points not yet in the cache. Redraws from scratch if strokes were removed
 * (undo) or the list belongs to a different mask. Returns true when the canvas changed.
 */
export function rasterizeStrokes(cache: StrokeRasterCache, strokes: BrushStroke[], srcW: number): boolean {
  const sig = strokes.length ? `${strokes[0].points[0]?.join(',')}|${strokes[0].size}|${strokes[0].erase}` : '';
  const drawn = cache.points > 0 ? cache.strokes + 1 : cache.strokes;
  const cur = strokes[cache.strokes];
  let changed = false;
  let mismatch = false;
  for (let i = 0, n = Math.min(cache.refs.length, strokes.length); i < n; i++) {
    if (cache.refs[i] !== strokes[i]) {
      mismatch = true;
      break;
    }
  }
  if (mismatch || sig !== cache.lastSig || strokes.length < drawn || (cur && cur.points.length < cache.points)) {
    cache.reset();
    cache.lastSig = sig;
    changed = true;
  }
  for (let i = cache.strokes; i < strokes.length; i++) {
    const s = strokes[i];
    const from = i === cache.strokes ? cache.points : 0;
    if (s.points.length > from) {
      drawSegment(cache, s, from, srcW);
      changed = true;
    }
    cache.strokes = i;
    cache.points = s.points.length;
  }
  cache.refs = strokes.slice();
  return changed;
}
