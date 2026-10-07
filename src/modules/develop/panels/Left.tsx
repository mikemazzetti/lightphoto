import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SETTING_GROUP_LABELS, SETTING_GROUPS, SettingGroup } from '@/core/develop/settings';
import { openContextMenu, openDialog, toast } from '@/state/app';
import { deletePreset, savePreset, useCatalog, UserPreset } from '@/state/catalog';
import { Button, Checkbox, cx } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { confirmDialog, Modal, promptDialog } from '@/ui/overlays';
import { getController, navBus, NavRect } from '../controller';
import { applyPreset, BUILTIN_GROUPS, BUILTIN_PRESETS, pickGroups } from '../presets';
import {
  addSnapshot,
  clearHistory,
  deleteSnapshot,
  editCommit,
  gotoHistory,
  historyOf,
  renameSnapshot,
  setPanelOpen,
  setPreview,
  Snapshot,
  updateSnapshot,
  useDevelop,
} from '../store';
import { DPanel } from '../ui';

// ---------------------------------------------------------------------------------------------
// Navigator

export function NavigatorPanel() {
  const zoomMode = useDevelop((s) => s.zoomMode);
  const zoomPct = useDevelop((s) => s.zoomPct);
  const zoomBtn = (label: string, active: boolean, fn: () => void, title: string) => (
    <button type="button" className={cx('dv-zoomlink', active && 'active')} onClick={fn} title={title}>
      {label}
    </button>
  );
  const c = () => getController();
  return (
    <DPanel
      id="navigator"
      title="Navigator"
      defaultOpen
      right={
        <span className="row" style={{ gap: 2 }}>
          {zoomBtn('Fit', zoomMode === 'fit', () => c()?.applyZoomMode('fit'), 'Fit (⌘0)')}
          {zoomBtn('Fill', zoomMode === 'fill', () => c()?.applyZoomMode('fill'), 'Fill the view')}
          {zoomBtn('1:1', zoomMode === '100', () => c()?.applyZoomMode('100'), 'Actual pixels (⌘1)')}
          {zoomMode === 'custom' && <span className="dv-zoomlink active">{Math.round(zoomPct)}%</span>}
        </span>
      }
    >
      <NavigatorView />
    </DPanel>
  );
}

