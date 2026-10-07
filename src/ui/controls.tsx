import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------------------------

export function Button({
  children,
  onClick,
  variant,
  small,
  block,
  active,
  disabled,
  title,
  icon,
  style,
  type = 'button',
}: {
  children?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: 'primary' | 'danger' | 'ghost';
  small?: boolean;
  block?: boolean;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  icon?: IconName;
  style?: CSSProperties;
  type?: 'button' | 'submit';
}) {
  return (
    <button type={type} className={cx('btn', variant, small && 'small', block && 'block', active && 'active')} onClick={onClick} disabled={disabled} title={title} style={style}>
      {icon && <Icon name={icon} size={small ? 13 : 14} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  title,
  active,
  disabled,
  small,
  size,
  style,
  corner,
  onContextMenu,
  onPointerDown,
}: {
  icon: IconName;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  small?: boolean;
  size?: number;
  style?: CSSProperties;
  /** Shows a small corner triangle (tool has variants). */
  corner?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <button
      type="button"
      className={cx('icon-btn', active && 'active', small && 'small')}
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={style}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
    >
      <Icon name={icon} size={size ?? (small ? 14 : 17)} />
      {corner && <span className="corner" />}
    </button>
  );
}

export function Switch({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      className={cx('switch', on && 'on')}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  style,
  title,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[] | readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <select
      className="select"
      value={String(value)}
      title={title}
      style={style}
      onChange={(e) => {
        const o = options.find((o) => String(o.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={(o as any).disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextInput({
  value,
  onChange,
  onCommit,
  placeholder,
  style,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
}) {
  return (
    <input
      className="input"
      type="text"
      value={value}
      placeholder={placeholder}
      style={style}
      autoFocus={autoFocus}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit?.(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit?.((e.target as HTMLInputElement).value);
      }}
    />
  );
}

/** Numeric field with scrubbing (drag horizontally on it) and arrow-key nudging. */
export function NumberField({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  suffix,
  width = 56,
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  width?: number;
  title?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (s: string) => {
    const v = parseFloat(s);
    if (Number.isFinite(v)) onChange(clampV(v));
    setText(null);
  };
  const shown = text ?? `${value.toFixed(precision)}${suffix ?? ''}`;
  return (
    <input
      className="input mono"
      style={{ width, textAlign: 'right', fontSize: 11 }}
      title={title}
      value={shown}
      onFocus={(e) => {
        setText(value.toFixed(precision));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(null);
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          const v = clampV(+(value + d).toFixed(6));
          onChange(v);
          setText(v.toFixed(precision));
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Slider (Lightroom-style row: label · track · value)

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Double-clicking the label/thumb resets to this. Defaults to 0 if within range, else min. */
  defaultValue?: number;
  onChange: (v: number) => void;
  /** Called once when a drag / edit finishes (good place to push undo history). */
  onCommit?: (v: number) => void;
  /** CSS background for the rail, e.g. a temperature gradient. */
  gradient?: string;
  precision?: number;
  suffix?: string;
  /** Show "+" for positive values (bipolar sliders). */
  signed?: boolean;
  labelWidth?: number;
  disabled?: boolean;
  /** Fill from this value (defaults to defaultValue for bipolar, min otherwise). */
  origin?: number;
  /** Non-linear mapping: 'pow2' gives finer control near min (e.g. brush size). */
  curve?: 'linear' | 'pow2';
}

export function Slider(p: SliderProps) {
  const { label, value, min, max, step = 1, onChange, onCommit, gradient, precision, suffix = '', signed, labelWidth, disabled, curve = 'linear' } = p;
  const def = p.defaultValue ?? (min <= 0 && max >= 0 ? 0 : min);
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const prec = precision ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  const toT = (v: number) => {
    const t = (v - min) / (max - min);
    return curve === 'pow2' ? Math.sqrt(Math.max(0, t)) : t;
  };
  const fromT = (t: number) => {
    t = Math.min(1, Math.max(0, t));
    if (curve === 'pow2') t = t * t;
    const v = min + t * (max - min);
    const q = Math.round(v / step) * step;
    return +Math.min(max, Math.max(min, q)).toFixed(6);
  };
  const t = Math.min(1, Math.max(0, toT(value)));
  const origin = p.origin ?? (min < 0 && max > 0 ? def : min);
  const to = Math.min(1, Math.max(0, toT(origin)));
  const lastVal = useRef(value);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    const el = trackRef.current!;
    el.setPointerCapture(e.pointerId);
    setDrag(true);
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startT = t;
    const onThumb = Math.abs((e.clientX - rect.left) / rect.width - t) * rect.width < 8;
    const update = (ev: PointerEvent) => {
      let nt: number;
      // Grabbing the thumb drags relatively (precise); clicking the rail jumps. Shift = fine.
      if (onThumb || ev.shiftKey) nt = startT + ((ev.clientX - startX) / rect.width) * (ev.shiftKey ? 0.2 : 1);
      else nt = (ev.clientX - rect.left) / rect.width;
      const v = fromT(nt);
      if (v !== lastVal.current) {
        lastVal.current = v;
        onChange(v);
      }
    };
    if (!onThumb) update(e.nativeEvent);
    const move = (ev: PointerEvent) => update(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(false);
      onCommit?.(lastVal.current);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  useEffect(() => {
    lastVal.current = value;
  }, [value]);

  const reset = () => {
    if (disabled) return;
    onChange(def);
    onCommit?.(def);
  };
  const fmt = (v: number) => {
    const s = v.toFixed(prec);
    return (signed && v > 0 ? '+' : '') + s + suffix;
  };
  const style = labelWidth ? ({ '--slider-label': `${labelWidth}px` } as CSSProperties) : undefined;

  return (
    <div className={cx('slider', drag && 'dragging', Math.abs(value - def) > 1e-9 && 'changed')} style={{ ...style, opacity: disabled ? 0.45 : 1 }}>
      <span className="slider-label" onDoubleClick={reset} title={`${label} — double-click to reset`}>
        {label}
      </span>
      <div className="slider-track" ref={trackRef} onPointerDown={onPointerDown} onDoubleClick={reset}>
        <div className={cx('slider-rail', gradient && 'gradient')} style={gradient ? { background: gradient } : undefined} />
        {!gradient && <div className="slider-fill" style={{ left: `${Math.min(t, to) * 100}%`, width: `${Math.abs(t - to) * 100}%` }} />}
        <div className="slider-thumb" style={{ left: `${t * 100}%` }} />
      </div>
      <input
        className="slider-value"
        value={edit ?? fmt(value)}
        disabled={disabled}
        onFocus={(e) => {
          setEdit(value.toFixed(prec));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setEdit(e.target.value)}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) {
            const c = Math.min(max, Math.max(min, v));
            onChange(c);
            onCommit?.(c);
          }
          setEdit(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setEdit(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const v = +Math.min(max, Math.max(min, value + d)).toFixed(6);
            onChange(v);
            onCommit?.(v);
            setEdit(v.toFixed(prec));
          }
        }}
      />
    </div>
  );
}

export const GRADIENTS = {
  temperature: 'linear-gradient(90deg, #3b6fd6, #c9c9c9, #e3b53b)',
  tint: 'linear-gradient(90deg, #3fb94f, #c9c9c9, #d04ad0)',
  hue: 'linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
  saturation: 'linear-gradient(90deg, #808080, #e33)',
  exposure: 'linear-gradient(90deg, #000, #fff)',
  bw: 'linear-gradient(90deg, #111, #eee)',
};

// ---------------------------------------------------------------------------------------------

export function Panel({
  title,
  children,
  defaultOpen = true,
  open: openProp,
  onToggle,
  right,
  enabled,
  onEnabledChange,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  right?: ReactNode;
  /** When provided, shows Lightroom's per-panel on/off switch. */
  enabled?: boolean;
  onEnabledChange?: (v: boolean) => void;
}) {
  const [openState, setOpen] = useState(defaultOpen);
  const open = openProp ?? openState;
  return (
    <div className={cx('panel', !open && 'collapsed', enabled === false && 'disabled')}>
      <div
        className="panel-header"
        onClick={() => {
          setOpen(!open);
          onToggle?.(!open);
        }}
      >
        <Icon name="chevronDown" size={13} className="chev" />
        <span className="grow ellipsis">{title}</span>
        <span className="row" onClick={(e) => e.stopPropagation()}>
          {right}
          {enabled !== undefined && onEnabledChange && <Switch on={enabled} onChange={onEnabledChange} title="Toggle panel effect" />}
        </span>
      </div>
      {open && <div className="panel-body">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange, style }: { value: T; tabs: { id: T; label: ReactNode }[]; onChange: (v: T) => void; style?: CSSProperties }) {
  return (
    <div className="tabs" style={style}>
      {tabs.map((t) => (
        <button key={t.id} type="button" className={cx('tab', t.id === value && 'active')} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label?: ReactNode; icon?: IconName; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="row" style={{ gap: 1, background: 'var(--bg-0)', borderRadius: 6, padding: 2, border: '1px solid var(--border)' }}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx('btn small ghost', o.value === value && 'active')}
          style={{ border: 0, height: 22 }}
        >
          {o.icon && <Icon name={o.icon} size={13} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value }: { value: number | null }) {
  return (
    <div className={cx('progress', value === null && 'indeterminate')}>
      <div style={{ width: `${(value ?? 0) * 100}%` }} />
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
