import { useEffect, useRef, useState } from 'react';
import { hexToRgba, hsvToRgb, RGBA, rgbaToCss, rgbaToHex, rgbToHsv } from '@/core/util/color';
import { Popover } from './overlays';

const RECENT_KEY = 'lp:recentColors';
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function pushRecent(hex: string) {
  const r = [hex, ...loadRecent().filter((x) => x !== hex)].slice(0, 16);
  localStorage.setItem(RECENT_KEY, JSON.stringify(r));
}

function useDrag(onMove: (x: number, y: number, rect: DOMRect) => void, onEnd?: () => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    onMove(e.clientX, e.clientY, rect);
    const move = (ev: PointerEvent) => onMove(ev.clientX, ev.clientY, rect);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
}

/** HSV picker body (no popover). */
export function ColorPickerBody({ value, onChange, alpha = true }: { value: RGBA; onChange: (c: RGBA) => void; alpha?: boolean }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(value.r, value.g, value.b));
  const [hex, setHex] = useState(rgbaToHex(value));
  const last = useRef(value);
  useEffect(() => {
    if (value.r !== last.current.r || value.g !== last.current.g || value.b !== last.current.b) {
      const n = rgbToHsv(value.r, value.g, value.b);
      setHsv((h) => [n[1] === 0 || n[2] === 0 ? h[0] : n[0], n[2] === 0 ? h[1] : n[1], n[2]]);
      setHex(rgbaToHex(value));
    }
    last.current = value;
  }, [value]);
  const emit = (h: number, s: number, v: number, a = value.a) => {
    setHsv([h, s, v]);
    const [r, g, b] = hsvToRgb(h, s, v);
    const c = { r, g, b, a };
    last.current = c;
    setHex(rgbaToHex(c));
    onChange(c);
  };
  const [h, s, v] = hsv;
  const pure = hsvToRgb(h, 1, 1);
  const svDrag = useDrag((x, y, r) => emit(h, Math.min(1, Math.max(0, (x - r.left) / r.width)), 1 - Math.min(1, Math.max(0, (y - r.top) / r.height))), () => pushRecent(rgbaToHex(last.current)));
  const hueDrag = useDrag((x, _y, r) => emit(Math.min(359.9, Math.max(0, ((x - r.left) / r.width) * 360)), s, v));
  const aDrag = useDrag((x, _y, r) => emit(h, s, v, Math.min(1, Math.max(0, (x - r.left) / r.width))));
  const recent = loadRecent();
  const opaque = rgbaToCss({ ...value, a: 1 });
  return (
    <div className="cp">
      <div className="cp-sv" style={{ background: `rgb(${pure.join(',')})` }} onPointerDown={svDrag}>
        <div className="cp-dot" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: opaque }} />
      </div>
      <div className="cp-strip" style={{ background: 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }} onPointerDown={hueDrag}>
        <div className="cp-knob" style={{ left: `${(h / 360) * 100}%` }} />
      </div>
      {alpha && (
        <div className="cp-strip checker" onPointerDown={aDrag}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: 6, background: `linear-gradient(90deg, transparent, ${opaque})` }} />
          <div className="cp-knob" style={{ left: `${value.a * 100}%` }} />
        </div>
      )}
      <div className="row">
        <div className="swatch checker" style={{ width: 30, height: 24 }}>
          <span style={{ background: rgbaToCss(value) }} />
        </div>
        <input
          className="input mono grow"
          value={hex}
          spellCheck={false}
          onChange={(e) => {
            setHex(e.target.value);
            if (/^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) {
              const c = { ...hexToRgba(e.target.value), a: value.a };
              last.current = c;
              setHsv(rgbToHsv(c.r, c.g, c.b));
              onChange(c);
            }
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {alpha && <span className="muted mono" style={{ width: 36, textAlign: 'right' }}>{Math.round(value.a * 100)}%</span>}
      </div>
      {recent.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {recent.map((c) => (
            <button key={c} type="button" className="swatch" style={{ width: 18, height: 18 }} title={c} onClick={() => onChange({ ...hexToRgba(c), a: value.a })}>
              <span style={{ background: c }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A colour swatch button that opens the picker in a popover. */
export function ColorSwatch({ value, onChange, alpha = true, size = 22, title }: { value: RGBA; onChange: (c: RGBA) => void; alpha?: boolean; size?: number; title?: string }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        className="swatch checker"
        title={title ?? rgbaToHex(value)}
        style={{ width: size, height: size }}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <span style={{ background: rgbaToCss(value) }} />
      </button>
      {anchor && (
        <Popover x={anchor.x} y={anchor.y} onClose={() => setAnchor(null)}>
          <ColorPickerBody value={value} onChange={onChange} alpha={alpha} />
        </Popover>
      )}
    </>
  );
}
