import LibRaw from 'libraw-wasm';
import * as UTIF from 'utif2';
import { readPsd } from 'ag-psd';
import exifr from 'exifr';
import { api, extname, kindOf } from '@/platform/api';
import type { PixelBuffer } from '../develop/engine';
import { limit } from '../util/async';

export interface DecodedImage {
  width: number;
  height: number;
  /** ImageBitmap for 8-bit formats, PixelBuffer (16-bit) for RAW. Both feed DevelopEngine.setSource. */
  source: ImageBitmap | PixelBuffer;
  isRaw: boolean;
  bitDepth: 8 | 16;
}

export interface PhotoMeta {
  width?: number;
  height?: number;
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  fNumber?: number;
  exposureTime?: number;
  focalLength?: number;
  dateTaken?: number;
  gps?: { lat: number; lon: number };
  orientation?: number;
}

const RAW_EXT = new Set(['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq', 'rwl', 'erf', 'kdc', 'mrw', 'mos', 'mef']);
export const isRawPath = (p: string) => RAW_EXT.has(extname(p));

const bitmapOpts: ImageBitmapOptions = { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' };

async function bitmapFromBlob(blob: Blob, maxSize?: number): Promise<ImageBitmap> {
  if (!maxSize) return createImageBitmap(blob, bitmapOpts);
  const full = await createImageBitmap(blob, bitmapOpts);
  if (Math.max(full.width, full.height) <= maxSize) return full;
  const k = maxSize / Math.max(full.width, full.height);
  const out = await createImageBitmap(full, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: 'high' });
  full.close();
  return out;
}

function rgbaToBitmap(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, w * h * 4);
  return createImageBitmap(new ImageData(data, w, h), { premultiplyAlpha: 'none' });
}

async function decodeTiff(buf: ArrayBuffer): Promise<ImageBitmap> {
  const ifds = UTIF.decode(buf);
  // Pick the largest image (skip thumbnails).
  let best = ifds[0];
  let bestArea = 0;
  for (const ifd of ifds) {
    const w = (ifd as any).t256?.[0] ?? 0;
    const h = (ifd as any).t257?.[0] ?? 0;
    if (w * h > bestArea) {
      bestArea = w * h;
      best = ifd;
    }
  }
  UTIF.decodeImage(buf, best);
  const rgba = UTIF.toRGBA8(best);
  return rgbaToBitmap(rgba, (best as any).width, (best as any).height);
}

async function decodePsdComposite(buf: ArrayBuffer): Promise<ImageBitmap> {
  const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
  const img = psd.imageData;
  if (!img) throw new Error('This PSD has no composite image (save it with "Maximize Compatibility").');
  return rgbaToBitmap(img.data as Uint8ClampedArray, img.width, img.height);
}

// RAW decoding runs LibRaw (WebAssembly, threaded) in a worker. Full decodes are serialised so
// several 50 MP files don't exhaust memory at once.
const rawQueue = limit(1);
const rawPreviewQueue = limit(2);

export interface RawDecodeOptions {
  halfSize?: boolean;
}

export async function decodeRaw(path: string, opts: RawDecodeOptions = {}): Promise<DecodedImage> {
  return rawQueue(async () => {
    const buf = await api.readFile(path);
    const raw = new LibRaw();
    try {
      await raw.open(new Uint8Array(buf), {
        outputBps: 16,
        useCameraWb: true,
        useCameraMatrix: 1,
        outputColor: 1,
        userQual: 3,
        halfSize: !!opts.halfSize,
        highlight: 0,
      });
      const img = await raw.imageData();
      if (!img) throw new Error('RAW decode returned no image');
      let data: Uint16Array | Uint8Array = img.data as Uint16Array | Uint8Array;
      if (img.bits === 16 && data instanceof Uint8Array) data = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
      const source: PixelBuffer = { width: img.width, height: img.height, data, channels: img.colors === 4 ? 4 : 3 };
      return { width: img.width, height: img.height, source, isRaw: true, bitDepth: img.bits === 16 ? 16 : 8 };
    } finally {
      raw.dispose();
    }
  });
}

