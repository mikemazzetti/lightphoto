import { useState } from 'react';
import { hexToRgba, rgbaToHex } from '@/core/util/color';
import { openDialog } from '@/state/app';
import { ColorSwatch } from '@/ui/ColorPicker';
import { Button, Checkbox, NumberField, Select, TextInput } from '@/ui/controls';
import { Modal } from '@/ui/overlays';
import { RESOLUTION_PRESETS } from '../model/defaults';
import { FPS_OPTIONS, parseTimecode, timecode } from '../model/time';
import type { Clip, Marker, Transition } from '../model/types';
import { setSequenceSettings, setSpeed } from '../state/actions';
import { mapClips } from '../state/clips';
import { edit, getSeq } from '../state/store';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function openSequenceSettings() {
  return openDialog((close) => <SequenceSettings close={() => close()} />);
}

function SequenceSettings({ close }: { close: () => void }) {
  const seq = getSeq();
  const [name, setName] = useState(seq.name);
  const [w, setW] = useState(seq.width);
  const [h, setH] = useState(seq.height);
  const [fps, setFps] = useState(seq.fps);
  const [bg, setBg] = useState(seq.bg);
  const preset = RESOLUTION_PRESETS.find((p) => p.w === w && p.h === h);
  return (
    <Modal
      title="Sequence Settings"
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              setSequenceSettings({ name, width: Math.max(16, Math.round(w / 2) * 2), height: Math.max(16, Math.round(h / 2) * 2), fps, bg });
              close();
            }}
          >
            OK
          </Button>
        </>
      }
    >
      <Field label="Name">
        <TextInput value={name} onChange={setName} style={{ flex: 1 }} />
      </Field>
      <Field label="Frame size">
        <Select
          value={preset ? `${preset.w}x${preset.h}` : 'custom'}
          options={[...RESOLUTION_PRESETS.map((p) => ({ value: `${p.w}x${p.h}`, label: p.label })), { value: 'custom', label: 'Custom' }]}
          onChange={(v) => {
            if (v === 'custom') return;
            const [a, b] = v.split('x').map(Number);
            setW(a);
            setH(b);
          }}
          style={{ flex: 1 }}
        />
      </Field>
      <Field label="">
        <NumberField value={w} onChange={setW} min={16} max={8192} width={70} title="Width" />
        <span className="faint">×</span>
        <NumberField value={h} onChange={setH} min={16} max={8192} width={70} title="Height" />
        <span className="faint">px</span>
      </Field>
      <Field label="Frame rate">
        <Select value={fps} options={FPS_OPTIONS.map((f) => ({ value: f, label: `${f} fps` }))} onChange={setFps} />
      </Field>
      <Field label="Background">
        <ColorSwatch value={hexToRgba(bg)} alpha={false} onChange={(c) => setBg(rgbaToHex(c))} />
        <span className="faint mono">{bg}</span>
      </Field>
      {Math.abs(fps - seq.fps) > 1e-6 && seq.clips.length > 0 && <div className="faint">Changing the frame rate re-times every clip, keyframe and marker to the nearest frame.</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

export function openSpeedDialog(clips: Clip[]) {
  if (!clips.length) return;
  return openDialog((close) => <SpeedDialog clips={clips} close={() => close()} />);
}

function SpeedDialog({ clips, close }: { clips: Clip[]; close: () => void }) {
  const fps = getSeq().fps;
  const c = clips[0];
  const [pct, setPct] = useState(Math.round(c.speed * 10000) / 100);
  const [dur, setDur] = useState(timecode(c.duration, fps));
  const [ripple, setRipple] = useState(false);
  const [pitch, setPitch] = useState(c.maintainPitch);
  const [mode, setMode] = useState<'speed' | 'duration'>('speed');
  const apply = () => {
    if (mode === 'duration') {
      const f = parseTimecode(dur, fps);
      if (f && f > 0) {
        const speed = (c.speed * c.duration) / f;
        setSpeed(
          clips.map((x) => x.id),
          speed,
          ripple,
          pitch,
          f,
        );
      }
    } else
      setSpeed(
        clips.map((x) => x.id),
        Math.max(1, pct) / 100,
        ripple,
        pitch,
      );
    close();
  };
  return (
    <Modal
      title="Clip Speed / Duration"
      onClose={close}
      width={400}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            OK
          </Button>
        </>
      }
    >
      <Field label="Speed">
        <NumberField
          value={pct}
          onChange={(v) => {
            setPct(v);
            setMode('speed');
            setDur(timecode(Math.max(1, Math.round((c.duration * c.speed * 100) / Math.max(1, v))), fps));
          }}
          min={5}
          max={2000}
          step={1}
          precision={2}
          suffix="%"
          width={90}
        />
      </Field>
      <Field label="Duration">
        <input
          className="input mono"
          value={dur}
          onChange={(e) => {
            setDur(e.target.value);
            setMode('duration');
            const f = parseTimecode(e.target.value, fps);
            if (f && f > 0) setPct(Math.round(((c.speed * c.duration) / f) * 10000) / 100);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') apply();
          }}
          style={{ width: 110 }}
        />
      </Field>
      <Checkbox checked={pitch} onChange={setPitch}>
        Maintain Audio Pitch
      </Checkbox>
      <Checkbox checked={ripple} onChange={setRipple}>
        Ripple Edit, Shifting Trailing Clips
      </Checkbox>
      {clips.length > 1 && <div className="faint">Applies to {clips.length} clips.</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

export function openTransitionDialog(clipId: string, edge: 'in' | 'out') {
  const c = getSeq().clips.find((x) => x.id === clipId);
  const t = c && (edge === 'in' ? c.transIn : c.transOut);
  if (!c || !t) return;
  return openDialog((close) => <TransitionDialog clip={c} edge={edge} t={t} close={() => close()} />);
}

function TransitionDialog({ clip, edge, t, close }: { clip: Clip; edge: 'in' | 'out'; t: Transition; close: () => void }) {
  const fps = getSeq().fps;
  const [dur, setDur] = useState(timecode(t.duration, fps));
  const [align, setAlign] = useState(t.align);
  const [dir, setDir] = useState(t.direction);
  const apply = () => {
    const f = parseTimecode(dur, fps) ?? t.duration;
    edit('Transition Settings', (p) => mapClips(p, clip.id, (c) => ({ ...c, [edge === 'in' ? 'transIn' : 'transOut']: { ...t, duration: Math.max(1, f), align, direction: dir } })));
    close();
  };
  const dirOpts = [
    { value: 0, label: 'From Left' },
    { value: 180, label: 'From Right' },
    { value: 90, label: 'From Top' },
    { value: 270, label: 'From Bottom' },
  ];
  return (
    <Modal
      title="Transition"
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            OK
          </Button>
        </>
      }
    >
      <Field label="Duration">
        <input
          className="input mono"
          value={dur}
          autoFocus
          onChange={(e) => setDur(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') apply();
          }}
          style={{ width: 110 }}
        />
      </Field>
      <Field label="Alignment">
        <Select
          value={align}
          options={[
            { value: 'center', label: 'Center at Cut' },
            { value: 'start', label: 'Start at Cut' },
            { value: 'end', label: 'End at Cut' },
          ]}
          onChange={setAlign}
        />
      </Field>
      {(t.type === 'wipe' || t.type === 'slide' || t.type === 'push') && (
        <Field label="Direction">
          <Select value={dir} options={dirOpts} onChange={setDir} />
        </Field>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

const MARKER_COLORS = ['#3fbf6f', '#e04f4f', '#e09a3a', '#e0d03a', '#4f8fe0', '#b05fe0', '#e05fb4', '#e8e8e8'];

export function openMarkerDialog(marker: Marker) {
  return openDialog((close) => <MarkerDialog m={marker} close={() => close()} />);
}

function MarkerDialog({ m, close }: { m: Marker; close: () => void }) {
  const fps = getSeq().fps;
  const [name, setName] = useState(m.name);
  const [comment, setComment] = useState(m.comment);
  const [color, setColor] = useState(m.color);
  const [tc, setTc] = useState(timecode(m.frame, fps));
  const apply = () => {
    const f = parseTimecode(tc, fps) ?? m.frame;
    edit('Edit Marker', (p) => ({ ...p, seq: { ...p.seq, markers: p.seq.markers.map((x) => (x.id === m.id ? { ...x, name, comment, color, frame: Math.max(0, f) } : x)).sort((a, b) => a.frame - b.frame) } }));
    close();
  };
  return (
    <Modal
      title="Marker"
      onClose={close}
      width={420}
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => {
              edit('Delete Marker', (p) => ({ ...p, seq: { ...p.seq, markers: p.seq.markers.filter((x) => x.id !== m.id) } }));
              close();
            }}
          >
            Delete
          </Button>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            OK
          </Button>
        </>
      }
    >
      <Field label="Name">
        <TextInput value={name} onChange={setName} autoFocus style={{ flex: 1 }} />
      </Field>
      <Field label="Time">
        <input className="input mono" value={tc} onChange={(e) => setTc(e.target.value)} onKeyDown={(e) => e.stopPropagation()} style={{ width: 110 }} />
      </Field>
      <Field label="Color">
        {MARKER_COLORS.map((c) => (
          <button key={c} type="button" className="swatch" style={{ width: 18, height: 18, outline: c === color ? '2px solid #fff' : undefined }} onClick={() => setColor(c)}>
            <span style={{ background: c }} />
          </button>
        ))}
      </Field>
      <div className="field" style={{ alignItems: 'start' }}>
        <label>Comment</label>
        <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.stopPropagation()} rows={3} style={{ height: 60, padding: 6, resize: 'vertical' }} />
      </div>
    </Modal>
  );
}
