import { useEffect, useRef, useState } from 'react';
import { CurveEditor } from '@/ui/CurveEditor';
import { ColorSwatch } from '@/ui/ColorPicker';
import { Button, Checkbox, GRADIENTS, Select, Slider } from '@/ui/controls';
import type { CurvePoint } from '@/core/develop/settings';
import type { AdjustParams, GradientStop, LevelsChannel, RGBA } from '../model/types';
import { levelsIdentity } from '../render/adjustments';
import { gradientCss } from '../tools/fill';

export interface Histo {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
}

export function histogramOf(px: Uint8ClampedArray | Uint8Array): Histo {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  const step = Math.max(1, Math.floor(px.length / 4 / 1_000_000)) * 4;
  for (let i = 0; i < px.length; i += step) {
    if (px[i + 3] < 8) continue;
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
    l[Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])]++;
  }
  return { r, g, b, l };
}

function HistogramView({ h, color = 'rgba(220,220,225,0.7)', height = 70 }: { h: Uint32Array | null | undefined; color?: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 236;
    c.width = w * dpr;
    c.height = height * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#141415';
    ctx.fillRect(0, 0, w, height);
    if (!h) return;
    let max = 1;
    for (let i = 1; i < 255; i++) max = Math.max(max, h[i]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, height - Math.min(1, h[i] / max) * (height - 2));
    ctx.lineTo(w, height);
    ctx.fill();
  }, [h, color, height]);
  return <canvas ref={ref} className="ed-histo" style={{ height }} />;
}

const PHOTO_FILTERS: { label: string; color: RGBA }[] = [
  { label: 'Warming Filter (85)', color: { r: 236, g: 138, b: 0, a: 1 } },
  { label: 'Warming Filter (LBA)', color: { r: 250, g: 150, b: 0, a: 1 } },
  { label: 'Warming Filter (81)', color: { r: 235, g: 177, b: 19, a: 1 } },
  { label: 'Cooling Filter (80)', color: { r: 0, g: 109, b: 255, a: 1 } },
  { label: 'Cooling Filter (LBB)', color: { r: 0, g: 93, b: 255, a: 1 } },
  { label: 'Cooling Filter (82)', color: { r: 0, g: 181, b: 255, a: 1 } },
  { label: 'Red', color: { r: 234, g: 26, b: 26, a: 1 } },
  { label: 'Orange', color: { r: 243, g: 132, b: 23, a: 1 } },
  { label: 'Yellow', color: { r: 249, g: 227, b: 28, a: 1 } },
  { label: 'Green', color: { r: 25, g: 201, b: 25, a: 1 } },
  { label: 'Cyan', color: { r: 29, g: 203, b: 234, a: 1 } },
  { label: 'Blue', color: { r: 29, g: 53, b: 234, a: 1 } },
  { label: 'Violet', color: { r: 155, g: 29, b: 234, a: 1 } },
  { label: 'Magenta', color: { r: 227, g: 24, b: 227, a: 1 } },
  { label: 'Sepia', color: { r: 172, g: 122, b: 51, a: 1 } },
  { label: 'Deep Red', color: { r: 255, g: 0, b: 0, a: 1 } },
  { label: 'Deep Blue', color: { r: 0, g: 34, b: 205, a: 1 } },
  { label: 'Underwater', color: { r: 0, g: 194, b: 177, a: 1 } },
];