/** Applies LibRaw's `flip` (dcraw convention: 3 = 180°, 5 = 90° CCW, 6 = 90° CW) to a preview bitmap. */
function orientRawPreview(bmp: ImageBitmap, flip: number | undefined): ImageBitmap {
  if (flip !== 3 && flip !== 5 && flip !== 6) return bmp;
  const quarter = flip !== 3;
  const c = new OffscreenCanvas(quarter ? bmp.height : bmp.width, quarter ? bmp.width : bmp.height);
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(flip === 3 ? Math.PI : flip === 6 ? Math.PI / 2 : -Math.PI / 2);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  bmp.close();
  return c.transferToImageBitmap();
}

/** The camera's embedded JPEG preview (fast; used for thumbnails and as a placeholder), upright. */
export async function decodeRawPreview(path: string, maxSize?: number): Promise<ImageBitmap | null> {
  return rawPreviewQueue(async () => {
    const buf = await api.readFile(path);
    const raw = new LibRaw();
    try {
      await raw.open(new Uint8Array(buf), { halfSize: true });
      const t = await raw.thumbnailData();
      if (!t) return null;
      // Embedded previews are stored in sensor orientation; the full decode applies flip itself.
      const flip = (await raw.metadata().catch(() => undefined))?.flip;
      if (t.format === 'jpeg') return orientRawPreview(await bitmapFromBlob(new Blob([t.data as BlobPart], { type: 'image/jpeg' }), maxSize), flip);
      if (t.format === 'bitmap') {
        const rgba = new Uint8Array(t.width * t.height * 4);
        for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
          rgba[j] = t.data[i];
          rgba[j + 1] = t.data[i + 1];
          rgba[j + 2] = t.data[i + 2];
          rgba[j + 3] = 255;
        }
        return orientRawPreview(await rgbaToBitmap(rgba, t.width, t.height), flip);
      }
      return null;
    } catch {
      return null;
    } finally {
      raw.dispose();
    }
  });
}

/**
 * Decodes any supported still image. 8-bit formats return an ImageBitmap (EXIF orientation
 * applied); RAW returns a 16-bit PixelBuffer. `maxSize` caps the long edge (8-bit only).
 */
export async function decodeImage(path: string, opts: { maxSize?: number; rawHalfSize?: boolean } = {}): Promise<DecodedImage> {
  const ext = extname(path);
  if (isRawPath(path)) return decodeRaw(path, { halfSize: opts.rawHalfSize });
  let bmp: ImageBitmap;
  if (ext === 'tif' || ext === 'tiff') bmp = await decodeTiff(await api.readFile(path));
  else if (ext === 'psd') bmp = await decodePsdComposite(await api.readFile(path));
  else if (ext === 'heic' || ext === 'heif') {
    const jpg = await api.convertToJpeg(path);
    if (!jpg) throw new Error('HEIC decoding is only available on macOS.');
    bmp = await bitmapFromBlob(await api.readBlob(jpg), opts.maxSize);
  } else bmp = await bitmapFromBlob(await api.readBlob(path), opts.maxSize);
  if (opts.maxSize && Math.max(bmp.width, bmp.height) > opts.maxSize) {
    const k = opts.maxSize / Math.max(bmp.width, bmp.height);
    const r = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
    bmp.close();
    bmp = r;
  }
  return { width: bmp.width, height: bmp.height, source: bmp, isRaw: false, bitDepth: 8 };
}

/** Decodes an image to an ImageBitmap at most `maxSize` on the long edge (RAW → embedded preview, falling back to a half-size decode). */
export async function decodeBitmap(path: string, maxSize?: number): Promise<ImageBitmap> {
  if (isRawPath(path)) {
    const prev = await decodeRawPreview(path, maxSize);
    if (prev) return prev;
    const d = await decodeRaw(path, { halfSize: true });
    return pixelBufferToBitmap(d.source as PixelBuffer, maxSize);
  }
  return (await decodeImage(path, { maxSize })).source as ImageBitmap;
}

