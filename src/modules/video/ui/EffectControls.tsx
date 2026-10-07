import { ReactNode, useEffect, useRef, useState } from 'react';
import { defaultSettings, DevelopSettings, HSL_BAND_COLORS, HSL_BAND_NAMES } from '@/core/develop/settings';
import { BLEND_MODE_GROUPS, BLEND_MODE_LABELS, BlendMode } from '@/core/gl/glsl';
import { hexToRgba, rgbaToHex } from '@/core/util/color';
import { MenuItem, openContextMenu, openMenu } from '@/state/app';
import { ColorSwatch } from '@/ui/ColorPicker';
import { Checkbox, cx, GRADIENTS, NumberField, Panel, Select, Slider, Switch } from '@/ui/controls';
import { CurveEditor } from '@/ui/CurveEditor';
import { Icon } from '@/ui/Icon';
import { defaultMotion, defaultTitle, makeLumetri } from '../model/defaults';
import { allKeyframeTimes, isAnimated, moveKeyframe, paramAt, ParamKey, setParam, toggleAnimation, toggleKeyframeAt } from '../model/keyframes';
import { timecode } from '../model/time';
import { Clip, Effect, FX_LABELS, FX_PARAMS, FX_TYPES, FxType, Lumetri, MediaItem, TitleSpec, TRANSITION_LABELS } from '../model/types';
import * as A from '../state/actions';
import { mapClips } from '../state/clips';
import { clipMap, edit, endLiveEdit, liveEdit, mediaLookup, useVideo } from '../state/store';
import { transport } from '../state/transport';
import { openSpeedDialog, openTransitionDialog } from './dialogs';

const LANE_W = 128;

interface Ctx {
  clip: Clip;
  local: number;
  fps: number;
}

/** Live (coalesced) edit of the clip. */
function liveClip(clip: Clip, key: string, label: string, fn: (c: Clip) => Clip) {
  liveEdit(`${clip.id}:${key}`, label, (p) => mapClips(p, clip.id, fn));
}

function commitClip(clip: Clip, label: string, fn: (c: Clip) => Clip) {
  edit(label, (p) => mapClips(p, clip.id, fn));
}

// ---------------------------------------------------------------------------------------------
// Keyframe lane

