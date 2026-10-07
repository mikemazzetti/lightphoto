import { useEffect } from 'react';
import { ASPECT_PRESETS, orientedSize } from '@/core/develop/geometry';
import type { LocalAdjustment, LocalParams } from '@/core/develop/settings';
import { MAX_LOCALS } from '@/core/develop/shaders';
import { openMenu } from '@/state/app';
import { Button, Checkbox, cx, GRADIENTS, IconButton, Select, Slider } from '@/ui/controls';
import { Icon, IconName } from '@/ui/Icon';
import { promptDialog } from '@/ui/overlays';
import { setTool } from '../actions';
import { getController } from '../controller';
import { applyCrop, cancelCrop, flip, resetCrop, rotateOrientation, setAspect, swapAspect } from '../cropTool';
import { deleteMask, duplicateMask, moveMask, patchMask, startCreate, updateLocal } from '../maskTool';
import { commit, editCommit, editLive, useDevelop } from '../store';
import { AngleSlider } from './More';
import { fmtValue, SubHead } from '../ui';

// ---------------------------------------------------------------------------------------------
// Crop & Straighten options

export function CropPanel() {
  const aspect = useDevelop((s) => s.cropAspect);
  const locked = useDevelop((s) => s.cropLocked);
  const straighten = useDevelop((s) => s.straighten);
  const crop = useDevelop((s) => s.settings?.crop);
  const orientation = useDevelop((s) => s.settings?.orientation ?? 0);
  const c = getController();
  const dims = c?.engine.hasSource ? orientedSize(c.srcW, c.srcH, orientation) : null;
  const rot = (dir: 1 | -1) => editCommit((x) => rotateOrientation(x, dir), dir > 0 ? 'Rotate Right' : 'Rotate Left');
  return (
    <div className="dv-toolpanel">
      <div className="dv-toolpanel-head">
        <Icon name="crop" size={13} />
        <span>Crop &amp; Straighten</span>
        <div className="spacer" />
        <Button small variant="ghost" onClick={resetCrop} title="Reset crop and angle">
          Reset
        </Button>
      </div>
      <div className="dv-field">
        <span>Aspect</span>
        <Select value={aspect} style={{ flex: 1 }} options={ASPECT_PRESETS.map((a) => ({ value: a.label, label: a.label }))} onChange={(l) => setAspect(l, false)} />
        <IconButton
          small
          icon={locked ? 'lock' : 'unlock'}
          active={locked}
          title={locked ? 'Aspect locked — click to unlock' : 'Lock aspect ratio'}
          onClick={() => (locked ? useDevelop.setState({ cropAspect: 'Free', cropLocked: false }) : useDevelop.setState({ cropLocked: true }))}
        />
        <IconButton small icon="refresh" title="Swap landscape / portrait (X)" onClick={swapAspect} />
      </div>
      <div className="row" style={{ gap: 4 }}>
        <div className="grow">
          <AngleSlider />
        </div>
        <IconButton small icon="line" active={straighten} title="Straighten tool — draw a line along the horizon (or hold ⌘ and drag)" onClick={() => useDevelop.setState((s) => ({ straighten: !s.straighten }))} />
      </div>
      <div className="dv-btnrow">
        <Button small icon="rotateLeft" onClick={() => rot(-1)} title="Rotate left" />
        <Button small icon="rotateRight" onClick={() => rot(1)} title="Rotate right" />
        <Button small icon="flipH" onClick={() => editCommit((x) => flip(x, 'h'), 'Flip Horizontal')} title="Flip horizontal" />
        <Button small icon="flipV" onClick={() => editCommit((x) => flip(x, 'v'), 'Flip Vertical')} title="Flip vertical" />
        <div className="spacer" />
        {crop && dims && (
          <span className="faint mono" style={{ fontSize: 10.5 }}>
            {Math.round(crop.w * dims[0])} × {Math.round(crop.h * dims[1])}
          </span>
        )}
      </div>
      <div className="faint dv-hint">Drag handles to resize (Shift keeps proportions, Alt from centre) · drag inside to move · drag outside to rotate.</div>
      <div className="dv-btnrow end">
        <Button small onClick={cancelCrop} title="Esc">
          Cancel
        </Button>
        <Button small variant="primary" onClick={applyCrop} title="Enter">
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Masking

const TYPE_ICON: Record<LocalAdjustment['type'], IconName> = { linear: 'gradient', radial: 'ellipse', brush: 'brush' };

/** What the mask list shows — selected as a JSON string so slider drags don't re-render the list. */
interface MaskRowInfo {
  id: string;
  name: string;
  type: LocalAdjustment['type'];
  enabled: boolean;
  invert: boolean;
}
const rowsKey = (locals: LocalAdjustment[] | undefined) => JSON.stringify((locals ?? []).map((l) => [l.id, l.name, l.type, l.enabled, l.invert]));
const parseRows = (key: string): MaskRowInfo[] => (JSON.parse(key) as [string, string, LocalAdjustment['type'], boolean, boolean][]).map(([id, name, type, enabled, invert]) => ({ id, name, type, enabled, invert }));

function MaskRow({ l, index, count, selected }: { l: MaskRowInfo; index: number; count: number; selected: boolean }) {
  const rename = async () => {
    const name = await promptDialog('Rename Mask', l.name);
    if (name && name.trim()) patchMask(l.id, { name: name.trim() }, 'Rename Mask');
  };
  const menu = (x: number, y: number) =>
    openMenu(x, y, [
      { label: 'Rename…', onClick: () => void rename() },
      { label: 'Duplicate', onClick: () => duplicateMask(l.id), disabled: count >= MAX_LOCALS },
      { label: l.invert ? 'Un-invert' : 'Invert', onClick: () => patchMask(l.id, { invert: !l.invert }, 'Invert Mask') },
      { label: 'Reset Adjustments', onClick: () => patchMask(l.id, ZERO_PARAMS, 'Reset Mask Adjustments') },
      { separator: true },
      { label: 'Move Up', onClick: () => moveMask(l.id, -1), disabled: index === 0 },
      { label: 'Move Down', onClick: () => moveMask(l.id, 1), disabled: index === count - 1 },
      { separator: true },
      { label: 'Delete', danger: true, onClick: () => deleteMask(l.id) },
    ]);
  return (
    <div
      className={cx('dv-mask-row', selected && 'active', !l.enabled && 'off')}
      onClick={() => useDevelop.setState({ selectedMask: l.id, creating: null })}
      onMouseEnter={() => useDevelop.setState({ hoverMask: l.id })}
      onMouseLeave={() => useDevelop.setState({ hoverMask: null })}
      onDoubleClick={() => void rename()}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
    >
      <Icon name={TYPE_ICON[l.type]} size={14} />
      <span className="grow ellipsis">{l.name}</span>
      {l.invert && <span className="dv-tag">INV</span>}
      <button
        type="button"
        className="dv-mini"
        title={l.enabled ? 'Hide mask effect' : 'Show mask effect'}
        onClick={(e) => {
          e.stopPropagation();
          patchMask(l.id, { enabled: !l.enabled }, l.enabled ? 'Disable Mask' : 'Enable Mask');
        }}
      >
        <Icon name={l.enabled ? 'eye' : 'eyeOff'} size={13} />
      </button>
      <button
        type="button"
        className="dv-mini"
        title="More…"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          menu(r.left, r.bottom + 2);
        }}
      >
        <Icon name="more" size={13} />
      </button>
    </div>
  );
}

