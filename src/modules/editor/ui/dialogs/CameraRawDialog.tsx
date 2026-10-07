import { useEffect, useMemo, useRef, useState } from 'react';
import { openDialog } from '@/state/app';
import { Button, GRADIENTS, Slider, Tabs } from '@/ui/controls';
import { DevelopEngine } from '@/core/develop/engine';
import type { Texture } from '@/core/gl/gl';
import { DevelopSettings, defaultSettings, PROFILES, Profile } from '@/core/develop/settings';
import type { Doc } from '../../model/doc';
import { requireCompositor } from '../../render/compositor';
import { withAlphaFrom } from '../../render/filters';
import { PreviewSession, ProcessFn } from '../../ops/process';
import { FloatingDialog } from './FloatingDialog';
import { Select } from '@/ui/controls';

type Tab = 'basic' | 'detail' | 'effects';

function Body({ session, close }: { session: PreviewSession; close: () => void }) {
  const [s, setS] = useState<DevelopSettings>(defaultSettings);
  const [tab, setTab] = useState<Tab>('basic');
  const [preview, setPreview] = useState(true);
  const engine = useRef<DevelopEngine | null>(null);
  /** Source the engine was last given (re-setting it rebuilds every engine pass). */
  const source = useRef<{ tex: Texture; version: number } | null>(null);
  const key = useMemo(() => JSON.stringify(s), [s]);

  const proc = (settings: DevelopSettings): ProcessFn => (c, src, w, h) => {
    // A frame rendered after the dialog closed gets a throwaway engine (nothing left to dispose it).
    const e = engine.current ?? new DevelopEngine(c.gl);
    try {
      const version = session.surface.version;
      if (e !== engine.current || source.current?.tex !== src || source.current.version !== version) {
        e.setSourceTexture(src, true);
        if (e === engine.current) source.current = { tex: src, version };
      }
      const rt = e.render(settings, w, h);
      return withAlphaFrom(c, rt, src, w, h);
    } finally {
      if (e !== engine.current) e.dispose();
    }
  };

  useEffect(() => {
    engine.current = new DevelopEngine(requireCompositor().gl);
    return () => {
      engine.current?.dispose();
      engine.current = null;
      source.current = null;
    };
  }, []);
  useEffect(() => {
    session.update(key, proc(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const S = (label: string, k: keyof DevelopSettings, min: number, max: number, extra: Partial<React.ComponentProps<typeof Slider>> = {}) => (
    <Slider label={label} value={s[k] as number} min={min} max={max} labelWidth={92} onChange={(v) => setS({ ...s, [k]: v })} {...extra} />
  );
  const N = <K extends 'sharpening' | 'noise' | 'vignette' | 'grain'>(label: string, group: K, k: keyof DevelopSettings[K], min: number, max: number, extra: Partial<React.ComponentProps<typeof Slider>> = {}) => (
    <Slider label={label} value={(s[group] as any)[k]} min={min} max={max} labelWidth={92} onChange={(v) => setS({ ...s, [group]: { ...(s[group] as object), [k]: v } })} {...extra} />
  );

  return (
    <FloatingDialog
      title="Camera Raw Filter"
      width={360}
      onOk={() => {
        session.apply(proc(s));
        close();
      }}
      onCancel={() => {
        session.cancel();
        close();
      }}
      preview={preview}
      onPreview={(v) => {
        setPreview(v);
        session.setEnabled(v);
      }}
      extraButtons={
        <Button small onClick={() => setS(defaultSettings())}>
          Reset
        </Button>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'basic', label: 'Basic' },
          { id: 'detail', label: 'Detail' },
          { id: 'effects', label: 'Effects' },
        ]}
      />
      {tab === 'basic' && (
        <div className="col" style={{ gap: 2 }}>
          <div className="row">
            <span className="muted" style={{ width: 92 }}>
              Profile
            </span>
            <Select value={s.profile} options={PROFILES.map((p) => ({ value: p.id, label: p.label }))} onChange={(v: Profile) => setS({ ...s, profile: v })} />
          </div>
          <div className="panel-sub">White Balance</div>
          {S('Temperature', 'temperature', -100, 100, { gradient: GRADIENTS.temperature })}
          {S('Tint', 'tint', -100, 100, { gradient: GRADIENTS.tint })}
          <div className="panel-sub">Tone</div>
          {S('Exposure', 'exposure', -5, 5, { step: 0.01, signed: true })}
          {S('Contrast', 'contrast', -100, 100, { signed: true })}
          {S('Highlights', 'highlights', -100, 100, { signed: true })}
          {S('Shadows', 'shadows', -100, 100, { signed: true })}
          {S('Whites', 'whites', -100, 100, { signed: true })}
          {S('Blacks', 'blacks', -100, 100, { signed: true })}
          <div className="panel-sub">Presence</div>
          {S('Texture', 'texture', -100, 100, { signed: true })}
          {S('Clarity', 'clarity', -100, 100, { signed: true })}
          {S('Dehaze', 'dehaze', -100, 100, { signed: true })}
          {S('Vibrance', 'vibrance', -100, 100, { signed: true, gradient: GRADIENTS.saturation })}
          {S('Saturation', 'saturation', -100, 100, { signed: true, gradient: GRADIENTS.saturation })}
        </div>
      )}
      {tab === 'detail' && (
        <div className="col" style={{ gap: 2 }}>
          <div className="panel-sub">Sharpening</div>
          {N('Amount', 'sharpening', 'amount', 0, 150)}
          {N('Radius', 'sharpening', 'radius', 0.5, 3, { step: 0.1, defaultValue: 1 })}
          {N('Detail', 'sharpening', 'detail', 0, 100, { defaultValue: 25 })}
          {N('Masking', 'sharpening', 'masking', 0, 100)}
          <div className="panel-sub">Noise Reduction</div>
          {N('Luminance', 'noise', 'luminance', 0, 100)}
          {N('Color', 'noise', 'color', 0, 100)}
        </div>
      )}
      {tab === 'effects' && (
        <div className="col" style={{ gap: 2 }}>
          <div className="panel-sub">Vignette</div>
          {N('Amount', 'vignette', 'amount', -100, 100, { signed: true })}
          {N('Midpoint', 'vignette', 'midpoint', 0, 100, { defaultValue: 50 })}
          {N('Roundness', 'vignette', 'roundness', -100, 100)}
          {N('Feather', 'vignette', 'feather', 0, 100, { defaultValue: 50 })}
          <div className="panel-sub">Grain</div>
          {N('Amount', 'grain', 'amount', 0, 100)}
          {N('Size', 'grain', 'size', 0, 100, { defaultValue: 25 })}
          {N('Roughness', 'grain', 'roughness', 0, 100, { defaultValue: 50 })}
        </div>
      )}
    </FloatingDialog>
  );
}

export async function cameraRawDialog(doc: Doc) {
  requireCompositor();
  const session = await PreviewSession.start(doc, { label: 'Camera Raw Filter', keepAlpha: true });
  if (!session) return;
  return openDialog((close) => <Body session={session} close={() => close()} />);
}