/** Converts a (16-bit) pixel buffer to an 8-bit ImageBitmap. */
export async function pixelBufferToBitmap(pb: PixelBuffer, maxSize?: number): Promise<ImageBitmap> {
  const n = pb.width * pb.height;
  const rgba = new Uint8ClampedArray(n * 4);
  const shift = pb.data instanceof Uint16Array ? 8 : 0;
  for (let i = 0, j = 0; j < rgba.length; i += pb.channels, j += 4) {
    rgba[j] = pb.data[i] >> shift;
    rgba[j + 1] = pb.data[i + 1] >> shift;
    rgba[j + 2] = pb.data[i + 2] >> shift;
    rgba[j + 3] = 255;
  }
  const bmp = await createImageBitmap(new ImageData(rgba, pb.width, pb.height));
  if (!maxSize || Math.max(bmp.width, bmp.height) <= maxSize) return bmp;
  const k = maxSize / Math.max(bmp.width, bmp.height);
  const out = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
  bmp.close();
  return out;
}

// --------------------------------------------------------------------------------------------
// Thumbnails (disk-cached JPEGs)

const thumbQueue = limit(Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2)));
const memThumbs = new Map<string, Promise<ImageBitmap>>();

export const thumbKey = (path: string, mtime: number, size: number, px: number, variant = '') => `${path}|${mtime}|${size}|${px}|${variant}`;

/**
 * Loads a thumbnail (long edge `px`), from memory, then the on-disk cache, then by decoding.
 * `variant` distinguishes edited renders (e.g. a hash of develop settings).
 */
export function loadThumbnail(entry: { path: string; mtime: number; size: number }, px = 384, variant = ''): Promise<ImageBitmap> {
  const key = thumbKey(entry.path, entry.mtime, entry.size, px, variant);
  let p = memThumbs.get(key);
  if (p) return p;
  p = thumbQueue(async () => {
    const cached = await api.thumbGet(key);
    if (cached) return createImageBitmap(new Blob([cached], { type: 'image/jpeg' }));
    if (variant) throw new Error('no edited thumbnail cached');
    const bmp = await decodeBitmap(entry.path, px);
    void storeThumbnail(key, bmp);
    return bmp;
  });
  memThumbs.set(key, p);
  p.catch(() => memThumbs.delete(key));
  if (memThumbs.size > 800) memThumbs.delete(memThumbs.keys().next().value!);
  return p;
}

/** Saves a bitmap/canvas as a cached thumbnail under `key`. */
export async function storeThumbnail(key: string, src: ImageBitmap | OffscreenCanvas | HTMLCanvasElement) {
  try {
    const c = new OffscreenCanvas(src.width, src.height);
    c.getContext('2d')!.drawImage(src, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
    await api.thumbPut(key, await blob.arrayBuffer());
    memThumbs.set(key, createImageBitmap(blob));
  } catch {
    /* non-fatal */
  }
}

export function forgetThumbnail(key: string) {
  memThumbs.delete(key);
}

// --------------------------------------------------------------------------------------------
// Metadata

export async function readMetadata(path: string): Promise<PhotoMeta> {
  const kind = kindOf(path);
  if (kind !== 'image' && kind !== 'raw') return {};
  try {
    const src: any = api.isElectron ? api.fileUrl(path) : await api.readBlob(path);
    const x = await exifr.parse(src, {
      pick: ['Make', 'Model', 'LensModel', 'ISO', 'FNumber', 'ExposureTime', 'FocalLength', 'DateTimeOriginal', 'CreateDate', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'Orientation', 'latitude', 'longitude'],
      gps: true,
      translateValues: false,
    });
    if (!x) return {};
    const date = x.DateTimeOriginal ?? x.CreateDate;
    return {
      make: x.Make,
      model: x.Model,
      lens: x.LensModel,
      iso: x.ISO,
      fNumber: x.FNumber,
      exposureTime: x.ExposureTime,
      focalLength: x.FocalLength,
      dateTaken: date instanceof Date ? date.getTime() : undefined,
      width: x.ExifImageWidth ?? x.ImageWidth,
      height: x.ExifImageHeight ?? x.ImageHeight,
      orientation: x.Orientation,
      gps: typeof x.latitude === 'number' && typeof x.longitude === 'number' ? { lat: x.latitude, lon: x.longitude } : undefined,
    };
  } catch {
    return {};
  }
}

export function formatShutter(t?: number): string {
  if (!t) return '';
  return t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`;
}
