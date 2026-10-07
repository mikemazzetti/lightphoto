import { clamp, Mat2D, Rect, rectEmpty, rectInflate, rectIntersect, rectRoundOut, rectUnion } from './geom';
import { ctx2d, makeCanvas } from './surface';

export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect';

/**
 * An 8-bit selection mask. Immutable: every operation returns a new Selection, which makes
 * undo a matter of swapping references. Only the bounding box is stored (selections are usually
 * much smaller than the document); `data` holds bounds.w × bounds.h alpha values (255 = selected).
 */
export class Selection {
  private _canvas: OffscreenCanvas | null = null;

  constructor(
    readonly docW: number,
    readonly docH: number,
    readonly bounds: Rect,
    readonly data: Uint8Array,
  ) {}

  get bytes() {
    return this.data.byteLength;
  }

  valueAt(x: number, y: number): number {
    const b = this.bounds;
    const ix = Math.floor(x) - b.x;
    const iy = Math.floor(y) - b.y;
    if (ix < 0 || iy < 0 || ix >= b.w || iy >= b.h) return 0;
    return this.data[iy * b.w + ix];
  }

  /** Canvas of bounds size: white with the selection in alpha (for Canvas2D masking). Cached. */
  canvas(): OffscreenCanvas {
    if (this._canvas) return this._canvas;
    const { w, h } = this.bounds;
    const c = makeCanvas(w, h);
    const ctx = ctx2d(c);
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0, j = 0; i < this.data.length; i++, j += 4) {
      d[j] = 255;
      d[j + 1] = 255;
      d[j + 2] = 255;
      d[j + 3] = this.data[i];
    }
    ctx.putImageData(img, 0, 0);
    this._canvas = c;
    return c;
  }

  /** Releases the cached canvas (history entries keep only the compact data). */
  releaseCanvas() {
    this._canvas = null;
  }

  /** Alpha over an arbitrary region (zeros outside the selection). */
  region(r: Rect): Uint8Array {
    const out = new Uint8Array(r.w * r.h);
    const b = this.bounds;
    const i = rectIntersect(r, b);
    if (!i) return out;
    for (let y = i.y; y < i.y + i.h; y++) {
      const src = (y - b.y) * b.w + (i.x - b.x);
      out.set(this.data.subarray(src, src + i.w), (y - r.y) * r.w + (i.x - r.x));
    }
    return out;
  }

  get isRectangular(): boolean {
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== 255) return false;
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Construction

  /** Builds a selection from region data, trimming empty borders and clipping to the document. */
  static fromRegion(docW: number, docH: number, r: Rect, data: Uint8Array): Selection | null {
    const clip = rectIntersect(r, { x: 0, y: 0, w: docW, h: docH });
    if (!clip) return null;
    let x0 = clip.x + clip.w;
    let y0 = clip.y + clip.h;
    let x1 = clip.x - 1;
    let y1 = clip.y - 1;
    for (let y = clip.y; y < clip.y + clip.h; y++) {
      const row = (y - r.y) * r.w - r.x;
      for (let x = clip.x; x < clip.x + clip.w; x++) {
        if (data[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    if (x1 < x0) return null;
    const b = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    if (b.x === r.x && b.y === r.y && b.w === r.w && b.h === r.h) return new Selection(docW, docH, b, data);
    const out = new Uint8Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) {
      const src = (y + b.y - r.y) * r.w + (b.x - r.x);
      out.set(data.subarray(src, src + b.w), y * b.w);
    }
    return new Selection(docW, docH, b, out);
  }

  static all(docW: number, docH: number): Selection {
    return new Selection(docW, docH, { x: 0, y: 0, w: docW, h: docH }, new Uint8Array(docW * docH).fill(255));
  }

  /** Rasterises a path drawn by `draw` (in document coordinates) with optional feather. */
  static fromPath(docW: number, docH: number, approxBounds: Rect, draw: (ctx: OffscreenCanvasRenderingContext2D) => void, feather = 0, antialias = true): Selection | null {
    const pad = Math.ceil(feather * 2) + 2;
    const r = rectIntersect(rectRoundOut(rectInflate(approxBounds, pad)), { x: 0, y: 0, w: docW, h: docH });
    if (!r) return null;
    const c = makeCanvas(r.w, r.h);
    const ctx = ctx2d(c, true);
    ctx.translate(-r.x, -r.y);
    if (feather > 0) ctx.filter = `blur(${feather / 2}px)`;
    ctx.fillStyle = '#fff';
    ctx.imageSmoothingEnabled = antialias;
    draw(ctx);
    const img = ctx.getImageData(0, 0, r.w, r.h).data;
    const data = new Uint8Array(r.w * r.h);
    for (let i = 0, j = 3; i < data.length; i++, j += 4) data[i] = antialias || feather > 0 ? img[j] : img[j] >= 128 ? 255 : 0;
    return Selection.fromRegion(docW, docH, r, data);
  }

  static rect(docW: number, docH: number, r: Rect, feather = 0): Selection | null {
    const rr = rectRoundOut(r);
    if (rectEmpty(rr)) return null;
    if (feather <= 0) {
      const c = rectIntersect(rr, { x: 0, y: 0, w: docW, h: docH });
      if (!c) return null;
      return new Selection(docW, docH, c, new Uint8Array(c.w * c.h).fill(255));
    }
    return Selection.fromPath(docW, docH, rr, (ctx) => ctx.fillRect(rr.x, rr.y, rr.w, rr.h), feather);
  }

  static ellipse(docW: number, docH: number, r: Rect, feather = 0, antialias = true): Selection | null {
    if (r.w < 0.5 || r.h < 0.5) return null;
    return Selection.fromPath(
      docW,
      docH,
      r,
      (ctx) => {
        ctx.beginPath();
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      },
      feather,
      antialias,
    );
  }

  static polygon(docW: number, docH: number, pts: [number, number][], feather = 0, antialias = true): Selection | null {
    if (pts.length < 3) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return Selection.fromPath(
      docW,
      docH,
      { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      (ctx) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fill('nonzero');
      },
      feather,
      antialias,
    );
  }

  /** From a full-document alpha array. */
  static fromFull(docW: number, docH: number, full: Uint8Array): Selection | null {
    return Selection.fromRegion(docW, docH, { x: 0, y: 0, w: docW, h: docH }, full);
  }

  // ------------------------------------------------------------------------------------------
  // Boolean operations

  static combine(a: Selection | null, b: Selection | null, mode: SelectionMode): Selection | null {
    if (mode === 'new') return b;
    if (!a) return mode === 'add' ? b : null;
    if (!b) return mode === 'intersect' ? null : a;
    const { docW, docH } = a;
    if (mode === 'intersect') {
      const r = rectIntersect(a.bounds, b.bounds);
      if (!r) return null;
      const da = a.region(r);
      const db = b.region(r);
      for (let i = 0; i < da.length; i++) da[i] = Math.min(da[i], db[i]);
      return Selection.fromRegion(docW, docH, r, da);
    }
    if (mode === 'add') {
      const r = rectUnion(a.bounds, b.bounds)!;
      const da = a.region(r);
      const db = b.region(r);
      for (let i = 0; i < da.length; i++) if (db[i] > da[i]) da[i] = db[i];
      return Selection.fromRegion(docW, docH, r, da);
    }
    // subtract
    const r = a.bounds;
    const da = a.region(r);
    const db = b.region(r);
    for (let i = 0; i < da.length; i++) da[i] = (da[i] * (255 - db[i]) + 127) / 255;
    return Selection.fromRegion(docW, docH, r, da);
  }

  invert(): Selection | null {
    const full = this.region({ x: 0, y: 0, w: this.docW, h: this.docH });
    for (let i = 0; i < full.length; i++) full[i] = 255 - full[i];
    return Selection.fromFull(this.docW, this.docH, full);
  }

  translate(dx: number, dy: number): Selection | null {
    dx = Math.round(dx);
    dy = Math.round(dy);
    return Selection.fromRegion(this.docW, this.docH, { ...this.bounds, x: this.bounds.x + dx, y: this.bounds.y + dy }, this.data);
  }

  /** Re-maps into a document of a new size through an affine transform (rotate / resize / crop). */
  remap(newW: number, newH: number, m: Mat2D): Selection | null {
    const c = makeCanvas(newW, newH);
    const ctx = ctx2d(c, true);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.canvas(), this.bounds.x, this.bounds.y);
    const img = ctx.getImageData(0, 0, newW, newH).data;
    const full = new Uint8Array(newW * newH);
    for (let i = 0, j = 3; i < full.length; i++, j += 4) full[i] = img[j];
    return Selection.fromFull(newW, newH, full);
  }

  /** Crop (document-coordinate rect becomes the new document). */
  crop(r: Rect): Selection | null {
    return Selection.fromRegion(r.w, r.h, { ...this.bounds, x: this.bounds.x - r.x, y: this.bounds.y - r.y }, this.data);
  }

  // ------------------------------------------------------------------------------------------
  // Modify

  feather(radius: number): Selection | null {
    if (radius <= 0) return this;
    const pad = Math.ceil(radius * 2.5) + 1;
    const r = rectIntersect(rectInflate(this.bounds, pad), { x: 0, y: 0, w: this.docW, h: this.docH })!;
    const d = this.region(r);
    blurAlpha(d, r.w, r.h, radius / 2);
    return Selection.fromRegion(this.docW, this.docH, r, d);
  }

  expand(radius: number): Selection | null {
    if (radius <= 0) return this;
    const pad = Math.ceil(radius) + 1;
    const r = rectIntersect(rectInflate(this.bounds, pad), { x: 0, y: 0, w: this.docW, h: this.docH })!;
    const d = this.region(r);
    const d2 = distanceField(d, r.w, r.h, true, false);
    for (let i = 0; i < d.length; i++) {
      if (d[i] >= 128) continue;
      const v = clamp((radius + 0.5 - Math.sqrt(d2[i])) * 255, 0, 255);
      if (v > d[i]) d[i] = v;
    }
    return Selection.fromRegion(this.docW, this.docH, r, d);
  }

  contract(radius: number): Selection | null {
    if (radius <= 0) return this;
    const r = this.bounds;
    const d = this.region(r);
    // Document edges count as unselected only when the selection reaches them (Photoshop behaviour).
    const d2 = distanceField(d, r.w, r.h, false, true);
    for (let i = 0; i < d.length; i++) {
      if (d[i] < 128) continue;
      const v = clamp((Math.sqrt(d2[i]) - radius) * 255, 0, 255);
      if (v < d[i]) d[i] = v;
    }
    return Selection.fromRegion(this.docW, this.docH, r, d);
  }

  border(width: number): Selection | null {
    const outer = this.expand(width / 2);
    const inner = this.contract(width / 2);
    if (!outer) return null;
    const r = outer.bounds;
    const a = outer.region(r);
    const b = inner ? inner.region(r) : new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) a[i] = Math.max(0, a[i] - b[i]);
    blurAlpha(a, r.w, r.h, 0.8);
    return Selection.fromRegion(this.docW, this.docH, r, a);
  }

  smooth(radius: number): Selection | null {
    if (radius <= 0) return this;
    const pad = Math.ceil(radius) + 1;
    const r = rectIntersect(rectInflate(this.bounds, pad), { x: 0, y: 0, w: this.docW, h: this.docH })!;
    const d = this.region(r);
    boxBlur(d, r.w, r.h, Math.max(1, Math.round(radius)));
    for (let i = 0; i < d.length; i++) d[i] = clamp((d[i] - 128) * 3 + 128, 0, 255);
    return Selection.fromRegion(this.docW, this.docH, r, d);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** One sliding-window box blur pass (horizontal then vertical) of radius r on an 8-bit plane. */
export function boxBlur(d: Uint8Array, w: number, h: number, r: number) {
  if (r < 1) return;
  const tmp = new Float32Array(Math.max(w, h));
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = -r - 1; x < r; x++) acc += d[o + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += d[o + Math.min(w - 1, x + r)] - d[o + Math.max(0, x - r - 1)];
      tmp[x] = acc * k;
    }
    for (let x = 0; x < w; x++) d[o + x] = tmp[x] + 0.5;
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r - 1; y < r; y++) acc += d[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += d[Math.min(h - 1, y + r) * w + x] - d[Math.max(0, y - r - 1) * w + x];
      tmp[y] = acc * k;
    }
    for (let y = 0; y < h; y++) d[y * w + x] = tmp[y] + 0.5;
  }
}

