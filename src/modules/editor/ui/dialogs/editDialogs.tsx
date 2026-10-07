import { useState } from 'react';
import { openDialog } from '@/state/app';
import { Button, Checkbox, NumberField, Select, Slider } from '@/ui/controls';
import { Modal } from '@/ui/overlays';
import { ColorSwatch } from '@/ui/ColorPicker';
import { BLEND_MODE_GROUPS, BLEND_MODE_LABELS, BlendMode } from '@/core/gl/glsl';
import type { Doc } from '../../model/doc';
import type { RGBA } from '../../model/types';
import { edState } from '../../model/store';
import { fillArea, StrokeLocation, strokeSelection } from '../../ops/edit';
import { ModifyKind, modifySelection } from '../../ops/select';
import { Row } from './FloatingDialog';

export const BLEND_OPTIONS = BLEND_MODE_GROUPS.flat().map((m) => ({ value: m, label: BLEND_MODE_LABELS[m] }));

type FillSource = 'fg' | 'bg' | 'color' | 'black' | 'gray' | 'white';

function resolveColor(src: FillSource, custom: RGBA): RGBA {
  const s = edState();
  switch (src) {
    case 'fg':
      return s.fg;
    case 'bg':
      return s.bg;
    case 'black':
      return { r: 0, g: 0, b: 0, a: 1 };
    case 'gray':
      return { r: 128, g: 128, b: 128, a: 1 };
    case 'white':
      return { r: 255, g: 255, b: 255, a: 1 };
    default:
      return custom;
  }
}

const SOURCE_OPTS: { value: FillSource; label: string }[] = [
  { value: 'fg', label: 'Foreground Color' },
  { value: 'bg', label: 'Background Color' },
  { value: 'color', label: 'Color…' },
  { value: 'black', label: 'Black' },
  { value: 'gray', label: '50% Gray' },
  { value: 'white', label: 'White' },
];

function FillBody({ doc, close }: { doc: Doc; close: () => void }) {
  const [src, setSrc] = useState<FillSource>('fg');
  const [custom, setCustom] = useState<RGBA>(edState().fg);
  const [mode, setMode] = useState<BlendMode>('normal');
  const [opacity, setOpacity] = useState(100);
  const [preserve, setPreserve] = useState(false);
  return (
    <Modal
      title="Fill"
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void fillArea(doc, resolveColor(src, custom), { opacity: opacity / 100, blend: mode, preserveTransparency: preserve });
            }}
          >
            OK
          </Button>
        </>
      }
    >
      <Row label="Contents">
        <Select value={src} options={SOURCE_OPTS} onChange={setSrc} />
        {src === 'color' && <ColorSwatch value={custom} alpha={false} onChange={setCustom} />}
      </Row>
      <Row label="Mode">
        <Select value={mode} options={BLEND_OPTIONS} onChange={setMode} />
      </Row>
      <Slider label="Opacity" value={opacity} min={0} max={100} suffix="%" defaultValue={100} onChange={setOpacity} />
      <Checkbox checked={preserve} onChange={setPreserve}>
        Preserve Transparency
      </Checkbox>
      {!doc.selection && <div className="faint">No selection — the whole layer will be filled.</div>}
    </Modal>
  );
}

export function fillDialog(doc: Doc) {
  return openDialog((close) => <FillBody doc={doc} close={() => close()} />);
}

function StrokeBody({ doc, close }: { doc: Doc; close: () => void }) {
  const [width, setWidth] = useState(4);
  const [color, setColor] = useState<RGBA>(edState().fg);
  const [loc, setLoc] = useState<StrokeLocation>('center');
  const [mode, setMode] = useState<BlendMode>('normal');
  const [opacity, setOpacity] = useState(100);
  return (
    <Modal
      title="Stroke"
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void strokeSelection(doc, width, color, loc, opacity / 100, mode);
            }}
          >
            OK
          </Button>
        </>
      }
    >
      <Row label="Width">
        <NumberField value={width} min={1} max={250} suffix=" px" onChange={setWidth} width={90} />
      </Row>
      <Row label="Color">
        <ColorSwatch value={color} alpha={false} onChange={setColor} />
      </Row>
      <Row label="Location">
        <Select
          value={loc}
          options={[
            { value: 'inside', label: 'Inside' },
            { value: 'center', label: 'Center' },
            { value: 'outside', label: 'Outside' },
          ]}
          onChange={setLoc}
        />
      </Row>
      <Row label="Mode">
        <Select value={mode} options={BLEND_OPTIONS} onChange={setMode} />
      </Row>
      <Slider label="Opacity" value={opacity} min={0} max={100} suffix="%" defaultValue={100} onChange={setOpacity} />
    </Modal>
  );
}

export function strokeDialog(doc: Doc) {
  return openDialog((close) => <StrokeBody doc={doc} close={() => close()} />);
}

const MODIFY_LABEL: Record<ModifyKind, [string, string, number, number]> = {
  expand: ['Expand Selection', 'Expand By', 1, 500],
  contract: ['Contract Selection', 'Contract By', 1, 500],
  feather: ['Feather Selection', 'Feather Radius', 0.1, 1000],
  border: ['Border Selection', 'Width', 1, 200],
  smooth: ['Smooth Selection', 'Sample Radius', 1, 100],
};

function ModifyBody({ doc, kind, close }: { doc: Doc; kind: ModifyKind; close: () => void }) {
  const [title, label, min, max] = MODIFY_LABEL[kind];
  const [v, setV] = useState(kind === 'feather' ? 5 : kind === 'border' ? 10 : kind === 'smooth' ? 4 : 5);
  const ok = () => {
    close();
    modifySelection(doc, kind, v);
  };
  return (
    <Modal
      title={title}
      onClose={close}
      width={340}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={ok}>
            OK
          </Button>
        </>
      }
    >
      <Row label={label}>
        <NumberField value={v} min={min} max={max} step={kind === 'feather' ? 0.5 : 1} precision={kind === 'feather' ? 1 : 0} suffix=" px" onChange={setV} width={100} />
      </Row>
    </Modal>
  );
}

export function modifySelectionDialog(doc: Doc, kind: ModifyKind) {
  if (!doc.selection) return;
  return openDialog((close) => <ModifyBody doc={doc} kind={kind} close={() => close()} />);
}