/** Mounted only while the panel is open. Draws from the navigator bus (no React re-render per frame). */
function NavigatorView() {
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLCanvasElement | null>(null);
  const rect = useRef<NavRect | null>(null);
  const [width, setWidth] = useState(226);
  const [aspect, setAspect] = useState(1.5);
  const height = Math.round(Math.min(180, Math.max(80, width / aspect)));

  const draw = () => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(width * dpr);
    const H = Math.round(height * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const src = img.current;
    if (!src) return;
    const k = Math.min(width / src.width, height / src.height);
    const w = src.width * k;
    const h = src.height * k;
    const x = (width - w) / 2;
    const y = (height - h) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, x, y, w, h);
    const r = rect.current;
    if (r && (r.w < 0.999 || r.h < 0.999)) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.rect(x + r.x * w, y + r.y * h, r.w * w, r.h * h);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + r.x * w + 0.75, y + r.y * h + 0.75, Math.max(2, r.w * w - 1.5), Math.max(2, r.h * h - 1.5));
    }
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useLayoutEffect(() => {
    const el = boxRef.current!;
    const ro = new ResizeObserver(() => setWidth(Math.max(80, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () =>
      navBus.subscribe({
        image: (data) => {
          let c = img.current;
          if (!c) c = img.current = document.createElement('canvas');
          c.width = data.width;
          c.height = data.height;
          c.getContext('2d')!.putImageData(data, 0, 0);
          setAspect(data.width / Math.max(1, data.height));
          drawRef.current();
        },
        rect: (r) => {
          rect.current = r;
          drawRef.current();
        },
      }),
    [],
  );
  useEffect(() => draw());

  const toNorm = (e: { clientX: number; clientY: number }) => {
    const src = img.current;
    const c = ref.current!;
    if (!src) return null;
    const b = c.getBoundingClientRect();
    const k = Math.min(width / src.width, height / src.height);
    const w = src.width * k;
    const h = src.height * k;
    return [(e.clientX - b.left - (width - w) / 2) / w, (e.clientY - b.top - (height - h) / 2) / h] as const;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const ctl = getController();
    if (!ctl || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const go = (ev: { clientX: number; clientY: number }) => {
      const p = toNorm(ev);
      if (p) ctl.panToNormalized(Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1])));
    };
    // Clicking while fitted zooms to 100% at that point (Lightroom behaviour).
    if (ctl.view.scale <= ctl.fitScale('fit') * 1.02) {
      ctl.applyZoomMode('100');
    }
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div ref={boxRef} className="dv-nav" style={{ height }}>
      <canvas ref={ref} style={{ width, height, display: 'block', cursor: 'crosshair' }} onPointerDown={onPointerDown} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Group checklist (Copy settings / Create preset)

const ALL_GROUPS = Object.keys(SETTING_GROUPS) as SettingGroup[];
let lastCopyGroups: SettingGroup[] = ALL_GROUPS.filter((g) => g !== 'geometry' && g !== 'masks');

function GroupChecklist({ value, onChange }: { value: SettingGroup[]; onChange: (v: SettingGroup[]) => void }) {
  return (
    <div className="dv-checklist">
      <div className="row" style={{ gap: 6, marginBottom: 4 }}>
        <Button small variant="ghost" onClick={() => onChange(ALL_GROUPS)}>
          Check All
        </Button>
        <Button small variant="ghost" onClick={() => onChange([])}>
          Check None
        </Button>
      </div>
      <div className="dv-checkgrid">
        {ALL_GROUPS.map((g) => (
          <Checkbox key={g} checked={value.includes(g)} onChange={(on) => onChange(on ? [...value, g] : value.filter((x) => x !== g))}>
            {SETTING_GROUP_LABELS[g]}
          </Checkbox>
        ))}
      </div>
    </div>
  );
}

function CopyDialog({ close }: { close: (v?: SettingGroup[] | null) => void }) {
  const [groups, setGroups] = useState<SettingGroup[]>(lastCopyGroups);
  return (
    <Modal
      title="Copy Settings"
      onClose={() => close(null)}
      width={460}
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" disabled={!groups.length} onClick={() => close(groups)}>
            Copy
          </Button>
        </>
      }
    >
      <div className="muted">Choose which settings to put on the clipboard. Paste with ⇧⌘V (here or on other photos).</div>
      <GroupChecklist value={groups} onChange={setGroups} />
    </Modal>
  );
}

export async function copySettingsDialog() {
  const s = useDevelop.getState().settings;
  if (!s) return;
  const groups = await openDialog<SettingGroup[] | null>((close) => <CopyDialog close={close} />);
  if (!groups || !groups.length) return;
  lastCopyGroups = groups;
  const cur = useDevelop.getState().settings ?? s;
  useCatalog.setState({ clipboard: pickGroups(cur, groups) });
  toast(`Copied ${groups.length} setting group${groups.length === 1 ? '' : 's'}`, 'success');
}

function CreatePresetDialog({ close, groupsInUse }: { close: (v?: { name: string; group: string; groups: SettingGroup[] } | null) => void; groupsInUse: string[] }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState(groupsInUse[0] ?? 'User Presets');
  const [groups, setGroups] = useState<SettingGroup[]>(ALL_GROUPS.filter((g) => g !== 'geometry' && g !== 'masks'));
  const ok = name.trim() && groups.length;
  return (
    <Modal
      title="New Develop Preset"
      onClose={() => close(null)}
      width={480}
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={() => close({ name: name.trim(), group: group.trim() || 'User Presets', groups })}>
            Create
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Preset Name</label>
        <input className="input" autoFocus value={name} placeholder="My Look" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="field">
        <label>Group</label>
        <input className="input" list="dv-preset-groups" value={group} onChange={(e) => setGroup(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <datalist id="dv-preset-groups">
          {groupsInUse.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </div>
      <div className="panel-sub">Include</div>
      <GroupChecklist value={groups} onChange={setGroups} />
    </Modal>
  );
}

export async function createPresetDialog() {
  const s = useDevelop.getState().settings;
  if (!s) return;
  const groupsInUse = [...new Set(useCatalog.getState().presets.map((p) => p.group))];
  const r = await openDialog<{ name: string; group: string; groups: SettingGroup[] } | null>((close) => <CreatePresetDialog close={close} groupsInUse={groupsInUse.length ? groupsInUse : ['User Presets']} />);
  if (!r) return;
  savePreset(r.name, r.group, pickGroups(useDevelop.getState().settings ?? s, r.groups));
  toast(`Preset “${r.name}” created`, 'success');
}

// ---------------------------------------------------------------------------------------------
// Presets

interface PresetItem {
  id: string;
  name: string;
  group: string;
  settings: UserPreset['settings'];
  user: boolean;
}

function previewPreset(p: PresetItem | null) {
  const s = useDevelop.getState().settings;
  if (!p || !s) return setPreview(null);
  setPreview(applyPreset(s, p.settings), p.name);
}

function applyPresetItem(p: PresetItem) {
  setPreview(null);
  editCommit((s) => applyPreset(s, p.settings), `Preset: ${p.name}`);
}

export function PresetsPanel() {
  const userPresets = useCatalog((s) => s.presets);
  const filter = useDevelop((s) => s.presetFilter);
  const panels = useDevelop((s) => s.panels);
  const groups = useMemo(() => {
    const items: PresetItem[] = [...BUILTIN_PRESETS.map((p) => ({ ...p, user: false })), ...userPresets.map((p) => ({ ...p, user: true }))];
    const q = filter.trim().toLowerCase();
    const names = [...new Set([...userPresets.map((p) => p.group || 'User Presets'), ...BUILTIN_GROUPS])];
    return names
      .map((g) => ({ name: g, user: !BUILTIN_GROUPS.includes(g), items: items.filter((p) => (p.group || 'User Presets') === g && (!q || p.name.toLowerCase().includes(q))) }))
      .filter((g) => g.items.length);
  }, [userPresets, filter]);

  useEffect(() => () => setPreview(null), []);

  const menu = (e: React.MouseEvent, p: PresetItem) =>
    openContextMenu(e, [
      { label: 'Apply', onClick: () => applyPresetItem(p) },
      ...(p.user
        ? [
            { separator: true },
            {
              label: 'Delete Preset…',
              danger: true,
              onClick: async () => {
                if (await confirmDialog(`Delete the preset “${p.name}”?`, { ok: 'Delete', danger: true })) deletePreset(p.id);
              },
            },
          ]
        : []),
    ]);

  return (
    <DPanel
      id="presets"
      title="Presets"
      defaultOpen
      right={
        <button type="button" className="dv-reset" title="Create preset from current settings…" onClick={() => void createPresetDialog()}>
          <Icon name="plus" size={13} />
        </button>
      }
    >
      <input className="input dv-search" placeholder="Filter presets" value={filter} onChange={(e) => useDevelop.setState({ presetFilter: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      <div className="dv-list" onMouseLeave={() => previewPreset(null)}>
        {groups.map((g) => {
          const key = `pg:${g.name}`;
          const open = filter ? true : panels[key] ?? (g.user || g.name === 'Color');
          return (
            <div key={g.name}>
              <div className="dv-group" onClick={() => setPanelOpen(key, !open)}>
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
                <Icon name="folder" size={12} />
                <span className="grow ellipsis">{g.name}</span>
                <span className="faint">{g.items.length}</span>
              </div>
              {open &&
                g.items.map((p) => (
                  <div
                    key={p.id}
                    className="dv-item indent"
                    onMouseEnter={() => previewPreset(p)}
                    onClick={() => applyPresetItem(p)}
                    onContextMenu={(e) => menu(e, p)}
                    title={p.user ? 'Click to apply · right-click for options' : 'Click to apply (hover previews)'}
                  >
                    <span className="grow ellipsis">{p.name}</span>
                    {p.user && <Icon name="star" size={10} style={{ opacity: 0.4 }} />}
                  </div>
                ))}
            </div>
          );
        })}
        {!groups.length && <div className="faint dv-hint">No presets match.</div>}
      </div>
    </DPanel>
  );
}

// ---------------------------------------------------------------------------------------------
// Snapshots

const EMPTY_SNAPS: Snapshot[] = [];

export function SnapshotsPanel() {
  const photoId = useDevelop((s) => s.photoId);
  const snaps = useDevelop((s) => (photoId ? s.snapshots[photoId] ?? EMPTY_SNAPS : EMPTY_SNAPS));
  useEffect(() => () => setPreview(null), []);
  const add = async () => {
    const name = await promptDialog('New Snapshot', new Date().toLocaleString(), { label: 'Snapshot name' });
    if (name !== null) addSnapshot(name.trim() || new Date().toLocaleString());
  };
  return (
    <DPanel
      id="snapshots"
      title="Snapshots"
      right={
        <button type="button" className="dv-reset" title="Create snapshot of the current settings" onClick={() => void add()}>
          <Icon name="plus" size={13} />
        </button>
      }
    >
      <div className="dv-list" onMouseLeave={() => setPreview(null)}>
        {snaps.map((sn) => (
          <div
            key={sn.id}
            className="dv-item"
            onMouseEnter={() => setPreview(sn.settings, sn.name)}
            onClick={() => {
              setPreview(null);
              editCommit(() => sn.settings, `Snapshot: ${sn.name}`);
            }}
            onContextMenu={(e) =>
              openContextMenu(e, [
                {
                  label: 'Apply',
                  onClick: () => {
                    setPreview(null);
                    editCommit(() => sn.settings, `Snapshot: ${sn.name}`);
                  },
                },
                { label: 'Update with Current Settings', onClick: () => updateSnapshot(sn.id) },
                {
                  label: 'Rename…',
                  onClick: async () => {
                    const n = await promptDialog('Rename Snapshot', sn.name);
                    if (n && n.trim()) renameSnapshot(sn.id, n.trim());
                  },
                },
                { separator: true },
                { label: 'Delete', danger: true, onClick: () => deleteSnapshot(sn.id) },
              ])
            }
          >
            <Icon name="image" size={12} style={{ opacity: 0.6 }} />
            <span className="grow ellipsis">{sn.name}</span>
          </div>
        ))}
        {!snaps.length && <div className="faint dv-hint">Save named versions of this photo’s settings with +.</div>}
      </div>
    </DPanel>
  );
}

// ---------------------------------------------------------------------------------------------
// History

export function HistoryPanel() {
  const photoId = useDevelop((s) => s.photoId);
  useDevelop((s) => s.historyTick);
  const h = historyOf(photoId);
  useEffect(() => () => setPreview(null), []);
  const entries = h ? h.entries.map((e, i) => ({ ...e, i })).reverse() : [];
  return (
    <DPanel
      id="history"
      title="History"
      defaultOpen
      right={
        <button
          type="button"
          className="dv-reset"
          title="Clear history"
          disabled={!h || h.entries.length < 2}
          onClick={async () => {
            if (await confirmDialog('Clear the history of this photo? The current settings are kept.', { ok: 'Clear', danger: true })) clearHistory();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      }
    >
      <div className="dv-list dv-history" onMouseLeave={() => setPreview(null)}>
        {entries.map((e) => (
          <div
            key={`${e.i}-${e.time}`}
            className={cx('dv-item', e.i === h!.index && 'active', e.i > h!.index && 'future')}
            onMouseEnter={() => (e.i !== h!.index ? setPreview(e.state, e.label) : setPreview(null))}
            onClick={() => gotoHistory(e.i)}
            title={new Date(e.time).toLocaleTimeString()}
          >
            <span className="grow ellipsis">{e.label}</span>
          </div>
        ))}
      </div>
    </DPanel>
  );
}
