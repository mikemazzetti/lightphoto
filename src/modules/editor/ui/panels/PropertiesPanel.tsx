import { useMemo } from 'react';
import { Button, Slider } from '@/ui/controls';
import { ColorSwatch } from '@/ui/ColorPicker';
import { BLEND_MODE_LABELS } from '@/core/gl/glsl';
import type { Doc } from '../../model/doc';
import type { AdjustParams, Layer, ShapeProps } from '../../model/types';
import { useActiveDoc } from '../../model/store';
import { ADJUST_NAMES } from '../../render/adjustments';
import { getCompositor } from '../../render/compositor';
import { A } from '../../actions';
import { commit, setLayerProps } from '../../ops/layers';
import { offsetLayer } from '../../ops/edit';
import { selectionFromLayer } from '../../ops/select';
import { applyAdjustmentNow } from '../../ops/process';
import { AdjustmentEditor, histogramOf } from '../AdjustmentEditor';
import { Scrub } from '../OptionsBar';
import { autoFor } from '../dialogs/AdjustDialog';

function useCompositeHisto(doc: Doc, key: string) {
  return useMemo(() => {
    const img = getCompositor()?.thumbnail(256, 256);
    return img ? { histo: histogramOf(img.data), px: img.data } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key]);
}

function AdjustProps({ doc, l }: { doc: Doc; l: Layer }) {
  const h = useCompositeHisto(doc, l.id);
  const onChange = (p: AdjustParams, done: boolean) => setLayerProps(doc, l.id, { adjust: p }, done ? `Modify ${ADJUST_NAMES[p.type]}` : undefined, done ? `adj:${l.id}` : undefined);
  return (
    <div className="col">
      <div className="ed-props-title">{ADJUST_NAMES[l.adjust!.type]}</div>
      <AdjustmentEditor p={l.adjust!} onChange={onChange} histo={h?.histo} onAuto={h ? () => onChange(autoFor(l.adjust!, h.px), true) : undefined} />
    </div>
  );
}