const ZERO_PARAMS: LocalParams & { amount: number } = { amount: 100, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0, saturation: 0, clarity: 0, dehaze: 0, texture: 0 };

function LocalSlider({ id, k, label, min = -100, max = 100, step = 1, gradient }: { id: string; k: keyof LocalParams | 'amount'; label: string; min?: number; max?: number; step?: number; gradient?: string }) {
  const v = useDevelop((s) => (s.settings?.locals.find((l) => l.id === id)?.[k] as number | undefined) ?? 0);
  return (
    <Slider
      label={label}
      value={v}
      min={min}
      max={max}
      step={step}
      gradient={gradient}
      signed={min < 0}
      defaultValue={k === 'amount' ? 100 : 0}
      onChange={(x) => editLive((s) => updateLocal(s, id, (l) => ({ ...l, [k]: x })))}
      onCommit={(x) => commit(`Mask ${label} ${fmtValue(x, step, min < 0)}`)}
    />
  );
}

function RadialFeather({ id }: { id: string }) {
  const f = useDevelop((s) => s.settings?.locals.find((l) => l.id === id)?.radial?.feather ?? 50);
  return (
    <Slider
      label="Feather"
      value={f}
      min={0}
      max={100}
      defaultValue={50}
      onChange={(x) => editLive((s) => updateLocal(s, id, (l) => (l.radial ? { ...l, radial: { ...l.radial, feather: x } } : l)))}
      onCommit={(x) => commit(`Radial Feather ${x}`)}
    />
  );
}

function BrushOptions({ id }: { id: string }) {
  const b = useDevelop((s) => s.brush);
  const strokes = useDevelop((s) => s.settings?.locals.find((l) => l.id === id)?.strokes?.length ?? 0);
  const setB = (patch: Partial<typeof b>) => useDevelop.setState((s) => ({ brush: { ...s.brush, ...patch } }));
  return (
    <>
      <SubHead
        right={
          <div className="row" style={{ gap: 2 }}>
            <button type="button" className={cx('dv-chip', !b.erase && 'active')} onClick={() => setB({ erase: false })} title="Paint (add to mask)">
              Add
            </button>
            <button type="button" className={cx('dv-chip', b.erase && 'active')} onClick={() => setB({ erase: true })} title="Erase (or hold Alt while painting)">
              Erase
            </button>
          </div>
        }
      >
        Brush
      </SubHead>
      <Slider label="Size" value={+(b.size * 100).toFixed(2)} min={0.2} max={40} step={0.1} curve="pow2" defaultValue={6} suffix="%" onChange={(v) => setB({ size: v / 100 })} />
      <Slider label="Feather" value={b.feather} min={0} max={100} defaultValue={60} onChange={(v) => setB({ feather: v })} />
      <Slider label="Flow" value={b.flow} min={1} max={100} defaultValue={100} onChange={(v) => setB({ flow: v })} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="faint">
          {strokes} stroke{strokes === 1 ? '' : 's'} · [ ] size · Alt erases
        </span>
        <Button small variant="ghost" disabled={!strokes} onClick={() => editCommit((s) => updateLocal(s, id, (l) => ({ ...l, strokes: [] })), 'Clear Brush Strokes')}>
          Clear
        </Button>
      </div>
    </>
  );
}

