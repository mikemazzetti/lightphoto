import { useState } from 'react';
import { normalizeSettings } from '@/core/develop/settings';
import { encodeImage, ExportFormat, ExportOptions, FORMAT_EXT } from '@/core/image/encode';
import { api, basename, FILTERS, stem } from '@/platform/api';
import { errorToast, openDialog, startTask, toast } from '@/state/app';
import { Photo, useCatalog } from '@/state/catalog';
import { Button, Checkbox, NumberField, Select, Slider } from '@/ui/controls';
import { Modal } from '@/ui/overlays';
import { renderFull } from './actions';
import { getController } from './controller';
import { applyCrop } from './cropTool';
import { defaultsFor, useDevelop } from './store';

interface ExportPrefs {
  format: ExportFormat;
  quality: number;
  resize: boolean;
  longEdge: number;
  batch: boolean;
}

const PREF_KEY = 'lp:develop-export';
function loadPrefs(): ExportPrefs {
  const d: ExportPrefs = { format: 'jpeg', quality: 90, resize: false, longEdge: 2048, batch: false };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
  } catch {
    return d;
  }
}
function savePrefs(p: ExportPrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function ExportBody({ close, photo, count, size }: { close: (v?: ExportPrefs | null) => void; photo: Photo; count: number; size: [number, number] | null }) {
  const [p, setP] = useState<ExportPrefs>(loadPrefs);
  const set = (patch: Partial<ExportPrefs>) => setP((x) => ({ ...x, ...patch }));
  let out = size;
  if (out && p.resize && p.longEdge > 0) {
    const k = Math.min(1, p.longEdge / Math.max(out[0], out[1]));
    out = [Math.round(out[0] * k), Math.round(out[1] * k)];
  }
  const batch = p.batch && count > 1;
  return (
    <Modal
      title={batch ? `Export ${count} Photos` : `Export “${photo.name}”`}
      onClose={() => close(null)}
      width={440}
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => close({ ...p, batch })}>
            {batch ? 'Choose Folder…' : 'Export…'}
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Format</label>
        <Select
          value={p.format}
          options={[
            { value: 'jpeg', label: 'JPEG' },
            { value: 'png', label: 'PNG' },
            { value: 'webp', label: 'WebP' },
          ]}
          onChange={(format) => set({ format })}
        />
      </div>
      {p.format !== 'png' && <Slider label="Quality" value={p.quality} min={10} max={100} defaultValue={90} onChange={(quality) => set({ quality })} labelWidth={96} />}
      <div className="field">
        <label>Resize</label>
        <div className="row">
          <Checkbox checked={p.resize} onChange={(resize) => set({ resize })}>
            Long edge
          </Checkbox>
          <NumberField value={p.longEdge} min={64} max={30000} step={64} suffix=" px" width={86} onChange={(longEdge) => set({ longEdge, resize: true })} />
        </div>
      </div>
      {count > 1 && (
        <Checkbox checked={p.batch} onChange={(b) => set({ batch: b })}>
          Export all {count} selected photos to a folder
        </Checkbox>
      )}
      {!batch && out && (
        <div className="faint">
          Output: {out[0]} × {out[1]} px · sRGB
        </div>
      )}
    </Modal>
  );
}

/** ⇧⌘E — export the developed photo (or the selection) at full resolution. */
export async function exportDialog() {
  const st = useDevelop.getState();
  const cat = useCatalog.getState();
  const photo = st.photoId ? cat.photos[st.photoId] : undefined;
  if (!photo || !st.settings) return;
  if (st.tool === 'crop') applyCrop();
  const sel = cat.selection.filter((id) => cat.photos[id]);
  const c = getController();
  const size = c?.engine.hasSource && c.stage === 'full' ? c.engine.fullSize(useDevelop.getState().settings!) : null;
  const prefs = await openDialog<ExportPrefs | null>((close) => <ExportBody close={close} photo={photo} count={sel.length} size={size} />);
  if (!prefs) return;
  savePrefs({ ...prefs, batch: prefs.batch });
  const opts: ExportOptions = { format: prefs.format, quality: prefs.quality, longEdge: prefs.resize ? prefs.longEdge : 0 };
  if (prefs.batch) return exportBatch(sel, opts);

  const path = await api.saveDialog({ title: 'Export Image', defaultPath: `${stem(photo.name)}.${FORMAT_EXT[opts.format]}`, filters: [FILTERS[opts.format]] });
  if (!path) return;
  // The active photo may have changed while the dialogs were open (←/→ still navigate).
  const settings = settingsFor(photo);
  const task = startTask(`Exporting ${photo.name}`);
  try {
    const img = await renderFull(photo, settings, opts.longEdge ?? 0, (l) => task.update(null, l));
    task.update(0.85, 'Encoding…');
    const blob = await encodeImage(img, opts);
    await api.writeFile(path, blob);
    toast(`Exported ${basename(path)}`, 'success');
  } catch (e) {
    errorToast(e, 'Export failed');
  } finally {
    task.done();
  }
}

/** Live settings for the photo being edited, catalog settings (or the kind's defaults) for others. */
function settingsFor(p: Photo) {
  const st = useDevelop.getState();
  if (p.id === st.photoId && st.settings) return st.settings;
  return p.settings ? normalizeSettings(p.settings) : defaultsFor(p);
}

async function exportBatch(ids: string[], opts: ExportOptions) {
  const dir = await api.openFolder('Choose Export Folder');
  if (!dir) return;
  let cancelled = false;
  const task = startTask(`Exporting ${ids.length} photos`, () => {
    cancelled = true;
  });
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  // A drive / volume root (C:\ or /) already ends with a separator.
  const base = /[\\/]$/.test(dir) ? dir : dir + sep;
  const used = new Set<string>();
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < ids.length && !cancelled; i++) {
    const p = useCatalog.getState().photos[ids[i]];
    if (!p) continue;
    task.update(i / ids.length, `Exporting ${p.name} (${i + 1}/${ids.length})`);
    const settings = settingsFor(p);
    try {
      const img = await renderFull(p, settings, opts.longEdge ?? 0);
      const blob = await encodeImage(img, opts);
      // Unique names: compared case-insensitively (macOS / Windows file systems) and never
      // clobbering files already in the folder.
      const ext = FORMAT_EXT[opts.format];
      let name = `${stem(p.name)}.${ext}`;
      for (let k = 2; used.has(name.toLowerCase()) || (await api.stat(base + name).catch(() => null)); k++) name = `${stem(p.name)}-${k}.${ext}`;
      used.add(name.toLowerCase());
      await api.writeFile(base + name, blob);
      ok++;
    } catch (e) {
      console.error(e);
      failed++;
    }
  }
  task.done();
  if (failed) toast(`Exported ${ok} photo${ok === 1 ? '' : 's'}, ${failed} failed.`, 'warn');
  else toast(`Exported ${ok} photo${ok === 1 ? '' : 's'}${cancelled ? ' (cancelled)' : ''}`, 'success');
}
