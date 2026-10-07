import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { uid } from '@/core/util/async';
import { api } from '@/platform/api';
import { errorToast, toast } from '@/state/app';
import { Select } from '@/ui/controls';
import { Icon, IconName } from '@/ui/Icon';
import { evalLayer } from '../model/evaluate';
import { setParam } from '../model/keyframes';
import { clipEnd, sequenceEnd } from '../model/ops';
import { timecode } from '../model/time';
import type { Clip, MediaItem, Sequence } from '../model/types';
import { Player } from '../engine/player';
import * as A from '../state/actions';
import { mapClips } from '../state/clips';
import { endLiveEdit, getState, liveEdit, mediaLookup, useVideo } from '../state/store';
import { transport } from '../state/transport';

export const programApi: { player: Player | null } = { player: null };

export function TransportButton({ icon, title, onClick, active }: { icon: IconName; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" className={'icon-btn small' + (active ? ' active' : '')} title={title} onClick={onClick} onMouseDown={(e) => e.preventDefault()}>
      <Icon name={icon} size={14} />
    </button>
  );
}

/** Corners (sequence px) of a clip's transformed frame at the current playhead, or null. */
function clipQuad(c: Clip, m: MediaItem, seq: Sequence, frame: number): { pts: [number, number][]; anchor: [number, number]; center: [number, number] } | null {
  if (frame < c.start || frame >= clipEnd(c) || m.kind === 'adjustment' || m.kind === 'audio') return null;
  const L = evalLayer(c, m, frame, seq.fps);
  const generated = m.kind === 'title' || m.kind === 'matte';
  const w = generated ? seq.width : m.width || seq.width;
  const h = generated ? seq.height : m.height || seq.height;
  const base = c.fit && !generated ? Math.min(seq.width / w, seq.height / h) : 1;
  const sx = L.sx * base;
  const sy = L.sy * base;
  const px = seq.width / 2 + L.x;
  const py = seq.height / 2 + L.y;
  const ax = w / 2 + L.anchorX;
  const ay = h / 2 + L.anchorY;
  const th = (L.rotation * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const mo = c.motion;
  const l = (mo.cropL / 100) * w;
  const t = (mo.cropT / 100) * h;
  const r = w - (mo.cropR / 100) * w;
  const b = h - (mo.cropB / 100) * h;
  const map = (x: number, y: number): [number, number] => {
    const dx = (x - ax) * sx;
    const dy = (y - ay) * sy;
    return [px + cs * dx - sn * dy, py + sn * dx + cs * dy];
  };
  return { pts: [map(l, t), map(r, t), map(r, b), map(l, b)], anchor: [px, py], center: map((l + r) / 2, (t + b) / 2) };
}

function inside(p: [number, number], poly: [number, number][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function ProgramMonitor() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const monitorZoom = useVideo((s) => s.monitorZoom);
  const playbackRes = useVideo((s) => s.playbackRes);
  const safe = useVideo((s) => s.safeMargins);
  const loop = useVideo((s) => s.loop);
  const playing = useVideo((s) => s.playing);
  const seq = useVideo((s) => s.project.seq);
  const drag = useRef<null | { kind: 'move' | 'scale'; clip: Clip; x0: number; y0: number; v0: [number, number]; s0: number; d0: number; center: [number, number]; key: string }>(null);

  useEffect(() => {
    let p: Player;
    try {
      p = new Player(canvasRef.current!, hostRef.current!);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    programApi.player = p;
    p.onFrame = drawOverlay;
    return () => {
      p.dispose();
      if (programApi.player === p) programApi.player = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      for (const c of [canvasRef.current!, overRef.current!]) {
        c.width = Math.max(2, Math.round(r.width * dpr));
        c.height = Math.max(2, Math.round(r.height * dpr));
      }
      programApi.player?.invalidate();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Timecode readout without React renders.
  useEffect(() => {
    const upd = () => {
      if (tcRef.current) tcRef.current.textContent = timecode(transport.frameInt, getState().project.seq.fps);
    };
    upd();
    return transport.subscribe(upd);
  }, []);

  useEffect(() => {
    programApi.player?.invalidate();
  }, [safe]);

  // Selection changes don't re-render the frame; refresh the transform box directly.
  useEffect(
    () =>
      useVideo.subscribe((s, prev) => {
        if (s.selection !== prev.selection || s.safeMargins !== prev.safeMargins) drawOverlay();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function drawOverlay() {
    const c = overRef.current;
    const p = programApi.player;
    if (!c || !p) return;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const s = getState();
    const sq = s.project.seq;
    const [rx, ry, rw, rh] = p.viewRect(sq);
    const dpr = window.devicePixelRatio || 1;
    if (s.safeMargins) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = dpr;
      for (const k of [0.9, 0.8]) ctx.strokeRect(rx + (rw * (1 - k)) / 2, ry + (rh * (1 - k)) / 2, rw * k, rh * k);
      const cx = rx + rw / 2;
      const cy = ry + rh / 2;
      ctx.beginPath();
      ctx.moveTo(cx - 10 * dpr, cy);
      ctx.lineTo(cx + 10 * dpr, cy);
      ctx.moveTo(cx, cy - 10 * dpr);
      ctx.lineTo(cx, cy + 10 * dpr);
      ctx.stroke();
    }
    if (transport.playing) return;
    const clip = A.primaryClip(s.project, s.selection);
    const m = clip && mediaLookup(s.project)(clip.mediaId);
    if (!clip || !m || s.project.seq.tracks.find((t) => t.id === clip.trackId)?.kind !== 'video') return;
    const q = clipQuad(clip, m, sq, transport.frameInt);
    if (!q) return;
    const k = rw / sq.width;
    const toPx = ([x, y]: [number, number]): [number, number] => [rx + x * k, ry + y * k];
    const pts = q.pts.map(toPx);
    ctx.strokeStyle = '#d8d8d8';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    const hs = 4 * dpr;
    for (const [x, y] of pts) ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
    const [ax, ay] = toPx(q.anchor);
    ctx.beginPath();
    ctx.arc(ax, ay, 5 * dpr, 0, Math.PI * 2);
    ctx.moveTo(ax - 8 * dpr, ay);
    ctx.lineTo(ax + 8 * dpr, ay);
    ctx.moveTo(ax, ay - 8 * dpr);
    ctx.lineTo(ax, ay + 8 * dpr);
    ctx.stroke();
  }

  const toSeq = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const p = programApi.player;
    if (!p) return null;
    const r = overRef.current!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const [rx, ry, rw] = p.viewRect();
    const k = rw / getState().project.seq.width;
    return [((e.clientX - r.left) * dpr - rx) / k, ((e.clientY - r.top) * dpr - ry) / k];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    useVideo.setState({ focus: 'program' });
    if (e.button !== 0 || transport.playing) return;
    const s = getState();
    const pt = toSeq(e);
    if (!pt) return;
    const sq = s.project.seq;
    const lookup = mediaLookup(s.project);
    const f = transport.frameInt;
    let clip = A.primaryClip(s.project, s.selection);
    let q = clip ? clipQuad(clip, lookup(clip.mediaId)!, sq, f) : null;
    const dpr = window.devicePixelRatio || 1;
    const k = programApi.player!.viewRect()[2] / sq.width / dpr;
    const near = q?.pts.findIndex(([x, y]) => Math.hypot(x - pt[0], y - pt[1]) * k < 8) ?? -1;
    if (!q || (near < 0 && !inside(pt, q.pts))) {
      // Pick the topmost visible clip under the cursor.
      const vt = sq.tracks.filter((t) => t.kind === 'video' && !t.hidden).reverse();
      clip = null;
      q = null;
      for (const t of vt) {
        const c = sq.clips.find((x) => x.trackId === t.id && x.start <= f && clipEnd(x) > f && x.enabled);
        const m = c && lookup(c.mediaId);
        const qq = c && m ? clipQuad(c, m, sq, f) : null;
        if (c && qq && inside(pt, qq.pts)) {
          clip = c;
          q = qq;
          break;
        }
      }
      if (!clip || !q) return;
      A.selectClips([clip.id]);
      useVideo.setState({ topLeftTab: 'effectControls' });
    }
    if (!clip || !q) return;
    const t = s.project.seq.tracks.find((x) => x.id === clip.trackId);
    if (t?.locked) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const local = f - clip.start;
    const L = evalLayer(clip, lookup(clip.mediaId)!, f, sq.fps);
    if (near >= 0) {
      drag.current = { kind: 'scale', clip, x0: pt[0], y0: pt[1], v0: [L.x, L.y], s0: L.sy * 100, d0: Math.hypot(pt[0] - q.anchor[0], pt[1] - q.anchor[1]), center: q.anchor, key: uid('pm') };
    } else drag.current = { kind: 'move', clip, x0: pt[0], y0: pt[1], v0: [L.x, L.y], s0: L.sy * 100, d0: 1, center: q.anchor, key: uid('pm') };
    void local;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pt = toSeq(e);
    if (!pt) return;
    const local = transport.frameInt - d.clip.start;
    if (d.kind === 'move') {
      let nx = d.v0[0] + pt[0] - d.x0;
      let ny = d.v0[1] + pt[1] - d.y0;
      if (e.shiftKey) {
        if (Math.abs(pt[0] - d.x0) > Math.abs(pt[1] - d.y0)) ny = d.v0[1];
        else nx = d.v0[0];
      }
      liveEdit(d.key, 'Position', (p) => mapClips(p, d.clip.id, (c) => setParam(setParam(c, 'x', local, Math.round(nx * 10) / 10), 'y', local, Math.round(ny * 10) / 10)));
    } else {
      const dist = Math.hypot(pt[0] - d.center[0], pt[1] - d.center[1]);
      const sc = Math.max(1, Math.round(((d.s0 * dist) / Math.max(1, d.d0)) * 10) / 10);
      liveEdit(d.key, 'Scale', (p) => mapClips(p, d.clip.id, (c) => setParam(c, 'scale', local, sc)));
    }
  };

  const onPointerUp = () => {
    if (drag.current) endLiveEdit();
    drag.current = null;
  };

  const snapshot = async () => {
    const p = programApi.player;
    if (!p) return;
    try {
      const blob = await p.snapshot();
      const name = `${getState().project.seq.name} ${timecode(transport.frameInt, getState().project.seq.fps).replace(/:/g, '-')}.png`;
      const path = await api.saveDialog({ title: 'Export Frame', defaultPath: name, filters: [{ name: 'PNG', extensions: ['png'] }] });
      if (!path) return;
      await api.writeFile(path, blob);
      toast('Frame exported', 'success');
    } catch (e) {
      errorToast(e, 'Export frame failed');
    }
  };

  const total = sequenceEnd(seq);

  return (
    <div className="vid-monitor">
      <div className="vid-monitor-view" ref={wrapRef}>
        <canvas ref={canvasRef} className="vid-gl" />
        <canvas ref={overRef} className="vid-gl over" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={() => useVideo.setState({ topLeftTab: 'effectControls' })} />
        <div ref={hostRef} className="vid-video-host" />
        {err && (
          <div className="empty-state">
            <p>Program monitor unavailable: {err}</p>
          </div>
        )}
      </div>
      <div className="vid-monitor-bar">
        <span className="vid-tc blue" ref={tcRef} />
        <Select
          value={monitorZoom}
          options={[
            { value: 0, label: 'Fit' },
            { value: 25, label: '25%' },
            { value: 50, label: '50%' },
            { value: 75, label: '75%' },
            { value: 100, label: '100%' },
            { value: 150, label: '150%' },
            { value: 200, label: '200%' },
          ]}
          onChange={(v) => {
            useVideo.setState({ monitorZoom: v });
            (document.activeElement as HTMLElement | null)?.blur();
          }}
          title="Zoom level"
          style={{ height: 20, fontSize: 11 }}
        />
        <div className="spacer" />
        <Select
          value={playbackRes}
          options={[
            { value: 1, label: 'Full' },
            { value: 0.5, label: '1/2' },
            { value: 0.25, label: '1/4' },
          ]}
          onChange={(v) => {
            useVideo.setState({ playbackRes: v as 1 | 0.5 | 0.25 });
            (document.activeElement as HTMLElement | null)?.blur();
          }}
          title="Playback resolution"
          style={{ height: 20, fontSize: 11 }}
        />
        <span className="vid-tc dim" title="Sequence duration">
          {timecode(total, seq.fps)}
        </span>
      </div>
      <div className="vid-transport">
        <TransportButton icon="marker" title="Add Marker (M)" onClick={() => A.addMarker()} />
        <TransportButton icon="chevronLeft" title="Mark In (I)" onClick={() => A.setSeqInOut('in')} />
        <TransportButton icon="chevronRight" title="Mark Out (O)" onClick={() => A.setSeqInOut('out')} />
        <span className="sep-v" />
        <TransportButton icon="skipBack" title="Go to In / previous edit (↑)" onClick={() => (seq.inPoint !== null && transport.frameInt !== seq.inPoint ? transport.seek(seq.inPoint) : A.gotoEdit(-1))} />
        <TransportButton icon="stepBack" title="Step Back 1 Frame (←)" onClick={() => A.step(-1)} />
        <button type="button" className="icon-btn vid-play" title="Play/Pause (Space)" onClick={() => transport.toggle()} onMouseDown={(e) => e.preventDefault()}>
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <TransportButton icon="stepForward" title="Step Forward 1 Frame (→)" onClick={() => A.step(1)} />
        <TransportButton icon="skipForward" title="Go to Out / next edit (↓)" onClick={() => (seq.outPoint !== null && transport.frameInt !== Math.max(0, seq.outPoint - 1) ? transport.seek(Math.max(0, seq.outPoint - 1)) : A.gotoEdit(1))} />
        <span className="sep-v" />
        <TransportButton icon="loop" title="Loop Playback" active={loop} onClick={() => useVideo.setState({ loop: !loop })} />
        <TransportButton icon="grid" title="Safe Margins" active={safe} onClick={() => useVideo.setState({ safeMargins: !safe })} />
        <TransportButton icon="upload" title="Lift (;)" onClick={() => A.liftExtract(false)} />
        <TransportButton icon="export" title="Extract (')" onClick={() => A.liftExtract(true)} />
        <TransportButton icon="image" title="Export Frame" onClick={() => void snapshot()} />
      </div>
    </div>
  );
}
