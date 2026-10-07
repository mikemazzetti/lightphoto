import { errorToast, toast } from '@/state/app';
import { Doc } from '../model/doc';
import { IDENTITY, Mat2D, matMul, matScale, Rect, rectIntersect, rectRoundOut } from '../model/geom';
import { rasterizeVector } from '../model/rasterize';
import { alphaBounds, rgbaCss, Surface } from '../model/surface';
import type { Layer, RGBA } from '../model/types';
import { touch } from '../model/store';
import { requireCompositor } from '../render/compositor';
import { checkSize, fitDocView } from './docs';
import { commit } from './layers';
import { transformSurface } from './edit';

export type ResampleMethod = 'bicubic' | 'bilinear' | 'nearest';

async function scaleSurface(s: Surface, nw: number, nh: number, method: ResampleMethod): Promise<Surface> {
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  if (method === 'nearest') {
    const out = new Surface(nw, nh);
    out.ctx.imageSmoothingEnabled = false;
    out.ctx.drawImage(s.canvas, 0, 0, nw, nh);
    return out;
  }
  const bmp = await createImageBitmap(s.canvas, { resizeWidth: nw, resizeHeight: nh, resizeQuality: method === 'bicubic' ? 'high' : 'medium' });
  const out = Surface.fromImage(bmp);
  bmp.close();
  return out;
}

function scaleVector(l: Layer, sx: number, sy: number) {
  const uniform = Math.abs(sx - sy) < 1e-3;
  if (!l.xform && uniform) {
    if (l.text) l.text = { ...l.text, x: l.text.x * sx, y: l.text.y * sy, size: l.text.size * sx, tracking: l.text.tracking * sx };
    if (l.shape) l.shape = { ...l.shape, x: l.shape.x * sx, y: l.shape.y * sy, w: l.shape.w * sx, h: l.shape.h * sy, radius: l.shape.radius * sx, strokeWidth: l.shape.strokeWidth * sx };
  } else l.xform = matMul(matScale(sx, sy), l.xform ?? IDENTITY);
  rasterizeVector(l);
}

export async function resizeImage(doc: Doc, w: number, h: number, method: ResampleMethod) {
  w = Math.round(w);
  h = Math.round(h);
  if (!checkSize(w, h) || (w === doc.width && h === doc.height)) return;
  const W0 = doc.width;
  const H0 = doc.height;
  const sx = w / W0;
  const sy = h / H0;
  const scaledRect = (x: number, y: number, s: Surface): Rect => {
    const x0 = Math.round(x * sx);
    const y0 = Math.round(y * sy);
    return { x: x0, y: y0, w: Math.round((x + s.width) * sx) - x0, h: Math.round((y + s.height) * sy) - y0 };
  };
  // Resample everything first: the document is only touched once all surfaces are ready.
  const layers = [...doc.layers];
  const sources = layers.map((l) => [l.surf, l.mask?.surf ?? null]);
  let scaled: { px: Rect | null; surf: Surface | null; mr: Rect | null; mask: Surface | null }[];
  try {
    scaled = await Promise.all(
      layers.map(async (l) => {
        const px = l.kind !== 'text' && l.kind !== 'shape' && l.surf ? scaledRect(l.x, l.y, l.surf) : null;
        const mr = l.mask ? scaledRect(l.mask.x, l.mask.y, l.mask.surf) : null;
        const [surf, mask] = await Promise.all([px && scaleSurface(l.surf!, px.w, px.h, method), mr && scaleSurface(l.mask!.surf, mr.w, mr.h, method)]);
        return { px, surf, mr, mask };
      }),
    );
  } catch (e) {
    errorToast(e, 'Image Size failed');
    return;
  }
  const unchanged = doc.width === W0 && doc.height === H0 && doc.layers.length === layers.length && doc.layers.every((l, i) => l === layers[i] && l.surf === sources[i][0] && (l.mask?.surf ?? null) === sources[i][1]);
  if (!unchanged) {
    toast('The document changed while resizing — Image Size was not applied.', 'warn');
    return;
  }
  layers.forEach((l, i) => {
    const r = scaled[i];
    if (l.kind === 'text' || l.kind === 'shape') scaleVector(l, sx, sy);
    else if (r.px && r.surf) {
      l.surf = r.surf;
      l.x = r.px.x;
      l.y = r.px.y;
    }
    if (l.mask && r.mr && r.mask) l.mask = { ...l.mask, x: r.mr.x, y: r.mr.y, surf: r.mask, feather: l.mask.feather * sx };
    if (l.style) {
      const k = (sx + sy) / 2;
      const st = JSON.parse(JSON.stringify(l.style));
      if (st.dropShadow) {
        st.dropShadow.distance *= k;
        st.dropShadow.size *= k;
      }
      if (st.outerGlow) st.outerGlow.size *= k;
      if (st.stroke) st.stroke.size *= k;
      l.style = st;
    }
    doc.touchLayer(l);
  });
  doc.selection = doc.selection ? doc.selection.remap(w, h, matScale(sx, sy)) : null;
  doc.lastSelection = null;
  doc.width = w;
  doc.height = h;
  doc.invalidate();
  commit(doc, 'Image Size');
  fitDocView(doc);
}

