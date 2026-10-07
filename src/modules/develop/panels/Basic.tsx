import { useEffect, useRef, useState } from 'react';
import { PROFILES, Profile, SETTING_GROUPS } from '@/core/develop/settings';
import { formatShutter } from '@/core/image/decode';
import { useCatalog } from '@/state/catalog';
import { Button, cx, GRADIENTS, IconButton, Select, SegmentedControl, Spinner } from '@/ui/controls';
import { shortcutLabel } from '@/app/commands';
import { autoTone, autoWhiteBalance, editInEditor, setTool } from '../actions';
import { commit, editCommit, setLive, useDevelop } from '../store';
import { DPanel, fmtValue, resetKeys, SSlider, SubHead } from '../ui';

// ---------------------------------------------------------------------------------------------
// Histogram (Lightroom-style: RGB overlay, clipping triangles, drag regions to adjust tone)

const REGIONS = [
  { key: 'blacks', label: 'Blacks', from: 0, to: 0.11, scale: 200, step: 1 },
  { key: 'shadows', label: 'Shadows', from: 0.11, to: 0.3, scale: 200, step: 1 },
  { key: 'exposure', label: 'Exposure', from: 0.3, to: 0.7, scale: 4, step: 0.01 },
  { key: 'highlights', label: 'Highlights', from: 0.7, to: 0.89, scale: 200, step: 1 },
  { key: 'whites', label: 'Whites', from: 0.89, to: 1, scale: 200, step: 1 },
] as const;

