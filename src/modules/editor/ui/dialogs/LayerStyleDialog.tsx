import { useEffect, useRef, useState } from 'react';
import { openDialog } from '@/state/app';
import { Button, Select, Slider } from '@/ui/controls';
import { ColorSwatch } from '@/ui/ColorPicker';
import type { Doc } from '../../model/doc';
import type { DropShadowFx, LayerStyle, OuterGlowFx, StrokeFx } from '../../model/types';
import { touch } from '../../model/store';
import { commit } from '../../ops/layers';
import { FloatingDialog } from './FloatingDialog';

export type FxKey = 'dropShadow' | 'outerGlow' | 'stroke';

export const defaultDropShadow = (): DropShadowFx => ({ enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.6, angle: 120, distance: 8, size: 12, spread: 0 });
export const defaultOuterGlow = (): OuterGlowFx => ({ enabled: true, color: { r: 255, g: 255, b: 190, a: 1 }, opacity: 0.75, size: 14, spread: 0 });
export const defaultStroke = (): StrokeFx => ({ enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, size: 3, position: 'outside' });

function Body({ doc, layerId, focus, close }: { doc: Doc; layerId: string; focus: FxKey; close: () => void }) {
  const l = doc.layer(layerId)!;
  const original = useRef<LayerStyle | null>(l.style ? JSON.parse(JSON.stringify(l.style)) : null);
  const [st, setSt] = useState<Required<LayerStyle>>(() => {
    const s = l.style ?? {};
    return {
      dropShadow: s.dropShadow ?? { ...defaultDropShadow(), enabled: focus === 'dropShadow' },
      outerGlow: s.outerGlow ?? { ...defaultOuterGlow(), enabled: focus === 'outerGlow' },
      stroke: s.stroke ?? { ...defaultStroke(), enabled: focus === 'stroke' },
    };
  });
  const [tab, setTab] = useState<FxKey>(focus);
  useEffect(() => {
    if (focus && !st[focus].enabled) setSt({ ...st, [focus]: { ...st[focus], enabled: true } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Live preview straight on the layer.
  useEffect(() => {
    const t = setTimeout(() => {
      const layer = doc.layer(layerId);
      if (!layer) return;
      layer.style = pack(st);
      doc.touchLayer(layer);
    }, 16);
    return () => clearTimeout(t);
  }, [st, doc, layerId]);

  const ds = st.dropShadow;
  const og = st.outerGlow;
  const sk = st.stroke;
  const setDs = (p: Partial<DropShadowFx>) => setSt({ ...st, dropShadow: { ...ds, ...p } });
  const setOg = (p: Partial<OuterGlowFx>) => setSt({ ...st, outerGlow: { ...og, ...p } });
  const setSk = (p: Partial<StrokeFx>) => setSt({ ...st, stroke: { ...sk, ...p } });

  return (
    <FloatingDialog
      title="Layer Style"
      width={380}
      extraButtons={
        <Button small onClick={() => setSt({ dropShadow: { ...ds, enabled: false }, outerGlow: { ...og, enabled: false }, stroke: { ...sk, enabled: false } })}>
          Clear All
        </Button>
      }
      onOk={() => {
        const layer = doc.layer(layerId);
        if (layer) {
          layer.style = pack(st);
          doc.touchLayer(layer);
          commit(doc, 'Layer Style');
        }
        close();
      }}
      onCancel={() => {
        const layer = doc.layer(layerId);
        if (layer) {
          layer.style = original.current;
          doc.touchLayer(layer);
          touch();
        }
        close();
      }}
    >
      <div className="ed-fx-tabs">
        {(
          [
            ['dropShadow', 'Drop Shadow', ds.enabled],
            ['outerGlow', 'Outer Glow', og.enabled],
            ['stroke', 'Stroke', sk.enabled],
          ] as const
        ).map(([k, label, on]) => (
          <div key={k} className={`ed-fx-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            <input
              type="checkbox"
              checked={on}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setSt({ ...st, [k]: { ...st[k], enabled: e.target.checked } })}
            />
            {label}
          </div>
        ))}
      </div>
      {tab === 'dropShadow' && (
        <div className="col" style={{ gap: 2 }}>
          <div className="row">
            <span className="muted" style={{ width: 84 }}>
              Color
            </span>
            <ColorSwatch value={ds.color} alpha={false} onChange={(c) => setDs({ color: c })} />
          </div>
          <Slider label="Opacity" value={Math.round(ds.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => setDs({ opacity: v / 100 })} />
          <Slider label="Angle" value={ds.angle} min={-180} max={180} suffix="°" defaultValue={120} onChange={(v) => setDs({ angle: v })} />
          <Slider label="Distance" value={ds.distance} min={0} max={300} suffix=" px" curve="pow2" onChange={(v) => setDs({ distance: v })} />
          <Slider label="Spread" value={ds.spread} min={0} max={100} suffix="%" onChange={(v) => setDs({ spread: v })} />
          <Slider label="Size" value={ds.size} min={0} max={250} suffix=" px" curve="pow2" onChange={(v) => setDs({ size: v })} />
        </div>
      )}
      {tab === 'outerGlow' && (
        <div className="col" style={{ gap: 2 }}>
          <div className="row">
            <span className="muted" style={{ width: 84 }}>
              Color
            </span>
            <ColorSwatch value={og.color} alpha={false} onChange={(c) => setOg({ color: c })} />
          </div>
          <Slider label="Opacity" value={Math.round(og.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => setOg({ opacity: v / 100 })} />
          <Slider label="Spread" value={og.spread} min={0} max={100} suffix="%" onChange={(v) => setOg({ spread: v })} />
          <Slider label="Size" value={og.size} min={0} max={250} suffix=" px" curve="pow2" onChange={(v) => setOg({ size: v })} />
        </div>
      )}
      {tab === 'stroke' && (
        <div className="col" style={{ gap: 2 }}>
          <div className="row">
            <span className="muted" style={{ width: 84 }}>
              Color
            </span>
            <ColorSwatch value={sk.color} alpha={false} onChange={(c) => setSk({ color: c })} />
          </div>
          <Slider label="Size" value={sk.size} min={1} max={250} suffix=" px" curve="pow2" onChange={(v) => setSk({ size: v })} />
          <div className="row">
            <span className="muted" style={{ width: 84 }}>
              Position
            </span>
            <Select
              value={sk.position}
              options={[
                { value: 'outside', label: 'Outside' },
                { value: 'inside', label: 'Inside' },
                { value: 'center', label: 'Center' },
              ]}
              onChange={(v) => setSk({ position: v })}
            />
          </div>
          <Slider label="Opacity" value={Math.round(sk.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => setSk({ opacity: v / 100 })} />
        </div>
      )}
    </FloatingDialog>
  );
}

function pack(st: Required<LayerStyle>): LayerStyle | null {
  const out: LayerStyle = {};
  if (st.dropShadow.enabled) out.dropShadow = st.dropShadow;
  if (st.outerGlow.enabled) out.outerGlow = st.outerGlow;
  if (st.stroke.enabled) out.stroke = st.stroke;
  return out.dropShadow || out.outerGlow || out.stroke ? out : null;
}

export function layerStyleDialog(doc: Doc, focus: FxKey = 'dropShadow', layerId = doc.activeLayerId) {
  const l = doc.layer(layerId);
  if (!l || l.kind === 'adjustment' || l.kind === 'fill') return;
  return openDialog((close) => <Body doc={doc} layerId={layerId} focus={focus} close={() => close()} />);
}