export async function resizeCanvas(doc: Doc, w: number, h: number, ax: number, ay: number, ext: 'transparent' | RGBA) {
  w = Math.round(w);
  h = Math.round(h);
  if (!checkSize(w, h) || (w === doc.width && h === doc.height)) return;
  const dx = Math.round((w - doc.width) * ax);
  const dy = Math.round((h - doc.height) * ay);
  const oldW = doc.width;
  const oldH = doc.height;
  for (const l of doc.layers) {
    l.x += dx;
    l.y += dy;
    if (l.mask) l.mask = { ...l.mask, x: l.mask.x + dx, y: l.mask.y + dy };
    if (l.kind === 'text' || l.kind === 'shape') {
      if (l.xform) l.xform = [l.xform[0], l.xform[1], l.xform[2], l.xform[3], l.xform[4] + dx, l.xform[5] + dy];
      else if (l.text) l.text = { ...l.text, x: l.text.x + dx, y: l.text.y + dy };
      else if (l.shape) l.shape = { ...l.shape, x: l.shape.x + dx, y: l.shape.y + dy };
    }
    doc.touchLayer(l);
  }
  // Extension colour: grow the bottom raster layer (when it covered the old canvas) and fill.
  const bottom = doc.layers[0];
  if (ext !== 'transparent' && bottom?.kind === 'raster' && bottom.surf && bottom.x <= dx && bottom.y <= dy && bottom.x + bottom.surf.width >= dx + oldW && bottom.y + bottom.surf.height >= dy + oldH) {
    const s = Surface.filled(w, h, rgbaCss(ext, 1));
    s.ctx.drawImage(bottom.surf.canvas, bottom.x, bottom.y);
    bottom.surf = s;
    bottom.x = 0;
    bottom.y = 0;
  }
  doc.selection = doc.selection ? doc.selection.remap(w, h, [1, 0, 0, 1, dx, dy]) : null;
  doc.width = w;
  doc.height = h;
  doc.invalidate();
  commit(doc, 'Canvas Size');
  fitDocView(doc);
}

/** Applies a document-level transform (rotations / flips by 90° multiples). */
function transformDoc(doc: Doc, m: Mat2D, w: number, h: number, label: string) {
  for (const l of doc.layers) {
    if (l.kind === 'text' || l.kind === 'shape') {
      l.xform = matMul(m, l.xform ?? IDENTITY);
      rasterizeVector(l);
    } else if (l.surf) {
      const r = transformSurface(l.surf, l.x, l.y, m, 'none');
      l.surf = r.surf;
      l.x = r.x;
      l.y = r.y;
    }
    if (l.mask) {
      const r = transformSurface(l.mask.surf, l.mask.x, l.mask.y, m, 'none', l.mask.defaultColor);
      l.mask = { ...l.mask, surf: r.surf, x: r.x, y: r.y };
    }
    doc.touchLayer(l);
  }
  doc.selection = doc.selection ? doc.selection.remap(w, h, m) : null;
  doc.lastSelection = null;
  doc.width = w;
  doc.height = h;
  doc.invalidate();
  commit(doc, label);
  fitDocView(doc);
}

