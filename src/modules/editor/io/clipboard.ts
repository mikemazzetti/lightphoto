import { errorToast, toast } from '@/state/app';
import { Surface } from '../model/surface';
import { activeDoc, touch } from '../model/store';
import { pasteInternal, pasteSurface } from '../ops/edit';
import { viewportSize } from '../ops/docs';

/** Pastes an image blob (from the system clipboard) as a new layer / document. */
async function pasteBlob(blob: Blob, inPlace: boolean) {
  const d = activeDoc();
  const bmp = await createImageBitmap(blob);
  try {
    // Our own copy comes back through the system clipboard: prefer the internal one (keeps position).
    if (pasteInternal(d, inPlace, viewportSize.w, viewportSize.h, bmp)) return;
    pasteSurface(d, Surface.fromImage(bmp), { viewW: viewportSize.w, viewH: viewportSize.h, name: d ? undefined : 'Pasted' });
  } finally {
    bmp.close();
  }
}

/** DOM `paste` event (native Edit ▸ Paste / ⌘V). */
export async function handlePasteEvent(e: ClipboardEvent) {
  const file = Array.from(e.clipboardData?.items ?? [])
    .find((it) => it.kind === 'file' && it.type.startsWith('image/'))
    ?.getAsFile();
  try {
    if (file) await pasteBlob(file, false);
    else await pasteFromSystem(false);
  } catch (err) {
    errorToast(err, 'Paste failed');
  } finally {
    touch();
  }
}

/** Reads the system clipboard through the async Clipboard API, falling back to the internal clipboard. */
export async function pasteFromSystem(inPlace: boolean) {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      await pasteBlob(await it.getType(type), inPlace);
      touch();
      return;
    }
  } catch {
    /* permission denied / unsupported — fall back */
  }
  if (!pasteInternal(activeDoc(), inPlace, viewportSize.w, viewportSize.h)) toast('The clipboard does not contain an image.', 'info');
  touch();
}
