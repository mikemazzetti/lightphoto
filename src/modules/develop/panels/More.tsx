import { useRef } from 'react';
import { CurvePoint, GradeWheel, HSL_BAND_COLORS, HSL_BAND_HUES, HSL_BAND_NAMES } from '@/core/develop/settings';
import { Button, Checkbox, cx, Select, Slider } from '@/ui/controls';
import { CurveEditor } from '@/ui/CurveEditor';
import { Icon } from '@/ui/Icon';
import { endAngle, flip, rotateOrientation, setAngle } from '../cropTool';
import { commit, CurveChannel, editCommit, GradingView, MixerTab, setPath, useDevelop } from '../store';
import { DPanel, resetKeys, SSlider, SubHead } from '../ui';

// ---------------------------------------------------------------------------------------------
// Tone curve

const CURVE_CHANNELS: { id: CurveChannel; label: string; color: string }[] = [
  { id: 'rgb', label: 'RGB', color: '#e8e8ea' },
  { id: 'r', label: 'Red', color: '#ff6b6b' },
  { id: 'g', label: 'Green', color: '#5fd37a' },
  { id: 'b', label: 'Blue', color: '#6b9bff' },
];

const CURVE_PRESETS: Record<string, CurvePoint[]> = {
  Linear: [
    [0, 0],
    [1, 1],
  ],
  'Medium Contrast': [
    [0, 0],
    [0.25, 0.21],
    [0.5, 0.5],
    [0.75, 0.79],
    [1, 1],
  ],
  'Strong Contrast': [
    [0, 0],
    [0.25, 0.17],
    [0.5, 0.5],
    [0.75, 0.83],
    [1, 1],
  ],
  'Matte Fade': [
    [0, 0.08],
    [0.25, 0.26],
    [0.75, 0.76],
    [1, 0.96],
  ],
};

export function ToneCurvePanel() {
  return (
    <DPanel id="curve" title="Tone Curve" toggle onReset={() => resetKeys(['curve'], 'Tone Curve')}>
      <ToneCurveBody />
    </DPanel>
  );
}

