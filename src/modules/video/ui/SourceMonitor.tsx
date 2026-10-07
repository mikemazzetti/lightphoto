import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/platform/api';
import { Icon } from '@/ui/Icon';
import { exactFps, formatDuration, secondsTimecode } from '../model/time';
import type { MediaItem } from '../model/types';
import { peaks } from '../engine/media';
import { renderTitle } from '../engine/titles';
import * as A from '../state/actions';
import { getState, useVideo } from '../state/store';
import { setDragPayload, DND_MIME } from '../timeline/dnd';
import { TransportButton } from './ProgramMonitor';

/** Imperative controls for keyboard shortcuts while the Source monitor has focus. */
export const sourceApi: {
  toggle: (() => void) | null;
  step: ((n: number) => void) | null;
  shuttle: ((dir: 1 | -1 | 0) => void) | null;
  markIn: (() => void) | null;
  markOut: (() => void) | null;
  clearMarks: (() => void) | null;
  home: (() => void) | null;
  end: (() => void) | null;
} = { toggle: null, step: null, shuttle: null, markIn: null, markOut: null, clearMarks: null, home: null, end: null };

export function SourceMonitor() {
  const sourceId = useVideo((s) => s.sourceId);
  const item = useVideo((s) => s.project.media.find((m) => m.id === s.sourceId) ?? null);
  if (!sourceId || !item) {
    return (
      <div className="vid-monitor">
        <div className="vid-monitor-view">
          <div className="empty-state" style={{ gap: 6 }}>
            <Icon name="film" size={28} />
            <p className="faint">Double-click a clip in the Project panel to open it here, set In/Out, then Insert (,) or Overwrite (.).</p>
          </div>
        </div>
      </div>
    );
  }
  return <SourceView key={item.id} item={item} />;
}

