import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api, FILTERS, kindOf } from '@/platform/api';
import { MenuItem, openContextMenu, openMenu } from '@/state/app';
import { cx } from '@/ui/controls';
import { Icon, IconName } from '@/ui/Icon';
import { promptDialog } from '@/ui/overlays';
import { ColorPickerBody } from '@/ui/ColorPicker';
import { hexToRgba, rgbaToHex } from '@/core/util/color';
import { openDialog } from '@/state/app';
import { Button } from '@/ui/controls';
import { Modal } from '@/ui/overlays';
import { formatDuration, secondsTimecode } from '../model/time';
import { FX_LABELS, FxType, MediaItem, TRANSITION_LABELS, TransitionType } from '../model/types';
import { importPaths, posters, relinkMedia } from '../engine/media';
import { renderTitle } from '../engine/titles';
import * as A from '../state/actions';
import { edit, getState, gotoHistory, history, useVideo } from '../state/store';
import { transport } from '../state/transport';
import { DND_MIME, setDragPayload } from '../timeline/dnd';
import { openSequenceSettings } from './dialogs';

const KIND_ICON: Record<MediaItem['kind'], IconName> = { video: 'film', audio: 'music', image: 'image', title: 'title', matte: 'color', adjustment: 'adjust' };
const KIND_COLOR: Record<MediaItem['kind'], string> = { video: '#6c74d8', audio: '#3c9a68', image: '#8d6bd0', title: '#cf5f95', matte: '#7d7d84', adjustment: '#b58a3a' };

export async function importDialog() {
  const paths = await api.openFiles({ title: 'Import Media', filters: [FILTERS.media, FILTERS.video, FILTERS.audio, FILTERS.images], multi: true });
  if (paths.length) await importPaths(paths);
}

function pickColor(initial: string): Promise<string | null> {
  return openDialog<string | null>((close) => <ColorDialog initial={initial} close={close} />).then((v) => v ?? null);
}

function ColorDialog({ initial, close }: { initial: string; close: (v: string | null) => void }) {
  const [c, setC] = useState(hexToRgba(initial));
  return (
    <Modal
      title="Color Matte"
      onClose={() => close(null)}
      width={280}
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => close(rgbaToHex(c))}>
            OK
          </Button>
        </>
      }
    >
      <ColorPickerBody value={c} onChange={setC} alpha={false} />
    </Modal>
  );
}

export function newItemMenu(x: number, y: number) {
  openMenu(x, y, [
    { label: 'Sequence Settings…', onClick: () => void openSequenceSettings() },
    { separator: true },
    { label: 'Title', onClick: () => A.newGeneratedItem('title') },
    {
      label: 'Color Matte…',
      onClick: async () => {
        const c = await pickColor('#2a2a2e');
        if (c) A.newGeneratedItem('matte', c);
      },
    },
    { label: 'Black Video', onClick: () => A.newGeneratedItem('matte', '#000000') },
    { label: 'Adjustment Layer', onClick: () => A.newGeneratedItem('adjustment') },
  ]);
}

const PosterCanvas = memo(function PosterCanvas({ item, w, h, version }: { item: MediaItem; w: number; h: number; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#121214';
    ctx.fillRect(0, 0, w, h);
    const fit = (bw: number, bh: number) => {
      const k = Math.min(w / bw, h / bh);
      return [(w - bw * k) / 2, (h - bh * k) / 2, bw * k, bh * k] as const;
    };
    if (item.kind === 'matte') {
      ctx.fillStyle = item.color ?? '#000';
      ctx.fillRect(0, 0, w, h);
    } else if (item.kind === 'title' && item.title) {
      const seq = getState().project.seq;
      const tw = Math.round(w * 2);
      const th = Math.round((tw * seq.height) / seq.width);
      const src = renderTitle(item.title, tw, th);
      const [x, y, ww, hh] = fit(tw, th);
      ctx.drawImage(src as CanvasImageSource, x, y, ww, hh);
    } else {
      const b = posters.get(item.id);
      if (b) {
        const [x, y, ww, hh] = fit(b.width, b.height);
        ctx.drawImage(b, x, y, ww, hh);
      }
    }
  }, [item, w, h, version]);
  return <canvas ref={ref} style={{ width: w, height: h, display: 'block' }} />;
});

