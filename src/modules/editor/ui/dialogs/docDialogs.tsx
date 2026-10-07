import { useState } from 'react';
import { openDialog } from '@/state/app';
import { Button, Checkbox, NumberField, Select, Slider, TextInput } from '@/ui/controls';
import { Modal } from '@/ui/overlays';
import { ColorSwatch } from '@/ui/ColorPicker';
import type { ExportFormat } from '@/core/image/encode';
import type { Doc } from '../../model/doc';
import type { RGBA } from '../../model/types';
import { edState } from '../../model/store';
import { createDoc, uniqueName } from '../../ops/docs';
import { resizeCanvas, resizeImage, ResampleMethod } from '../../ops/image';
import { exportDoc } from '../../io/files';
import { Row } from './FloatingDialog';

// ---------------------------------------------------------------------------------------------
// New Document

const PRESETS: { group: string; items: { label: string; w: number; h: number }[] }[] = [
  {
    group: 'Screen',
    items: [
      { label: 'HD 1280 × 720', w: 1280, h: 720 },
      { label: 'Full HD 1920 × 1080', w: 1920, h: 1080 },
      { label: '4K UHD 3840 × 2160', w: 3840, h: 2160 },
      { label: 'MacBook Pro 3024 × 1964', w: 3024, h: 1964 },
      { label: 'iPhone 1179 × 2556', w: 1179, h: 2556 },
    ],
  },
  {
    group: 'Social',
    items: [
      { label: 'Square 1080 × 1080', w: 1080, h: 1080 },
      { label: 'Portrait 1080 × 1350', w: 1080, h: 1350 },
      { label: 'Story 1080 × 1920', w: 1080, h: 1920 },
      { label: 'Banner 1500 × 500', w: 1500, h: 500 },
    ],
  },
  {
    group: 'Print (300 ppi)',
    items: [
      { label: 'A4 2480 × 3508', w: 2480, h: 3508 },
      { label: 'A3 3508 × 4961', w: 3508, h: 4961 },
      { label: 'Letter 2550 × 3300', w: 2550, h: 3300 },
      { label: '4 × 6 in 1200 × 1800', w: 1200, h: 1800 },
    ],
  },
];

type Bg = 'white' | 'black' | 'transparent' | 'fg' | 'bg';

