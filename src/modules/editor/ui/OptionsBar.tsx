import { ReactNode, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, cx, Select } from '@/ui/controls';
import { ColorSwatch } from '@/ui/ColorPicker';
import { Icon } from '@/ui/Icon';
import type { BlendMode } from '@/core/gl/glsl';
import { activeDoc, CloneOpts, edState, setOpts, setRetouchOpts, ToolId, TOOL_LABELS, useActiveDoc, useEditor } from '../model/store';
import type { SelectionMode } from '../model/selection';
import type { RGBA, ShapeProps, TextProps } from '../model/types';
import { A } from '../actions';
import { setLayerProps } from '../ops/layers';
import { commitCrop, cancelCrop } from '../tools/crop';
import { commitTextEdit, cancelTextEdit, updateEditingText, useTextEdit } from '../tools/text';
import { cancelTransform, commitTransform, setTransformParams, useTransformUI } from '../tools/transform';
import { gradientCss, gradientStops } from '../tools/fill';
import { BLEND_OPTIONS } from './dialogs/editDialogs';
import { EdIcon, TOOL_ICONS } from './icons';

// ---------------------------------------------------------------------------------------------
// Compact controls

/** Photoshop "scrubby" numeric field: drag the label to change the value, or type. */
export function Scrub({ label, value, min, max, step = 1, suffix = '', onChange, width = 44, precision = 0, title }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void; width?: number; precision?: number; title?: string }) {
  const [text, setText] = useState<string | null>(null);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const onDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = value;
    const range = max - min;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const k = range > 500 ? Math.max(1, Math.abs(v0) / 60) : range > 50 ? 0.5 : step;
      const v = clampV(+(v0 + Math.round(dx * (ev.shiftKey ? 4 : 1) * k / step) * step).toFixed(6));
      onChange(v);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <span className="ed-scrub" title={title}>
      <span className="ed-scrub-label" onPointerDown={onDown}>
        {label}
      </span>
      <input
        className="input mono"
        style={{ width }}
        value={text ?? `${value.toFixed(precision)}${suffix}`}
        onFocus={(e) => {
          setText(value.toFixed(precision));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(clampV(v));
          setText(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const v = clampV(+(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(6));
            onChange(v);
            setText(v.toFixed(precision));
          }
        }}
      />
    </span>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; icon?: ReactNode; label?: string; title: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="ed-seg">
      {options.map((o) => (
        <button key={o.value} type="button" title={o.title} className={cx(o.value === value && 'active')} onClick={() => onChange(o.value)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </span>
  );
}

const Sep = () => <span className="ed-opt-sep" />;

function Toggle({ on, onChange, title, children }: { on: boolean; onChange: (v: boolean) => void; title: string; children: ReactNode }) {
  return (
    <button type="button" className={cx('ed-toggle', on && 'active')} title={title} onClick={() => onChange(!on)}>
      {children}
    </button>
  );
}

const SEL_MODES: { value: SelectionMode; icon: ReactNode; title: string }[] = [
  { value: 'new', icon: <span className="ed-selmode new" />, title: 'New selection' },
  { value: 'add', icon: <span className="ed-selmode add" />, title: 'Add to selection (Shift)' },
  { value: 'subtract', icon: <span className="ed-selmode sub" />, title: 'Subtract from selection (Alt)' },
  { value: 'intersect', icon: <span className="ed-selmode int" />, title: 'Intersect with selection (Shift+Alt)' },
];

function BlendSelect({ value, onChange }: { value: BlendMode; onChange: (v: BlendMode) => void }) {
  return <Select value={value} options={BLEND_OPTIONS} onChange={onChange} style={{ width: 118 }} title="Mode" />;
}

const PressureIcon = ({ label }: { label: string }) => (
  <span className="ed-pressure">
    <Icon name="pencil" size={12} />
    <small>{label}</small>
  </span>
);

const FONT_FALLBACK = [
  'Helvetica',
  'Helvetica Neue',
  'Arial',
  'Avenir',
  'Avenir Next',
  'Futura',
  'Gill Sans',
  'Optima',
  'Georgia',
  'Times New Roman',
  'Baskerville',
  'Didot',
  'Palatino',
  'Courier New',
  'Menlo',
  'Monaco',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Impact',
  'Segoe UI',
  'Calibri',
  'Cambria',
  'Consolas',
  'system-ui',
  'serif',
  'sans-serif',
  'monospace',
];
let fontList: string[] = FONT_FALLBACK;
let fontQuery: Promise<void> | null = null;
function loadFonts(cb: () => void) {
  const q = (window as any).queryLocalFonts;
  if (!q || fontQuery) return;
  fontQuery = q()
    .then((fonts: { family: string }[]) => {
      const fams = [...new Set(fonts.map((f) => f.family))].sort();
      if (fams.length) fontList = [...fams, 'system-ui', 'serif', 'sans-serif', 'monospace'];
      cb();
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------------------------

function BrushOptions({ tool }: { tool: 'brush' | 'pencil' | 'eraser' | 'clone' }) {
  const o = useEditor((s) => s.opts[tool]);
  const set = (p: Partial<typeof o>) => setOpts(tool, p as never);
  const er = useEditor((s) => s.opts.eraser.eraserMode);
  const pencilish = tool === 'pencil' || (tool === 'eraser' && er === 'pencil');
  return (
    <>
      {tool === 'eraser' && (
        <>
          <span className="faint">Mode</span>
          <Select
            value={er}
            options={[
              { value: 'brush', label: 'Brush' },
              { value: 'pencil', label: 'Pencil' },
            ]}
            onChange={(v) => setOpts('eraser', { eraserMode: v })}
          />
          <Sep />
        </>
      )}
      <Scrub label="Size" value={o.size} min={1} max={5000} suffix=" px" onChange={(v) => set({ size: v })} width={58} />
      {!pencilish && <Scrub label="Hardness" value={o.hardness} min={0} max={100} suffix="%" onChange={(v) => set({ hardness: v })} />}
      <Sep />
      {tool !== 'eraser' && (
        <>
          <span className="faint">Mode</span>
          <BlendSelect value={o.blend} onChange={(v) => set({ blend: v })} />
        </>
      )}
      <Scrub label="Opacity" value={o.opacity} min={1} max={100} suffix="%" onChange={(v) => set({ opacity: v })} />
      <Toggle on={o.pressureOpacity} onChange={(v) => set({ pressureOpacity: v })} title="Use pressure for opacity">
        <PressureIcon label="O" />
      </Toggle>
      {!pencilish && <Scrub label="Flow" value={o.flow} min={1} max={100} suffix="%" onChange={(v) => set({ flow: v })} />}
      {!pencilish && <Scrub label="Smoothing" value={o.smoothing} min={0} max={100} suffix="%" onChange={(v) => set({ smoothing: v })} />}
      <Scrub label="Spacing" value={o.spacing} min={1} max={300} suffix="%" onChange={(v) => set({ spacing: v })} />
      <Toggle on={o.pressureSize} onChange={(v) => set({ pressureSize: v })} title="Use pressure for size">
        <PressureIcon label="S" />
      </Toggle>
      {tool === 'clone' && (
        <>
          <Sep />
          <Checkbox checked={(o as CloneOpts).aligned} onChange={(v) => setOpts('clone', { aligned: v })}>
            Aligned
          </Checkbox>
          <Checkbox checked={(o as CloneOpts).sampleAll} onChange={(v) => setOpts('clone', { sampleAll: v })}>
            Sample All Layers
          </Checkbox>
          <span className="faint">{navigator.platform.includes('Mac') ? '⌥' : 'Alt'}-click sets the source</span>
        </>
      )}
    </>
  );
}

function HealOptions({ tool }: { tool: 'heal' | 'spotHeal' }) {
  const o = useEditor((s) => s.opts.heal);
  return (
    <>
      <Scrub label="Size" value={o.size} min={1} max={2000} suffix=" px" onChange={(v) => setOpts('heal', { size: v })} width={58} />
      <Scrub label="Hardness" value={o.hardness} min={0} max={100} suffix="%" onChange={(v) => setOpts('heal', { hardness: v })} />
      <Scrub label="Spacing" value={o.spacing} min={1} max={200} suffix="%" onChange={(v) => setOpts('heal', { spacing: v })} />
      {tool === 'heal' ? (
        <>
          <Sep />
          <Checkbox checked={o.aligned} onChange={(v) => setOpts('heal', { aligned: v })}>
            Aligned
          </Checkbox>
          <Checkbox checked={o.sampleAll} onChange={(v) => setOpts('heal', { sampleAll: v })}>
            Sample All Layers
          </Checkbox>
          <span className="faint">{navigator.platform.includes('Mac') ? '⌥' : 'Alt'}-click sets the source</span>
        </>
      ) : (
        <span className="faint">Content-aware: paint over blemishes</span>
      )}
    </>
  );
}

function RetouchOptions({ tool }: { tool: 'blur' | 'sharpen' | 'smudge' | 'dodge' | 'burn' | 'sponge' }) {
  const o = useEditor((s) => s.opts.retouch[tool]);
  const set = (p: Partial<typeof o>) => setRetouchOpts(tool, p);
  return (
    <>
      <Scrub label="Size" value={o.size} min={1} max={2000} suffix=" px" onChange={(v) => set({ size: v })} width={58} />
      <Scrub label="Hardness" value={o.hardness} min={0} max={100} suffix="%" onChange={(v) => set({ hardness: v })} />
      <Sep />
      {(tool === 'dodge' || tool === 'burn') && (
        <>
          <span className="faint">Range</span>
          <Select
            value={o.range}
            options={[
              { value: 'shadows', label: 'Shadows' },
              { value: 'midtones', label: 'Midtones' },
              { value: 'highlights', label: 'Highlights' },
            ]}
            onChange={(v) => set({ range: v })}
          />
        </>
      )}
      {tool === 'sponge' && (
        <>
          <span className="faint">Mode</span>
          <Select
            value={o.spongeMode}
            options={[
              { value: 'desaturate', label: 'Desaturate' },
              { value: 'saturate', label: 'Saturate' },
            ]}
            onChange={(v) => set({ spongeMode: v })}
          />
        </>
      )}
      <Scrub label={tool === 'dodge' || tool === 'burn' ? 'Exposure' : tool === 'sponge' ? 'Flow' : 'Strength'} value={o.strength} min={1} max={100} suffix="%" onChange={(v) => set({ strength: v })} />
      {(tool === 'dodge' || tool === 'burn' || tool === 'sponge') && (
        <Checkbox checked={o.protectTones} onChange={(v) => set({ protectTones: v })}>
          {tool === 'sponge' ? 'Vibrance' : 'Protect Tones'}
        </Checkbox>
      )}
    </>
  );
}

function SelectOptions({ which }: { which: 'marquee' | 'lasso' }) {
  const o = useEditor((s) => s.opts[which]);
  const tool = useEditor((s) => s.tool);
  return (
    <>
      <Seg value={o.mode} options={SEL_MODES} onChange={(v) => setOpts(which, { mode: v })} />
      <Sep />
      <Scrub label="Feather" value={o.feather} min={0} max={250} suffix=" px" onChange={(v) => setOpts(which, { feather: v })} />
      {tool !== 'marqueeRect' && (
        <Checkbox checked={o.antialias} onChange={(v) => setOpts(which, { antialias: v })}>
          Anti-alias
        </Checkbox>
      )}
      {which === 'marquee' && (
        <>
          <Sep />
          <span className="faint">Style</span>
          <Select
            value={o.style}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'ratio', label: 'Fixed Ratio' },
              { value: 'size', label: 'Fixed Size' },
            ]}
            onChange={(v) => setOpts('marquee', { style: v, ...(v === 'size' && o.ratioW < 8 ? { ratioW: 512, ratioH: 512 } : v === 'ratio' && o.ratioW > 64 ? { ratioW: 1, ratioH: 1 } : {}) })}
          />
          {o.style !== 'normal' && (
            <>
              <Scrub label="W" value={o.ratioW} min={o.style === 'ratio' ? 0.01 : 1} max={o.style === 'ratio' ? 100 : 16384} step={o.style === 'ratio' ? 0.01 : 1} precision={o.style === 'ratio' ? 2 : 0} onChange={(v) => setOpts('marquee', { ratioW: v })} />
              <button type="button" className="ed-mini-btn" title="Swap" onClick={() => setOpts('marquee', { ratioW: o.ratioH, ratioH: o.ratioW })}>
                ⇄
              </button>
              <Scrub label="H" value={o.ratioH} min={o.style === 'ratio' ? 0.01 : 1} max={o.style === 'ratio' ? 100 : 16384} step={o.style === 'ratio' ? 0.01 : 1} precision={o.style === 'ratio' ? 2 : 0} onChange={(v) => setOpts('marquee', { ratioH: v })} />
            </>
          )}
        </>
      )}
    </>
  );
}

function WandOptions() {
  const o = useEditor((s) => s.opts.wand);
  return (
    <>
      <Seg value={o.mode} options={SEL_MODES} onChange={(v) => setOpts('wand', { mode: v })} />
      <Sep />
      <Scrub label="Tolerance" value={o.tolerance} min={0} max={255} onChange={(v) => setOpts('wand', { tolerance: v })} />
      <Checkbox checked={o.antialias} onChange={(v) => setOpts('wand', { antialias: v })}>
        Anti-alias
      </Checkbox>
      <Checkbox checked={o.contiguous} onChange={(v) => setOpts('wand', { contiguous: v })}>
        Contiguous
      </Checkbox>
      <Checkbox checked={o.sampleAll} onChange={(v) => setOpts('wand', { sampleAll: v })}>
        Sample All Layers
      </Checkbox>
    </>
  );
}

function CropOptions() {
  const o = useEditor((s) => s.opts.crop);
  return (
    <>
      <Select
        value={o.ratio}
        options={[
          { value: 'free', label: 'Ratio: Free' },
          { value: 'original', label: 'Original Ratio' },
          { value: '1:1', label: '1 : 1 (Square)' },
          { value: '4:3', label: '4 : 3' },
          { value: '3:2', label: '3 : 2' },
          { value: '16:9', label: '16 : 9' },
          { value: '5:4', label: '5 : 4' },
          { value: '4:5', label: '4 : 5 (8 × 10)' },
          { value: '2:3', label: '2 : 3' },
        ]}
        onChange={(v) => setOpts('crop', { ratio: v })}
      />
      <Sep />
      <Checkbox checked={o.deletePixels} onChange={(v) => setOpts('crop', { deletePixels: v })}>
        Delete Cropped Pixels
      </Checkbox>
      <span className="spacer" />
      <button type="button" className="ed-commit cancel" title="Cancel (Esc)" onClick={cancelCrop}>
        <Icon name="x" size={15} />
      </button>
      <button
        type="button"
        className="ed-commit ok"
        title="Commit (Enter)"
        onClick={() => {
          const d = activeDoc();
          if (d) commitCrop(d);
        }}
      >
        <Icon name="check" size={15} />
      </button>
    </>
  );
}

function GradientOptions() {
  const o = useEditor((s) => s.opts.gradient);
  const fg = useEditor((s) => s.fg);
  const bg = useEditor((s) => s.bg);
  const stops = gradientStops(o, fg, bg);
  const types: { value: typeof o.type; title: string; css: string }[] = [
    { value: 'linear', title: 'Linear', css: 'linear-gradient(90deg,#111,#eee)' },
    { value: 'radial', title: 'Radial', css: 'radial-gradient(circle,#111,#eee)' },
    { value: 'angle', title: 'Angle', css: 'conic-gradient(#111,#eee)' },
    { value: 'reflected', title: 'Reflected', css: 'linear-gradient(90deg,#eee,#111,#eee)' },
    { value: 'diamond', title: 'Diamond', css: 'radial-gradient(#111 10%, #eee 75%)' },
  ];
  return (
    <>
      <span className="ed-grad-preview checker">
        <span style={{ background: gradientCss(stops) }} />
      </span>
      <Select
        value={o.preset}
        options={[
          { value: 'fgbg', label: 'Foreground to Background' },
          { value: 'fgtrans', label: 'Foreground to Transparent' },
          { value: 'bw', label: 'Black, White' },
          { value: 'custom', label: 'Custom' },
        ]}
        onChange={(v) => setOpts('gradient', { preset: v })}
      />
      {o.preset === 'custom' && (
        <>
          <ColorSwatch value={o.custom[0].color} alpha onChange={(c) => setOpts('gradient', { custom: [{ ...o.custom[0], color: c }, o.custom[1]] })} title="Start color" />
          <ColorSwatch value={o.custom[1].color} alpha onChange={(c) => setOpts('gradient', { custom: [o.custom[0], { ...o.custom[1], color: c }] })} title="End color" />
        </>
      )}
      <Sep />
      <span className="ed-seg">
        {types.map((t) => (
          <button key={t.value} type="button" title={`${t.title} Gradient`} className={cx(o.type === t.value && 'active')} onClick={() => setOpts('gradient', { type: t.value })}>
            <span className="ed-gtype" style={{ background: t.css }} />
          </button>
        ))}
      </span>
      <Sep />
      <span className="faint">Mode</span>
      <BlendSelect value={o.blend} onChange={(v) => setOpts('gradient', { blend: v })} />
      <Scrub label="Opacity" value={o.opacity} min={1} max={100} suffix="%" onChange={(v) => setOpts('gradient', { opacity: v })} />
      <Checkbox checked={o.reverse} onChange={(v) => setOpts('gradient', { reverse: v })}>
        Reverse
      </Checkbox>
      <Checkbox checked={o.dither} onChange={(v) => setOpts('gradient', { dither: v })}>
        Dither
      </Checkbox>
    </>
  );
}

function BucketOptions() {
  const o = useEditor((s) => s.opts.bucket);
  return (
    <>
      <Select
        value={o.source}
        options={[
          { value: 'fg', label: 'Foreground' },
          { value: 'bg', label: 'Background' },
        ]}
        onChange={(v) => setOpts('bucket', { source: v })}
      />
      <span className="faint">Mode</span>
      <BlendSelect value={o.blend} onChange={(v) => setOpts('bucket', { blend: v })} />
      <Scrub label="Opacity" value={o.opacity} min={1} max={100} suffix="%" onChange={(v) => setOpts('bucket', { opacity: v })} />
      <Scrub label="Tolerance" value={o.tolerance} min={0} max={255} onChange={(v) => setOpts('bucket', { tolerance: v })} />
      <Checkbox checked={o.antialias} onChange={(v) => setOpts('bucket', { antialias: v })}>
        Anti-alias
      </Checkbox>
      <Checkbox checked={o.contiguous} onChange={(v) => setOpts('bucket', { contiguous: v })}>
        Contiguous
      </Checkbox>
      <Checkbox checked={o.sampleAll} onChange={(v) => setOpts('bucket', { sampleAll: v })}>
        All Layers
      </Checkbox>
    </>
  );
}

function TextOptions() {
  const o = useEditor((s) => s.opts.text);
  const fg = useEditor((s) => s.fg);
  const editing = useTextEdit((s) => s.layerId);
  const doc = useActiveDoc();
  const [, force] = useState(0);
  const l = doc?.activeLayer;
  const target: TextProps | null = l?.kind === 'text' && l.text ? l.text : null;
  const cur = target ?? { ...o, color: fg, text: '', x: 0, y: 0 };
  const apply = (p: Partial<TextProps>) => {
    const { color, ...rest } = p;
    void color;
    setOpts('text', rest as never);
    if (editing) updateEditingText(p);
    else if (doc && l && target) setLayerProps(doc, l.id, { text: { ...target, ...p } }, 'Edit Type Layer', `text:${l.id}`);
    force((x) => x + 1);
  };
  return (
    <>
      <input
        className="input"
        list="ed-fonts"
        style={{ width: 150 }}
        value={cur.font}
        onFocus={() => loadFonts(() => force((x) => x + 1))}
        onChange={(e) => apply({ font: e.target.value })}
        onKeyDown={(e) => e.stopPropagation()}
        title="Font family"
      />
      <datalist id="ed-fonts">
        {fontList.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <Select
        value={`${cur.weight}${cur.italic ? 'i' : ''}`}
        options={[
          { value: '300', label: 'Light' },
          { value: '400', label: 'Regular' },
          { value: '400i', label: 'Italic' },
          { value: '500', label: 'Medium' },
          { value: '600', label: 'Semibold' },
          { value: '700', label: 'Bold' },
          { value: '700i', label: 'Bold Italic' },
          { value: '900', label: 'Black' },
        ]}
        onChange={(v) => apply({ weight: parseInt(v), italic: v.endsWith('i') })}
      />
      <Scrub label="Size" value={cur.size} min={1} max={2000} suffix=" px" step={1} onChange={(v) => apply({ size: v })} width={58} />
      <Scrub label="Leading" value={cur.lineHeight} min={0.5} max={4} step={0.05} precision={2} onChange={(v) => apply({ lineHeight: v })} />
      <Scrub label="Tracking" value={cur.tracking} min={-50} max={200} step={0.5} precision={1} onChange={(v) => apply({ tracking: v })} />
      <Seg
        value={cur.align}
        options={[
          { value: 'left', icon: <Icon name="alignLeft" size={14} />, title: 'Left align' },
          { value: 'center', icon: <Icon name="alignCenter" size={14} />, title: 'Center' },
          { value: 'right', icon: <Icon name="alignRight" size={14} />, title: 'Right align' },
        ]}
        onChange={(v) => apply({ align: v })}
      />
      <ColorSwatch value={cur.color} alpha={false} title="Text color" onChange={(c) => (target || editing ? apply({ color: { ...c, a: 1 } }) : useEditor.setState({ fg: { ...c, a: 1 } }))} />
      {editing && (
        <>
          <span className="spacer" />
          <button type="button" className="ed-commit cancel" title="Cancel" onClick={cancelTextEdit}>
            <Icon name="x" size={15} />
          </button>
          <button type="button" className="ed-commit ok" title="Commit (⌘↵ / Esc)" onClick={commitTextEdit}>
            <Icon name="check" size={15} />
          </button>
        </>
      )}
    </>
  );
}

function ColorOrNone({ value, onChange, title }: { value: RGBA | null; onChange: (c: RGBA | null) => void; title: string }) {
  return (
    <span className="row" style={{ gap: 3 }}>
      <span className="faint">{title}</span>
      {value ? <ColorSwatch value={value} alpha onChange={onChange} title={title} /> : <span className="ed-none-swatch" title="None" />}
      <button type="button" className="ed-mini-btn" title={value ? 'No color' : 'Use foreground'} onClick={() => onChange(value ? null : { ...edState().fg })}>
        {value ? '∅' : '+'}
      </button>
    </span>
  );
}

function ShapeOptions({ tool }: { tool: ToolId }) {
  const o = useEditor((s) => s.opts.shape);
  const doc = useActiveDoc();
  const l = doc?.activeLayer;
  const target: ShapeProps | null = l?.kind === 'shape' && l.shape ? l.shape : null;
  const isLine = tool === 'shapeLine' || target?.type === 'line';
  const fill = target ? target.fill : o.fill;
  const stroke = target ? target.stroke : o.stroke;
  const sw = target ? target.strokeWidth : isLine ? o.lineWidth : o.strokeWidth;
  const radius = target ? target.radius : o.radius;
  const apply = (p: Partial<ShapeProps>) => {
    if (doc && l && target) setLayerProps(doc, l.id, { shape: { ...target, ...p } }, 'Edit Shape', `shape:${l.id}`);
    const op: Record<string, unknown> = {};
    if ('fill' in p) op.fill = p.fill;
    if ('stroke' in p) op.stroke = p.stroke;
    if ('strokeWidth' in p) op[isLine ? 'lineWidth' : 'strokeWidth'] = p.strokeWidth;
    if ('radius' in p) op.radius = p.radius;
    setOpts('shape', op as never);
  };
  return (
    <>
      {!isLine && <ColorOrNone title="Fill" value={fill} onChange={(c) => apply({ fill: c })} />}
      <ColorOrNone title={isLine ? 'Color' : 'Stroke'} value={stroke} onChange={(c) => apply({ stroke: c })} />
      <Scrub label={isLine ? 'Weight' : 'Width'} value={sw} min={0} max={500} step={0.5} precision={1} suffix=" px" onChange={(v) => apply({ strokeWidth: v })} />
      {(tool === 'shapeRounded' || target?.type === 'rounded') && <Scrub label="Radius" value={radius} min={0} max={2000} suffix=" px" onChange={(v) => apply({ radius: v })} />}
      {target && <span className="faint">Editing “{l!.name}”</span>}
    </>
  );
}

function TransformOptions() {
  const t = useTransformUI();
  const deg = (t.angle * 180) / Math.PI;
  return (
    <>
      <span className="ed-opt-title">
        <EdIcon name="transform" size={14} /> Free Transform
      </span>
      <Scrub label="X" value={t.tx} min={-100000} max={100000} step={1} precision={0} suffix=" px" onChange={(v) => setTransformParams({ tx: v })} width={64} />
      <Scrub label="Y" value={t.ty} min={-100000} max={100000} step={1} precision={0} suffix=" px" onChange={(v) => setTransformParams({ ty: v })} width={64} />
      <Sep />
      <Scrub label="W" value={t.sx * 100} min={-10000} max={10000} step={0.1} precision={1} suffix="%" onChange={(v) => setTransformParams({ sx: v / 100 })} width={58} />
      <Scrub label="H" value={t.sy * 100} min={-10000} max={10000} step={0.1} precision={1} suffix="%" onChange={(v) => setTransformParams({ sy: v / 100 })} width={58} />
      <Scrub label="∠" value={deg} min={-180} max={180} step={0.1} precision={1} suffix="°" onChange={(v) => setTransformParams({ angle: (v * Math.PI) / 180 })} width={52} />
      <span className="faint">Shift: proportional / 15° · {navigator.platform.includes('Mac') ? '⌥' : 'Alt'}: from centre</span>
      <span className="spacer" />
      <button type="button" className="ed-commit cancel" title="Cancel (Esc)" onClick={cancelTransform}>
        <Icon name="x" size={15} />
      </button>
      <button type="button" className="ed-commit ok" title="Commit (Enter)" onClick={commitTransform}>
        <Icon name="check" size={15} />
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function OptionsBar() {
  const tool = useEditor((s) => s.tool);
  const session = useEditor((s) => s.session);
  const autoSel = useEditor((s) => s.opts.move.autoSelect);
  const eye = useEditor((s) => s.opts.eyedropper);
  let body: ReactNode = null;
  if (session === 'transform') body = <TransformOptions />;
  else
    switch (tool) {
      case 'move':
        body = (
          <>
            <Checkbox checked={autoSel} onChange={(v) => setOpts('move', { autoSelect: v })}>
              Auto-Select Layer
            </Checkbox>
            <Sep />
            <Button small onClick={A.freeTransform}>
              Free Transform
            </Button>
            <span className="faint">Arrows nudge 1 px · Shift 10 px · {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}-click auto-selects</span>
          </>
        );
        break;
      case 'marqueeRect':
      case 'marqueeEllipse':
        body = <SelectOptions which="marquee" />;
        break;
      case 'lasso':
      case 'lassoPoly':
        body = <SelectOptions which="lasso" />;
        break;
      case 'wand':
        body = <WandOptions />;
        break;
      case 'crop':
        body = <CropOptions />;
        break;
      case 'eyedropper':
        body = (
          <>
            <span className="faint">Sample Size</span>
            <Select
              value={eye.sampleSize}
              options={[
                { value: 1, label: 'Point Sample' },
                { value: 3, label: '3 by 3 Average' },
                { value: 5, label: '5 by 5 Average' },
                { value: 11, label: '11 by 11 Average' },
              ]}
              onChange={(v) => setOpts('eyedropper', { sampleSize: v })}
            />
            <span className="faint">Sample</span>
            <Select
              value={eye.sampleAll ? 1 : 0}
              options={[
                { value: 0, label: 'Current Layer' },
                { value: 1, label: 'All Layers' },
              ]}
              onChange={(v) => setOpts('eyedropper', { sampleAll: !!v })}
            />
            <span className="faint">{navigator.platform.includes('Mac') ? '⌥' : 'Alt'}-click picks the background color</span>
          </>
        );
        break;
      case 'spotHeal':
      case 'heal':
        body = <HealOptions tool={tool} />;
        break;
      case 'brush':
      case 'pencil':
      case 'eraser':
      case 'clone':
        body = <BrushOptions tool={tool} />;
        break;
      case 'gradient':
        body = <GradientOptions />;
        break;
      case 'bucket':
        body = <BucketOptions />;
        break;
      case 'blur':
      case 'sharpen':
      case 'smudge':
      case 'dodge':
      case 'burn':
      case 'sponge':
        body = <RetouchOptions tool={tool} />;
        break;
      case 'text':
        body = <TextOptions />;
        break;
      case 'shapeRect':
      case 'shapeRounded':
      case 'shapeEllipse':
      case 'shapeLine':
        body = <ShapeOptions tool={tool} />;
        break;
      case 'hand':
      case 'zoom':
        body = (
          <>
            <Button small onClick={A.actual}>
              100%
            </Button>
            <Button small onClick={A.fit}>
              Fit Screen
            </Button>
            <Button small onClick={A.zoomIn}>
              Zoom In
            </Button>
            <Button small onClick={A.zoomOut}>
              Zoom Out
            </Button>
          </>
        );
        break;
    }
  return (
    <div className="ed-options">
      <span className="ed-opt-tool" title={TOOL_LABELS[tool]}>
        <EdIcon name={TOOL_ICONS[tool]} size={16} />
      </span>
      <Sep />
      {body}
    </div>
  );
}

export function useForceOnBus(on: (fn: () => void) => () => void) {
  const [, force] = useState(0);
  const cb = useRef(() => force((x) => x + 1));
  useEffect(() => on(cb.current), [on]);
}
