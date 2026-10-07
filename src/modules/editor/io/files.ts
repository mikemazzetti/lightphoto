import { readPsd } from 'ag-psd';
import { createGL } from '@/core/gl/gl';
import { DevelopEngine, PixelBuffer } from '@/core/develop/engine';
import { defaultRawSettings } from '@/core/develop/settings';
import { decodeImage } from '@/core/image/decode';
import { encodeImage, ExportOptions, FORMAT_EXT } from '@/core/image/encode';
import { api, basename, extname, FILTERS, stem } from '@/platform/api';
import { errorToast, startTask, toast } from '@/state/app';
import type { Doc } from '../model/doc';
import { rasterLayer } from '../model/doc';
import { Surface } from '../model/surface';
import { activeDoc, edState, syncDirty, touch } from '../model/store';
import { addDoc, docFromImage, uniqueName } from '../ops/docs';
import { addLayer, flattenToCanvas } from '../ops/layers';
import { readPsdDoc, writePsdDoc } from './psd';

const RECENT_KEY = 'editor:recent';

export async function recentFiles(): Promise<string[]> {
  return (await api.storeGet<string[]>(RECENT_KEY)) ?? [];
}
async function pushRecent(path: string) {
  if (!api.isElectron) return;
  const r = [path, ...(await recentFiles()).filter((p) => p !== path)].slice(0, 12);
  await api.storeSet(RECENT_KEY, r);
}

const OPEN_FILTERS = [{ name: 'All Images', extensions: [...FILTERS.photos.extensions] }, FILTERS.psd, FILTERS.images, FILTERS.raw];

