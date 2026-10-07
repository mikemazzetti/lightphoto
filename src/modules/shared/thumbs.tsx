import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadThumbnail } from '@/core/image/decode';
import type { Photo } from '@/state/catalog';
import { EDITED_THUMB_PX } from './editedThumb';

/**
 * Loads a photo's thumbnail (the edited render when `photo.thumbVariant` is set, falling back
 * to the original). Returns null while loading.
 */
export function useThumbnail(photo: Pick<Photo, 'path' | 'mtime' | 'size' | 'thumbVariant'> | undefined, px = 384): ImageBitmap | null {
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const path = photo?.path;
  const variant = photo?.thumbVariant ?? '';
  useEffect(() => {
    if (!photo || !path) return;
    let alive = true;
    const entry = { path, mtime: photo.mtime, size: photo.size };
    // Edited renders are cached at a single size (EDITED_THUMB_PX); fall back to the original.
    const load = variant ? loadThumbnail(entry, EDITED_THUMB_PX, variant).catch(() => loadThumbnail(entry, px)) : loadThumbnail(entry, px);
    load.then((b) => alive && setBmp(b)).catch(() => alive && setBmp(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, variant, px, photo?.mtime]);
  return bmp;
}

/** Draws an ImageBitmap into a canvas that fills its box, letterboxed (contain) or cropped (cover). */
export function BitmapView({ bitmap, fit = 'contain', style, className }: { bitmap: ImageBitmap | null; fit?: 'contain' | 'cover'; style?: CSSProperties; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.w * dpr));
    const H = Math.max(1, Math.round(box.h * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!bitmap) return;
    const k = fit === 'contain' ? Math.min(W / bitmap.width, H / bitmap.height) : Math.max(W / bitmap.width, H / bitmap.height);
    const w = bitmap.width * k;
    const h = bitmap.height * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
  }, [bitmap, box, fit]);
  return <canvas ref={ref} className={className} style={{ width: '100%', height: '100%', display: 'block', ...style }} />;
}

/** Size (in image px) of the drawn bitmap inside a contain box — handy for overlays. */
export function containRect(imgW: number, imgH: number, boxW: number, boxH: number) {
  const k = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * k;
  const h = imgH * k;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, k };
}
