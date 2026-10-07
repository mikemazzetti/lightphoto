import { api, FILTERS, stem } from '@/platform/api';

export type ExportFormat = 'jpeg' | 'png' | 'webp';

export const FORMAT_MIME: Record<ExportFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const FORMAT_EXT: Record<ExportFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

export interface ExportOptions {
  format: ExportFormat;
  quality: number; // 0..100 (jpeg/webp)
  /** Long-edge cap in px (0 = original). */
  longEdge?: number;
}

type Drawable = ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

function size(src: Drawable) {
  return { w: src.width, h: src.height };
}

/** Encodes pixels to an image Blob, optionally downscaling (high quality) to `longEdge`. */
export async function encodeImage(src: Drawable, opts: ExportOptions): Promise<Blob> {
  let { w, h } = size(src);
  const k = opts.longEdge && opts.longEdge > 0 ? Math.min(1, opts.longEdge / Math.max(w, h)) : 1;
  let drawable: CanvasImageSource;
  if (src instanceof ImageData) {
    drawable = await createImageBitmap(src, { premultiplyAlpha: 'none' });
  } else drawable = src as CanvasImageSource;
  if (k < 1) {
    drawable = await createImageBitmap(drawable as ImageBitmap, {
      resizeWidth: Math.round(w * k),
      resizeHeight: Math.round(h * k),
      resizeQuality: 'high',
    });
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  if (opts.format === 'jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(drawable, 0, 0);
  return c.convertToBlob({ type: FORMAT_MIME[opts.format], quality: opts.format === 'png' ? undefined : opts.quality / 100 });
}

/** Shows a save dialog and writes the encoded image. Returns the path, or null if cancelled. */
export async function saveImageAs(src: Drawable, defaultName: string, opts: ExportOptions): Promise<string | null> {
  const ext = FORMAT_EXT[opts.format];
  const path = await api.saveDialog({
    title: 'Export Image',
    defaultPath: `${stem(defaultName)}.${ext}`,
    filters: [FILTERS[opts.format === 'jpeg' ? 'jpeg' : opts.format]],
  });
  if (!path) return null;
  const blob = await encodeImage(src, opts);
  await api.writeFile(path, blob);
  return path;
}
