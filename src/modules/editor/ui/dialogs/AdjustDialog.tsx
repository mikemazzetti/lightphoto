import { useEffect, useMemo, useState } from 'react';
import { openDialog } from '@/state/app';
import type { Doc } from '../../model/doc';
import type { AdjustParams, AdjustType, LevelsChannel } from '../../model/types';
import { edState } from '../../model/store';
import { ctx2d, makeCanvas, Surface } from '../../model/surface';
import { ADJUST_NAMES, autoLevels, defaultAdjust } from '../../render/adjustments';
import { adjustProcess, PreviewSession } from '../../ops/process';
import { AdjustmentEditor, histogramOf, Histo } from '../AdjustmentEditor';
import { FloatingDialog } from './FloatingDialog';

/** Downsampled pixels of a surface (for histograms / auto). */
export function samplePixelsOf(s: Surface, max = 512): Uint8ClampedArray {
  const k = Math.min(1, max / Math.max(s.width, s.height));
  const w = Math.max(1, Math.round(s.width * k));
  const h = Math.max(1, Math.round(s.height * k));
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c, true);
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(s.canvas, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Converts an auto-levels result into the requested adjustment type. */
export function autoFor(p: AdjustParams, px: Uint8ClampedArray): AdjustParams {
  const lv = autoLevels(px, 'color') as Extract<AdjustParams, { type: 'levels' }>;
  if (p.type === 'levels') return lv;
  if (p.type === 'curves') {
    const pts = (c: LevelsChannel): [number, number][] => {
      const a: [number, number][] = [
        [c.inBlack / 255, 0],
        [c.inWhite / 255, 1],
      ];
      if (c.gamma !== 1) {
        const mx = (c.inBlack + c.inWhite) / 2 / 255;
        a.splice(1, 0, [mx, Math.pow(0.5, 1 / c.gamma)]);
      }
      if (a[0][0] > 0) a.unshift([0, 0]);
      if (a[a.length - 1][0] < 1) a.push([1, 1]);
      return a;
    };
    return {
      ...p,
      r: pts(lv.r),
      g: pts(lv.g),
      b: pts(lv.b),
      rgb: [
        [0, 0],
        [1, 1],
      ],
    };
  }
  return p;
}

function Body({ session, type, histo, px, close }: { session: PreviewSession; type: AdjustType; histo: Histo; px: Uint8ClampedArray; close: () => void }) {
  const s = edState();
  const [p, setP] = useState<AdjustParams>(() => defaultAdjust(type, s.fg, s.bg));
  const [preview, setPreview] = useState(true);
  const key = useMemo(() => JSON.stringify(p), [p]);
  useEffect(() => {
    session.update(key, adjustProcess(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <FloatingDialog
      title={ADJUST_NAMES[type]}
      onOk={() => {
        session.apply(adjustProcess(p));
        close();
      }}
      onCancel={() => {
        session.cancel();
        close();
      }}
      preview={preview}
      onPreview={(v) => {
        setPreview(v);
        session.setEnabled(v);
      }}
      width={type === 'curves' ? 290 : 340}
    >
      <AdjustmentEditor p={p} onChange={(np) => setP(np)} histo={histo} onAuto={type === 'levels' || type === 'curves' ? () => setP(autoFor(p, px)) : undefined} />
    </FloatingDialog>
  );
}

/** Image ▸ Adjustments ▸ … (destructive, live preview on the canvas). */
export async function adjustDialog(doc: Doc, type: AdjustType) {
  const session = await PreviewSession.start(doc, { label: ADJUST_NAMES[type], keepAlpha: true });
  if (!session) return;
  const px = samplePixelsOf(session.surface);
  const histo = histogramOf(px);
  return openDialog((close) => <Body session={session} type={type} histo={histo} px={px} close={() => close()} />);
}