export function HistogramPanel() {
  const hist = useDevelop((s) => s.histogram);
  const clipping = useDevelop((s) => s.clipping);
  const photoId = useDevelop((s) => s.photoId);
  const status = useDevelop((s) => s.status);
  const meta = useCatalog((s) => (photoId ? s.photos[photoId]?.meta : undefined));
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(276);
  const [region, setRegion] = useState<(typeof REGIONS)[number] | null>(null);
  const [dragVal, setDragVal] = useState<string | null>(null);
  const H = 92;

  useEffect(() => {
    const el = boxRef.current!;
    const ro = new ResizeObserver(() => setWidth(Math.max(120, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#141416';
    ctx.fillRect(0, 0, width, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const x = Math.round((i / 4) * width) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
    if (region) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(region.from * width, 0, (region.to - region.from) * width, H);
    }
    if (!hist) return;
    const max = hist.max || 1;
    const chans: [Uint32Array, string][] = [
      [hist.r, 'rgba(225,55,55,0.75)'],
      [hist.g, 'rgba(55,190,75,0.7)'],
      [hist.b, 'rgba(55,105,235,0.8)'],
    ];
    ctx.globalCompositeOperation = 'lighter';
    for (const [bins, col] of chans) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        // 3-tap smoothing so a 256px readback doesn't look spiky.
        const v = (bins[Math.max(0, i - 1)] + 2 * bins[i] + bins[Math.min(255, i + 1)]) / 4;
        const y = H - Math.min(1, v / max) * (H - 4);
        ctx.lineTo((i / 255) * width, y);
      }
      ctx.lineTo(width, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }, [hist, width, region]);

  const lowOn = (hist?.clipLow ?? 0) > 0.0008;
  const highOn = (hist?.clipHigh ?? 0) > 0.0008;

  const onPointerDown = (e: React.PointerEvent) => {
    const st = useDevelop.getState();
    if (!st.settings || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const t = (e.clientX - r.left) / r.width;
    const reg = REGIONS.find((g) => t >= g.from && t <= g.to) ?? REGIONS[2];
    const start = st.settings[reg.key];
    const lim = reg.key === 'exposure' ? 5 : 100;
    // The drag is relative to the value it started from: it belongs to the photo it started on.
    const same = () => useDevelop.getState().photoId === st.photoId && !!useDevelop.getState().settings;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!same()) return;
      const d = ((ev.clientX - e.clientX) / r.width) * reg.scale;
      const v = Math.max(-lim, Math.min(lim, Math.round((start + d) / reg.step) * reg.step));
      const s = useDevelop.getState().settings!;
      if (s[reg.key] !== v) setLive({ ...s, [reg.key]: +v.toFixed(2) });
      setDragVal(`${reg.label} ${fmtValue(v, reg.step)}`);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (same()) {
        const v = useDevelop.getState().settings![reg.key];
        if (v !== start) commit(`${reg.label} ${fmtValue(v, reg.step)}`);
      }
      setDragVal(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const info = [meta?.iso ? `ISO ${meta.iso}` : '', meta?.focalLength ? `${Math.round(meta.focalLength)} mm` : '', meta?.fNumber ? `ƒ/${meta.fNumber}` : '', formatShutter(meta?.exposureTime)].filter(Boolean);

  return (
    <div className="dv-histo">
      <div
        ref={boxRef}
        className="dv-histo-graph"
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          if (e.buttons) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const t = (e.clientX - r.left) / r.width;
          setRegion(REGIONS.find((g) => t >= g.from && t <= g.to) ?? null);
        }}
        onPointerLeave={() => setRegion(null)}
        title="Drag to adjust Blacks / Shadows / Exposure / Highlights / Whites"
      >
        <canvas ref={ref} style={{ width, height: H, display: 'block' }} />
        <button
          type="button"
          className={cx('dv-clip lo', lowOn && 'on', clipping && 'active')}
          title={`Shadow clipping${hist ? ` (${(hist.clipLow * 100).toFixed(2)}%)` : ''} — click to toggle warnings (J)`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => useDevelop.setState((s) => ({ clipping: !s.clipping }))}
        />
        <button
          type="button"
          className={cx('dv-clip hi', highOn && 'on', clipping && 'active')}
          title={`Highlight clipping${hist ? ` (${(hist.clipHigh * 100).toFixed(2)}%)` : ''} — click to toggle warnings (J)`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => useDevelop.setState((s) => ({ clipping: !s.clipping }))}
        />
      </div>
      <div className="dv-histo-info">
        {dragVal ? (
          <span className="dv-histo-val">{dragVal}</span>
        ) : region ? (
          <span className="dv-histo-val">{region.label}</span>
        ) : status.loading ? (
          <span className="row" style={{ gap: 6 }}>
            <Spinner /> {status.label}
          </span>
        ) : info.length ? (
          info.map((t) => <span key={t}>{t}</span>)
        ) : (
          <span className="faint">No camera info</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function ToolStrip() {
  const tool = useDevelop((s) => s.tool);
  const hasMasks = useDevelop((s) => (s.settings?.locals.length ?? 0) > 0);
  return (
    <div className="dv-toolstrip">
      <IconButton icon="crop" title={`Crop & Straighten (R)`} active={tool === 'crop'} onClick={() => setTool('crop')} />
      <IconButton icon="mask" title="Masking (⇧M) — gradients and brush" active={tool === 'mask'} onClick={() => setTool('mask')} corner={hasMasks} />
      <IconButton icon="eyedropper" title="White Balance Selector (W)" active={tool === 'wb'} onClick={() => setTool('wb')} />
      <div className="spacer" />
      <IconButton icon="editor" title={`Edit in Editor (${shortcutLabel('mod+e')})`} onClick={() => void editInEditor()} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Basic

/** White-balance presets. Temperature/tint are relative to the camera's As Shot balance. */
const WB_PRESETS: { id: string; label: string; t: number; n: number }[] = [
  { id: 'asShot', label: 'As Shot', t: 0, n: 0 },
  { id: 'daylight', label: 'Daylight', t: 6, n: 2 },
  { id: 'cloudy', label: 'Cloudy', t: 18, n: 4 },
  { id: 'shade', label: 'Shade', t: 30, n: 6 },
  { id: 'tungsten', label: 'Tungsten', t: -48, n: 4 },
  { id: 'fluorescent', label: 'Fluorescent', t: -28, n: 22 },
  { id: 'flash', label: 'Flash', t: 12, n: 2 },
];
const lastAuto = new Map<string, { temperature: number; tint: number }>();

function WhiteBalanceSelect() {
  const temp = useDevelop((s) => s.settings?.temperature ?? 0);
  const tint = useDevelop((s) => s.settings?.tint ?? 0);
  const photoId = useDevelop((s) => s.photoId);
  const auto = photoId ? lastAuto.get(photoId) : undefined;
  const preset = WB_PRESETS.find((p) => p.t === temp && p.n === tint);
  const value = preset ? preset.id : auto && auto.temperature === temp && auto.tint === tint ? 'auto' : 'custom';
  const options = [
    WB_PRESETS[0],
    { id: 'auto', label: 'Auto' },
    ...WB_PRESETS.slice(1),
    { id: 'custom', label: 'Custom' },
  ].map((o) => ({ value: o.id, label: o.label, disabled: o.id === 'custom' }));
  return (
    <Select
      value={value}
      options={options}
      style={{ flex: 1 }}
      onChange={(id) => {
        if (id === 'auto') {
          const wb = autoWhiteBalance();
          if (wb && photoId) lastAuto.set(photoId, wb);
          return;
        }
        const p = WB_PRESETS.find((x) => x.id === id);
        if (p) editCommit((s) => ({ ...s, temperature: p.t, tint: p.n }), `White Balance: ${p.label}`);
      }}
    />
  );
}

export function BasicPanel() {
  const treatment = useDevelop((s) => s.settings?.treatment ?? 'color');
  const profile = useDevelop((s) => s.settings?.profile ?? 'none');
  const tool = useDevelop((s) => s.tool);
  return (
    <DPanel id="basic" title="Basic" defaultOpen onReset={() => resetKeys([...SETTING_GROUPS.whiteBalance, ...SETTING_GROUPS.basicTone, ...SETTING_GROUPS.presence, 'treatment', 'profile'], 'Basic')}>
      <div className="dv-field">
        <span>Treatment</span>
        <SegmentedControl
          value={treatment}
          options={[
            { value: 'color', label: 'Color' },
            { value: 'bw', label: 'Black & White' },
          ]}
          onChange={(v) =>
            editCommit(
              (s) => ({ ...s, treatment: v, profile: v === 'color' && s.profile === 'monochrome' ? 'color' : s.profile }),
              v === 'bw' ? 'Treatment: Black & White' : 'Treatment: Color',
            )
          }
        />
      </div>
      <div className="dv-field">
        <span>Profile</span>
        <Select
          value={profile}
          options={PROFILES.map((p) => ({ value: p.id, label: p.label }))}
          style={{ flex: 1 }}
          onChange={(v: Profile) => editCommit((s) => ({ ...s, profile: v, treatment: v === 'monochrome' ? 'bw' : s.treatment }), `Profile: ${PROFILES.find((p) => p.id === v)?.label}`)}
        />
      </div>
      <SubHead
        right={
          <IconButton icon="eyedropper" small title="White Balance Selector (W) — click a neutral area" active={tool === 'wb'} onClick={() => setTool('wb')} />
        }
      >
        White Balance
      </SubHead>
      <div className="dv-field">
        <span>WB</span>
        <WhiteBalanceSelect />
      </div>
      <SSlider path="temperature" label="Temp" min={-100} max={100} gradient={GRADIENTS.temperature} history="Temperature" />
      <SSlider path="tint" label="Tint" min={-100} max={100} gradient={GRADIENTS.tint} />
      <SubHead
        right={
          <Button small onClick={autoTone} title="Auto tone (⇧A)">
            Auto
          </Button>
        }
      >
        Tone
      </SubHead>
      <SSlider path="exposure" label="Exposure" min={-5} max={5} step={0.01} gradient={GRADIENTS.exposure} />
      <SSlider path="contrast" label="Contrast" min={-100} max={100} />
      <SSlider path="highlights" label="Highlights" min={-100} max={100} />
      <SSlider path="shadows" label="Shadows" min={-100} max={100} />
      <SSlider path="whites" label="Whites" min={-100} max={100} />
      <SSlider path="blacks" label="Blacks" min={-100} max={100} />
      <SubHead>Presence</SubHead>
      <SSlider path="texture" label="Texture" min={-100} max={100} />
      <SSlider path="clarity" label="Clarity" min={-100} max={100} />
      <SSlider path="dehaze" label="Dehaze" min={-100} max={100} />
      <SSlider path="vibrance" label="Vibrance" min={-100} max={100} gradient="linear-gradient(90deg, #7d7d7d, #c86bd8 55%, #e8c33a)" />
      <SSlider path="saturation" label="Saturation" min={-100} max={100} gradient="linear-gradient(90deg, #808080, #e0503a 50%, #3ac06b 75%, #3a7ee0)" />
    </DPanel>
  );
}
