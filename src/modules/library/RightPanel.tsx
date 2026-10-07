import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/platform/api';
import { formatShutter } from '@/core/image/decode';
import type { DevelopSettings } from '@/core/develop/settings';
import { COLOR_LABELS, LABEL_COLORS, Photo, useCatalog } from '@/state/catalog';
import { openMenu, toast } from '@/state/app';
import { Icon } from '@/ui/Icon';
import { cx, IconButton, Panel } from '@/ui/controls';
import { addKeywords, applyPresetSettings, editSettings, flag, label, rate, removeKeyword, resetSettings } from './actions';
import { autoAdjust, BUILTIN_PRESETS } from './presets';
import { targetIds } from './selection';
import { togglePanel, useLibraryUI } from './store';
import { useGridThumb } from './thumbs';
import { cameraName, clamp, exposureParts, fmtAperture, fmtFocal, fmtIso, formatBytes, formatDate, orientedDims, plural, revealLabel } from './util';

/** Photos the right panel acts on — subscribes so labels/counts stay current. */
function useTargets(): { ids: string[]; active: Photo | undefined } {
  const selection = useCatalog((s) => s.selection);
  const activeId = useCatalog((s) => s.activeId);
  const active = useCatalog((s) => (s.activeId ? s.photos[s.activeId] : undefined));
  const view = useLibraryUI((s) => s.view);
  const ids = useMemo(() => targetIds(), [selection, activeId, view]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ids, active };
}

export function RightPanel() {
  const { ids, active } = useTargets();
  const panels = useLibraryUI((s) => s.panels);
  const isOpen = (id: string, def = true) => panels[id] ?? def;
  return (
    <div className="sidebar right lib-right">
      <Histogram photo={active} />
      <div className="sidebar-scroll">
        <Panel title="Quick Develop" open={isOpen('qd')} onToggle={(o) => togglePanel('qd', o)} right={ids.length > 1 ? <span className="lib-count">{ids.length} photos</span> : undefined}>
          <QuickDevelop ids={ids} />
        </Panel>
        <Panel title="Keywording" open={isOpen('kw')} onToggle={(o) => togglePanel('kw', o)}>
          <Keywording ids={ids} />
        </Panel>
        <Panel title="Metadata" open={isOpen('meta')} onToggle={(o) => togglePanel('meta', o)}>
          <Metadata photo={active} count={ids.length} />
        </Panel>
      </div>
    </div>
  );
}

// =============================================================================================
// Histogram (from the thumbnail — the edited render when available)

const histCache = new Map<ImageBitmap, { r: Uint32Array; g: Uint32Array; b: Uint32Array }>();

function computeHist(bmp: ImageBitmap) {
  const hit = histCache.get(bmp);
  if (hit) return hit;
  const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
  }
  const out = { r, g, b };
  histCache.set(bmp, out);
  if (histCache.size > 64) histCache.delete(histCache.keys().next().value!);
  return out;
}

