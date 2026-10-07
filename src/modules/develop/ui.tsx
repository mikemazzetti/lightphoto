import { ReactNode } from 'react';
import type { DevelopSettings } from '@/core/develop/settings';
import { Panel, Slider } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { commit, editCommit, getIn, setPanelDisabled, setPanelOpen, setPath, useDevelop } from './store';

/** Formats a value the way the slider shows it (for history labels). */
export function fmtValue(v: number, step = 1, signed = true, precision?: number) {
  const p = precision ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  return (signed && v > 0 ? '+' : '') + v.toFixed(p);
}

export interface SSliderProps {
  path: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  gradient?: string;
  precision?: number;
  suffix?: string;
  /** History label (defaults to the slider label). */
  history?: string;
  labelWidth?: number;
  curve?: 'linear' | 'pow2';
  disabled?: boolean;
}

/**
 * Slider bound to a settings path. Subscribes to just its own value, so dragging re-renders one
 * row; the viewer picks the change up from the store on the next animation frame.
 */
export function SSlider({ path, label, min, max, step = 1, gradient, precision, suffix, history, labelWidth, curve, disabled }: SSliderProps) {
  const value = useDevelop((s) => (getIn(s.settings, path) as number | undefined) ?? 0);
  const def = useDevelop((s) => (getIn(s.defaults, path) as number | undefined) ?? 0);
  const signed = min < 0;
  return (
    <Slider
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      gradient={gradient}
      precision={precision}
      suffix={suffix}
      signed={signed}
      defaultValue={def}
      labelWidth={labelWidth}
      curve={curve}
      disabled={disabled}
      onChange={(v) => setPath(path, v)}
      onCommit={(v) => commit(`${history ?? label} ${fmtValue(v, step, signed, precision)}`)}
    />
  );
}

export function ResetButton({ onClick, title = 'Reset panel' }: { onClick: () => void; title?: string }) {
  return (
    <button type="button" className="dv-reset" title={title} onClick={onClick}>
      <Icon name="refresh" size={12} />
    </button>
  );
}

/** Develop panel: open state kept in the module store, header reset, optional on/off switch. */
export function DPanel({ id, title, children, onReset, toggle, right, defaultOpen = false }: { id: string; title: ReactNode; children: ReactNode; onReset?: () => void; toggle?: boolean; right?: ReactNode; defaultOpen?: boolean }) {
  const open = useDevelop((s) => s.panels[id] ?? defaultOpen);
  const disabled = useDevelop((s) => !!s.disabledPanels[id]);
  return (
    <Panel
      title={title}
      open={open}
      onToggle={(o) => setPanelOpen(id, o)}
      right={
        <>
          {right}
          {onReset && <ResetButton onClick={onReset} />}
        </>
      }
      enabled={toggle ? !disabled : undefined}
      onEnabledChange={toggle ? (v) => setPanelDisabled(id, !v) : undefined}
    >
      {children}
    </Panel>
  );
}

/** Resets settings keys to the photo's defaults as one history step. */
export function resetKeys(keys: (keyof DevelopSettings)[], label: string) {
  const d = useDevelop.getState().defaults as any;
  editCommit((s) => {
    const o: any = { ...s };
    for (const k of keys) o[k] = structuredClone(d[k]);
    return o;
  }, `Reset ${label}`);
}

export function SubHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="dv-subhead">
      <span>{children}</span>
      {right}
    </div>
  );
}