function MaskProps({ doc, l }: { doc: Doc; l: Layer }) {
  const m = l.mask!;
  return (
    <div className="col">
      <div className="ed-props-title">Layer Mask</div>
      <Slider label="Density" value={Math.round(m.density * 100)} min={0} max={100} suffix="%" defaultValue={100} onChange={(v) => setLayerProps(doc, l.id, { mask: { ...m, density: v / 100 } })} onCommit={(v) => setLayerProps(doc, l.id, { mask: { ...m, density: v / 100 } }, 'Mask Density')} />
      <Slider label="Feather" value={m.feather} min={0} max={250} step={0.5} suffix=" px" curve="pow2" onChange={(v) => setLayerProps(doc, l.id, { mask: { ...m, feather: v } })} onCommit={(v) => setLayerProps(doc, l.id, { mask: { ...m, feather: v } }, 'Mask Feather')} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Button small onClick={() => selectionFromLayer(doc, l.id, 'new', true)}>
          Select
        </Button>
        <Button
          small
          onClick={() => {
            doc.editMask = true;
            void applyAdjustmentNow(doc, { type: 'invert' }, 'Invert Mask');
          }}
        >
          Invert
        </Button>
        <Button small onClick={A.toggleMask}>{m.enabled ? 'Disable' : 'Enable'}</Button>
        {l.kind !== 'adjustment' && l.kind !== 'fill' && (
          <Button small onClick={A.applyMask}>
            Apply
          </Button>
        )}
        <Button small onClick={A.deleteMask}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function ShapePropsEditor({ doc, l }: { doc: Doc; l: Layer }) {
  const s = l.shape!;
  const set = (p: Partial<ShapeProps>, label?: string) => setLayerProps(doc, l.id, { shape: { ...s, ...p } }, label ?? 'Edit Shape', `shape:${l.id}`);
  return (
    <div className="col">
      <div className="ed-props-title">{s.type === 'rect' ? 'Rectangle' : s.type === 'rounded' ? 'Rounded Rectangle' : s.type === 'ellipse' ? 'Ellipse' : 'Line'}</div>
      <div className="ed-grid2">
        <Scrub label="X" value={s.x} min={-100000} max={100000} onChange={(v) => set({ x: v })} width={54} />
        <Scrub label="Y" value={s.y} min={-100000} max={100000} onChange={(v) => set({ y: v })} width={54} />
        <Scrub label="W" value={s.w} min={s.type === 'line' ? -100000 : 1} max={100000} onChange={(v) => set({ w: v })} width={54} />
        <Scrub label="H" value={s.h} min={s.type === 'line' ? -100000 : 1} max={100000} onChange={(v) => set({ h: v })} width={54} />
      </div>
      {s.type !== 'line' && (
        <div className="row">
          <span className="muted" style={{ width: 56 }}>
            Fill
          </span>
          {s.fill ? <ColorSwatch value={s.fill} onChange={(c) => set({ fill: c })} /> : <span className="ed-none-swatch" />}
          <Button small onClick={() => set({ fill: s.fill ? null : { r: 128, g: 128, b: 128, a: 1 } })}>
            {s.fill ? 'None' : 'Add'}
          </Button>
        </div>
      )}
      <div className="row">
        <span className="muted" style={{ width: 56 }}>
          {s.type === 'line' ? 'Color' : 'Stroke'}
        </span>
        {s.stroke ? <ColorSwatch value={s.stroke} onChange={(c) => set({ stroke: c })} /> : <span className="ed-none-swatch" />}
        <Button small onClick={() => set({ stroke: s.stroke ? null : { r: 0, g: 0, b: 0, a: 1 } })}>
          {s.stroke ? 'None' : 'Add'}
        </Button>
        <Scrub label="Width" value={s.strokeWidth} min={0} max={500} step={0.5} precision={1} onChange={(v) => set({ strokeWidth: v })} />
      </div>
      {s.type === 'rounded' && <Slider label="Radius" value={s.radius} min={0} max={Math.max(10, Math.min(Math.abs(s.w), Math.abs(s.h)) / 2)} onChange={(v) => setLayerProps(doc, l.id, { shape: { ...s, radius: v } })} onCommit={(v) => set({ radius: v })} />}
    </div>
  );
}

function TextProps({ doc, l }: { doc: Doc; l: Layer }) {
  const t = l.text!;
  return (
    <div className="col">
      <div className="ed-props-title">Type Layer</div>
      <div className="faint ellipsis">
        {t.font} · {t.weight >= 600 ? 'Bold' : 'Regular'}
        {t.italic ? ' Italic' : ''} · {Math.round(t.size)} px
      </div>
      <div className="row">
        <span className="muted" style={{ width: 56 }}>
          Color
        </span>
        <ColorSwatch value={t.color} alpha={false} onChange={(c) => setLayerProps(doc, l.id, { text: { ...t, color: { ...c, a: 1 } } }, 'Text Color', `text:${l.id}`)} />
      </div>
      <Slider label="Size" value={t.size} min={4} max={1000} curve="pow2" onChange={(v) => setLayerProps(doc, l.id, { text: { ...t, size: v } })} onCommit={(v) => setLayerProps(doc, l.id, { text: { ...t, size: v } }, 'Text Size')} />
      <div className="faint" style={{ fontSize: 11 }}>
        Use the Type tool (T) and click the text to edit it; font options are in the options bar.
      </div>
    </div>
  );
}

function PixelProps({ doc, l }: { doc: Doc; l: Layer }) {
  const w = l.surf?.width ?? 0;
  const h = l.surf?.height ?? 0;
  const move = (nx: number, ny: number) => {
    offsetLayer(l, Math.round(nx - l.x), Math.round(ny - l.y));
    doc.touchLayer(l);
    commit(doc, 'Move', { mergeKey: `move:${l.id}` });
  };
  return (
    <div className="col">
      <div className="ed-props-title">{l.kind === 'fill' ? 'Solid Color Fill' : 'Pixel Layer'}</div>
      {l.kind === 'fill' && l.fillColor && (
        <div className="row">
          <span className="muted" style={{ width: 56 }}>
            Color
          </span>
          <ColorSwatch value={l.fillColor} alpha={false} onChange={(c) => setLayerProps(doc, l.id, { fillColor: { ...c, a: 1 } }, 'Fill Color', `fill:${l.id}`)} />
        </div>
      )}
      {l.surf && (
        <div className="ed-grid2">
          <Scrub label="X" value={l.x} min={-100000} max={100000} onChange={(v) => move(v, l.y)} width={54} />
          <Scrub label="Y" value={l.y} min={-100000} max={100000} onChange={(v) => move(l.x, v)} width={54} />
          <span className="faint">W {w} px</span>
          <span className="faint">H {h} px</span>
        </div>
      )}
      <div className="faint" style={{ fontSize: 11 }}>
        {BLEND_MODE_LABELS[l.blendMode]} · {Math.round(l.opacity * 100)}% opacity
        {l.clip ? ' · clipped' : ''}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Button small onClick={A.freeTransform} disabled={!l.surf}>
          Transform
        </Button>
        <Button small onClick={A.flipLayerH} disabled={!l.surf}>
          Flip H
        </Button>
        <Button small onClick={A.flipLayerV} disabled={!l.surf}>
          Flip V
        </Button>
        {!l.mask && (
          <Button small onClick={() => A.mask(doc.selection ? 'selection' : 'reveal')}>
            Add Mask
          </Button>
        )}
      </div>
    </div>
  );
}

export function PropertiesPanel() {
  const doc = useActiveDoc();
  const l = doc?.activeLayer;
  if (!doc || !l) return <div className="ed-panel-empty">No properties</div>;
  return (
    <div className="ed-props">
      {doc.editMask && l.mask ? (
        <MaskProps doc={doc} l={l} />
      ) : l.kind === 'adjustment' && l.adjust ? (
        <>
          <AdjustProps doc={doc} l={l} />
          {l.mask && (
            <>
              <div className="sep-h" />
              <MaskProps doc={doc} l={l} />
            </>
          )}
        </>
      ) : l.kind === 'shape' && l.shape ? (
        <ShapePropsEditor doc={doc} l={l} />
      ) : l.kind === 'text' && l.text ? (
        <TextProps doc={doc} l={l} />
      ) : (
        <PixelProps doc={doc} l={l} />
      )}
    </div>
  );
}