/** Approximate Gaussian blur (3 box passes) of an 8-bit plane. */
export function blurAlpha(d: Uint8Array, w: number, h: number, sigma: number) {
  if (sigma <= 0.3) return;
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  for (let i = 0; i < n; i++) boxBlur(d, w, h, ((i < m ? wl : wu) - 1) / 2);
}

/**
 * Squared Euclidean distance (Felzenszwalb & Huttenlocher) from every pixel to the nearest
 * feature pixel. Features: selected pixels (a >= 128) when `toInside`, else unselected ones.
 * `edgeIsOutside` treats the area beyond the plane as unselected.
 */
export function distanceField(d: Uint8Array, w: number, h: number, toInside: boolean, edgeIsOutside: boolean): Float32Array {
  const INF = 1e20;
  // Pad by one pixel so a border ring can act as "outside".
  const pw = w + 2;
  const ph = h + 2;
  const f = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const inner = x > 0 && y > 0 && x <= w && y <= h;
      let feature: boolean;
      if (inner) {
        const sel = d[(y - 1) * w + (x - 1)] >= 128;
        feature = toInside ? sel : !sel;
      } else feature = !toInside && edgeIsOutside;
      f[y * pw + x] = feature ? 0 : INF;
    }
  }
  const n = Math.max(pw, ph);
  const col = new Float32Array(n);
  const out = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  for (let x = 0; x < pw; x++) {
    for (let y = 0; y < ph; y++) col[y] = f[y * pw + x];
    edt1d(col, ph, out, v, z);
    for (let y = 0; y < ph; y++) f[y * pw + x] = out[y];
  }
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) col[x] = f[y * pw + x];
    edt1d(col, pw, out, v, z);
    for (let x = 0; x < pw; x++) f[y * pw + x] = out[x];
  }
  const res = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) res[y * w + x] = f[(y + 1) * pw + x + 1];
  return res;
}

function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -1e20;
  z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}
