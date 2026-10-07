import { useEffect, useRef, useState } from 'react';
import { openDialog } from '@/state/app';
import { Checkbox, Select, Slider } from '@/ui/controls';
import type { Doc } from '../../model/doc';
import { Selection } from '../../model/selection';
import { edState, touch, useEditor } from '../../model/store';
import { samplePixels } from '../../ops/select';
import { colorRangeMask } from '../../paint/fill';
import { commit } from '../../ops/layers';
import { FloatingDialog } from './FloatingDialog';

type RangeMode = 'sampled' | 'highlights' | 'midtones' | 'shadows' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas';

const HUES: Partial<Record<RangeMode, number>> = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

function rangeMask(px: Uint8ClampedArray | Uint8Array, w: number, h: number, mode: RangeMode, samples: [number, number, number][], fuzz: number, invert: boolean): Uint8Array {
  if (mode === 'sampled') return colorRangeMask(px, w, h, samples, fuzz, invert);
  const out = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    let v: number;
    if (mode === 'highlights' || mode === 'midtones' || mode === 'shadows') {
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      v = mode === 'highlights' ? smooth(0.6, 0.8, l) : mode === 'shadows' ? 1 - smooth(0.2, 0.4, l) : smooth(0.15, 0.35, l) * (1 - smooth(0.65, 0.85, l));
    } else {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      let hue = 0;
      if (mx !== mn) {
        if (mx === r) hue = ((g - b) / (mx - mn)) % 6;
        else if (mx === g) hue = (b - r) / (mx - mn) + 2;
        else hue = (r - g) / (mx - mn) + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      const d = Math.min(Math.abs(hue - HUES[mode]!), 360 - Math.abs(hue - HUES[mode]!));
      v = (1 - smooth(20, 40, d)) * smooth(0.12, 0.3, sat);
    }
    v *= px[i + 3] / 255;
    out[p] = Math.round((invert ? 1 - v : v) * 255);
  }
  return out;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function Body({ doc, close }: { doc: Doc; close: () => void }) {
  const original = useRef(doc.selection);
  const px = useRef(samplePixels(doc, true));
  const fg = edState().fg;
  const [samples, setSamples] = useState<[number, number, number][]>([[fg.r, fg.g, fg.b]]);
  const [fuzz, setFuzz] = useState(40);
  const [invert, setInvert] = useState(false);
  const [mode, setMode] = useState<RangeMode>('sampled');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Canvas clicks sample colours (Shift adds, Alt removes).
  useEffect(() => {
    useEditor.setState({
      canvasPick: (x, y, mods) => {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= doc.width || iy >= doc.height) return;
        const i = (iy * doc.width + ix) * 4;
        const c: [number, number, number] = [px.current[i], px.current[i + 1], px.current[i + 2]];
        setMode('sampled');
        setSamples((s) => (mods.shift ? [...s, c] : mods.alt ? s.filter((x) => Math.hypot(x[0] - c[0], x[1] - c[1], x[2] - c[2]) > fuzz / 2) : [c]));
      },
    });
    return () => useEditor.setState({ canvasPick: null });
  }, [doc, fuzz]);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const base = rangeMask(px.current, doc.width, doc.height, mode, samples, fuzz, invert);
      let sel = Selection.fromFull(doc.width, doc.height, base);
      // Like Photoshop, Color Range works inside an existing selection.
      if (original.current) sel = Selection.combine(original.current, sel, 'intersect');
      doc.selection = sel;
      doc.invalidate();
    }, 40);
    return () => clearTimeout(timer.current);
  }, [samples, fuzz, invert, mode, doc]);

  return (
    <FloatingDialog
      title="Color Range"
      onOk={() => {
        clearTimeout(timer.current);
        const base = rangeMask(px.current, doc.width, doc.height, mode, samples, fuzz, invert);
        let sel = Selection.fromFull(doc.width, doc.height, base);
        if (original.current) sel = Selection.combine(original.current, sel, 'intersect');
        doc.selection = sel;
        if (original.current) doc.lastSelection = original.current;
        commit(doc, 'Color Range');
        touch();
        close();
      }}
      onCancel={() => {
        clearTimeout(timer.current);
        doc.selection = original.current;
        doc.invalidate();
        close();
      }}
    >
      <div className="row">
        <span className="muted" style={{ width: 70 }}>
          Select
        </span>
        <Select
          value={mode}
          options={[
            { value: 'sampled', label: 'Sampled Colors' },
            { value: 'reds', label: 'Reds' },
            { value: 'yellows', label: 'Yellows' },
            { value: 'greens', label: 'Greens' },
            { value: 'cyans', label: 'Cyans' },
            { value: 'blues', label: 'Blues' },
            { value: 'magentas', label: 'Magentas' },
            { value: 'highlights', label: 'Highlights' },
            { value: 'midtones', label: 'Midtones' },
            { value: 'shadows', label: 'Shadows' },
          ]}
          onChange={setMode}
        />
      </div>
      {mode === 'sampled' && (
        <>
          <Slider label="Fuzziness" value={fuzz} min={0} max={200} defaultValue={40} onChange={setFuzz} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {samples.map((c, i) => (
              <span key={i} className="swatch" style={{ width: 18, height: 18 }}>
                <span style={{ background: `rgb(${c.join(',')})` }} />
              </span>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11 }}>
            Click the image to sample · Shift-click adds · {navigator.platform.includes('Mac') ? 'Option' : 'Alt'}-click removes
          </div>
        </>
      )}
      <Checkbox checked={invert} onChange={setInvert}>
        Invert
      </Checkbox>
    </FloatingDialog>
  );
}

export function colorRangeDialog(doc: Doc) {
  return openDialog((close) => <Body doc={doc} close={() => close()} />);
}