function SourceView({ item }: { item: MediaItem }) {
  const timed = (item.kind === 'video' || item.kind === 'audio') && !!item.path;
  const mediaRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLCanvasElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const fps = item.fps || 30;
  const dur = item.duration || 0;
  const markIn = item.markIn ?? null;
  const markOut = item.markOut ?? null;
  const shuttleRate = useRef(0);
  const reverseTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaVersion = useVideo((s) => s.mediaVersion);
  const marks = useRef({ markIn, markOut });
  marks.current = { markIn, markOut };

  const el = () => mediaRef.current;
  const stopReverse = () => {
    if (reverseTimer.current) clearInterval(reverseTimer.current);
    reverseTimer.current = null;
  };

  useEffect(() => {
    const v = el();
    if (!v) return;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (tcRef.current) tcRef.current.textContent = secondsTimecode(v.currentTime, fps);
      drawBar(v.currentTime);
    };
    raf = requestAnimationFrame(loop);
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      setTime(v.currentTime);
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onPause);
    if (markIn !== null) v.currentTime = markIn;
    return () => {
      cancelAnimationFrame(raf);
      stopReverse();
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onPause);
      v.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // Stop at Out point.
  useEffect(() => {
    const v = el();
    if (!v) return;
    const onTime = () => {
      if (markOut !== null && !v.paused && v.currentTime >= markOut && shuttleRate.current <= 1) {
        v.pause();
        v.currentTime = markOut;
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [markOut]);

  const drawBar = (t: number) => {
    const c = barRef.current;
    if (!c) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#141416';
    ctx.fillRect(0, 0, w, h);
    if (!dur) return;
    const { markIn, markOut } = marks.current;
    const pk = peaks.get(item.id);
    if (pk && item.kind === 'audio') {
      ctx.fillStyle = '#2f7a52';
      const data = pk.levels[0];
      for (let x = 0; x < w; x++) {
        const a = Math.floor(((x / w) * dur) * pk.rate);
        const b = Math.max(a + 1, Math.floor((((x + 1) / w) * dur) * pk.rate));
        let mx = 0;
        for (let i = a; i < b && i < data.length; i++) mx = Math.max(mx, data[i]);
        const hh = mx * (h - 4);
        ctx.fillRect(x, (h - hh) / 2, 1, hh);
      }
    }
    const xi = markIn !== null ? (markIn / dur) * w : 0;
    const xo = markOut !== null ? (markOut / dur) * w : w;
    if (markIn !== null || markOut !== null) {
      ctx.fillStyle = 'rgba(110,140,255,0.28)';
      ctx.fillRect(xi, 0, xo - xi, h);
      ctx.fillStyle = '#9fb4ff';
      if (markIn !== null) ctx.fillRect(xi, 0, 2, h);
      if (markOut !== null) ctx.fillRect(xo - 2, 0, 2, h);
    }
    const x = (t / dur) * w;
    ctx.fillStyle = '#4d9bff';
    ctx.fillRect(Math.round(x) - 1, 0, 2, h);
  };

  useLayoutEffect(() => drawBar(el()?.currentTime ?? 0));

  const seekTo = (t: number, fast = false) => {
    const v = el();
    if (!v) return;
    t = Math.max(0, Math.min(dur || v.duration || 0, t));
    if (fast && typeof v.fastSeek === 'function') v.fastSeek(t);
    else v.currentTime = t;
    setTime(t);
  };

  const toggle = () => {
    const v = el();
    if (!v) return;
    stopReverse();
    shuttleRate.current = 0;
    v.playbackRate = 1;
    if (v.paused) {
      if (markOut !== null && v.currentTime >= markOut - 0.01) v.currentTime = markIn ?? 0;
      else if (v.currentTime >= (dur || v.duration) - 0.01) v.currentTime = markIn ?? 0;
      void v.play().catch(() => {});
    } else v.pause();
  };

  const step = (n: number) => {
    const v = el();
    if (!v) return;
    stopReverse();
    v.pause();
    seekTo(v.currentTime + n / exactFps(fps));
  };

  const shuttle = (dir: 1 | -1 | 0) => {
    const v = el();
    if (!v) return;
    if (dir === 0) {
      stopReverse();
      shuttleRate.current = 0;
      v.pause();
      return;
    }
    const cur = shuttleRate.current;
    const next = Math.sign(cur) === dir ? Math.min(8, Math.abs(cur) * 2) * dir : dir;
    shuttleRate.current = next;
    stopReverse();
    if (next > 0) {
      v.playbackRate = next;
      void v.play().catch(() => {});
    } else {
      v.pause();
      const sp = -next;
      reverseTimer.current = setInterval(() => {
        const nt = v.currentTime - (sp * 1) / 15;
        if (nt <= 0) {
          stopReverse();
          v.currentTime = 0;
          return;
        }
        if (!v.seeking) v.currentTime = nt;
      }, 1000 / 15);
    }
  };

  const setIn = () => A.setMediaMarks(item.id, el()?.currentTime ?? 0, markOut !== null && markOut <= (el()?.currentTime ?? 0) ? null : undefined);
  const setOut = () => A.setMediaMarks(item.id, markIn !== null && markIn >= (el()?.currentTime ?? 0) ? null : undefined, el()?.currentTime ?? 0);

  useEffect(() => {
    sourceApi.toggle = toggle;
    sourceApi.step = step;
    sourceApi.shuttle = shuttle;
    sourceApi.markIn = timed ? setIn : null;
    sourceApi.markOut = timed ? setOut : null;
    sourceApi.clearMarks = () => A.setMediaMarks(item.id, null, null);
    sourceApi.home = () => seekTo(0);
    sourceApi.end = () => seekTo(dur);
    return () => {
      for (const k of Object.keys(sourceApi) as (keyof typeof sourceApi)[]) sourceApi[k] = null;
    };
  });

  const onBarDown = (e: React.PointerEvent) => {
    const c = e.currentTarget as HTMLElement;
    c.setPointerCapture(e.pointerId);
    const r = c.getBoundingClientRect();
    const v = el();
    v?.pause();
    const at = (x: number) => ((x - r.left) / r.width) * dur;
    seekTo(at(e.clientX), true);
    const move = (ev: PointerEvent) => seekTo(at(ev.clientX), true);
    const up = (ev: PointerEvent) => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      seekTo(at(ev.clientX), false);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
  };

  const startDrag = (e: React.DragEvent) => {
    setDragPayload({ kind: 'media', ids: [item.id] });
    e.dataTransfer.setData(DND_MIME, item.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const spanDur = timed ? (markOut ?? dur) - (markIn ?? 0) : 0;

  return (
    <div className="vid-monitor" onPointerDown={() => useVideo.setState({ focus: 'source' })}>
      <div className="vid-monitor-view source" draggable onDragStart={startDrag} onDragEnd={() => setDragPayload(null)} title="Drag to the timeline">
        {timed ? (
          <>
            <video ref={mediaRef} className="vid-source-media" src={api.fileUrl(item.path!)} crossOrigin="anonymous" preload="auto" playsInline onDoubleClick={toggle} />
            {item.kind === 'audio' && (
              <div className="vid-source-audio">
                <Icon name="music" size={34} />
                <span>{item.name}</span>
              </div>
            )}
          </>
        ) : item.kind === 'image' && item.path ? (
          <img className="vid-source-media" src={api.fileUrl(item.path)} crossOrigin="anonymous" alt="" draggable={false} />
        ) : item.kind === 'title' ? (
          <TitlePreview item={item} />
        ) : item.kind === 'matte' ? (
          <div className="vid-source-matte" style={{ background: item.color }} />
        ) : (
          <div className="empty-state">
            <p className="faint">Adjustment layers apply their effects to everything on the tracks below.</p>
          </div>
        )}
        {item.missing && (
          <div className="empty-state" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <p>Media offline</p>
          </div>
        )}
      </div>
      {timed && <canvas ref={barRef} className="vid-source-bar" onPointerDown={onBarDown} data-v={mediaVersion} />}
      <div className="vid-monitor-bar">
        <span className="vid-tc blue" ref={tcRef}>
          {secondsTimecode(time, fps)}
        </span>
        <span className="faint ellipsis" style={{ flex: 1, textAlign: 'center' }}>
          {item.name}
        </span>
        {timed && (
          <span className="vid-tc dim" title="In/Out duration">
            {secondsTimecode(spanDur, fps)}
          </span>
        )}
        {!timed && <span className="faint">{item.kind === 'image' ? `${item.width}×${item.height}` : formatDuration(A.STILL_SECONDS)}</span>}
      </div>
      <div className="vid-transport">
        <TransportButton icon="chevronLeft" title="Mark In (I)" onClick={() => timed && setIn()} />
        <TransportButton icon="chevronRight" title="Mark Out (O)" onClick={() => timed && setOut()} />
        <span className="sep-v" />
        <TransportButton icon="skipBack" title="Go to In" onClick={() => seekTo(markIn ?? 0)} />
        <TransportButton icon="stepBack" title="Step Back (←)" onClick={() => step(-1)} />
        <button type="button" className="icon-btn vid-play" title="Play/Pause (Space)" onClick={toggle} disabled={!timed} onMouseDown={(e) => e.preventDefault()}>
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <TransportButton icon="stepForward" title="Step Forward (→)" onClick={() => step(1)} />
        <TransportButton icon="skipForward" title="Go to Out" onClick={() => seekTo(markOut ?? dur)} />
        <span className="sep-v" />
        <TransportButton icon="download" title="Insert (,)" onClick={() => A.sourceEdit('insert')} />
        <TransportButton icon="paste" title="Overwrite (.)" onClick={() => A.sourceEdit('overwrite')} />
      </div>
    </div>
  );
}

function TitlePreview({ item }: { item: MediaItem }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const seq = getState().project.seq;
  useEffect(() => {
    if (!item.title || !ref.current) return;
    const w = Math.round(seq.width / 2);
    const h = Math.round(seq.height / 2);
    const c = ref.current;
    c.width = w;
    c.height = h;
    const src = renderTitle(item.title, w, h);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src as CanvasImageSource, 0, 0);
  }, [item.title, seq.width, seq.height]);
  return <canvas ref={ref} className="vid-source-media checker-dark" />;
}
