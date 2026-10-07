import { createGL } from '@/core/gl/gl';
import { DevelopEngine, EngineSource } from '@/core/develop/engine';
import { DevelopSettings, normalizeSettings } from '@/core/develop/settings';
import { decodeImage } from '@/core/image/decode';
import { nextFrame } from '@/core/util/async';
import { openInEditor } from '@/app/bridge';
import { errorToast, startTask, toast, useApp } from '@/state/app';
import { filterAndSort, Photo, setActive, useCatalog } from '@/state/catalog';
import { getController } from './controller';
import { applyCrop, enterCrop } from './cropTool';
import { defaultsFor, editCommit, Tool, useDevelop } from './store';

/** Switches tools (toggling the current one off). Leaving Crop applies it. */
export function setTool(t: Tool) {
  const st = useDevelop.getState();
  if (!st.settings) return;
  const next: Tool = st.tool === t ? 'none' : t;
  if (st.tool === 'crop' && next !== 'crop') applyCrop();
  if (next === 'crop') {
    enterCrop();
    return;
  }
  const patch: Partial<typeof st> = { tool: next, creating: null, straighten: false };
  if (next === 'mask') {
    const ids = st.settings.locals.map((l) => l.id);
    if (!st.selectedMask || !ids.includes(st.selectedMask)) patch.selectedMask = ids[ids.length - 1] ?? null;
  }
  useDevelop.setState(patch);
}

export function autoTone() {
  const p = getController()?.computeAutoTone();
  if (!p) return;
  editCommit((s) => ({ ...s, ...p }), 'Auto Tone');
}

export function autoWhiteBalance() {
  const wb = getController()?.computeAutoWB();
  if (!wb) return;
  editCommit((s) => ({ ...s, ...wb }), 'White Balance: Auto');
  return wb;
}

export function pasteSettings() {
  const clip = useCatalog.getState().clipboard;
  if (!clip) {
    toast('Nothing to paste — copy settings first (⇧⌘C).', 'warn');
    return;
  }
  editCommit((s) => normalizeSettings({ ...s, ...structuredClone(clip) }), 'Paste Settings');
}

export function applyPrevious() {
  const st = useDevelop.getState();
  const prev = st.prevPhotoId ? useCatalog.getState().photos[st.prevPhotoId] : undefined;
  if (!prev) {
    toast('No previous photo to copy settings from.', 'warn');
    return;
  }
  const src = prev.settings ? normalizeSettings(prev.settings) : defaultsFor(prev);
  editCommit(() => structuredClone(src), `Previous (${prev.name})`);
}

export function resetAll() {
  const st = useDevelop.getState();
  if (!st.settings) return;
  editCommit(() => structuredClone(st.defaults), 'Reset');
}

/** ← / → through the Library's current filter + sort order. */
export function navigatePhoto(delta: 1 | -1) {
  const cat = useCatalog.getState();
  const ids = filterAndSort(cat);
  if (!ids.length) return;
  const i = cat.activeId ? ids.indexOf(cat.activeId) : -1;
  const j = i < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, i + delta));
  if (ids[j] && ids[j] !== cat.activeId) {
    useCatalog.setState({ selection: [ids[j]] });
    setActive(ids[j]);
  }
}

// ---------------------------------------------------------------------------------------------
// Full-resolution rendering (separate engine so the viewer keeps its caches)

/** Renders `settings` for `photo` at full resolution (or capped to `longEdge`) on a throwaway GPU context. */
export async function renderFull(photo: Photo, settings: DevelopSettings, longEdge = 0, onStage?: (label: string) => void): Promise<ImageData> {
  const c = getController();
  let src: EngineSource | null = null;
  let owned = false;
  onStage?.('Rendering…');
  await nextFrame();
  if (c && c.photoId === photo.id) {
    if (c.stage !== 'full') onStage?.('Waiting for full-quality decode…');
    src = await c.whenFull();
    if (src) onStage?.('Rendering…');
  }
  if (!src) {
    onStage?.(`Decoding ${photo.name}…`);
    const d = await decodeImage(photo.path);
    src = d.source;
    owned = true;
    onStage?.('Rendering…');
  }
  // No await between here and setSource: the viewer may release its decoded source when switching photos.
  const gl = createGL(new OffscreenCanvas(1, 1));
  let eng: DevelopEngine | null = null;
  try {
    eng = new DevelopEngine(gl);
    eng.setSource(src);
    const s = normalizeSettings(settings);
    const img = longEdge > 0 ? eng.renderImageData(s, longEdge, longEdge) : eng.renderImageData(s);
    if (gl.isContextLost()) throw new Error('The GPU ran out of memory while rendering this image.');
    return img;
  } finally {
    try {
      eng?.dispose();
    } catch {
      /* lost context */
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (owned && src instanceof ImageBitmap) src.close();
  }
}

/** ⌘E — sends the full-resolution developed image to the layered editor. */
export async function editInEditor() {
  const st = useDevelop.getState();
  const photo = st.photoId ? useCatalog.getState().photos[st.photoId] : undefined;
  if (!photo || !st.settings) return;
  if (st.tool === 'crop') applyCrop();
  const settings = useDevelop.getState().settings!;
  const task = startTask(`Preparing ${photo.name} for Edit…`);
  try {
    const image = await renderFull(photo, settings, 0, (l) => task.update(null, l));
    openInEditor({ name: photo.name, image, path: photo.path });
  } catch (e) {
    errorToast(e, 'Edit in Editor failed');
  } finally {
    task.done();
  }
}

export const goToLibrary = () => useApp.getState().setModule('library');