function Lane({ ctx, pkey }: { ctx: Ctx; pkey?: ParamKey }) {
  const { clip } = ctx;
  const kfs = pkey ? clip.kf[pkey] ?? [] : [];
  const toX = (t: number) => (Math.max(0, Math.min(clip.duration, t)) / Math.max(1, clip.duration)) * LANE_W;
  const onDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const t = Math.round(((e.clientX - r.left) / r.width) * clip.duration);
    transport.seek(clip.start + Math.max(0, Math.min(clip.duration - 1, t)));
  };
  const onDiamond = (e: React.PointerEvent, t: number) => {
    e.stopPropagation();
    if (!pkey) return;
    const lane = (e.currentTarget as HTMLElement).parentElement!;
    const r = lane.getBoundingClientRect();
    transport.seek(clip.start + t);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let cur = t;
    const key = `${clip.id}:kfmove:${pkey}:${t}`;
    const move = (ev: PointerEvent) => {
      const nt = Math.max(0, Math.min(clip.duration - 1, Math.round(((ev.clientX - r.left) / r.width) * clip.duration)));
      if (nt === cur) return;
      // Another keyframe sits there: moveKeyframe refuses, so keep tracking ours at `cur` (else the next
      // move would grab the other keyframe).
      if (clipMap().get(clip.id)?.kf[pkey]?.some((x) => x.t === nt)) return;
      const from = cur;
      cur = nt;
      liveEdit(key, 'Move Keyframe', (p) => mapClips(p, clip.id, (c) => moveKeyframe(c, pkey, from, nt)));
      transport.seek(clip.start + nt);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      endLiveEdit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className="ec-lane" style={{ width: LANE_W }} onPointerDown={onDown}>
      <div className="ec-lane-ph" />
      {kfs.map((k) => (
        <div
          key={k.t}
          className={cx('ec-kf', k.t === Math.round(ctx.local) && 'on', k.ease === 'hold' && 'hold', k.ease === 'ease' && 'ease')}
          style={{ left: toX(k.t) }}
          onPointerDown={(e) => e.button === 0 && onDiamond(e, k.t)}
          onContextMenu={(e) => {
            e.stopPropagation();
            if (!pkey) return;
            const setEase = (ease: 'linear' | 'hold' | 'ease') => commitClip(clip, 'Keyframe Interpolation', (c) => ({ ...c, kf: { ...c.kf, [pkey]: (c.kf[pkey] ?? []).map((x) => (x.t === k.t ? { ...x, ease } : x)) } }));
            openContextMenu(e, [
              { label: 'Linear', checked: !k.ease || k.ease === 'linear', onClick: () => setEase('linear') },
              { label: 'Ease In/Out', checked: k.ease === 'ease', onClick: () => setEase('ease') },
              { label: 'Hold', checked: k.ease === 'hold', onClick: () => setEase('hold') },
              { separator: true },
              { label: 'Delete Keyframe', onClick: () => commitClip(clip, 'Remove Keyframe', (c) => toggleKeyframeAt(c, pkey, k.t)) },
            ]);
          }}
          title={`${timecode(k.t, ctx.fps)} — right-click for interpolation`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Rows

function Row({ children, ctx, pkey, animatable }: { children: ReactNode; ctx: Ctx; pkey?: ParamKey; animatable?: boolean }) {
  const { clip, local } = ctx;
  const anim = pkey ? isAnimated(clip, pkey) : false;
  const times = pkey && anim ? clip.kf[pkey].map((k) => k.t) : [];
  const atKf = times.includes(Math.round(local));
  const prev = [...times].reverse().find((t) => t < Math.round(local));
  const next = times.find((t) => t > Math.round(local));
  return (
    <div className="ec-row">
      <div className="ec-stopwatch">
        {animatable && pkey && (
          <button
            type="button"
            className={cx('ec-sw', anim && 'on')}
            title={anim ? 'Turn off animation (removes keyframes)' : 'Toggle animation'}
            onClick={() => commitClip(clip, anim ? 'Remove Keyframes' : 'Enable Animation', (c) => toggleAnimation(c, pkey, local))}
          >
            <Icon name="history" size={12} />
          </button>
        )}
      </div>
      <div className="ec-ctl">{children}</div>
      <div className="ec-nav">
        {anim && pkey && (
          <>
            <button type="button" className="ec-nav-btn" disabled={prev === undefined} title="Previous keyframe" onClick={() => prev !== undefined && transport.seek(clip.start + prev)}>
              ◂
            </button>
            <button type="button" className={cx('ec-nav-btn', atKf && 'on')} title={atKf ? 'Remove keyframe' : 'Add keyframe'} onClick={() => commitClip(clip, atKf ? 'Remove Keyframe' : 'Add Keyframe', (c) => toggleKeyframeAt(c, pkey, local))}>
              ◆
            </button>
            <button type="button" className="ec-nav-btn" disabled={next === undefined} title="Next keyframe" onClick={() => next !== undefined && transport.seek(clip.start + next)}>
              ▸
            </button>
          </>
        )}
      </div>
      <Lane ctx={ctx} pkey={anim ? pkey : undefined} />
    </div>
  );
}

function ParamSlider({ ctx, pkey, label, min, max, step = 1, precision, suffix, def, gradient }: { ctx: Ctx; pkey: ParamKey; label: string; min: number; max: number; step?: number; precision?: number; suffix?: string; def?: number; gradient?: string }) {
  const v = paramAt(ctx.clip, pkey, ctx.local);
  return (
    <Row ctx={ctx} pkey={pkey} animatable>
      <Slider
        label={label}
        value={Math.round(v * 1000) / 1000}
        min={min}
        max={max}
        step={step}
        precision={precision}
        suffix={suffix}
        defaultValue={def}
        gradient={gradient}
        labelWidth={84}
        onChange={(x) => liveClip(ctx.clip, pkey, label, (c) => setParam(c, pkey, ctx.local, x))}
        onCommit={() => endLiveEdit()}
      />
    </Row>
  );
}

function PairField({ ctx, kx, ky, label, step = 1, offsetX = 0, offsetY = 0 }: { ctx: Ctx; kx: ParamKey; ky: ParamKey; label: string; step?: number; offsetX?: number; offsetY?: number }) {
  const vx = paramAt(ctx.clip, kx, ctx.local);
  const vy = paramAt(ctx.clip, ky, ctx.local);
  const set = (k: ParamKey, v: number) => commitClip(ctx.clip, label, (c) => setParam(c, k, ctx.local, v));
  const toggle = () =>
    commitClip(ctx.clip, isAnimated(ctx.clip, kx) ? 'Remove Keyframes' : 'Enable Animation', (c) => {
      const on = isAnimated(c, kx);
      let n = toggleAnimation(c, kx, ctx.local);
      if (isAnimated(n, ky) === on) n = toggleAnimation(n, ky, ctx.local);
      return n;
    });
  const anim = isAnimated(ctx.clip, kx) || isAnimated(ctx.clip, ky);
  const times = allKeyframeTimes(ctx.clip, [kx, ky]);
  const atKf = times.includes(Math.round(ctx.local));
  const prev = [...times].reverse().find((t) => t < Math.round(ctx.local));
  const next = times.find((t) => t > Math.round(ctx.local));
  return (
    <div className="ec-row">
      <div className="ec-stopwatch">
        <button type="button" className={cx('ec-sw', anim && 'on')} title="Toggle animation" onClick={toggle}>
          <Icon name="history" size={12} />
        </button>
      </div>
      <div className="ec-ctl row">
        <span className="ec-label">{label}</span>
        <ScrubNumber value={vx + offsetX} step={step} onChange={(v) => liveClip(ctx.clip, kx, label, (c) => setParam(c, kx, ctx.local, v - offsetX))} onCommit={endLiveEdit} onSet={(v) => set(kx, v - offsetX)} />
        <ScrubNumber value={vy + offsetY} step={step} onChange={(v) => liveClip(ctx.clip, ky, label, (c) => setParam(c, ky, ctx.local, v - offsetY))} onCommit={endLiveEdit} onSet={(v) => set(ky, v - offsetY)} />
      </div>
      <div className="ec-nav">
        {anim && (
          <>
            <button type="button" className="ec-nav-btn" disabled={prev === undefined} onClick={() => prev !== undefined && transport.seek(ctx.clip.start + prev)}>
              ◂
            </button>
            <button
              type="button"
              className={cx('ec-nav-btn', atKf && 'on')}
              onClick={() =>
                commitClip(ctx.clip, atKf ? 'Remove Keyframe' : 'Add Keyframe', (c) => {
                  let n = c;
                  for (const k of [kx, ky]) {
                    const has = (n.kf[k] ?? []).some((x) => x.t === Math.round(ctx.local));
                    if (has === atKf) n = toggleKeyframeAt(n, k, ctx.local);
                  }
                  return n;
                })
              }
            >
              ◆
            </button>
            <button type="button" className="ec-nav-btn" disabled={next === undefined} onClick={() => next !== undefined && transport.seek(ctx.clip.start + next)}>
              ▸
            </button>
          </>
        )}
      </div>
      <Lane ctx={ctx} pkey={isAnimated(ctx.clip, kx) ? kx : isAnimated(ctx.clip, ky) ? ky : undefined} />
    </div>
  );
}

/** Premiere-style blue number you can drag horizontally to scrub, or click to type. */
function ScrubNumber({ value, onChange, onCommit, onSet, step = 1, precision = 1 }: { value: number; onChange: (v: number) => void; onCommit: () => void; onSet: (v: number) => void; step?: number; precision?: number }) {
  const [edit, setEdit] = useState<string | null>(null);
  if (edit !== null)
    return (
      <input
        className="input mono ec-num-input"
        autoFocus
        value={edit}
        onChange={(e) => setEdit(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          const v = parseFloat(edit);
          if (Number.isFinite(v)) onSet(v);
          setEdit(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEdit(null);
        }}
      />
    );
  return (
    <span
      className="ec-num"
      onPointerDown={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const v0 = value;
        let moved = false;
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - x0;
          if (Math.abs(dx) > 2) moved = true;
          if (moved) onChange(Math.round((v0 + dx * step * (ev.shiftKey ? 10 : 1)) * 10) / 10);
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          if (moved) onCommit();
          else setEdit(value.toFixed(precision));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    >
      {value.toFixed(precision)}
    </span>
  );
}

function PlainRow({ children }: { children: ReactNode }) {
  return (
    <div className="ec-row">
      <div className="ec-stopwatch" />
      <div className="ec-ctl">{children}</div>
      <div className="ec-nav" />
      <div className="ec-lane blank" style={{ width: LANE_W }} />
    </div>
  );
}

function StaticSlider({ label, value, min, max, step = 1, suffix, precision, def, gradient, onChange, liveKey, clip }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; precision?: number; def?: number; gradient?: string; onChange: (c: Clip, v: number) => Clip; liveKey: string; clip: Clip }) {
  return (
    <PlainRow>
      <Slider label={label} value={value} min={min} max={max} step={step} suffix={suffix} precision={precision} defaultValue={def} gradient={gradient} labelWidth={84} onChange={(v) => liveClip(clip, liveKey, label, (c) => onChange(c, v))} onCommit={() => endLiveEdit()} />
    </PlainRow>
  );
}

// ---------------------------------------------------------------------------------------------

export function EffectControls() {
  const project = useVideo((s) => s.project);
  const selection = useVideo((s) => s.selection);
  const transitionSel = useVideo((s) => s.transition);
  const playhead = useVideo((s) => s.playhead);
  const rootRef = useRef<HTMLDivElement>(null);
  const clip = A.primaryClip(project, selection);

  // Playhead line in every keyframe lane, updated without React.
  useEffect(() => {
    if (!clip) return;
    const upd = () => {
      const root = rootRef.current;
      if (!root) return;
      const t = transport.frame - clip.start;
      const x = (t / Math.max(1, clip.duration)) * LANE_W;
      const vis = t >= 0 && t <= clip.duration;
      root.querySelectorAll<HTMLElement>('.ec-lane-ph').forEach((el) => {
        el.style.left = `${x}px`;
        el.style.display = vis ? 'block' : 'none';
      });
    };
    upd();
    return transport.subscribe(upd);
  });

  if (transitionSel) {
    const c = project.seq.clips.find((x) => x.id === transitionSel.clipId);
    const t = c && (transitionSel.edge === 'in' ? c.transIn : c.transOut);
    if (c && t)
      return (
        <div className="ec">
          <div className="ec-head">
            <span className="ellipsis">
              {TRANSITION_LABELS[t.type]} — {c.name}
            </span>
          </div>
          <div className="ec-body" style={{ padding: 10 }}>
            <div className="field">
              <label>Duration</label>
              <span className="mono">{timecode(t.duration, project.seq.fps)}</span>
            </div>
            <div className="field">
              <label>Alignment</label>
              <span>{t.align === 'center' ? 'Center at Cut' : t.align === 'start' ? 'Start at Cut' : 'End at Cut'}</span>
            </div>
            <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void openTransitionDialog(c.id, transitionSel.edge)}>
              Edit Transition…
            </button>
          </div>
        </div>
      );
  }

  if (!clip)
    return (
      <div className="ec">
        <div className="empty-state">
          <Icon name="sliders" size={26} />
          <p className="faint">Select a clip in the timeline to edit its Motion, Opacity, Volume, Lumetri Color and effects.</p>
        </div>
      </div>
    );

  const media = mediaLookup(project)(clip.mediaId);
  const track = project.seq.tracks.find((t) => t.id === clip.trackId);
  const isVideo = track?.kind === 'video';
  const local = Math.max(0, Math.min(clip.duration - 1, playhead - clip.start));
  const ctx: Ctx = { clip, local, fps: project.seq.fps };
  const audioTracks = new Set(project.seq.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
  const audioPartner = isVideo ? project.seq.clips.find((c) => selection.includes(c.id) && audioTracks.has(c.trackId) && (c.linkId ? c.linkId === clip.linkId : true)) ?? null : null;
  const outside = playhead < clip.start || playhead >= clip.start + clip.duration;

  const addMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = isVideo
      ? [{ label: 'Lumetri Color', disabled: !!clip.lumetri, onClick: () => A.addEffectToClips([clip.id], 'lumetri') }, { separator: true }, ...FX_TYPES.map((t) => ({ label: FX_LABELS[t], onClick: () => A.addEffectToClips([clip.id], t) }))]
      : [{ label: 'Audio clips support Volume, Pan and Fades', disabled: true }];
    openMenu(r.left, r.bottom + 4, items);
  };

  return (
    <div className="ec" ref={rootRef}>
      <div className="ec-head">
        <span className="ellipsis" title={clip.name}>
          {project.seq.name} › <b>{clip.name}</b>
        </span>
        <span className="spacer" />
        {outside && <span className="faint" style={{ fontSize: 10 }}>playhead outside clip</span>}
        <span className="vid-tc dim" style={{ fontSize: 10.5 }}>
          {timecode(playhead, project.seq.fps)}
        </span>
        {isVideo && (
          <button type="button" className="btn small" onClick={addMenu} title="Add effect">
            <Icon name="fx" size={12} /> Add
          </button>
        )}
      </div>
      <div className="ec-body">
        {isVideo ? <VideoSections ctx={ctx} media={media} /> : <AudioSections ctx={ctx} />}
        {isVideo && audioPartner && (
          <>
            <div className="ec-divider">Audio — {audioPartner.name}</div>
            <AudioSections ctx={{ clip: audioPartner, local: Math.max(0, Math.min(audioPartner.duration - 1, playhead - audioPartner.start)), fps: project.seq.fps }} />
          </>
        )}
      </div>
    </div>
  );
}

function SectionHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <span className="row" style={{ width: '100%' }}>
      <span className="grow ellipsis">{title}</span>
      {right}
    </span>
  );
}

function ResetBtn({ onClick, title = 'Reset' }: { onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      className="icon-btn small"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name="undo" size={12} />
    </button>
  );
}

function VideoSections({ ctx, media }: { ctx: Ctx; media: MediaItem | undefined }) {
  const { clip } = ctx;
  const m = clip.motion;
  const seq = useVideo((s) => s.project.seq);
  const kind = media?.kind;
  return (
    <>
      {kind !== 'adjustment' && (
        <Panel
          title={<SectionHead title="Motion" />}
          right={<ResetBtn onClick={() => commitClip(clip, 'Reset Motion', (c) => ({ ...c, motion: defaultMotion(), kf: Object.fromEntries(Object.entries(c.kf).filter(([k]) => !['x', 'y', 'scale', 'scaleW', 'rotation', 'anchorX', 'anchorY'].includes(k))) }))} />}
        >
          <PairField ctx={ctx} kx="x" ky="y" label="Position" offsetX={seq.width / 2} offsetY={seq.height / 2} />
          <ParamSlider ctx={ctx} pkey="scale" label={m.uniform ? 'Scale' : 'Scale Height'} min={0} max={400} step={0.1} precision={1} def={100} />
          {!m.uniform && <ParamSlider ctx={ctx} pkey="scaleW" label="Scale Width" min={0} max={400} step={0.1} precision={1} def={100} />}
          <PlainRow>
            <div className="row" style={{ gap: 14 }}>
              <Checkbox checked={m.uniform} onChange={(v) => commitClip(clip, 'Uniform Scale', (c) => ({ ...c, motion: { ...c.motion, uniform: v, scaleW: v ? c.motion.scaleW : c.motion.scale } }))}>
                Uniform Scale
              </Checkbox>
              {(kind === 'video' || kind === 'image') && (
                <Checkbox checked={clip.fit} onChange={(v) => commitClip(clip, 'Scale to Frame Size', (c) => ({ ...c, fit: v }))}>
                  Scale to Frame
                </Checkbox>
              )}
            </div>
          </PlainRow>
          <ParamSlider ctx={ctx} pkey="rotation" label="Rotation" min={-360} max={360} step={0.1} precision={1} suffix="°" />
          <PairField ctx={ctx} kx="anchorX" ky="anchorY" label="Anchor Point" />
          {(['cropL', 'cropT', 'cropR', 'cropB'] as const).map((k, i) => (
            <StaticSlider key={k} clip={clip} liveKey={k} label={['Crop Left', 'Crop Top', 'Crop Right', 'Crop Bottom'][i]} value={m[k]} min={0} max={100} step={0.1} precision={1} suffix="%" onChange={(c, v) => ({ ...c, motion: { ...c.motion, [k]: v } })} />
          ))}
        </Panel>
      )}
      <Panel title={<SectionHead title="Opacity" />} right={<ResetBtn onClick={() => commitClip(clip, 'Reset Opacity', (c) => ({ ...c, opacity: 100, blend: 'normal', fadeIn: 0, fadeOut: 0, kf: Object.fromEntries(Object.entries(c.kf).filter(([k]) => k !== 'opacity')) }))} />}>
        <ParamSlider ctx={ctx} pkey="opacity" label="Opacity" min={0} max={100} step={0.1} precision={1} suffix="%" def={100} />
        <PlainRow>
          <div className="row">
            <span className="ec-label">Blend Mode</span>
            <select className="select" value={clip.blend} onChange={(e) => commitClip(clip, 'Blend Mode', (c) => ({ ...c, blend: e.target.value as BlendMode }))} style={{ flex: 1, height: 22 }}>
              {BLEND_MODE_GROUPS.map((g, i) => (
                <optgroup key={i} label={'—'}>
                  {g.map((b) => (
                    <option key={b} value={b}>
                      {BLEND_MODE_LABELS[b]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </PlainRow>
        <FadeRows ctx={ctx} />
      </Panel>
      <SpeedSection ctx={ctx} />
      {kind === 'title' && clip.title && <TitleSection clip={clip} />}
      {kind === 'matte' && (
        <Panel title="Color Matte">
          <PlainRow>
            <div className="row">
              <span className="ec-label">Color</span>
              <ColorSwatch value={hexToRgba(clip.color ?? '#000000')} alpha={false} onChange={(c) => liveClip(clip, 'matte', 'Matte Color', (x) => ({ ...x, color: rgbaToHex(c) }))} />
            </div>
          </PlainRow>
        </Panel>
      )}
      {clip.lumetri && <LumetriSection clip={clip} lum={clip.lumetri} />}
      {clip.fx.map((e, i) => (
        <EffectSection key={e.id} ctx={ctx} fx={e} index={i} count={clip.fx.length} />
      ))}
    </>
  );
}

function FadeRows({ ctx }: { ctx: Ctx }) {
  const { clip, fps } = ctx;
  return (
    <PlainRow>
      <div className="row" style={{ gap: 10 }}>
        <span className="ec-label">Fade In</span>
        <NumberField value={clip.fadeIn} min={0} max={clip.duration} onChange={(v) => commitClip(clip, 'Fade In', (c) => ({ ...c, fadeIn: Math.round(v) }))} suffix="f" width={52} title={timecode(clip.fadeIn, fps)} />
        <span className="ec-label" style={{ width: 'auto' }}>
          Out
        </span>
        <NumberField value={clip.fadeOut} min={0} max={clip.duration} onChange={(v) => commitClip(clip, 'Fade Out', (c) => ({ ...c, fadeOut: Math.round(v) }))} suffix="f" width={52} title={timecode(clip.fadeOut, fps)} />
      </div>
    </PlainRow>
  );
}

function SpeedSection({ ctx }: { ctx: Ctx }) {
  const { clip, fps } = ctx;
  return (
    <Panel title="Time Remapping" defaultOpen={false}>
      <PlainRow>
        <div className="row">
          <span className="ec-label">Speed</span>
          <span className="mono">{Math.round(clip.speed * 10000) / 100}%</span>
          <span className="faint">·</span>
          <span className="mono faint">{timecode(clip.duration, fps)}</span>
          <span className="spacer" />
          <button type="button" className="btn small" onClick={() => void openSpeedDialog([clip])}>
            Speed/Duration…
          </button>
        </div>
      </PlainRow>
    </Panel>
  );
}

function AudioSections({ ctx }: { ctx: Ctx }) {
  const { clip } = ctx;
  return (
    <>
      <Panel title={<SectionHead title="Volume" />} right={<ResetBtn onClick={() => commitClip(clip, 'Reset Volume', (c) => ({ ...c, volume: 0, kf: Object.fromEntries(Object.entries(c.kf).filter(([k]) => k !== 'volume')) }))} />}>
        <ParamSlider ctx={ctx} pkey="volume" label="Level" min={-60} max={15} step={0.1} precision={1} suffix=" dB" def={0} />
        <FadeRows ctx={ctx} />
      </Panel>
      <Panel title={<SectionHead title="Panner" />} right={<ResetBtn onClick={() => commitClip(clip, 'Reset Pan', (c) => ({ ...c, pan: 0, kf: Object.fromEntries(Object.entries(c.kf).filter(([k]) => k !== 'pan')) }))} />}>
        <ParamSlider ctx={ctx} pkey="pan" label="Balance" min={-100} max={100} step={1} def={0} />
      </Panel>
      <SpeedSection ctx={ctx} />
      <div className="faint" style={{ padding: '8px 12px', fontSize: 10.5 }}>
        Speed changes keep pitch during playback when “Maintain Audio Pitch” is on.
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Titles

function TitleSection({ clip }: { clip: Clip }) {
  const t = clip.title!;
  const set = (patch: Partial<TitleSpec>, key = 'title') => liveClip(clip, key, 'Edit Title', (c) => ({ ...c, title: { ...c.title!, ...patch } }));
  const [text, setText] = useState(t.text);
  useEffect(() => setText(t.text), [t.text]);
  const fonts = ['Helvetica Neue, Arial, sans-serif', 'Georgia, serif', 'Times New Roman, serif', 'Futura, Avenir, sans-serif', 'Impact, sans-serif', 'Courier New, monospace', 'Gill Sans, sans-serif', 'Didot, serif', 'system-ui, sans-serif'];
  return (
    <Panel title={<SectionHead title="Text" />} right={<ResetBtn onClick={() => commitClip(clip, 'Reset Title', (c) => ({ ...c, title: { ...defaultTitle(), text: c.title!.text } }))} />}>
      <div className="ec-title-text">
        <textarea
          className="input"
          value={text}
          rows={3}
          onChange={(e) => {
            setText(e.target.value);
            set({ text: e.target.value }, 'title-text');
          }}
          onBlur={() => endLiveEdit()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <PlainRow>
        <div className="row">
          <span className="ec-label">Font</span>
          <Select value={t.font} options={fonts.map((f) => ({ value: f, label: f.split(',')[0] }))} onChange={(v) => (set({ font: v }), endLiveEdit())} style={{ flex: 1, height: 22 }} />
        </div>
      </PlainRow>
      <PlainRow>
        <div className="row">
          <span className="ec-label">Style</span>
          <Select
            value={t.weight}
            options={[
              { value: 300, label: 'Light' },
              { value: 400, label: 'Regular' },
              { value: 600, label: 'Semibold' },
              { value: 700, label: 'Bold' },
              { value: 900, label: 'Black' },
            ]}
            onChange={(v) => (set({ weight: v }), endLiveEdit())}
            style={{ height: 22 }}
          />
          <button type="button" className={cx('icon-btn small', t.italic && 'active')} onClick={() => (set({ italic: !t.italic }), endLiveEdit())} title="Italic">
            <Icon name="italic" size={13} />
          </button>
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} type="button" className={cx('icon-btn small', t.align === a && 'active')} onClick={() => (set({ align: a }), endLiveEdit())} title={`Align ${a}`}>
              <Icon name={a === 'left' ? 'alignLeft' : a === 'center' ? 'alignCenter' : 'alignRight'} size={13} />
            </button>
          ))}
          <ColorSwatch value={hexToRgba(t.color)} alpha={false} size={20} onChange={(c) => set({ color: rgbaToHex(c) }, 'title-color')} title="Fill" />
        </div>
      </PlainRow>
      <TS label="Size" v={t.size} min={8} max={400} on={(v) => set({ size: v }, 'title-size')} />
      <TS label="Tracking" v={t.tracking} min={-20} max={80} on={(v) => set({ tracking: v }, 'title-tracking')} />
      <TS label="Leading" v={t.lineHeight} min={0.6} max={3} step={0.01} on={(v) => set({ lineHeight: v }, 'title-lh')} def={1.15} />
      <TS label="Position X" v={t.x * 100} min={0} max={100} step={0.1} suffix="%" on={(v) => set({ x: v / 100 }, 'title-x')} def={50} />
      <TS label="Position Y" v={t.y * 100} min={0} max={100} step={0.1} suffix="%" on={(v) => set({ y: v / 100 }, 'title-y')} def={50} />
      <PlainRow>
        <div className="row">
          <Checkbox checked={t.stroke.on} onChange={(v) => (set({ stroke: { ...t.stroke, on: v } }), endLiveEdit())}>
            Stroke
          </Checkbox>
          <ColorSwatch value={hexToRgba(t.stroke.color)} alpha={false} size={18} onChange={(c) => set({ stroke: { ...t.stroke, color: rgbaToHex(c) } }, 'title-sc')} />
          <NumberField value={t.stroke.width} min={0} max={60} onChange={(v) => (set({ stroke: { ...t.stroke, width: v } }), endLiveEdit())} width={44} title="Stroke width" />
        </div>
      </PlainRow>
      <PlainRow>
        <div className="row">
          <Checkbox checked={t.shadow.on} onChange={(v) => (set({ shadow: { ...t.shadow, on: v } }), endLiveEdit())}>
            Shadow
          </Checkbox>
          <ColorSwatch value={hexToRgba(t.shadow.color)} alpha={false} size={18} onChange={(c) => set({ shadow: { ...t.shadow, color: rgbaToHex(c) } }, 'title-shc')} />
          <NumberField value={t.shadow.blur} min={0} max={100} onChange={(v) => (set({ shadow: { ...t.shadow, blur: v } }), endLiveEdit())} width={40} title="Blur" />
          <NumberField value={t.shadow.dy} min={-100} max={100} onChange={(v) => (set({ shadow: { ...t.shadow, dy: v, dx: t.shadow.dx } }), endLiveEdit())} width={40} title="Distance" />
        </div>
      </PlainRow>
      <PlainRow>
        <div className="row">
          <Checkbox checked={t.box.on} onChange={(v) => (set({ box: { ...t.box, on: v } }), endLiveEdit())}>
            Background
          </Checkbox>
          <ColorSwatch value={hexToRgba(t.box.color)} alpha={false} size={18} onChange={(c) => set({ box: { ...t.box, color: rgbaToHex(c) } }, 'title-bc')} />
          <NumberField value={Math.round(t.box.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => (set({ box: { ...t.box, opacity: v / 100 } }), endLiveEdit())} width={50} title="Opacity" />
          <NumberField value={t.box.padding} min={0} max={200} onChange={(v) => (set({ box: { ...t.box, padding: v } }), endLiveEdit())} width={44} title="Padding" />
        </div>
      </PlainRow>
    </Panel>
  );
}

function TS({ label, v, min, max, step = 1, suffix, on, def }: { label: string; v: number; min: number; max: number; step?: number; suffix?: string; on: (v: number) => void; def?: number }) {
  return (
    <PlainRow>
      <Slider label={label} value={v} min={min} max={max} step={step} suffix={suffix} defaultValue={def} labelWidth={84} onChange={on} onCommit={() => endLiveEdit()} />
    </PlainRow>
  );
}

// ---------------------------------------------------------------------------------------------
// Lumetri

function LumetriSection({ clip, lum }: { clip: Clip; lum: Lumetri }) {
  const s = lum.s;
  const [curveCh, setCurveCh] = useState<'rgb' | 'r' | 'g' | 'b'>('rgb');
  const [band, setBand] = useState(0);
  const setS = (key: string, fn: (s: DevelopSettings) => DevelopSettings) => liveClip(clip, 'lum-' + key, 'Lumetri Color', (c) => (c.lumetri ? { ...c, lumetri: { ...c.lumetri, s: fn(c.lumetri.s) } } : c));
  const num = (k: keyof DevelopSettings, label: string, min: number, max: number, step = 1, gradient?: string, precision?: number) => (
    <PlainRow key={k as string}>
      <Slider label={label} value={s[k] as number} min={min} max={max} step={step} gradient={gradient} precision={precision} signed labelWidth={84} onChange={(v) => setS(k as string, (x) => ({ ...x, [k]: v }))} onCommit={() => endLiveEdit()} />
    </PlainRow>
  );
  const curveColors = { rgb: '#e8e8ea', r: '#ff6b6b', g: '#5fd47a', b: '#5b9bff' };
  return (
    <Panel
      title={<SectionHead title="Lumetri Color" />}
      enabled={lum.enabled}
      onEnabledChange={(v) => commitClip(clip, v ? 'Enable Lumetri' : 'Disable Lumetri', (c) => (c.lumetri ? { ...c, lumetri: { ...c.lumetri, enabled: v } } : c))}
      right={
        <>
          <ResetBtn onClick={() => commitClip(clip, 'Reset Lumetri', (c) => ({ ...c, lumetri: makeLumetri() }))} />
          <button type="button" className="icon-btn small" title="Remove Lumetri Color" onClick={() => commitClip(clip, 'Remove Lumetri', (c) => ({ ...c, lumetri: null }))}>
            <Icon name="trash" size={12} />
          </button>
        </>
      }
    >
      <div className="panel-sub">Basic Correction — White Balance</div>
      {num('temperature', 'Temperature', -100, 100, 1, GRADIENTS.temperature)}
      {num('tint', 'Tint', -100, 100, 1, GRADIENTS.tint)}
      <div className="panel-sub">Tone</div>
      {num('exposure', 'Exposure', -5, 5, 0.01, undefined, 2)}
      {num('contrast', 'Contrast', -100, 100)}
      {num('highlights', 'Highlights', -100, 100)}
      {num('shadows', 'Shadows', -100, 100)}
      {num('whites', 'Whites', -100, 100)}
      {num('blacks', 'Blacks', -100, 100)}
      {num('saturation', 'Saturation', -100, 100)}
      <div className="panel-sub">Creative</div>
      <PlainRow>
        <Slider label="Faded Film" value={lum.faded} min={0} max={100} labelWidth={84} onChange={(v) => liveClip(clip, 'lum-faded', 'Lumetri Color', (c) => (c.lumetri ? { ...c, lumetri: { ...c.lumetri, faded: v } } : c))} onCommit={() => endLiveEdit()} />
      </PlainRow>
      <PlainRow>
        <Slider label="Sharpen" value={s.sharpening.amount} min={0} max={150} labelWidth={84} onChange={(v) => setS('sharp', (x) => ({ ...x, sharpening: { ...x.sharpening, amount: v } }))} onCommit={() => endLiveEdit()} />
      </PlainRow>
      {num('vibrance', 'Vibrance', -100, 100)}
      {num('clarity', 'Clarity', -100, 100)}
      {num('dehaze', 'Dehaze', -100, 100)}
      <PlainRow>
        <Checkbox checked={s.treatment === 'bw'} onChange={(v) => (setS('bw', (x) => ({ ...x, treatment: v ? 'bw' : 'color' })), endLiveEdit())}>
          Black & White
        </Checkbox>
      </PlainRow>
      <div className="panel-sub">Curves</div>
      <div className="ec-curves">
        <div className="row" style={{ gap: 2, marginBottom: 4 }}>
          {(['rgb', 'r', 'g', 'b'] as const).map((ch) => (
            <button key={ch} type="button" className={cx('btn small ghost', curveCh === ch && 'active')} style={{ color: curveColors[ch] }} onClick={() => setCurveCh(ch)}>
              {ch.toUpperCase()}
            </button>
          ))}
          <span className="spacer" />
          <button type="button" className="btn small ghost" onClick={() => (setS('curve', (x) => ({ ...x, curve: defaultSettings().curve })), endLiveEdit())}>
            Reset
          </button>
        </div>
        <CurveEditor points={s.curve[curveCh]} color={curveColors[curveCh]} size={200} onChange={(pts) => setS('curve', (x) => ({ ...x, curve: { ...x.curve, [curveCh]: pts } }))} onCommit={() => endLiveEdit()} />
      </div>
      <div className="panel-sub">HSL Secondary</div>
      <PlainRow>
        <div className="row" style={{ gap: 3 }}>
          {HSL_BAND_NAMES.map((n, i) => (
            <button key={n} type="button" title={n} className={cx('ec-band', band === i && 'on')} style={{ background: HSL_BAND_COLORS[i] }} onClick={() => setBand(i)} />
          ))}
          <span className="faint" style={{ marginLeft: 6 }}>
            {HSL_BAND_NAMES[band]}
          </span>
        </div>
      </PlainRow>
      {(['hue', 'sat', 'lum'] as const).map((k) => (
        <PlainRow key={k}>
          <Slider
            label={k === 'hue' ? 'Hue' : k === 'sat' ? 'Saturation' : 'Luminance'}
            value={s.hsl[k][band]}
            min={-100}
            max={100}
            labelWidth={84}
            signed
            onChange={(v) => setS('hsl' + k + band, (x) => ({ ...x, hsl: { ...x.hsl, [k]: x.hsl[k].map((y, j) => (j === band ? v : y)) } }))}
            onCommit={() => endLiveEdit()}
          />
        </PlainRow>
      ))}
      <div className="panel-sub">Vignette</div>
      {(
        [
          ['amount', 'Amount', -100, 100],
          ['midpoint', 'Midpoint', 0, 100],
          ['roundness', 'Roundness', -100, 100],
          ['feather', 'Feather', 0, 100],
        ] as const
      ).map(([k, l, a, b]) => (
        <PlainRow key={k}>
          <Slider label={l} value={s.vignette[k]} min={a} max={b} labelWidth={84} defaultValue={k === 'midpoint' || k === 'feather' ? 50 : 0} onChange={(v) => setS('vig' + k, (x) => ({ ...x, vignette: { ...x.vignette, [k]: v } }))} onCommit={() => endLiveEdit()} />
        </PlainRow>
      ))}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Effects

function EffectSection({ ctx, fx, index, count }: { ctx: Ctx; fx: Effect; index: number; count: number }) {
  const { clip } = ctx;
  const setFx = (label: string, fn: (e: Effect) => Effect) => commitClip(clip, label, (c) => ({ ...c, fx: c.fx.map((e) => (e.id === fx.id ? fn(e) : e)) }));
  const move = (d: number) =>
    commitClip(clip, 'Reorder Effects', (c) => {
      const arr = [...c.fx];
      const j = index + d;
      if (j < 0 || j >= arr.length) return c;
      [arr[index], arr[j]] = [arr[j], arr[index]];
      return { ...c, fx: arr };
    });
  return (
    <Panel
      title={<SectionHead title={FX_LABELS[fx.type as FxType] ?? fx.type} />}
      enabled={fx.enabled}
      onEnabledChange={(v) => setFx(v ? 'Enable Effect' : 'Disable Effect', (e) => ({ ...e, enabled: v }))}
      right={
        <>
          <button type="button" className="icon-btn small" title="Move up" disabled={index === 0} onClick={() => move(-1)}>
            <Icon name="chevronUp" size={12} />
          </button>
          <button type="button" className="icon-btn small" title="Move down" disabled={index === count - 1} onClick={() => move(1)}>
            <Icon name="chevronDown" size={12} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            title="Remove effect"
            onClick={() => commitClip(clip, 'Remove Effect', (c) => ({ ...c, fx: c.fx.filter((e) => e.id !== fx.id), kf: Object.fromEntries(Object.entries(c.kf).filter(([k]) => !k.startsWith(`fx:${fx.id}:`))) }))}
          >
            <Icon name="trash" size={12} />
          </button>
        </>
      }
    >
      {FX_PARAMS[fx.type].map((p) => (
        <ParamSlider key={p.key} ctx={ctx} pkey={`fx:${fx.id}:${p.key}`} label={p.label} min={p.min} max={p.max} step={p.step} suffix={p.suffix} def={p.def} precision={p.step < 1 ? 1 : 0} />
      ))}
      {fx.type === 'tint' && (
        <PlainRow>
          <div className="row">
            <span className="ec-label">Map Black to</span>
            <ColorSwatch value={hexToRgba(String(fx.params.black))} alpha={false} size={18} onChange={(c) => liveClip(clip, 'tintb' + fx.id, 'Tint', (x) => ({ ...x, fx: x.fx.map((e) => (e.id === fx.id ? { ...e, params: { ...e.params, black: rgbaToHex(c) } } : e)) }))} />
            <span className="ec-label" style={{ width: 'auto' }}>
              White to
            </span>
            <ColorSwatch value={hexToRgba(String(fx.params.white))} alpha={false} size={18} onChange={(c) => liveClip(clip, 'tintw' + fx.id, 'Tint', (x) => ({ ...x, fx: x.fx.map((e) => (e.id === fx.id ? { ...e, params: { ...e.params, white: rgbaToHex(c) } } : e)) }))} />
          </div>
        </PlainRow>
      )}
      {fx.type === 'blur' && (
        <PlainRow>
          <Checkbox checked={fx.params.repeatEdges !== false} onChange={(v) => setFx('Repeat Edge Pixels', (e) => ({ ...e, params: { ...e.params, repeatEdges: v } }))}>
            Repeat Edge Pixels
          </Checkbox>
        </PlainRow>
      )}
      {FX_PARAMS[fx.type].length === 0 && fx.type !== 'tint' && (
        <PlainRow>
          <span className="faint">No parameters.</span>
        </PlainRow>
      )}
    </Panel>
  );
}

