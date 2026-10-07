import { Rect, rectIntersect, rectUnion } from './geom';

/** Monotonic counter shared by every versioned object (surfaces, layers) so cache keys never collide. */
let globalSeq = 1;
export const nextSeq = () => ++globalSeq;

export type Canvas2D = OffscreenCanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

export function ctx2d(c: OffscreenCanvas, readFrequently = false): Canvas2D {
  const ctx = c.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined) as Canvas2D | null;
  if (!ctx) throw new Error('Could not create a 2D canvas context (out of memory?)');
  return ctx;
}

/**
 * A mutable pixel buffer (Canvas2D, GPU-backed in Chromium). Layers, masks and the stroke buffer
 * are Surfaces. Every change must go through `touch()` so the compositor knows which region of
 * its GL texture to re-upload.
 */
export class Surface {
  readonly id = nextSeq();
  canvas: OffscreenCanvas;
  ctx: Canvas2D;
  version = nextSeq();
  /** Region changed since the compositor last uploaded (null + fullDirty=false = clean). */
  dirty: Rect | null = null;
  fullDirty = true;
  /** Version at which the compositor last uploaded (partial uploads are only valid from there). */
  uploadedVersion = -1;

  constructor(w: number, h: number, canvas?: OffscreenCanvas) {
    this.canvas = canvas ?? makeCanvas(w, h);
    this.ctx = ctx2d(this.canvas);
  }

  get width() {
    return this.canvas.width;
  }
  get height() {
    return this.canvas.height;
  }
  get bytes() {
    return this.canvas.width * this.canvas.height * 4;
  }

  /** Marks pixels changed (rect in surface coordinates; omit for the whole surface). */
  touch(r?: Rect | null) {
    this.version = nextSeq();
    if (!r) {
      this.fullDirty = true;
      this.dirty = null;
      return;
    }
    const c = rectIntersect(r, { x: 0, y: 0, w: this.width, h: this.height });
    if (c) this.dirty = rectUnion(this.dirty, c);
  }

  /** Replaces the backing canvas (e.g. after a resize). */
  replace(canvas: OffscreenCanvas) {
    this.canvas = canvas;
    this.ctx = ctx2d(canvas);
    this.touch();
  }

  clone(): Surface {
    const s = new Surface(this.width, this.height);
    s.ctx.drawImage(this.canvas, 0, 0);
    return s;
  }

  static fromImage(src: CanvasImageSource & { width: number; height: number }): Surface {
    const s = new Surface(src.width as number, src.height as number);
    s.ctx.drawImage(src, 0, 0);
    return s;
  }

  static fromImageData(img: ImageData): Surface {
    const s = new Surface(img.width, img.height);
    s.ctx.putImageData(img, 0, 0);
    return s;
  }

  static filled(w: number, h: number, css: string): Surface {
    const s = new Surface(w, h);
    s.ctx.fillStyle = css;
    s.ctx.fillRect(0, 0, w, h);
    return s;
  }

  getImageData(r: Rect): ImageData {
    return this.ctx.getImageData(r.x, r.y, r.w, r.h);
  }

  clear(r?: Rect) {
    if (r) this.ctx.clearRect(r.x, r.y, r.w, r.h);
    else this.ctx.clearRect(0, 0, this.width, this.height);
    this.touch(r);
  }
}

/** Pixel bounds of non-transparent content (alpha > threshold) of an ImageData. */
export function alphaBounds(img: ImageData, threshold = 0): Rect | null {
  const { width: w, height: h, data } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x++, row += 4) {
      if (data[row] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export const rgbaCss = (c: { r: number; g: number; b: number; a?: number }, alpha = c.a ?? 1) =>
  `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${alpha})`;
