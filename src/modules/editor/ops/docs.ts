import { toast } from '@/state/app';
import { confirmDialog } from '@/ui/overlays';
import { fitView } from '@/ui/viewport';
import { bus } from '../model/bus';
import { Doc, rasterLayer } from '../model/doc';
import { Surface } from '../model/surface';
import type { RGBA } from '../model/types';
import { edState, syncDirty, touch, useEditor } from '../model/store';

/** Last known size of the canvas viewport (CSS px) — for fitting new documents. */
export const viewportSize = { w: 1200, h: 800 };

export function fitDocView(doc: Doc, allowUpscale = false) {
  doc.view = fitView(doc.width, doc.height, viewportSize.w, viewportSize.h, 28, allowUpscale);
  doc.fitted = true;
  bus.view.emit();
  bus.requestFrame();
}

export function addDoc(doc: Doc) {
  if (!doc.activeLayerId && doc.layers.length) doc.activeLayerId = doc.layers[doc.layers.length - 1].id;
  fitDocView(doc);
  useEditor.setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id }));
  touch();
}

export function activateDoc(id: string) {
  useEditor.setState({ activeId: id, session: null });
  const d = edState().docs.find((x) => x.id === id);
  d?.invalidate();
  bus.view.emit();
  touch();
}

export const MAX_DOC_SIZE = 16384;

export function checkSize(w: number, h: number): boolean {
  if (w < 1 || h < 1 || w > MAX_DOC_SIZE || h > MAX_DOC_SIZE) {
    toast(`Document size must be between 1 and ${MAX_DOC_SIZE} pixels per side.`, 'error');
    return false;
  }
  if (w * h > 400e6) {
    toast('Document is too large (over 400 megapixels).', 'error');
    return false;
  }
  return true;
}

export function createDoc(name: string, w: number, h: number, background: 'white' | 'transparent' | 'black' | RGBA = 'white'): Doc | null {
  if (!checkSize(w, h)) return null;
  const doc = new Doc(name, w, h);
  const css = background === 'white' ? '#fff' : background === 'black' ? '#000' : background === 'transparent' ? null : `rgb(${background.r},${background.g},${background.b})`;
  const surf = css ? Surface.filled(w, h, css) : new Surface(w, h);
  const l = rasterLayer(css ? 'Background' : 'Layer 1', surf);
  doc.layers = [l];
  doc.activeLayerId = l.id;
  doc.resetHistory('New');
  addDoc(doc);
  return doc;
}

/** Creates a document from a decoded image. */
export function docFromImage(name: string, img: CanvasImageSource & { width: number; height: number }, path?: string): Doc | null {
  const w = img.width as number;
  const h = img.height as number;
  if (!checkSize(w, h)) return null;
  const doc = new Doc(name, w, h);
  doc.path = path;
  const l = rasterLayer('Background', Surface.fromImage(img));
  doc.layers = [l];
  doc.activeLayerId = l.id;
  doc.resetHistory('Open');
  addDoc(doc);
  return doc;
}

export async function closeDoc(id: string, force = false): Promise<boolean> {
  const doc = edState().docs.find((d) => d.id === id);
  if (!doc) return true;
  if (doc.dirty && !force) {
    const ok = await confirmDialog(`"${doc.name}" has unsaved changes. Close it anyway?`, { title: 'Unsaved Changes', ok: 'Close Without Saving', danger: true });
    if (!ok) return false;
  }
  // Re-read: tabs may have been opened, closed or switched while the dialog was up.
  const s = edState();
  const idx = s.docs.findIndex((d) => d.id === id);
  if (idx < 0) return true;
  const docs = s.docs.filter((d) => d.id !== id);
  if (s.activeId === id) {
    // Closing the active tab activates its neighbour; a background tab leaves the active one alone.
    const next = docs[Math.min(idx, docs.length - 1)] ?? null;
    useEditor.setState({ docs, activeId: next?.id ?? null, session: null });
    next?.invalidate();
  } else useEditor.setState({ docs });
  touch();
  syncDirty();
  return true;
}

export function uniqueName(base: string): string {
  const names = new Set(edState().docs.map((d) => d.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