function NewDocBody({ close }: { close: () => void }) {
  const [name, setName] = useState(uniqueName('Untitled'));
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [bg, setBg] = useState<Bg>('white');
  const create = () => {
    const s = edState();
    const fill = bg === 'fg' ? s.fg : bg === 'bg' ? s.bg : bg;
    createDoc(name.trim() || 'Untitled', Math.round(w), Math.round(h), fill as 'white' | 'black' | 'transparent' | RGBA);
    close();
  };
  return (
    <Modal
      title="New Document"
      onClose={close}
      width={620}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={create}>
            Create
          </Button>
        </>
      }
    >
      <div className="ed-newdoc">
        <div className="ed-presets">
          {PRESETS.map((g) => (
            <div key={g.group}>
              <div className="panel-sub">{g.group}</div>
              {g.items.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`ed-preset ${p.w === w && p.h === h ? 'active' : ''}`}
                  onClick={() => {
                    setW(p.w);
                    setH(p.h);
                  }}
                >
                  <span className="ed-preset-icon" style={{ aspectRatio: `${p.w} / ${p.h}` }} />
                  {p.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="col" style={{ gap: 8, minWidth: 230 }}>
          <Row label="Name" width={84}>
            <TextInput value={name} onChange={setName} style={{ flex: 1 }} autoFocus />
          </Row>
          <Row label="Width" width={84}>
            <NumberField value={w} min={1} max={16384} onChange={setW} width={90} suffix=" px" />
            <Button small title="Swap orientation" onClick={() => (setW(h), setH(w))}>
              ⇄
            </Button>
          </Row>
          <Row label="Height" width={84}>
            <NumberField value={h} min={1} max={16384} onChange={setH} width={90} suffix=" px" />
          </Row>
          <Row label="Background" width={84}>
            <Select
              value={bg}
              options={[
                { value: 'white', label: 'White' },
                { value: 'black', label: 'Black' },
                { value: 'transparent', label: 'Transparent' },
                { value: 'fg', label: 'Foreground Color' },
                { value: 'bg', label: 'Background Color' },
              ]}
              onChange={setBg}
            />
          </Row>
          <div className="faint" style={{ fontSize: 11 }}>
            {((w * h) / 1e6).toFixed(1)} MP · {((w * h * 4) / 1048576).toFixed(0)} MB per layer
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function newDocDialog() {
  return openDialog((close) => <NewDocBody close={() => close()} />);
}

// ---------------------------------------------------------------------------------------------
// Image Size

function ImageSizeBody({ doc, close }: { doc: Doc; close: () => void }) {
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [pct, setPct] = useState(false);
  const [lock, setLock] = useState(true);
  const [method, setMethod] = useState<ResampleMethod>('bicubic');
  const ar = doc.width / doc.height;
  const setWidth = (v: number) => {
    setW(v);
    if (lock) setH(Math.max(1, Math.round(v / ar)));
  };
  const setHeight = (v: number) => {
    setH(v);
    if (lock) setW(Math.max(1, Math.round(v * ar)));
  };
  return (
    <Modal
      title="Image Size"
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void resizeImage(doc, w, h, method);
            }}
          >
            OK
          </Button>
        </>
      }
    >
      <div className="faint">
        Current: {doc.width} × {doc.height} px · New: {((w * h * 4 * doc.layers.length) / 1048576).toFixed(0)} MB
      </div>
      <Row label="Width">
        {pct ? <NumberField value={(w / doc.width) * 100} precision={1} suffix=" %" min={0.1} max={10000} onChange={(v) => setWidth(Math.round((doc.width * v) / 100))} width={100} /> : <NumberField value={w} min={1} max={16384} suffix=" px" onChange={setWidth} width={100} />}
      </Row>
      <Row label="Height">
        {pct ? <NumberField value={(h / doc.height) * 100} precision={1} suffix=" %" min={0.1} max={10000} onChange={(v) => setHeight(Math.round((doc.height * v) / 100))} width={100} /> : <NumberField value={h} min={1} max={16384} suffix=" px" onChange={setHeight} width={100} />}
      </Row>
      <Row label="">
        <Checkbox checked={lock} onChange={setLock}>
          Constrain proportions
        </Checkbox>
        <Checkbox checked={pct} onChange={setPct}>
          Percent
        </Checkbox>
      </Row>
      <Row label="Resample">
        <Select
          value={method}
          options={[
            { value: 'bicubic', label: 'Bicubic (smooth gradients)' },
            { value: 'bilinear', label: 'Bilinear' },
            { value: 'nearest', label: 'Nearest Neighbor (hard edges)' },
          ]}
          onChange={setMethod}
        />
      </Row>
    </Modal>
  );
}

export function imageSizeDialog(doc: Doc) {
  return openDialog((close) => <ImageSizeBody doc={doc} close={() => close()} />);
}

// ---------------------------------------------------------------------------------------------
// Canvas Size

function CanvasSizeBody({ doc, close }: { doc: Doc; close: () => void }) {
  const [rel, setRel] = useState(false);
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [ax, setAx] = useState(0.5);
  const [ay, setAy] = useState(0.5);
  const [ext, setExt] = useState<'transparent' | 'white' | 'black' | 'bg' | 'fg' | 'custom'>('transparent');
  const [custom, setCustom] = useState<RGBA>({ r: 128, g: 128, b: 128, a: 1 });
  const nw = rel ? doc.width + w : w;
  const nh = rel ? doc.height + h : h;
  const extColor = (): 'transparent' | RGBA => {
    const s = edState();
    if (ext === 'transparent') return 'transparent';
    if (ext === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    if (ext === 'black') return { r: 0, g: 0, b: 0, a: 1 };
    if (ext === 'fg') return s.fg;
    if (ext === 'bg') return s.bg;
    return custom;
  };
  return (
    <Modal
      title="Canvas Size"
      onClose={close}
      width={400}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void resizeCanvas(doc, nw, nh, ax, ay, extColor());
            }}
          >
            OK
          </Button>
        </>
      }
    >
      <div className="faint">
        Current: {doc.width} × {doc.height} px → New: {nw} × {nh} px
      </div>
      <Row label="Width">
        <NumberField value={w} min={rel ? -doc.width + 1 : 1} max={16384} suffix=" px" onChange={setW} width={100} />
      </Row>
      <Row label="Height">
        <NumberField value={h} min={rel ? -doc.height + 1 : 1} max={16384} suffix=" px" onChange={setH} width={100} />
      </Row>
      <Row label="">
        <Checkbox
          checked={rel}
          onChange={(v) => {
            setRel(v);
            setW(v ? 0 : doc.width);
            setH(v ? 0 : doc.height);
          }}
        >
          Relative
        </Checkbox>
      </Row>
      <Row label="Anchor">
        <div className="ed-anchor">
          {[0, 0.5, 1].map((y) =>
            [0, 0.5, 1].map((x) => (
              <button
                key={`${x}${y}`}
                type="button"
                className={x === ax && y === ay ? 'active' : ''}
                onClick={() => {
                  setAx(x);
                  setAy(y);
                }}
              />
            )),
          )}
        </div>
      </Row>
      <Row label="Extension color">
        <Select
          value={ext}
          options={[
            { value: 'transparent', label: 'Transparent' },
            { value: 'bg', label: 'Background' },
            { value: 'fg', label: 'Foreground' },
            { value: 'white', label: 'White' },
            { value: 'black', label: 'Black' },
            { value: 'custom', label: 'Other…' },
          ]}
          onChange={setExt}
        />
        {ext === 'custom' && <ColorSwatch value={custom} alpha={false} onChange={setCustom} />}
      </Row>
    </Modal>
  );
}

export function canvasSizeDialog(doc: Doc) {
  return openDialog((close) => <CanvasSizeBody doc={doc} close={() => close()} />);
}

// ---------------------------------------------------------------------------------------------
// Export As

function ExportBody({ doc, close }: { doc: Doc; close: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState(90);
  const [scale, setScale] = useState(100);
  const w = Math.max(1, Math.round((doc.width * scale) / 100));
  const h = Math.max(1, Math.round((doc.height * scale) / 100));
  return (
    <Modal
      title="Export As"
      onClose={close}
      width={400}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void exportDoc(doc, { format, quality, width: w, height: h });
            }}
          >
            Export…
          </Button>
        </>
      }
    >
      <Row label="Format">
        <Select
          value={format}
          options={[
            { value: 'png', label: 'PNG (lossless, transparency)' },
            { value: 'jpeg', label: 'JPEG' },
            { value: 'webp', label: 'WebP' },
          ]}
          onChange={setFormat}
        />
      </Row>
      {format !== 'png' && <Slider label="Quality" value={quality} min={1} max={100} onChange={setQuality} defaultValue={90} />}
      <Slider label="Scale" value={scale} min={5} max={400} onChange={setScale} defaultValue={100} suffix="%" curve="pow2" />
      <div className="faint">
        {w} × {h} px{format === 'jpeg' ? ' · transparency becomes white' : ''}
      </div>
    </Modal>
  );
}

export function exportDialog(doc: Doc) {
  return openDialog((close) => <ExportBody doc={doc} close={() => close()} />);
}