export function rotateCanvas(doc: Doc, op: 'cw' | 'ccw' | '180' | 'flipH' | 'flipV') {
  const W = doc.width;
  const H = doc.height;
  switch (op) {
    case 'cw':
      return transformDoc(doc, [0, 1, -1, 0, H, 0], H, W, 'Rotate Canvas 90° Clockwise');
    case 'ccw':
      return transformDoc(doc, [0, -1, 1, 0, 0, W], H, W, 'Rotate Canvas 90° Counter Clockwise');
    case '180':
      return transformDoc(doc, [-1, 0, 0, -1, W, H], W, H, 'Rotate Canvas 180°');
    case 'flipH':
      return transformDoc(doc, [-1, 0, 0, 1, W, 0], W, H, 'Flip Canvas Horizontal');
    case 'flipV':
      return transformDoc(doc, [1, 0, 0, -1, 0, H], W, H, 'Flip Canvas Vertical');
  }
}

/** Crops the document to `r` (document pixels). Pixels outside are kept unless `deletePixels`. */
export function cropDoc(doc: Doc, r: Rect, deletePixels: boolean, label = 'Crop') {
  r = rectRoundOut(r);
  if (r.w < 1 || r.h < 1) return;
  if (!checkSize(r.w, r.h)) return;
  for (const l of doc.layers) {
    l.x -= r.x;
    l.y -= r.y;
    if (l.mask) l.mask = { ...l.mask, x: l.mask.x - r.x, y: l.mask.y - r.y };
    if (l.kind === 'text' || l.kind === 'shape') {
      if (l.xform) l.xform = [l.xform[0], l.xform[1], l.xform[2], l.xform[3], l.xform[4] - r.x, l.xform[5] - r.y];
      else if (l.text) l.text = { ...l.text, x: l.text.x - r.x, y: l.text.y - r.y };
      else if (l.shape) l.shape = { ...l.shape, x: l.shape.x - r.x, y: l.shape.y - r.y };
    } else if (deletePixels && l.surf) {
      const keep = rectIntersect({ x: l.x, y: l.y, w: l.surf.width, h: l.surf.height }, { x: 0, y: 0, w: r.w, h: r.h });
      if (keep && (keep.w !== l.surf.width || keep.h !== l.surf.height)) {
        const s = new Surface(keep.w, keep.h);
        s.ctx.drawImage(l.surf.canvas, keep.x - l.x, keep.y - l.y, keep.w, keep.h, 0, 0, keep.w, keep.h);
        l.surf = s;
        l.x = keep.x;
        l.y = keep.y;
      } else if (!keep) {
        l.surf = new Surface(1, 1);
        l.x = 0;
        l.y = 0;
      }
    }
    doc.touchLayer(l);
  }
  doc.selection = doc.selection ? doc.selection.crop(r) : null;
  doc.lastSelection = null;
  doc.width = r.w;
  doc.height = r.h;
  doc.invalidate();
  commit(doc, label);
  fitDocView(doc);
}

export function cropToSelection(doc: Doc) {
  if (!doc.selection) {
    toast('Crop needs a selection.', 'warn');
    return;
  }
  const b = doc.selection.bounds;
  doc.selection = null;
  cropDoc(doc, b, true, 'Crop');
}

export function trimTransparent(doc: Doc) {
  const c = requireCompositor();
  c.render(doc);
  const px = c.readComposite();
  if (!px) return;
  const r = alphaBounds(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), doc.width, doc.height));
  if (!r) {
    toast('The image is completely transparent.', 'warn');
    return;
  }
  if (r.x === 0 && r.y === 0 && r.w === doc.width && r.h === doc.height) {
    toast('Nothing to trim.', 'info');
    return;
  }
  cropDoc(doc, r, true, 'Trim');
  touch();
}
