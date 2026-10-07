import { useState } from 'react';
import { api } from '@/platform/api';
import { SETTING_GROUP_LABELS, SETTING_GROUPS, SettingGroup } from '@/core/develop/settings';
import type { ExportFormat } from '@/core/image/encode';
import { openDialog, toast } from '@/state/app';
import { Button, Checkbox, Select, SegmentedControl, Slider, Switch } from '@/ui/controls';
import { Modal } from '@/ui/overlays';
import { exampleName, isExporting, runExport } from './exporter';
import { ExportPrefs, useLibraryUI } from './store';
import { plural } from './util';

const GROUPS = Object.keys(SETTING_GROUPS) as SettingGroup[];

/** Lets the user choose which develop setting groups to copy / sync. Resolves null on cancel. */
export function chooseGroups(title: string, okLabel: string, note?: string): Promise<SettingGroup[] | null> {
  return openDialog<SettingGroup[] | null>((close) => <GroupsBody title={title} okLabel={okLabel} note={note} close={close} />).then((v) => v ?? null);
}

function GroupsBody({ title, okLabel, note, close }: { title: string; okLabel: string; note?: string; close: (v?: SettingGroup[] | null) => void }) {
  const [sel, setSel] = useState<Set<SettingGroup>>(() => new Set(useLibraryUI.getState().copyGroups));
  const toggle = (g: SettingGroup, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(g);
      else n.delete(g);
      return n;
    });
  const ok = () => {
    const groups = GROUPS.filter((g) => sel.has(g));
    if (!groups.length) return toast('Choose at least one group.', 'warn');
    useLibraryUI.setState({ copyGroups: groups });
    close(groups);
  };
  return (
    <Modal
      title={title}
      width={440}
      onClose={() => close(null)}
      footer={
        <>
          <Button small onClick={() => setSel(new Set(GROUPS))}>
            Check All
          </Button>
          <Button small onClick={() => setSel(new Set())}>
            Check None
          </Button>
          <div className="spacer" />
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" onClick={ok}>
            {okLabel}
          </Button>
        </>
      }
    >
      {note && <div className="muted">{note}</div>}
      <div className="lib-groups">
        {GROUPS.map((g) => (
          <Checkbox key={g} checked={sel.has(g)} onChange={(v) => toggle(g, v)}>
            {SETTING_GROUP_LABELS[g]}
          </Checkbox>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

let exportOpen = false;

export function openExportDialog(ids: string[]) {
  if (!ids.length) return toast('Select photos to export.');
  if (exportOpen) return;
  if (isExporting()) return toast('An export is already running.', 'warn');
  exportOpen = true;
  void openDialog<ExportPrefs | null>((close) => <ExportBody ids={ids} close={close} />).then((prefs) => {
    exportOpen = false;
    if (prefs) void runExport(ids, prefs);
  });
}

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
];

const SIZES = [0, 1080, 1600, 2048, 2560, 3840];

function ExportBody({ ids, close }: { ids: string[]; close: (v?: ExportPrefs | null) => void }) {
  const [o, setO] = useState<ExportPrefs>(() => useLibraryUI.getState().exportPrefs);
  const set = (patch: Partial<ExportPrefs>) => setO((x) => ({ ...x, ...patch }));
  const needDir = api.isElectron;
  const chooseDir = async () => {
    const d = await api.openFolder('Export To');
    if (d) set({ dir: d });
  };
  const go = () => {
    if (needDir && !o.dir) return toast('Choose an output folder.', 'warn');
    useLibraryUI.setState({ exportPrefs: o });
    close(o);
  };
  const lossy = o.format !== 'png';
  return (
    <Modal
      title={`Export ${plural(ids.length, 'Photo')}`}
      width={520}
      onClose={() => close(null)}
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" icon="export" onClick={go}>
            Export
          </Button>
        </>
      }
    >
      <div className="panel-sub">Export location</div>
      {needDir ? (
        <div className="field">
          <label>Folder</label>
          <div className="row">
            <div className="input grow ellipsis lib-pathbox" title={o.dir} style={{ direction: 'rtl', textAlign: 'left' }}>
              {o.dir || 'Not chosen'}
            </div>
            <Button small onClick={chooseDir}>
              Choose…
            </Button>
          </div>
        </div>
      ) : (
        <div className="muted">Files are saved through your browser’s downloads.</div>
      )}
      <div className="field">
        <label>If file exists</label>
        <Select
          value={o.onExists}
          onChange={(v) => set({ onExists: v })}
          options={[
            { value: 'suffix', label: 'Choose a new name' },
            { value: 'overwrite', label: 'Overwrite' },
            { value: 'skip', label: 'Skip' },
          ]}
        />
      </div>

      <div className="panel-sub">File naming</div>
      <div className="field">
        <label>Template</label>
        <input className="input" value={o.template} spellCheck={false} onChange={(e) => set({ template: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="field">
        <label />
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {['{name}', '{seq}', '{date}'].map((t) => (
            <button key={t} type="button" className="btn small ghost mono" onClick={() => set({ template: (o.template + (o.template && !o.template.endsWith('-') && !o.template.endsWith('_') ? '_' : '') + t).trim() })}>
              {t}
            </button>
          ))}
          <span className="faint ellipsis" style={{ marginLeft: 'auto', maxWidth: 220 }} title={exampleName(ids, o)}>
            e.g. {exampleName(ids, o)}
          </span>
        </div>
      </div>

      <div className="panel-sub">File settings</div>
      <div className="field">
        <label>Format</label>
        <SegmentedControl value={o.format} onChange={(v) => set({ format: v })} options={FORMATS} />
      </div>
      {lossy && (
        <Slider label="Quality" labelWidth={96} value={o.quality} min={10} max={100} defaultValue={90} onChange={(v) => set({ quality: v })} />
      )}

      <div className="panel-sub">Image sizing</div>
      <div className="field">
        <label>Long edge</label>
        <div className="row">
          <input
            className="input mono"
            type="number"
            min={0}
            step={1}
            style={{ width: 90 }}
            value={o.longEdge}
            onChange={(e) => set({ longEdge: Math.max(0, Math.round(+e.target.value || 0)) })}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <span className="faint">px</span>
          <Select value={SIZES.includes(o.longEdge) ? o.longEdge : -1} onChange={(v) => v >= 0 && set({ longEdge: v })} options={[...SIZES.map((s) => ({ value: s, label: s ? `${s} px` : 'Original size' })), ...(SIZES.includes(o.longEdge) ? [] : [{ value: -1, label: 'Custom' }])]} />
        </div>
      </div>

      <div className="panel-sub">Develop</div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">Include develop edits (RAW files are always rendered)</span>
        <Switch on={o.includeEdits} onChange={(v) => set({ includeEdits: v })} />
      </div>
    </Modal>
  );
}