function MaskSettings({ l }: { l: MaskRowInfo }) {
  const id = l.id;
  return (
    <div className="dv-mask-settings">
      {l.type === 'brush' && <BrushOptions id={id} />}
      {l.type === 'radial' && (
        <>
          <SubHead>Shape</SubHead>
          <RadialFeather id={id} />
        </>
      )}
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <Checkbox checked={l.invert} onChange={(v) => patchMask(id, { invert: v }, 'Invert Mask')}>
          Invert
        </Checkbox>
        <Button small variant="ghost" onClick={() => patchMask(id, ZERO_PARAMS, 'Reset Mask Adjustments')}>
          Reset sliders
        </Button>
      </div>
      <LocalSlider id={id} k="amount" label="Amount" min={0} max={100} />
      <SubHead>Light</SubHead>
      <LocalSlider id={id} k="exposure" label="Exposure" min={-4} max={4} step={0.01} gradient={GRADIENTS.exposure} />
      <LocalSlider id={id} k="contrast" label="Contrast" />
      <LocalSlider id={id} k="highlights" label="Highlights" />
      <LocalSlider id={id} k="shadows" label="Shadows" />
      <LocalSlider id={id} k="whites" label="Whites" />
      <LocalSlider id={id} k="blacks" label="Blacks" />
      <SubHead>Color</SubHead>
      <LocalSlider id={id} k="temperature" label="Temp" gradient={GRADIENTS.temperature} />
      <LocalSlider id={id} k="tint" label="Tint" gradient={GRADIENTS.tint} />
      <LocalSlider id={id} k="saturation" label="Saturation" />
      <SubHead>Effects</SubHead>
      <LocalSlider id={id} k="texture" label="Texture" />
      <LocalSlider id={id} k="clarity" label="Clarity" />
      <LocalSlider id={id} k="dehaze" label="Dehaze" />
    </div>
  );
}

export function MaskPanel() {
  useEffect(() => () => useDevelop.setState({ hoverMask: null }), []);
  const key = useDevelop((s) => rowsKey(s.settings?.locals));
  const locals = parseRows(key);
  const selected = useDevelop((s) => s.selectedMask);
  const creating = useDevelop((s) => s.creating);
  const overlay = useDevelop((s) => s.maskOverlay);
  const sel = locals.find((l) => l.id === selected);
  const full = locals.length >= MAX_LOCALS;
  return (
    <div className="dv-toolpanel">
      <div className="dv-toolpanel-head">
        <Icon name="mask" size={13} />
        <span>Masks</span>
        <span className="faint">
          {locals.length}/{MAX_LOCALS}
        </span>
        <div className="spacer" />
        <Checkbox checked={overlay} onChange={(v) => useDevelop.setState({ maskOverlay: v })}>
          Overlay (O)
        </Checkbox>
      </div>
      <div className="dv-btnrow">
        <Button small icon="gradient" active={creating === 'linear'} disabled={full} onClick={() => startCreate('linear')} title="Linear Gradient (M) — drag on the photo">
          Linear
        </Button>
        <Button small icon="ellipse" active={creating === 'radial'} disabled={full} onClick={() => startCreate('radial')} title="Radial Gradient (⇧R) — drag from the centre">
          Radial
        </Button>
        <Button small icon="brush" disabled={full} onClick={() => startCreate('brush')} title="Brush (K)">
          Brush
        </Button>
      </div>
      {creating && <div className="dv-hint accent">Drag on the photo to place the {creating === 'linear' ? 'linear' : 'radial'} gradient — or click for a default size. Esc cancels.</div>}
      <div className="dv-mask-list">
        {locals.map((l, i) => (
          <MaskRow key={l.id} l={l} index={i} count={locals.length} selected={l.id === selected} />
        ))}
        {!locals.length && !creating && <div className="faint dv-hint">No masks yet. Add a gradient or brush to make local adjustments.</div>}
      </div>
      {sel && <MaskSettings key={sel.id} l={sel} />}
      <div className="dv-btnrow end">
        <Button small variant="primary" onClick={() => setTool('mask')}>
          Done
        </Button>
      </div>
    </div>
  );
}

