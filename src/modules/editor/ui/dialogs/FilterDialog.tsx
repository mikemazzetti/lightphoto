import { useEffect, useMemo, useState } from 'react';
import { openDialog } from '@/state/app';
import { Checkbox, Select, Slider } from '@/ui/controls';
import type { Doc } from '../../model/doc';
import { edState } from '../../model/store';
import { defaultFilterParams, FilterContext, FilterDef } from '../../render/filters';
import { PreviewSession, ProcessFn } from '../../ops/process';
import { FloatingDialog } from './FloatingDialog';

/** Last applied filter (Filter ▸ Last Filter). */
export let lastFilter: { def: FilterDef; params: Record<string, number> } | null = null;

const savedParams = new Map<string, Record<string, number>>();

function filterContext(): FilterContext {
  const s = edState();
  return { fg: [s.fg.r / 255, s.fg.g / 255, s.fg.b / 255], bg: [s.bg.r / 255, s.bg.g / 255, s.bg.b / 255], seed: Math.random() * 100 };
}

const processFor =
  (f: FilterDef, p: Record<string, number>, ctx: FilterContext): ProcessFn =>
  (c, src, w, h) =>
    f.run(c, src, w, h, p, ctx);

function Body({ session, f, close }: { session: PreviewSession; f: FilterDef; close: () => void }) {
  const [p, setP] = useState<Record<string, number>>(() => ({ ...defaultFilterParams(f), ...(savedParams.get(f.id) ?? {}) }));
  const [preview, setPreview] = useState(true);
  const [ctx] = useState(filterContext);
  const key = useMemo(() => JSON.stringify(p), [p]);
  useEffect(() => {
    session.update(key, processFor(f, p, ctx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <FloatingDialog
      title={f.label.replace('…', '')}
      onOk={() => {
        savedParams.set(f.id, p);
        lastFilter = { def: f, params: p };
        session.apply(processFor(f, p, ctx));
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
    >
      {f.params.map((d) =>
        d.kind === 'select' ? (
          <div key={d.key} className="row">
            <span className="muted" style={{ width: 84 }}>
              {d.label}
            </span>
            <Select value={p[d.key]} options={d.options!} onChange={(v) => setP({ ...p, [d.key]: v })} />
          </div>
        ) : d.kind === 'check' ? (
          <Checkbox key={d.key} checked={!!p[d.key]} onChange={(v) => setP({ ...p, [d.key]: v ? 1 : 0 })}>
            {d.label}
          </Checkbox>
        ) : (
          <Slider key={d.key} label={d.label} value={p[d.key]} min={d.min} max={d.max} step={d.step ?? 1} suffix={d.suffix} defaultValue={d.default} curve={d.curve} onChange={(v) => setP({ ...p, [d.key]: v })} />
        ),
      )}
    </FloatingDialog>
  );
}

export async function filterDialog(doc: Doc, f: FilterDef) {
  const session = await PreviewSession.start(doc, { label: f.label.replace('…', ''), keepAlpha: f.keepAlpha });
  if (!session) return;
  if (f.instant || !f.params.length) {
    const p = defaultFilterParams(f);
    lastFilter = { def: f, params: p };
    session.apply(processFor(f, p, filterContext()));
    return;
  }
  return openDialog((close) => <Body session={session} f={f} close={() => close()} />);
}

export async function repeatLastFilter(doc: Doc) {
  if (!lastFilter) return;
  const session = await PreviewSession.start(doc, { label: lastFilter.def.label.replace('…', ''), keepAlpha: lastFilter.def.keepAlpha });
  session?.apply(processFor(lastFilter.def, lastFilter.params, filterContext()));
}
