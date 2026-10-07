import { createGL } from '@/core/gl/gl';
import { DevelopEngine } from '@/core/develop/engine';
import { normalizeSettings } from '@/core/develop/settings';
import { decodeImage, storeThumbnail, thumbKey, forgetThumbnail } from '@/core/image/decode';
import { limit } from '@/core/util/async';
import { Photo, setThumbVariant, settingsHash, useCatalog } from '@/state/catalog';

/** Long edge of cached *edited* thumbnails. useThumbnail() always requests variants at this size. */
export const EDITED_THUMB_PX = 384;

/**
 * Renders the current settings of `photo` with an engine that already has the photo as its
 * source, and caches the result as the photo's edited thumbnail.
 */
export async function storeEditedThumbnail(photo: Photo, engine: DevelopEngine): Promise<void> {
  if (!photo.settings) {
    setThumbVariant(photo.id, '');
    return;
  }
  const s = normalizeSettings(photo.settings);
  const hash = settingsHash(photo.settings);
  const [w, h] = engine.fitSize(s, EDITED_THUMB_PX, EDITED_THUMB_PX);
  const img = engine.render(s, w, h).toImageData();
  const bmp = await createImageBitmap(img);
  const key = thumbKey(photo.path, photo.mtime, photo.size, EDITED_THUMB_PX, hash);
  forgetThumbnail(key);
  await storeThumbnail(key, bmp);
  // A newer render may have finished first; never replace a current variant with a stale one.
  const cur = useCatalog.getState().photos[photo.id];
  if (cur && settingsHash(cur.settings) !== hash && cur.thumbVariant === settingsHash(cur.settings)) return;
  setThumbVariant(photo.id, hash);
}

let shared: DevelopEngine | null = null;
const queue = limit(1);

/** Decodes the photo (RAW at half size) and regenerates its edited thumbnail in the background. */
export function regenerateEditedThumbnail(photoId: string): Promise<void> {
  return queue(async () => {
    const photo = useCatalog.getState().photos[photoId];
    if (!photo) return;
    if (!photo.settings) {
      setThumbVariant(photo.id, '');
      return;
    }
    if (!shared) shared = new DevelopEngine(createGL(new OffscreenCanvas(1, 1)));
    const dec = await decodeImage(photo.path, { maxSize: 1600, rawHalfSize: true });
    shared.setSource(dec.source);
    if (dec.source instanceof ImageBitmap) dec.source.close();
    // Settings may have changed while decoding — render the latest.
    const fresh = useCatalog.getState().photos[photoId];
    if (!fresh) return;
    await storeEditedThumbnail(fresh, shared);
    shared.trim();
  });
}
