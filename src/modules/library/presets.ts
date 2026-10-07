import type { DevelopSettings } from '@/core/develop/settings';
import { autoTone, whiteBalanceFrom } from '@/core/develop/engine';
import { decodeImage } from '@/core/image/decode';
import { Photo, useCatalog } from '@/state/catalog';
import { errorToast, startTask, toast } from '@/state/app';
import { baseSettings, editSettings } from './actions';
import { destroyEngine, makeEngine } from './render';
import { plural } from './util';

/** Built-in Quick Develop presets (partial settings merged over each photo's current ones). */
export const BUILTIN_PRESETS: { id: string; name: string; settings: Partial<DevelopSettings> | null }[] = [
  { id: 'builtin:default', name: 'Default Settings', settings: null },
  { id: 'builtin:punch', name: 'Punch', settings: { contrast: 25, clarity: 15, dehaze: 8, vibrance: 22, blacks: -10 } },
  { id: 'builtin:vivid', name: 'Vivid Landscape', settings: { profile: 'landscape', vibrance: 30, saturation: 6, clarity: 12, highlights: -25, shadows: 20 } },
  { id: 'builtin:soft', name: 'Soft Portrait', settings: { profile: 'portrait', texture: -15, clarity: -8, highlights: -15, shadows: 10, vibrance: 8 } },
  {
    id: 'builtin:matte',
    name: 'Matte Fade',
    settings: {
      contrast: -12,
      saturation: -12,
      curve: { rgb: [[0, 0.08], [0.5, 0.5], [1, 0.94]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
    },
  },
  {
    id: 'builtin:warmfilm',
    name: 'Warm Film',
    settings: { temperature: 14, tint: 4, contrast: 10, saturation: -6, grain: { amount: 22, size: 25, roughness: 50 }, vignette: { amount: -14, midpoint: 50, roundness: 0, feather: 50, highlights: 0 } },
  },
  { id: 'builtin:cool', name: 'Cool Clean', settings: { temperature: -12, tint: -2, vibrance: 10, clarity: 6, whites: 8 } },
  { id: 'builtin:bwhigh', name: 'B&W High Contrast', settings: { treatment: 'bw', contrast: 40, clarity: 20, whites: 15, blacks: -20 } },
  { id: 'builtin:bwsoft', name: 'B&W Soft', settings: { treatment: 'bw', contrast: -10, highlights: -20, shadows: 25 } },
];

/**
 * Auto Tone / Auto White Balance for a batch of photos: each one is decoded small, rendered
 * neutral through a temporary engine, and analysed (luminance histogram / gray world).
 */
export async function autoAdjust(kind: 'tone' | 'wb', ids: string[]) {
  if (!ids.length) return toast('Select one or more photos first.');
  let cancelled = false;
  const label = kind === 'tone' ? 'Auto Tone' : 'Auto White Balance';
  const task = startTask(`${label}…`, () => (cancelled = true));
  let engine: ReturnType<typeof makeEngine> | null = null;
  const results = new Map<string, Partial<DevelopSettings>>();
  let failed = 0;
  try {
    // Inside the try: if no GPU context can be created the task must still end.
    engine = makeEngine();
    for (let i = 0; i < ids.length && !cancelled; i++) {
      const p: Photo | undefined = useCatalog.getState().photos[ids[i]];
      if (!p) continue;
      task.update(i / ids.length, `${label} ${i + 1}/${ids.length}`);
      try {
        const dec = await decodeImage(p.path, { maxSize: 900, rawHalfSize: true });
        engine.setSource(dec.source);
        if (dec.source instanceof ImageBitmap) dec.source.close();
        const s = baseSettings(p);
        const neutral: DevelopSettings = { ...s, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0 };
        const [w, h] = engine.fitSize(neutral, 512, 512);
        engine.render(neutral, w, h);
        if (kind === 'tone') results.set(p.id, autoTone(engine.histogram()));
        else results.set(p.id, whiteBalanceFrom(engine.averageBase()));
      } catch {
        failed++;
      }
    }
  } catch (e) {
    errorToast(e, label);
    return;
  } finally {
    if (engine) destroyEngine(engine);
    task.done();
  }
  if (results.size) {
    const n = editSettings(label, [...results.keys()], (s, p) => ({ ...s, ...results.get(p.id) }));
    toast(`${label}: ${plural(n, 'photo')} adjusted${failed ? `, ${failed} failed` : ''}.`, failed ? 'warn' : 'success');
  } else if (failed) toast(`${label} failed for ${plural(failed, 'photo')}.`, 'error');
}