function Histogram({ photo }: { photo: Photo | undefined }) {
  const bmp = useGridThumb(photo, 384, 0);
  const ref = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(256);
  useLayoutEffect(() => {
    const el = ref.current!.parentElement!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const H = 84;
    c.width = Math.round(w * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    // Quarter grid lines.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const x = Math.round((w * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    if (!bmp) return;
    let hist: ReturnType<typeof computeHist>;
    try {
      hist = computeHist(bmp);
    } catch {
      return;
    }
    // Smooth + normalise (ignore the extreme bins so clipping doesn't flatten the curve).
    const smooth = (a: Uint32Array) => Array.from(a, (_, i) => (a[Math.max(0, i - 1)] + 2 * a[i] + a[Math.min(255, i + 1)]) / 4);
    const chans = [smooth(hist.r), smooth(hist.g), smooth(hist.b)];
    let max = 1;
    for (const ch of chans) for (let i = 2; i < 254; i++) max = Math.max(max, ch[i]);
    ctx.globalCompositeOperation = 'lighter';
    const colors = ['rgba(225,60,60,0.75)', 'rgba(60,200,80,0.7)', 'rgba(70,110,240,0.8)'];
    chans.forEach((ch, ci) => {
      ctx.fillStyle = colors[ci];
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, H - Math.min(1, Math.sqrt(ch[i] / max)) * (H - 4));
      ctx.lineTo(w, H);
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
  }, [bmp, w]);

  const m = photo?.meta;
  const parts = exposureParts(m);
  return (
    <div className="lib-histo-panel">
      <div className="lib-histo">
        <canvas ref={ref} style={{ width: '100%', height: 84, display: 'block' }} />
        {!photo && <div className="lib-histo-empty">No photo selected</div>}
      </div>
      <div className="lib-exif-line">
        {photo ? (
          parts.length ? (
            parts.map((p, i) => <span key={i}>{p}</span>)
          ) : (
            <span className="faint">{photo.meta ? 'No exposure data' : 'Reading metadata…'}</span>
          )
        ) : (
          <span className="faint">—</span>
        )}
      </div>
    </div>
  );
}

// =============================================================================================
// Quick Develop

type QuickKey = 'temperature' | 'tint' | 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'clarity' | 'vibrance' | 'saturation';

const TONE_ROWS: { key: QuickKey; label: string; small: number; big: number }[] = [
  { key: 'exposure', label: 'Exposure', small: 1 / 3, big: 1 },
  { key: 'contrast', label: 'Contrast', small: 5, big: 20 },
  { key: 'highlights', label: 'Highlights', small: 5, big: 20 },
  { key: 'shadows', label: 'Shadows', small: 5, big: 20 },
  { key: 'whites', label: 'Whites', small: 5, big: 20 },
  { key: 'blacks', label: 'Blacks', small: 5, big: 20 },
];
const PRESENCE_ROWS: typeof TONE_ROWS = [
  { key: 'clarity', label: 'Clarity', small: 5, big: 20 },
  { key: 'vibrance', label: 'Vibrance', small: 5, big: 20 },
  { key: 'saturation', label: 'Saturation', small: 5, big: 20 },
];
const WB_ROWS: typeof TONE_ROWS = [
  { key: 'temperature', label: 'Temperature', small: 5, big: 20 },
  { key: 'tint', label: 'Tint', small: 5, big: 20 },
];

function quick(ids: string[], key: QuickKey, delta: number, labelText: string) {
  const lo = key === 'exposure' ? -5 : -100;
  const hi = key === 'exposure' ? 5 : 100;
  editSettings(`${labelText} ${delta > 0 ? '+' : ''}${key === 'exposure' ? delta.toFixed(2) : delta}`, ids, (s) => {
    const v = clamp((s[key] as number) + delta, lo, hi);
    return { ...s, [key]: key === 'exposure' ? Math.round(v * 100) / 100 : Math.round(v) };
  });
}

function StepRow({ ids, row, value }: { ids: string[]; row: (typeof TONE_ROWS)[number]; value: number | null }) {
  const fmt = (v: number) => (row.key === 'exposure' ? (v > 0 ? '+' : '') + v.toFixed(2) : (v > 0 ? '+' : '') + Math.round(v));
  const step = (d: number) => quick(ids, row.key, d, row.label);
  const isExp = row.key === 'exposure';
  return (
    <div className="lib-qd-row">
      <span className="lib-qd-label">{row.label}</span>
      <button type="button" className="lib-step" title={isExp ? '−1 EV' : `−${row.big}`} onClick={() => step(-row.big)}>
        «
      </button>
      <button type="button" className="lib-step" title={isExp ? '−⅓ EV' : `−${row.small}`} onClick={() => step(-row.small)}>
        ‹
      </button>
      <span className={cx('lib-qd-val', value !== null && value !== 0 && 'changed')}>{value === null ? '—' : fmt(value)}</span>
      <button type="button" className="lib-step" title={isExp ? '+⅓ EV' : `+${row.small}`} onClick={() => step(row.small)}>
        ›
      </button>
      <button type="button" className="lib-step" title={isExp ? '+1 EV' : `+${row.big}`} onClick={() => step(row.big)}>
        »
      </button>
    </div>
  );
}

function QuickDevelop({ ids }: { ids: string[] }) {
  const presets = useCatalog((s) => s.presets);
  const photos = useCatalog((s) => s.photos);
  const disabled = !ids.length;
  // Show the value when all targets agree, otherwise "—".
  const valueOf = (key: QuickKey): number | null => {
    let v: number | null = null;
    for (const id of ids.slice(0, 500)) {
      const p = photos[id];
      if (!p) continue;
      const x = (p.settings?.[key] as number | undefined) ?? 0;
      if (v === null) v = x;
      else if (v !== x) return null;
    }
    return v ?? 0;
  };
  const treatment = (() => {
    let t: 'color' | 'bw' | null = null;
    for (const id of ids.slice(0, 500)) {
      const x = photos[id]?.settings?.treatment ?? 'color';
      if (t === null) t = x;
      else if (t !== x) return null;
    }
    return t;
  })();
  const editedCount = useMemo(() => ids.filter((id) => photos[id]?.settings).length, [ids, photos]);

  const presetMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const groups = new Map<string, typeof presets>();
    for (const p of presets) {
      const g = p.group || 'User Presets';
      groups.set(g, [...(groups.get(g) ?? []), p]);
    }
    openMenu(r.left, r.bottom + 2, [
      { heading: 'Built-in' },
      ...BUILTIN_PRESETS.map((p) => ({ label: p.name, onClick: () => applyPresetSettings(p.name, p.settings, targetIds()) })),
      ...[...groups].flatMap(([g, list]) => [{ heading: g }, ...list.map((p) => ({ label: p.name, onClick: () => applyPresetSettings(p.name, p.settings, targetIds()) }))]),
      ...(presets.length ? [] : [{ separator: true }, { label: 'Save presets in Develop to see them here', disabled: true }]),
    ]);
  };

  const setTreatment = (t: 'color' | 'bw') => editSettings(t === 'bw' ? 'Treatment: B&W' : 'Treatment: Color', ids, (s) => ({ ...s, treatment: t } as DevelopSettings));

  return (
    <div className={cx('lib-qd', disabled && 'disabled')}>
      <div className="lib-qd-line">
        <span className="lib-qd-label">Saved Preset</span>
        <button type="button" className="select lib-qd-select" disabled={disabled} onClick={presetMenu}>
          Choose…
        </button>
      </div>
      <div className="lib-qd-line">
        <span className="lib-qd-label">Treatment</span>
        <div className="row" style={{ gap: 2 }}>
          <button type="button" className={cx('btn small', treatment === 'color' && 'active')} disabled={disabled} onClick={() => setTreatment('color')}>
            Color
          </button>
          <button type="button" className={cx('btn small', treatment === 'bw' && 'active')} disabled={disabled} onClick={() => setTreatment('bw')}>
            B&amp;W
          </button>
        </div>
      </div>

      <div className="lib-qd-sub">
        <span>White Balance</span>
        <button type="button" className="btn small ghost" disabled={disabled} title="Neutralise colour casts (gray world)" onClick={() => void autoAdjust('wb', ids)}>
          Auto
        </button>
        <button type="button" className="btn small ghost" disabled={disabled} title="Temperature & tint back to as shot" onClick={() => editSettings('White Balance: As Shot', ids, (s) => ({ ...s, temperature: 0, tint: 0 }))}>
          As Shot
        </button>
      </div>
      {WB_ROWS.map((r) => (
        <StepRow key={r.key} ids={ids} row={r} value={valueOf(r.key)} />
      ))}

      <div className="lib-qd-sub">
        <span>Tone Control</span>
        <button type="button" className="btn small ghost" disabled={disabled} title="Lightroom-style auto tone" onClick={() => void autoAdjust('tone', ids)}>
          Auto Tone
        </button>
      </div>
      {TONE_ROWS.map((r) => (
        <StepRow key={r.key} ids={ids} row={r} value={valueOf(r.key)} />
      ))}
      <div className="lib-qd-sub">
        <span>Presence</span>
      </div>
      {PRESENCE_ROWS.map((r) => (
        <StepRow key={r.key} ids={ids} row={r} value={valueOf(r.key)} />
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn small block" disabled={!editedCount} onClick={() => resetSettings(ids)}>
          Reset All{editedCount > 1 ? ` (${editedCount})` : ''}
        </button>
      </div>
    </div>
  );
}

// =============================================================================================
// Keywording

function Keywording({ ids }: { ids: string[] }) {
  const photos = useCatalog((s) => s.photos);
  const [text, setText] = useState('');
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of ids) for (const k of photos[id]?.keywords ?? []) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  }, [ids, photos]);
  const recent = useMemo(() => {
    // Most used keywords in the catalog (cheap enough; keywords change rarely).
    const counts = new Map<string, number>();
    for (const p of Object.values(photos)) for (const k of p.keywords) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k]) => k);
  }, [photos]);
  const onAll = new Set(tags.filter(([, n]) => n === ids.length).map(([k]) => k));
  const commit = () => {
    const words = text.split(',').map((w) => w.trim()).filter(Boolean);
    if (!words.length) return;
    if (!ids.length) return toast('Select photos to add keywords.');
    addKeywords(words, ids);
    setText('');
  };
  return (
    <div className="lib-kw">
      <div className="lib-chips">
        {!ids.length && <span className="faint">No photo selected</span>}
        {ids.length > 0 && !tags.length && <span className="faint">No keywords</span>}
        {tags.map(([k, n]) => (
          <span key={k} className={cx('lib-chip', n < ids.length && 'partial')} title={n < ids.length ? `On ${n} of ${ids.length} photos — click to add to all` : k} onClick={() => n < ids.length && addKeywords([k], ids)}>
            {k}
            {n < ids.length && <span className="faint">*</span>}
            <button
              type="button"
              title="Remove keyword"
              onClick={(e) => {
                e.stopPropagation();
                removeKeyword(k, ids);
              }}
            >
              <Icon name="x" size={9} />
            </button>
          </span>
        ))}
      </div>
      <input
        className="input"
        placeholder="Add keywords, comma-separated…"
        value={text}
        disabled={!ids.length}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            e.stopPropagation(); // Esc belongs to the field (else it also leaves Loupe / Survey)
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={() => text.trim() && commit()}
      />
      {recent.filter((k) => !onAll.has(k)).length > 0 && (
        <>
          <div className="panel-sub">Keyword suggestions</div>
          <div className="lib-chips">
            {recent
              .filter((k) => !onAll.has(k))
              .map((k) => (
                <span key={k} className="lib-chip ghost" onClick={() => (ids.length ? addKeywords([k], ids) : toast('Select photos first.'))}>
                  {k}
                </span>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================================
// Metadata

function Row({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) {
  return (
    <div className="lib-meta-row" title={title}>
      <span className="lib-meta-k">{k}</span>
      <span className="lib-meta-v">{v || <span className="faint">—</span>}</span>
    </div>
  );
}

function Metadata({ photo, count }: { photo: Photo | undefined; count: number }) {
  if (!photo) return <div className="faint">No photo selected.</div>;
  const m = photo.meta;
  const dims = orientedDims(m);
  const ids = () => targetIds();
  return (
    <div className="lib-meta">
      {count > 1 && <div className="lib-meta-note">{plural(count, 'photo')} selected — showing the active photo; rating, flag and label apply to all.</div>}
      <Row k="File Name" v={<span className="ellipsis" title={photo.name}>{photo.name}</span>} />
      {photo.virtualOf && <Row k="Copy" v="Virtual copy" />}
      <Row
        k="Folder"
        title={photo.path}
        v={
          <span className="row" style={{ gap: 4, minWidth: 0 }}>
            <span className="ellipsis" style={{ direction: 'rtl', textAlign: 'left' }}>
              {photo.path.slice(0, Math.max(photo.path.lastIndexOf('/'), photo.path.lastIndexOf('\\')))}
            </span>
            {api.isElectron && <IconButton icon="folder" small size={12} title={revealLabel} onClick={() => api.reveal(photo.path)} />}
          </span>
        }
      />
      <div className="lib-meta-row">
        <span className="lib-meta-k">Rating</span>
        <span className="lib-meta-v lib-stars big">
          {[1, 2, 3, 4, 5].map((r) => (
            <button key={r} type="button" className={cx('lib-star', r <= photo.rating && 'on')} onClick={() => rate(photo.rating === r ? 0 : r, ids())}>
              {r <= photo.rating ? <Icon name="starFill" size={12} /> : <span className="lib-dot" />}
            </button>
          ))}
        </span>
      </div>
      <div className="lib-meta-row">
        <span className="lib-meta-k">Flag</span>
        <span className="lib-meta-v row" style={{ gap: 2 }}>
          <IconButton icon="flagFill" small size={12} active={photo.flag === 'pick'} title="Pick (P)" onClick={() => flag(photo.flag === 'pick' ? null : 'pick', ids())} />
          <IconButton icon="reject" small size={12} active={photo.flag === 'reject'} title="Reject (X)" onClick={() => flag(photo.flag === 'reject' ? null : 'reject', ids())} />
        </span>
      </div>
      <div className="lib-meta-row">
        <span className="lib-meta-k">Label</span>
        <span className="lib-meta-v row" style={{ gap: 4 }}>
          {COLOR_LABELS.map((l) => (
            <button key={l} type="button" className={cx('lib-swatch', photo.label === l && 'on')} style={{ background: LABEL_COLORS[l] }} title={l} onClick={() => label(l, ids())} />
          ))}
        </span>
      </div>
      <div className="sep-h" />
      <Row k="Dimensions" v={dims ? `${dims[0]} × ${dims[1]}` : ''} />
      <Row k="File Size" v={formatBytes(photo.size)} />
      <Row k="File Type" v={`${(photo.ext || '').toUpperCase()}${photo.kind === 'raw' ? ' (Camera RAW)' : ''}`} />
      <Row k="Capture Time" v={m?.dateTaken ? formatDate(m.dateTaken) : ''} />
      <Row k="Modified" v={formatDate(photo.mtime)} />
      <Row k="Imported" v={formatDate(photo.importedAt)} />
      <div className="sep-h" />
      <Row k="Camera" v={cameraName(m)} />
      <Row k="Lens" v={m?.lens} />
      <Row k="Exposure" v={m?.exposureTime ? `${formatShutter(m.exposureTime)}${m.fNumber ? ` at ${fmtAperture(m.fNumber)}` : ''}` : ''} />
      <Row k="ISO" v={fmtIso(m?.iso)} />
      <Row k="Focal Length" v={fmtFocal(m?.focalLength)} />
      <Row k="GPS" v={m?.gps ? `${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}` : ''} />
      <div className="sep-h" />
      <Row k="Develop" v={photo.settings ? `Edited ${formatDate(photo.editedAt)}` : 'Original'} />
      <Row k="Keywords" v={photo.keywords.join(', ')} />
    </div>
  );
}