const GRADIENT_PRESETS: { label: string; stops: GradientStop[] }[] = [
  { label: 'Black, White', stops: [{ pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { pos: 1, color: { r: 255, g: 255, b: 255, a: 1 } }] },
  { label: 'Sepia', stops: [{ pos: 0, color: { r: 32, g: 18, b: 6, a: 1 } }, { pos: 0.5, color: { r: 150, g: 104, b: 60, a: 1 } }, { pos: 1, color: { r: 255, g: 245, b: 225, a: 1 } }] },
  { label: 'Blue, Orange', stops: [{ pos: 0, color: { r: 10, g: 40, b: 90, a: 1 } }, { pos: 0.5, color: { r: 128, g: 128, b: 128, a: 1 } }, { pos: 1, color: { r: 255, g: 160, b: 60, a: 1 } }] },
  { label: 'Violet, Orange', stops: [{ pos: 0, color: { r: 41, g: 10, b: 89, a: 1 } }, { pos: 1, color: { r: 255, g: 124, b: 0, a: 1 } }] },
  { label: 'Copper', stops: [{ pos: 0, color: { r: 25, g: 10, b: 5, a: 1 } }, { pos: 0.6, color: { r: 200, g: 110, b: 60, a: 1 } }, { pos: 1, color: { r: 255, g: 230, b: 200, a: 1 } }] },
  { label: 'Infrared', stops: [{ pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { pos: 0.33, color: { r: 140, g: 0, b: 140, a: 1 } }, { pos: 0.66, color: { r: 255, g: 120, b: 0, a: 1 } }, { pos: 1, color: { r: 255, g: 255, b: 200, a: 1 } }] },
];

type Ch = 'rgb' | 'r' | 'g' | 'b';
const CH_OPTS: { value: Ch; label: string }[] = [
  { value: 'rgb', label: 'RGB' },
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
];
const CH_COLOR: Record<Ch, string> = { rgb: '#e8e8ea', r: '#ff5a5a', g: '#5ad65a', b: '#5a8cff' };

/**
 * Parameter editor for every adjustment type. `onChange(p, commit)` — commit=true when a drag /
 * edit finished (record history), false for live updates.
 */
export function AdjustmentEditor({ p, onChange, histo, onAuto }: { p: AdjustParams; onChange: (p: AdjustParams, commit: boolean) => void; histo?: Histo | null; onAuto?: () => void }) {
  const [ch, setCh] = useState<Ch>('rgb');
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const set = (patch: Partial<AdjustParams>, commit = false) => onChange({ ...p, ...patch } as AdjustParams, commit);
  const S = (label: string, key: string, min: number, max: number, extra: Partial<React.ComponentProps<typeof Slider>> = {}) => (
    <Slider label={label} value={(p as any)[key]} min={min} max={max} onChange={(v) => set({ [key]: v } as any)} onCommit={(v) => set({ [key]: v } as any, true)} {...extra} />
  );

  switch (p.type) {
    case 'brightness':
      return (
        <div className="col">
          {S('Brightness', 'brightness', p.legacy ? -100 : -150, p.legacy ? 100 : 150)}
          {S('Contrast', 'contrast', p.legacy ? -100 : -50, 100)}
          <Checkbox checked={p.legacy} onChange={(v) => set({ legacy: v }, true)}>
            Use Legacy
          </Checkbox>
        </div>
      );
    case 'levels': {
      const c: LevelsChannel = p[ch];
      const setC = (patch: Partial<LevelsChannel>, commit = false) => onChange({ ...p, [ch]: { ...c, ...patch } }, commit);
      return (
        <div className="col">
          <div className="row">
            <Select value={ch} options={CH_OPTS} onChange={setCh} />
            <span className="spacer" />
            {onAuto && (
              <Button small onClick={onAuto}>
                Auto
              </Button>
            )}
            <Button small onClick={() => onChange({ ...p, [ch]: levelsIdentity() }, true)}>
              Reset
            </Button>
          </div>
          <HistogramView h={histo ? (ch === 'rgb' ? histo.l : histo[ch]) : null} color={CH_COLOR[ch]} />
          <div className="ed-levels-bar" style={{ background: `linear-gradient(90deg,#000,${ch === 'rgb' ? '#fff' : CH_COLOR[ch]})` }} />
          <Slider label="Input Black" value={c.inBlack} min={0} max={253} onChange={(v) => setC({ inBlack: Math.min(v, c.inWhite - 2) })} onCommit={() => setC({}, true)} />
          <Slider label="Gamma" value={c.gamma} min={0.1} max={9.99} step={0.01} defaultValue={1} curve="pow2" onChange={(v) => setC({ gamma: v })} onCommit={() => setC({}, true)} />
          <Slider label="Input White" value={c.inWhite} min={2} max={255} defaultValue={255} onChange={(v) => setC({ inWhite: Math.max(v, c.inBlack + 2) })} onCommit={() => setC({}, true)} />
          <Slider label="Output Black" value={c.outBlack} min={0} max={255} onChange={(v) => setC({ outBlack: v })} onCommit={() => setC({}, true)} />
          <Slider label="Output White" value={c.outWhite} min={0} max={255} defaultValue={255} onChange={(v) => setC({ outWhite: v })} onCommit={() => setC({}, true)} />
        </div>
      );
    }
    case 'curves': {
      const pts = p[ch] as CurvePoint[];
      return (
        <div className="col">
          <div className="row">
            <Select value={ch} options={CH_OPTS} onChange={setCh} />
            <span className="spacer" />
            {onAuto && (
              <Button small onClick={onAuto}>
                Auto
              </Button>
            )}
            <Button
              small
              onClick={() =>
                onChange(
                  {
                    ...p,
                    [ch]: [
                      [0, 0],
                      [1, 1],
                    ],
                  },
                  true,
                )
              }
            >
              Reset
            </Button>
          </div>
          <CurveEditor points={pts} color={CH_COLOR[ch]} histogram={histo ? (ch === 'rgb' ? histo.l : histo[ch]) : null} onChange={(v) => onChange({ ...p, [ch]: v }, false)} onCommit={(v) => onChange({ ...p, [ch]: v }, true)} />
          <div className="faint" style={{ fontSize: 10.5 }}>
            Click to add a point · drag off the graph or double-click to remove
          </div>
        </div>
      );
    }
    case 'exposure':
      return (
        <div className="col">
          {S('Exposure', 'exposure', -10, 10, { step: 0.01 })}
          {S('Offset', 'offset', -0.5, 0.5, { step: 0.0001, precision: 4 })}
          {S('Gamma', 'gamma', 0.01, 9.99, { step: 0.01, defaultValue: 1, curve: 'pow2' })}
        </div>
      );
    case 'vibrance':
      return (
        <div className="col">
          {S('Vibrance', 'vibrance', -100, 100, { gradient: GRADIENTS.saturation })}
          {S('Saturation', 'saturation', -100, 100, { gradient: GRADIENTS.saturation })}
        </div>
      );
    case 'hueSat':
      return (
        <div className="col">
          {S('Hue', 'hue', p.colorize ? 0 : -180, p.colorize ? 360 : 180, { gradient: GRADIENTS.hue })}
          {S('Saturation', 'saturation', p.colorize ? 0 : -100, 100, { gradient: GRADIENTS.saturation })}
          {S('Lightness', 'lightness', -100, 100, { gradient: 'linear-gradient(90deg,#000,#888,#fff)' })}
          <Checkbox checked={p.colorize} onChange={(v) => set(v ? { colorize: true, hue: p.hue < 0 ? p.hue + 360 : p.hue, saturation: p.saturation > 0 ? p.saturation : 25 } : { colorize: false, hue: p.hue > 180 ? p.hue - 360 : p.hue, saturation: 0 }, true)}>
            Colorize
          </Checkbox>
        </div>
      );
    case 'colorBalance': {
      const v = p[tone];
      const setV = (i: number, val: number, commit = false) => {
        const nv = [...v] as [number, number, number];
        nv[i] = val;
        onChange({ ...p, [tone]: nv }, commit);
      };
      return (
        <div className="col">
          <Select
            value={tone}
            options={[
              { value: 'shadows', label: 'Shadows' },
              { value: 'midtones', label: 'Midtones' },
              { value: 'highlights', label: 'Highlights' },
            ]}
            onChange={setTone}
          />
          <Slider label="Cyan – Red" value={v[0]} min={-100} max={100} gradient="linear-gradient(90deg,#0ff,#888,#f33)" onChange={(x) => setV(0, x)} onCommit={(x) => setV(0, x, true)} />
          <Slider label="Magenta – Green" value={v[1]} min={-100} max={100} gradient="linear-gradient(90deg,#f0f,#888,#3c3)" onChange={(x) => setV(1, x)} onCommit={(x) => setV(1, x, true)} />
          <Slider label="Yellow – Blue" value={v[2]} min={-100} max={100} gradient="linear-gradient(90deg,#ff0,#888,#36f)" onChange={(x) => setV(2, x)} onCommit={(x) => setV(2, x, true)} />
          <Checkbox checked={p.preserveLum} onChange={(x) => set({ preserveLum: x }, true)}>
            Preserve Luminosity
          </Checkbox>
        </div>
      );
    }
    case 'bw':
      return (
        <div className="col">
          {S('Reds', 'reds', -200, 300, { defaultValue: 40, gradient: 'linear-gradient(90deg,#000,#f33)' })}
          {S('Yellows', 'yellows', -200, 300, { defaultValue: 60, gradient: 'linear-gradient(90deg,#000,#ff3)' })}
          {S('Greens', 'greens', -200, 300, { defaultValue: 40, gradient: 'linear-gradient(90deg,#000,#3c3)' })}
          {S('Cyans', 'cyans', -200, 300, { defaultValue: 60, gradient: 'linear-gradient(90deg,#000,#3ff)' })}
          {S('Blues', 'blues', -200, 300, { defaultValue: 20, gradient: 'linear-gradient(90deg,#000,#36f)' })}
          {S('Magentas', 'magentas', -200, 300, { defaultValue: 80, gradient: 'linear-gradient(90deg,#000,#f3f)' })}
          <div className="row">
            <Checkbox checked={p.tint} onChange={(v) => set({ tint: v }, true)}>
              Tint
            </Checkbox>
            <ColorSwatch value={p.tintColor} alpha={false} onChange={(c) => set({ tintColor: { ...c, a: 1 }, tint: true }, true)} />
          </div>
        </div>
      );
    case 'photoFilter':
      return (
        <div className="col">
          <div className="row">
            <Select
              value={PHOTO_FILTERS.findIndex((f) => f.color.r === p.color.r && f.color.g === p.color.g && f.color.b === p.color.b)}
              options={[{ value: -1, label: 'Custom' }, ...PHOTO_FILTERS.map((f, i) => ({ value: i, label: f.label }))]}
              onChange={(i) => i >= 0 && set({ color: { ...PHOTO_FILTERS[i].color } }, true)}
              style={{ flex: 1 }}
            />
            <ColorSwatch value={p.color} alpha={false} onChange={(c) => set({ color: { ...c, a: 1 } }, true)} />
          </div>
          {S('Density', 'density', 0, 100, { suffix: '%' })}
          <Checkbox checked={p.preserveLum} onChange={(v) => set({ preserveLum: v }, true)}>
            Preserve Luminosity
          </Checkbox>
        </div>
      );
    case 'invert':
      return <div className="faint">Invert has no settings.</div>;
    case 'posterize':
      return <div className="col">{S('Levels', 'levels', 2, 255, { defaultValue: 4, curve: 'pow2' })}</div>;
    case 'threshold':
      return (
        <div className="col">
          <HistogramView h={histo?.l} />
          {S('Threshold Level', 'level', 1, 255, { defaultValue: 128 })}
        </div>
      );
    case 'gradientMap': {
      const stops = [...p.stops].sort((a, b) => a.pos - b.pos);
      return (
        <div className="col">
          <div className="ed-grad-bar" style={{ background: gradientCss(p.reverse ? stops.map((s) => ({ ...s, pos: 1 - s.pos })) : stops) }} />
          <Select value={-1} options={[{ value: -1, label: 'Presets…' }, ...GRADIENT_PRESETS.map((g, i) => ({ value: i, label: g.label }))]} onChange={(i) => i >= 0 && set({ stops: GRADIENT_PRESETS[i].stops.map((s) => ({ ...s, color: { ...s.color } })) }, true)} />
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {stops.map((s, i) => (
              <div key={i} className="row" style={{ gap: 3 }}>
                <ColorSwatch value={s.color} alpha={false} onChange={(c) => set({ stops: stops.map((x, j) => (j === i ? { ...x, color: { ...c, a: 1 } } : x)) }, true)} />
                <span className="faint mono" style={{ fontSize: 10 }}>
                  {Math.round(s.pos * 100)}%
                </span>
              </div>
            ))}
            {stops.length < 6 && (
              <Button
                small
                onClick={() => {
                  const ns = [...stops, { pos: 0.5, color: { r: 128, g: 128, b: 128, a: 1 } }].sort((a, b) => a.pos - b.pos);
                  set({ stops: ns }, true);
                }}
              >
                + Stop
              </Button>
            )}
            {stops.length > 2 && (
              <Button small onClick={() => set({ stops: stops.filter((_, i) => i !== 1) }, true)}>
                − Stop
              </Button>
            )}
          </div>
          <Checkbox checked={p.reverse} onChange={(v) => set({ reverse: v }, true)}>
            Reverse
          </Checkbox>
        </div>
      );
    }
  }
}