function ToneCurveBody() {
  const ch = useDevelop((s) => s.curveChannel);
  const pts = useDevelop((s) => s.settings?.curve[ch]);
  const hist = useDevelop((s) => s.histogram);
  const meta = CURVE_CHANNELS.find((c) => c.id === ch)!;
  const bins = hist ? (ch === 'rgb' ? hist.l : hist[ch]) : null;
  const presetName = pts ? Object.keys(CURVE_PRESETS).find((k) => JSON.stringify(CURVE_PRESETS[k]) === JSON.stringify(pts)) ?? 'Custom' : 'Linear';
  return (
    <>
      <div className="dv-chips">
        {CURVE_CHANNELS.map((c) => (
          <button key={c.id} type="button" className={cx('dv-chip', c.id === ch && 'active')} onClick={() => useDevelop.setState({ curveChannel: c.id })} title={`${c.label} channel`}>
            <span className="dv-dot" style={{ background: c.id === 'rgb' ? 'conic-gradient(#f55, #5d5, #59f, #f55)' : c.color }} />
            {c.label}
          </button>
        ))}
      </div>
      <div className="dv-curve">
        {pts && (
          <CurveEditor
            points={pts}
            color={meta.color}
            histogram={bins}
            size={252}
            onChange={(p) => setPath(`curve.${ch}`, p)}
            onCommit={() => commit(`Tone Curve (${meta.label})`)}
          />
        )}
      </div>
      <div className="dv-field">
        <span>Point Curve</span>
        <Select
          value={presetName}
          style={{ flex: 1 }}
          options={[...Object.keys(CURVE_PRESETS), 'Custom'].map((k) => ({ value: k, label: k, disabled: k === 'Custom' }))}
          onChange={(k) => {
            const p = CURVE_PRESETS[k];
            if (p) editCommit((s) => ({ ...s, curve: { ...s.curve, [ch]: p.map((x) => [...x] as CurvePoint) } }), `Tone Curve: ${k}`);
          }}
        />
      </div>
      <div className="faint dv-hint">Click to add points · drag off the graph or double-click to remove</div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Color mixer / B&W mix

const hsl = (h: number, s: number, l: number) => `hsl(${((h % 360) + 360) % 360}, ${s}%, ${l}%)`;
const bandGradient = (prop: 'hue' | 'sat' | 'lum', i: number) => {
  const h = HSL_BAND_HUES[i];
  if (prop === 'hue') return `linear-gradient(90deg, ${hsl(h - 32, 80, 50)}, ${hsl(h, 80, 50)}, ${hsl(h + 32, 80, 50)})`;
  if (prop === 'sat') return `linear-gradient(90deg, ${hsl(h, 0, 52)}, ${hsl(h, 85, 50)})`;
  return `linear-gradient(90deg, ${hsl(h, 55, 14)}, ${hsl(h, 75, 48)}, ${hsl(h, 85, 86)})`;
};
const PROP_LABEL = { hue: 'Hue', sat: 'Saturation', lum: 'Luminance' } as const;

function BandSliders({ prop }: { prop: 'hue' | 'sat' | 'lum' }) {
  return (
    <>
      {HSL_BAND_NAMES.map((name, i) => (
        <SSlider key={name} path={`hsl.${prop}.${i}`} label={name} min={-100} max={100} gradient={bandGradient(prop, i)} history={`${name} ${PROP_LABEL[prop]}`} />
      ))}
    </>
  );
}

export function ColorMixerPanel() {
  const bw = useDevelop((s) => s.settings?.treatment === 'bw' || s.settings?.profile === 'monochrome');
  const tab = useDevelop((s) => s.mixerTab);
  if (bw)
    return (
      <DPanel id="mixer" title="B&W Mix" toggle onReset={() => resetKeys(['bwMix'], 'B&W Mix')}>
        {HSL_BAND_NAMES.map((name, i) => (
          <SSlider key={name} path={`bwMix.${i}`} label={name} min={-100} max={100} gradient={`linear-gradient(90deg, #1b1b1b, ${HSL_BAND_COLORS[i]}, #f2f2f2)`} history={`B&W ${name}`} />
        ))}
      </DPanel>
    );
  const tabs: { id: MixerTab; label: string }[] = [
    { id: 'hue', label: 'Hue' },
    { id: 'sat', label: 'Saturation' },
    { id: 'lum', label: 'Luminance' },
    { id: 'all', label: 'All' },
  ];
  return (
    <DPanel id="mixer" title="Color Mixer" toggle onReset={() => resetKeys(['hsl'], 'Color Mixer')}>
      <div className="dv-chips">
        {tabs.map((t) => (
          <button key={t.id} type="button" className={cx('dv-chip', t.id === tab && 'active')} onClick={() => useDevelop.setState({ mixerTab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'all' ? (
        <>
          <SubHead>Hue</SubHead>
          <BandSliders prop="hue" />
          <SubHead>Saturation</SubHead>
          <BandSliders prop="sat" />
          <SubHead>Luminance</SubHead>
          <BandSliders prop="lum" />
        </>
      ) : (
        <BandSliders prop={tab} />
      )}
    </DPanel>
  );
}

// ---------------------------------------------------------------------------------------------
// Color grading

type Zone = 'shadows' | 'midtones' | 'highlights' | 'global';
const ZONE_LABEL: Record<Zone, string> = { shadows: 'Shadows', midtones: 'Midtones', highlights: 'Highlights', global: 'Global' };

/** Hue/saturation disc (hue = angle counter-clockwise from 3 o'clock, saturation = radius). */
function ColorWheel({ zone, size }: { zone: Zone; size: number }) {
  const w = useDevelop((s) => s.settings?.grading[zone]) ?? { hue: 0, sat: 0, lum: 0 };
  const ref = useRef<HTMLDivElement>(null);
  const R = size / 2;
  const rad = (w.hue * Math.PI) / 180;
  const r = (w.sat / 100) * (R - 6);
  const px = R + Math.cos(rad) * r;
  const py = R - Math.sin(rad) * r;
  const [cr, cg, cb] = hueRgb(w.hue);
  const tint = `rgba(${cr},${cg},${cb},${0.25 + (w.sat / 100) * 0.75})`;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const start = useDevelop.getState().settings!.grading[zone];
    const update = (ev: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }) => {
      if (!useDevelop.getState().settings) return;
      const dx = ev.clientX - rect.left - R;
      const dy = ev.clientY - rect.top - R;
      let hue = Math.round((((Math.atan2(-dy, dx) * 180) / Math.PI) % 360 + 360) % 360);
      let sat = Math.round(Math.min(100, (Math.hypot(dx, dy) / (R - 6)) * 100));
      if (ev.shiftKey) hue = start.hue; // Shift: saturation only
      if (ev.altKey) sat = start.sat; // Alt: hue only
      const cur: GradeWheel = useDevelop.getState().settings!.grading[zone];
      if (cur.hue !== hue || cur.sat !== sat) setPath(`grading.${zone}`, { ...cur, hue, sat });
    };
    update(e);
    const move = (ev: PointerEvent) => update(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const g = useDevelop.getState().settings?.grading[zone];
      if (g) commit(`${ZONE_LABEL[zone]} Grade H ${g.hue} S ${g.sat}`);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    // Without this a cancelled drag leaves the move listener attached: hovering would keep editing.
    el.addEventListener('pointercancel', up);
  };

  return (
    <div className="dv-wheel-wrap" style={{ width: size }}>
      <div
        ref={ref}
        className="dv-wheel"
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => {
          editCommit((s) => ({ ...s, grading: { ...s.grading, [zone]: { ...s.grading[zone], hue: 0, sat: 0 } } }), `Reset ${ZONE_LABEL[zone]} Grade`);
        }}
        title={`${ZONE_LABEL[zone]} — drag to set hue & saturation (Shift: saturation only, Alt: hue only, double-click to reset)`}
      >
        <div className="dv-wheel-puck" style={{ left: px, top: py, background: w.sat > 0 ? tint : '#9a9a9a' }} />
      </div>
      <div className="dv-wheel-meta">
        <span>{ZONE_LABEL[zone]}</span>
        <span className="faint mono">
          {w.hue}° · {w.sat}
        </span>
      </div>
    </div>
  );
}

function hueRgb(h: number): [number, number, number] {
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => 1 - Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

function LumSlider({ zone, compact }: { zone: Zone; compact?: boolean }) {
  return <SSlider path={`grading.${zone}.lum`} label={compact ? 'Lum' : 'Luminance'} min={-100} max={100} gradient={GRAD_LUM} labelWidth={compact ? 26 : undefined} history={`${ZONE_LABEL[zone]} Luminance`} />;
}
const GRAD_LUM = 'linear-gradient(90deg, #111, #eee)';

export function ColorGradingPanel() {
  const view = useDevelop((s) => s.gradingView);
  const views: { id: GradingView; label: string; title: string }[] = [
    { id: '3way', label: '3-Way', title: 'Shadows, midtones, highlights and global' },
    { id: 'shadows', label: 'Shad', title: 'Shadows' },
    { id: 'midtones', label: 'Mid', title: 'Midtones' },
    { id: 'highlights', label: 'High', title: 'Highlights' },
    { id: 'global', label: 'Global', title: 'Global' },
  ];
  return (
    <DPanel id="grading" title="Color Grading" toggle onReset={() => resetKeys(['grading'], 'Color Grading')}>
      <div className="dv-chips">
        {views.map((v) => (
          <button key={v.id} type="button" title={v.title} className={cx('dv-chip', v.id === view && 'active')} onClick={() => useDevelop.setState({ gradingView: v.id })}>
            {v.label}
          </button>
        ))}
      </div>
      {view === '3way' ? (
        <div className="dv-wheels">
          {(['midtones', 'global', 'shadows', 'highlights'] as Zone[]).map((z) => (
            <div key={z} className="dv-wheel-cell">
              <ColorWheel zone={z} size={112} />
              <LumSlider zone={z} compact />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="dv-wheel-big">
            <ColorWheel zone={view} size={176} />
          </div>
          <SSlider path={`grading.${view}.hue`} label="Hue" min={0} max={360} gradient="linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" history={`${ZONE_LABEL[view]} Hue`} />
          <SSlider path={`grading.${view}.sat`} label="Saturation" min={0} max={100} gradient="linear-gradient(90deg, #777, #e85)" history={`${ZONE_LABEL[view]} Saturation`} />
          <LumSlider zone={view} />
        </>
      )}
      <div className="sep-h" />
      <SSlider path="grading.blending" label="Blending" min={0} max={100} history="Grading Blending" />
      <SSlider path="grading.balance" label="Balance" min={-100} max={100} history="Grading Balance" />
    </DPanel>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail / Lens / Effects / Transform

export function DetailPanel() {
  const amount = useDevelop((s) => s.settings?.sharpening.amount ?? 0);
  return (
    <DPanel id="detail" title="Detail" toggle onReset={() => resetKeys(['sharpening', 'noise'], 'Detail')}>
      <SubHead>Sharpening</SubHead>
      <SSlider path="sharpening.amount" label="Amount" min={0} max={150} history="Sharpening" />
      <SSlider path="sharpening.radius" label="Radius" min={0.5} max={3} step={0.1} history="Sharpen Radius" disabled={!amount} />
      <SSlider path="sharpening.detail" label="Detail" min={0} max={100} history="Sharpen Detail" disabled={!amount} />
      <SSlider path="sharpening.masking" label="Masking" min={0} max={100} history="Sharpen Masking" disabled={!amount} />
      <SubHead>Noise Reduction</SubHead>
      <SSlider path="noise.luminance" label="Luminance" min={0} max={100} history="Luminance NR" />
      <SSlider path="noise.color" label="Color" min={0} max={100} history="Color NR" />
      <div className="faint dv-hint">Zoom to 100% (Z) to judge sharpening and noise.</div>
    </DPanel>
  );
}

export function LensPanel() {
  return (
    <DPanel id="lens" title="Lens Corrections" toggle onReset={() => resetKeys(['lens'], 'Lens Corrections')}>
      <LensProfileRow />
      <SSlider path="lens.distortion" label="Distortion" min={-100} max={100} history="Lens Distortion" />
      <SSlider path="lens.vignette" label="Vignetting" min={-100} max={100} history="Lens Vignetting" />
    </DPanel>
  );
}

/** Built-in (camera-embedded) lens profile toggle — Lightroom's "Enable Profile Corrections". */
function LensProfileRow() {
  const profile = useDevelop((s) => s.lensProfile);
  const on = useDevelop((s) => s.settings?.lens.profile !== false);
  return (
    <div className="col" style={{ gap: 2, margin: '2px 0 6px' }}>
      <Checkbox checked={on} onChange={(v) => editCommit((s) => ({ ...s, lens: { ...s.lens, profile: v } }), v ? 'Enable Lens Profile' : 'Disable Lens Profile')}>
        Use built-in lens profile
      </Checkbox>
      <span className="faint" style={{ fontSize: 11, paddingLeft: 20 }}>
        {profile ? `${profile} — distortion, vignetting & CA` : 'None embedded in this image'}
      </span>
    </div>
  );
}

export function EffectsPanel() {
  const vig = useDevelop((s) => s.settings?.vignette.amount ?? 0);
  const grain = useDevelop((s) => s.settings?.grain.amount ?? 0);
  return (
    <DPanel id="effects" title="Effects" toggle onReset={() => resetKeys(['vignette', 'grain'], 'Effects')}>
      <SubHead>Post-Crop Vignetting</SubHead>
      <SSlider path="vignette.amount" label="Amount" min={-100} max={100} history="Vignette Amount" gradient="linear-gradient(90deg, #111, #888, #f4f4f4)" />
      <SSlider path="vignette.midpoint" label="Midpoint" min={0} max={100} history="Vignette Midpoint" disabled={!vig} />
      <SSlider path="vignette.roundness" label="Roundness" min={-100} max={100} history="Vignette Roundness" disabled={!vig} />
      <SSlider path="vignette.feather" label="Feather" min={0} max={100} history="Vignette Feather" disabled={!vig} />
      <SSlider path="vignette.highlights" label="Highlights" min={0} max={100} history="Vignette Highlights" disabled={vig >= 0} />
      <SubHead>Grain</SubHead>
      <SSlider path="grain.amount" label="Amount" min={0} max={100} history="Grain Amount" />
      <SSlider path="grain.size" label="Size" min={0} max={100} history="Grain Size" disabled={!grain} />
      <SSlider path="grain.roughness" label="Roughness" min={0} max={100} history="Grain Roughness" disabled={!grain} />
    </DPanel>
  );
}

export function AngleSlider() {
  const angle = useDevelop((s) => s.settings?.angle ?? 0);
  return (
    <Slider
      label="Angle"
      value={angle}
      min={-45}
      max={45}
      step={0.05}
      precision={2}
      signed
      suffix="°"
      onChange={(v) => setAngle(v)}
      onCommit={() => endAngle()}
    />
  );
}

export function TransformPanel() {
  const flipH = useDevelop((st) => st.settings?.flipH ?? false);
  const flipV = useDevelop((st) => st.settings?.flipV ?? false);
  const orientation = useDevelop((st) => st.settings?.orientation ?? 0);
  const s = { flipH, flipV, orientation };
  const rot = (dir: 1 | -1) => editCommit((x) => rotateOrientation(x, dir), dir > 0 ? 'Rotate Right' : 'Rotate Left');
  const fl = (axis: 'h' | 'v') => editCommit((x) => flip(x, axis), axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical');
  return (
    <DPanel id="transform" title="Transform" onReset={() => resetKeys(['orientation', 'flipH', 'flipV', 'angle'], 'Transform')}>
      <div className="dv-btnrow">
        <Button small icon="rotateLeft" onClick={() => rot(-1)} title="Rotate 90° counter-clockwise (⌘[)">
          Left
        </Button>
        <Button small icon="rotateRight" onClick={() => rot(1)} title="Rotate 90° clockwise (⌘])">
          Right
        </Button>
        <Button small icon="flipH" active={s.flipH} onClick={() => fl('h')} title="Flip horizontal">
          Flip H
        </Button>
        <Button small icon="flipV" active={s.flipV} onClick={() => fl('v')} title="Flip vertical">
          Flip V
        </Button>
      </div>
      <AngleSlider />
      <div className="faint dv-hint">
        <Icon name="info" size={11} /> Orientation {s.orientation}°{s.flipH ? ' · mirrored' : ''}
        {s.flipV ? ' · flipped' : ''} — use Crop (R) to straighten interactively.
      </div>
    </DPanel>
  );
}