/** Renders a RAW pixel buffer with Lightroom-style defaults into an ImageBitmap. */
async function renderRaw(pb: PixelBuffer): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(4, 4);
  const gl = createGL(canvas);
  const eng = new DevelopEngine(gl);
  try {
    eng.setSource(pb);
    const img = eng.renderImageData(defaultRawSettings(pb.iso));
    return await createImageBitmap(img);
  } finally {
    eng.dispose();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

async function decodeToBitmap(path: string): Promise<ImageBitmap> {
  const d = await decodeImage(path);
  if (d.isRaw) return renderRaw(d.source as PixelBuffer);
  return d.source as ImageBitmap;
}

/** Opens a file as a new document (PSD with layers). */
export async function openPath(path: string): Promise<Doc | null> {
  const task = startTask(`Opening ${basename(path)}…`);
  try {
    let doc: Doc | null;
    if (extname(path) === 'psd') {
      doc = readPsdDoc(await api.readFile(path), basename(path), path);
      addDoc(doc);
    } else {
      const bmp = await decodeToBitmap(path);
      doc = docFromImage(basename(path), bmp, undefined);
      bmp.close();
      if (doc) doc.name = basename(path);
    }
    void pushRecent(path);
    touch();
    return doc;
  } catch (e) {
    errorToast(e, `Could not open ${basename(path)}`);
    return null;
  } finally {
    task.done();
  }
}

export async function openDialog() {
  const paths = await api.openFiles({ title: 'Open', filters: OPEN_FILTERS, multi: true });
  for (const p of paths) await openPath(p);
}

/** Adds an image file as a new layer of `doc`, centred. */
export async function placePath(doc: Doc, path: string) {
  const task = startTask(`Placing ${basename(path)}…`);
  try {
    let surf: Surface;
    if (extname(path) === 'psd') {
      // Placed PSDs come in flattened (their composite image).
      const psd = readPsd(await api.readFile(path), { useImageData: true, skipLayerImageData: true, skipThumbnail: true });
      if (!psd.imageData) throw new Error('This PSD has no composite image (save it with "Maximize Compatibility").');
      const id = psd.imageData;
      surf = Surface.fromImageData(new ImageData(new Uint8ClampedArray(id.data.buffer as ArrayBuffer, id.data.byteOffset, id.width * id.height * 4), id.width, id.height));
    } else {
      const bmp = await decodeToBitmap(path);
      surf = Surface.fromImage(bmp);
      bmp.close();
    }
    const x = Math.round((doc.width - surf.width) / 2);
    const y = Math.round((doc.height - surf.height) / 2);
    addLayer(doc, rasterLayer(stem(path), surf, x, y), 'Place');
  } catch (e) {
    errorToast(e, `Could not place ${basename(path)}`);
  } finally {
    task.done();
  }
}

export async function placeDialog() {
  const doc = activeDoc();
  if (!doc) return openDialog();
  const paths = await api.openFiles({ title: 'Place', filters: OPEN_FILTERS, multi: true });
  for (const p of paths) await placePath(doc, p);
}

export async function dropFiles(files: File[]) {
  const paths = files.map((f) => api.pathForFile(f)).filter((p) => !!p);
  const doc = activeDoc();
  for (const p of paths) {
    if (doc) await placePath(doc, p);
    else await openPath(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Save / export

const SAVE_FILTERS = [FILTERS.psd, FILTERS.png, FILTERS.jpeg, FILTERS.webp];

export async function saveDoc(doc: Doc, saveAs = false): Promise<boolean> {
  let path = doc.path;
  if (!path || saveAs || extname(path) !== 'psd') {
    const chosen = await api.saveDialog({ title: 'Save As', defaultPath: `${stem(doc.name)}.psd`, filters: SAVE_FILTERS });
    if (!chosen) return false;
    path = chosen;
  }
  if (!extname(path)) path = `${path}.psd`;
  const task = startTask(`Saving ${basename(path)}…`);
  try {
    const ext = extname(path);
    // Edits made while the file is being written must keep the document dirty.
    const state = doc.historyState;
    if (ext === 'psd') {
      const composite = flattenToCanvas(doc);
      const bytes = writePsdDoc(doc, composite);
      await api.writeFile(path, bytes);
    } else {
      const fmt = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpeg';
      const canvas = flattenToCanvas(doc, fmt === 'jpeg' ? [1, 1, 1, 1] : undefined);
      await api.writeFile(path, await encodeImage(canvas, { format: fmt, quality: 92 }));
      if (doc.layers.length > 1) toast(`Saved a flattened ${fmt.toUpperCase()} — use PSD to keep layers.`, 'info');
    }
    doc.path = path;
    doc.name = basename(path);
    doc.markSaved(state);
    void pushRecent(path);
    toast(`Saved ${basename(path)}`, 'success');
    touch();
    syncDirty();
    return true;
  } catch (e) {
    errorToast(e, 'Save failed');
    return false;
  } finally {
    task.done();
  }
}

export async function exportDoc(doc: Doc, opts: ExportOptions & { width?: number; height?: number }): Promise<string | null> {
  const fmt = opts.format;
  let canvas: OffscreenCanvas = flattenToCanvas(doc, fmt === 'jpeg' ? [1, 1, 1, 1] : undefined);
  if (opts.width && opts.height && (opts.width !== doc.width || opts.height !== doc.height)) {
    const bmp = await createImageBitmap(canvas, { resizeWidth: opts.width, resizeHeight: opts.height, resizeQuality: 'high' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    (c.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(bmp, 0, 0);
    bmp.close();
    canvas = c;
  }
  const path = await api.saveDialog({ title: 'Export As', defaultPath: `${stem(doc.name)}.${FORMAT_EXT[fmt]}`, filters: [FILTERS[fmt === 'jpeg' ? 'jpeg' : fmt]] });
  if (!path) return null;
  const task = startTask('Exporting…');
  try {
    const blob = await encodeImage(canvas, { format: fmt, quality: opts.quality });
    await api.writeFile(path, blob);
    toast(`Exported ${basename(path)}`, 'success');
    return path;
  } catch (e) {
    errorToast(e, 'Export failed');
    return null;
  } finally {
    task.done();
  }
}

/** Sends the flattened image back to whoever opened it (Library / Develop). */
export function saveBack(doc: Doc) {
  if (!doc.onSaveBack) return;
  doc.onSaveBack(flattenToCanvas(doc));
  doc.markSaved();
  touch();
  syncDirty();
  toast('Sent back.', 'success');
}

// ---------------------------------------------------------------------------------------------
// Inbox items from other modules

export function openFromInbox(item: { name: string; image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas; path?: string; onSaveBack?: (c: HTMLCanvasElement | OffscreenCanvas) => void }) {
  let src: CanvasImageSource & { width: number; height: number };
  if (item.image instanceof ImageData) {
    const c = new OffscreenCanvas(item.image.width, item.image.height);
    (c.getContext('2d') as OffscreenCanvasRenderingContext2D).putImageData(item.image, 0, 0);
    src = c;
  } else src = item.image as CanvasImageSource & { width: number; height: number };
  const doc = docFromImage(uniqueName(item.name), src, undefined);
  if (doc) {
    doc.onSaveBack = item.onSaveBack;
    if (item.path) doc.name = basename(item.path);
  }
}

export const isEditableEmpty = () => edState().docs.length === 0;