export function ProjectPanel() {
  const media = useVideo((s) => s.project.media);
  const clips = useVideo((s) => s.project.seq.clips);
  const view = useVideo((s) => s.binView);
  const filter = useVideo((s) => s.binFilter);
  const sel = useVideo((s) => s.binSelection);
  const version = useVideo((s) => s.mediaVersion);
  const projectName = useVideo((s) => s.project.name);
  const [dropping, setDropping] = useState(false);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clips) m.set(c.mediaId, (m.get(c.mediaId) ?? 0) + 1);
    return m;
  }, [clips]);
  const items = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? media.filter((m) => m.name.toLowerCase().includes(f)) : media;
  }, [media, filter]);

  const select = (id: string, e: React.MouseEvent) => {
    const s = getState().binSelection;
    if (e.metaKey || e.ctrlKey) useVideo.setState({ binSelection: s.includes(id) ? s.filter((x) => x !== id) : [...s, id] });
    else if (e.shiftKey && s.length) {
      const ids = items.map((m) => m.id);
      const a = ids.indexOf(s[s.length - 1]);
      const b = ids.indexOf(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      useVideo.setState({ binSelection: [...new Set([...s, ...ids.slice(lo, hi + 1)])] });
    } else useVideo.setState({ binSelection: [id] });
  };

  const open = (m: MediaItem) => {
    if (m.kind === 'adjustment') return;
    useVideo.setState({ sourceId: m.id, topLeftTab: 'source', focus: 'source' });
  };

  const onDragStart = (e: React.DragEvent, m: MediaItem) => {
    const s = getState().binSelection;
    const ids = s.includes(m.id) ? items.filter((x) => s.includes(x.id)).map((x) => x.id) : [m.id];
    if (!s.includes(m.id)) useVideo.setState({ binSelection: [m.id] });
    setDragPayload({ kind: 'media', ids });
    e.dataTransfer.setData(DND_MIME, ids.join(','));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const menu = (e: React.MouseEvent, m: MediaItem | null) => {
    if (m && !getState().binSelection.includes(m.id)) useVideo.setState({ binSelection: [m.id] });
    const ids = m ? (getState().binSelection.length ? getState().binSelection : [m.id]) : [];
    const lookup = new Map(media.map((x) => [x.id, x]));
    const sel = ids.map((id) => lookup.get(id)).filter((x): x is MediaItem => !!x);
    const items: MenuItem[] = m
      ? [
          { label: 'Open in Source Monitor', disabled: m.kind === 'adjustment', onClick: () => open(m) },
          { label: 'Insert at Playhead', shortcut: ',', onClick: () => void A.placeMedia(sel.map((x) => ({ media: x })), transport.frameInt, 'insert', { movePlayhead: true }) },
          { label: 'Overwrite at Playhead', shortcut: '.', onClick: () => void A.placeMedia(sel.map((x) => ({ media: x })), transport.frameInt, 'overwrite', { movePlayhead: true }) },
          { separator: true },
          {
            label: 'Rename…',
            onClick: async () => {
              const n = await promptDialog('Rename', m.name);
              if (n) A.renameMedia(m.id, n);
            },
          },
          ...(m.kind === 'matte'
            ? [
                {
                  label: 'Change Color…',
                  onClick: async () => {
                    const c = await pickColor(m.color ?? '#000000');
                    if (c) edit('Matte Color', (p) => ({ ...p, media: p.media.map((x) => (x.id === m.id ? { ...x, color: c } : x)) }));
                  },
                },
              ]
            : []),
          ...(m.path
            ? [
                {
                  label: m.missing ? 'Link Media…' : 'Replace Footage…',
                  onClick: async () => {
                    const p = await api.openFiles({ title: `Locate ${m.name}`, filters: [FILTERS.media], multi: false });
                    if (p[0]) await relinkMedia(m.id, p[0]);
                  },
                },
                ...(api.isElectron ? [{ label: api.isMac ? 'Reveal in Finder' : 'Show in Explorer', onClick: () => api.reveal(m.path!) }] : []),
              ]
            : []),
          { separator: true },
          { label: 'Clear', danger: true, shortcut: '⌫', onClick: () => void A.removeMedia(ids) },
        ]
      : [
          { label: 'Import…', onClick: () => void importDialog() },
          { label: 'New Title', onClick: () => A.newGeneratedItem('title') },
          { label: 'New Color Matte…', onClick: async () => {
            const c = await pickColor('#2a2a2e');
            if (c) A.newGeneratedItem('matte', c);
          } },
          { label: 'New Adjustment Layer', onClick: () => A.newGeneratedItem('adjustment') },
          { separator: true },
          { label: 'Sequence Settings…', onClick: () => void openSequenceSettings() },
        ];
    openContextMenu(e, items);
  };

  const onDrop = async (e: React.DragEvent) => {
    setDropping(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    await importPaths(files.map((f) => api.pathForFile(f)).filter((p) => kindOf(p)));
  };

  const info = (m: MediaItem) => {
    if (m.kind === 'audio') return [m.sampleRate ? `${(m.sampleRate / 1000).toFixed(1)} kHz` : '', m.channels === 1 ? 'Mono' : m.channels ? 'Stereo' : ''].filter(Boolean).join(' · ');
    if (m.kind === 'adjustment' || m.kind === 'title' || m.kind === 'matte') return `${m.width}×${m.height}`;
    return m.width ? `${m.width}×${m.height}` : '';
  };

  return (
    <div
      className={cx('vid-bin', dropping && 'dropping')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => void onDrop(e)}
      onPointerDown={() => useVideo.setState({ focus: 'project' })}
    >
      <div className="vid-bin-bar">
        <span className="faint ellipsis" style={{ maxWidth: 120 }} title={projectName}>
          {projectName}
        </span>
        <span className="faint">· {media.length} items</span>
        <div className="spacer" />
        <input className="input vid-search" placeholder="Search" value={filter} onChange={(e) => useVideo.setState({ binFilter: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="vid-bin-list" onContextMenu={(e) => menu(e, null)} onClick={(e) => e.target === e.currentTarget && useVideo.setState({ binSelection: [] })}>
        {!media.length && (
          <div className="empty-state" style={{ position: 'relative', padding: 30 }}>
            <Icon name="import" size={28} />
            <p>Import media to start</p>
            <p className="faint">Drop video, audio or image files here, or use File › Import Media.</p>
            <button type="button" className="btn primary" onClick={() => void importDialog()}>
              Import…
            </button>
          </div>
        )}
        {view === 'list' ? (
          <table className="vid-bin-table">
            {items.length > 0 && (
              <thead>
                <tr>
                  <th style={{ width: '46%' }}>Name</th>
                  <th>Duration</th>
                  <th>Frame Rate</th>
                  <th>Media Info</th>
                </tr>
              </thead>
            )}
            <tbody>
              {items.map((m) => (
                <tr
                  key={m.id}
                  className={cx(sel.includes(m.id) && 'sel', m.missing && 'missing', m.id === getState().sourceId && 'src')}
                  draggable
                  onDragStart={(e) => onDragStart(e, m)}
                  onDragEnd={() => setDragPayload(null)}
                  onClick={(e) => select(m.id, e)}
                  onDoubleClick={() => open(m)}
                  onContextMenu={(e) => (e.stopPropagation(), menu(e, m))}
                >
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="vid-bin-kind" style={{ background: KIND_COLOR[m.kind] }} />
                      {m.kind === 'video' || m.kind === 'image' ? <PosterCanvas item={m} w={30} h={18} version={version} /> : <Icon name={KIND_ICON[m.kind]} size={13} />}
                      <span className="ellipsis" title={m.path ?? m.name}>
                        {m.name}
                      </span>
                      {usage.get(m.id) ? <span className="vid-bin-use" title="Used in sequence">{usage.get(m.id)}</span> : null}
                    </div>
                  </td>
                  <td className="mono">{m.duration ? secondsTimecode(m.duration, m.fps || 30) : '—'}</td>
                  <td className="mono">{m.fps ? `${m.fps} fps` : ''}</td>
                  <td className="faint">{info(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="vid-bin-grid">
            {items.map((m) => (
              <div
                key={m.id}
                className={cx('vid-bin-tile', sel.includes(m.id) && 'sel', m.missing && 'missing')}
                draggable
                onDragStart={(e) => onDragStart(e, m)}
                onDragEnd={() => setDragPayload(null)}
                onClick={(e) => select(m.id, e)}
                onDoubleClick={() => open(m)}
                onContextMenu={(e) => (e.stopPropagation(), menu(e, m))}
                title={m.path ?? m.name}
              >
                <div className="vid-bin-thumb">
                  {m.kind === 'audio' || m.kind === 'adjustment' ? (
                    <div className="vid-bin-icon" style={{ color: KIND_COLOR[m.kind] }}>
                      <Icon name={KIND_ICON[m.kind]} size={26} />
                    </div>
                  ) : (
                    <PosterCanvas item={m} w={124} h={70} version={version} />
                  )}
                  {m.duration > 0 && <span className="vid-bin-dur">{formatDuration(m.duration)}</span>}
                  {usage.get(m.id) ? <span className="vid-bin-use corner">{usage.get(m.id)}</span> : null}
                </div>
                <div className="vid-bin-name ellipsis">
                  <span className="vid-bin-kind" style={{ background: KIND_COLOR[m.kind] }} />
                  {m.name}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="vid-bin-foot">
        <button type="button" className={cx('icon-btn small', view === 'list' && 'active')} title="List view" onClick={() => useVideo.setState({ binView: 'list' })}>
          <Icon name="sort" size={13} />
        </button>
        <button type="button" className={cx('icon-btn small', view === 'grid' && 'active')} title="Icon view" onClick={() => useVideo.setState({ binView: 'grid' })}>
          <Icon name="grid" size={13} />
        </button>
        <div className="spacer" />
        <button type="button" className="icon-btn small" title="Import media…" onClick={() => void importDialog()}>
          <Icon name="import" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn small"
          title="New item"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            newItemMenu(r.left, r.top - 4 - 170);
          }}
        >
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="icon-btn small" title="Clear selected items" disabled={!sel.length} onClick={() => void A.removeMedia(sel)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const TRANSITION_GROUPS: { name: string; items: TransitionType[] }[] = [
  { name: 'Dissolve', items: ['crossDissolve', 'dipToBlack', 'dipToWhite'] },
  { name: 'Wipe', items: ['wipe'] },
  { name: 'Slide', items: ['slide', 'push'] },
];
const EFFECT_GROUPS: { name: string; items: (FxType | 'lumetri')[] }[] = [
  { name: 'Color Correction', items: ['lumetri', 'brightness', 'tint', 'bw'] },
  { name: 'Blur & Sharpen', items: ['blur', 'sharpen'] },
  { name: 'Transform', items: ['crop', 'hflip', 'vflip', 'mirror'] },
  { name: 'Stylize', items: ['invert', 'posterize'] },
];

export function EffectsPanel() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ vt: true, ve: true });
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const apply = (p: { kind: 'transition'; type: TransitionType } | { kind: 'effect'; type: FxType | 'lumetri' }) => {
    if (p.kind === 'transition') A.applyDefaultTransitions(p.type);
    else {
      const ids = getState().selection;
      if (!ids.length) return;
      A.addEffectToClips(ids, p.type);
      useVideo.setState({ topLeftTab: 'effectControls' });
    }
  };
  const item = (key: string, label: string, icon: IconName, p: { kind: 'transition'; type: TransitionType } | { kind: 'effect'; type: FxType | 'lumetri' }) =>
    match(label) && (
      <div
        key={key}
        className="vid-fx-item"
        draggable
        onDragStart={(e) => {
          setDragPayload(p);
          e.dataTransfer.setData(DND_MIME, key);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onDragEnd={() => setDragPayload(null)}
        onDoubleClick={() => apply(p)}
        title={p.kind === 'transition' ? 'Drag onto a clip edge or cut · double-click to apply to selected clips' : 'Drag onto a clip · double-click to apply to selected clips'}
      >
        <Icon name={icon} size={13} />
        {label}
      </div>
    );
  const folder = (id: string, name: string, children: React.ReactNode) => (
    <div key={id}>
      <div className="vid-fx-folder" onClick={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}>
        <Icon name={open[id] || q ? 'chevronDown' : 'chevronRight'} size={12} />
        <Icon name="folder" size={13} />
        {name}
      </div>
      {(open[id] || q) && <div className="vid-fx-children">{children}</div>}
    </div>
  );
  return (
    <div className="vid-bin" onPointerDown={() => useVideo.setState({ focus: 'effects' })}>
      <div className="vid-bin-bar">
        <input className="input vid-search" style={{ flex: 1 }} placeholder="Search effects" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="vid-bin-list vid-fx">
        {folder(
          'vt',
          'Video Transitions',
          TRANSITION_GROUPS.map((g) => folder('vt-' + g.name, g.name, g.items.map((t) => item(t, TRANSITION_LABELS[t], 'split', { kind: 'transition', type: t })))),
        )}
        {folder(
          've',
          'Video Effects',
          EFFECT_GROUPS.map((g) => folder('ve-' + g.name, g.name, g.items.map((t) => item(t, t === 'lumetri' ? 'Lumetri Color' : FX_LABELS[t], 'fx', { kind: 'effect', type: t })))),
        )}
        {folder('at', 'Audio Transitions', [item('cp', 'Constant Power (fade)', 'wave', { kind: 'transition', type: 'crossDissolve' })])}
      </div>
    </div>
  );
}

export function HistoryPanel() {
  const index = useVideo((s) => s.historyIndex);
  useVideo((s) => s.historyLen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  return (
    <div className="vid-bin">
      <div className="vid-bin-list" ref={ref}>
        {history.entries.map((e, i) => (
          <div key={i + e.label + e.time} className={cx('vid-hist', i === index && 'cur', i > index && 'future')} onClick={() => gotoHistory(i)}>
            <Icon name={i === 0 ? 'folder' : 'history'} size={12} />
            <span className="ellipsis">{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
