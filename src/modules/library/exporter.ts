import { api, stem } from '@/platform/api';
import { encodeImage, FORMAT_EXT } from '@/core/image/encode';
import { nextFrame } from '@/core/util/async';
import { useCatalog } from '@/state/catalog';
import { startTask, toast } from '@/state/app';
import type { DevelopEngine } from '@/core/develop/engine';
import { destroyEngine, makeEngine, renderFull, renderSettingsFor } from './render';
import { getLibraryIds } from './ids';
import type { ExportPrefs } from './store';
import { isoDay, joinPath, plural, sanitizeFileName } from './util';

/** Expands the filename template for photo #seq (1-based) of `total`. */
export function expandTemplate(template: string, p: { name: string; path: string; mtime: number; meta?: { dateTaken?: number }; virtualOf?: string }, seq: number, total: number): string {
  const digits = Math.max(3, String(total).length);
  const base = stem(p.path.split(/[\\/]/).pop() ?? p.name);
  const out = (template.trim() || '{name}')
    .replace(/\{name\}/gi, base + (p.virtualOf ? '-copy' : ''))
    .replace(/\{seq\}/gi, String(seq).padStart(digits, '0'))
    .replace(/\{date\}/gi, isoDay(p.meta?.dateTaken ?? p.mtime));
  return sanitizeFileName(out);
}

let exporting = false;
export const isExporting = () => exporting;

/** Renders and writes each photo (one reused GPU engine), with title-bar progress + cancel. */
export async function runExport(ids: string[], o: ExportPrefs) {
  if (exporting) return toast('An export is already running.', 'warn');
  // Export in grid order so {seq} matches what the user sees.
  const order = new Map(getLibraryIds().map((id, i) => [id, i]));
  const list = [...ids].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  exporting = true;
  let cancelled = false;
  const task = startTask(`Exporting ${plural(list.length, 'photo')}…`, () => (cancelled = true));
  let engine: DevelopEngine | null = null;
  let ok = 0;
  let skipped = 0;
  const errors: string[] = [];
  const used = new Set<string>();
  const ext = FORMAT_EXT[o.format];
  const toDisk = api.isElectron && !!o.dir;
  try {
    for (let i = 0; i < list.length && !cancelled; i++) {
      const p = useCatalog.getState().photos[list[i]];
      if (!p) continue;
      task.update(i / list.length, `Exporting ${i + 1}/${list.length} · ${p.name}`);
      try {
        // Unique, non-clobbering file name.
        const stemName = expandTemplate(o.template, { ...p, meta: p.meta }, i + 1, list.length);
        let name = `${stemName}.${ext}`;
        let target = toDisk ? joinPath(o.dir, name) : `download://${name}`;
        for (let k = 2; ; k++) {
          const taken = used.has(name.toLowerCase()) || (toDisk && o.onExists !== 'overwrite' && !!(await api.stat(target)));
          if (!taken) break;
          if (o.onExists === 'skip' && !used.has(name.toLowerCase())) {
            target = '';
            break;
          }
          name = `${stemName}-${k}.${ext}`;
          target = toDisk ? joinPath(o.dir, name) : `download://${name}`;
        }
        if (!target) {
          skipped++;
          continue;
        }
        used.add(name.toLowerCase());
        const needsEngine = !!renderSettingsFor(p, o.includeEdits);
        if (needsEngine && !engine) engine = makeEngine();
        const pixels = await renderFull(p, { includeEdits: o.includeEdits, longEdge: o.longEdge, engine: engine ?? undefined });
        const blob = await encodeImage(pixels, { format: o.format, quality: o.quality, longEdge: o.longEdge || undefined });
        if (pixels instanceof ImageBitmap) pixels.close();
        await api.writeFile(target, blob);
        ok++;
      } catch (e) {
        errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        console.error(e);
      }
      await nextFrame(); // keep the UI responsive between photos
    }
  } finally {
    if (engine) destroyEngine(engine);
    exporting = false;
    task.done();
  }
  const where = toDisk ? ` to ${o.dir}` : '';
  const parts = [`Exported ${plural(ok, 'photo')}${where}`];
  if (skipped) parts.push(`${skipped} skipped (file exists)`);
  if (errors.length) parts.push(`${errors.length} failed — ${errors[0]}`);
  if (cancelled) parts.push('cancelled');
  toast(parts.join(' · '), errors.length ? (ok ? 'warn' : 'error') : 'success', errors.length ? 9000 : 4500);
}

/** Example of the first output name (for the dialog). */
export function exampleName(ids: string[], o: Pick<ExportPrefs, 'template' | 'format'>): string {
  const p = useCatalog.getState().photos[ids[0]];
  if (!p) return '';
  return `${expandTemplate(o.template, p, 1, ids.length)}.${FORMAT_EXT[o.format]}`;
}

