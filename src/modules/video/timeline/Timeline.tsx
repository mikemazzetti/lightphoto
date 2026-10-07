/**
 * Timeline panel: React track headers + two stacked canvases (static content / overlay). The overlay
 * (playhead, drag ghosts, marquee) redraws in requestAnimationFrame from the transport, so playback
 * never re-renders React.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, kindOf } from '@/platform/api';
import { MenuItem, openContextMenu, toast } from '@/state/app';
import { cx } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { promptDialog } from '@/ui/overlays';
import { uid } from '@/core/util/async';
import { clipIndexAt, seqIndex } from '../model/evaluate';
import { clampTrackDelta, clipEnd, gapAt, headroomFrames, maxClipFrames, moveClips, rippleTrim, sequenceEnd, snapDelta, snapPoints, tracksOf, trimHead, trimTail, withLinked } from '../model/ops';
import { parseTimecode, timecode } from '../model/time';
import { TRANSITION_LABELS, type Clip, type Marker, type Project, type Track, type TransitionType } from '../model/types';
import { importPaths } from '../engine/media';
import * as A from '../state/actions';
import { mapClips, withSeq } from '../state/clips';
import { edit, endLiveEdit, getState, liveEdit, mediaLookup, useVideo } from '../state/store';
import { transport } from '../state/transport';
import { openMarkerDialog, openSpeedDialog, openTransitionDialog } from '../ui/dialogs';
import { timelineApi } from './api';
import { DND_MIME, getDragPayload } from './dnd';
import { drawOverlay, drawTimeline, OverlayState } from './draw';
import { CLIP_COLORS, EDGE_PX, frameToX, HEADER_W, LABEL_H, layoutRows, Row, rowAt, RULER_H, rowTop, transitionRegion, View, xToFrame } from './layout';

type Hit =
  | { kind: 'ruler'; marker: Marker | null }
  | { kind: 'clip'; clip: Clip; row: Row; part: 'body' | 'head' | 'tail' | 'fadeIn' | 'fadeOut' }
  | { kind: 'trans'; clip: Clip; edge: 'in' | 'out'; row: Row; side: 'body' | 'start' | 'end'; cut: boolean }
  | { kind: 'empty'; row: Row | null };

type Drag =
  | { kind: 'scrub' }
  | { kind: 'marker'; id: string; moved: boolean; frame: number }
  | { kind: 'move'; anchor: Clip; ids: Set<string>; x0: number; y0: number; moved: boolean; dF: number; dV: number; dA: number; alt: boolean; toggleOnUp: boolean }
  | { kind: 'trim'; anchor: Clip; ids: Set<string>; edge: 'head' | 'tail'; ripple: boolean; x0: number; delta: number }
  | { kind: 'fade'; clip: Clip; edge: 'in' | 'out'; key: string }
  | { kind: 'transDur'; clip: Clip; edge: 'in' | 'out'; side: 'start' | 'end'; x0: number; start: number; factor: number; key: string }
  | { kind: 'empty'; x0: number; y0: number; row: Row | null; shift: boolean; marquee: boolean; x1: number; y1: number };

const MIN_ZOOM = 0.004;
const MAX_ZOOM = 60;

export function Timeline() {
  const project = useVideo((s) => s.project);
  const selection = useVideo((s) => s.selection);
  const gap = useVideo((s) => s.gap);
  const transition = useVideo((s) => s.transition);
  const selectedTracks = useVideo((s) => s.selectedTracks);
  const zoom = useVideo((s) => s.zoom);
  const scrollX = useVideo((s) => s.scrollX);
  const scrollY = useVideo((s) => s.scrollY);
  const tool = useVideo((s) => s.tool);
  const snapping = useVideo((s) => s.snapping);
  const linkedSelection = useVideo((s) => s.linkedSelection);
  const mediaVersion = useVideo((s) => s.mediaVersion);
  const seq = project.seq;
  const layout = layoutRows(seq);

  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const hscrollRef = useRef<HTMLDivElement>(null);
  const vscrollRef = useRef<HTMLDivElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 800, h: 300 });
  const drag = useRef<Drag | null>(null);
  const hover = useRef<{ clip: string | null; x: number | null }>({ clip: null, x: null });
  const overlay = useRef<Pick<OverlayState, 'ghosts' | 'snapX' | 'marquee' | 'label'>>({ ghosts: [], snapX: null, marquee: null, label: null });
  const baseDirty = useRef(true);
  const overDirty = useRef(true);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  /** Current view straight from the store (handlers may run several times between renders). */
  const cv = (): View => {
    const s = getState();
    return { zoom: s.zoom, scrollX: s.scrollX, scrollY: s.scrollY, width: sizeRef.current.w, height: sizeRef.current.h };
  };

  // ---- sizing
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(50, Math.floor(r.width)), h: Math.max(50, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [baseRef.current!, overRef.current!]) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
      c.style.width = size.w + 'px';
      c.style.height = size.h + 'px';
    }
    baseDirty.current = overDirty.current = true;
  }, [size.w, size.h]);

  useEffect(() => {
    baseDirty.current = true;
  }, [size]);
  useEffect(
    () =>
      useVideo.subscribe((s, p) => {
        if (s.project !== p.project || s.selection !== p.selection || s.gap !== p.gap || s.transition !== p.transition || s.selectedTracks !== p.selectedTracks || s.zoom !== p.zoom || s.scrollX !== p.scrollX || s.scrollY !== p.scrollY || s.mediaVersion !== p.mediaVersion)
          baseDirty.current = true;
        if (s.tool !== p.tool) overDirty.current = true;
      }),
    [],
  );

  // ---- render loop
  useEffect(() => {
    let raf = 0;
    let lastPh = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = getState();
      const v = cv();
      const dpr = window.devicePixelRatio || 1;
      // Auto-scroll (page) while playing.
      if (transport.playing && !drag.current) {
        const px = frameToX(v, transport.frame);
        if (px > v.width - 24 || px < 0) {
          const nx = Math.max(0, transport.frame * v.zoom - 40);
          useVideo.setState({ scrollX: nx });
        }
      }
      if (baseDirty.current) {
        baseDirty.current = false;
        overDirty.current = true;
        const ctx = baseRef.current!.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawTimeline(ctx, {
          seq: s.project.seq,
          media: mediaLookup(s.project),
          layout: layoutRows(s.project.seq),
          view: v,
          selection: new Set(s.selection),
          transition: s.transition,
          gap: s.gap,
          selectedTracks: new Set(s.selectedTracks),
          hoverClip: hover.current.clip,
        });
      }
      const ph = transport.frame;
      if (ph !== lastPh) {
        lastPh = ph;
        overDirty.current = true;
        if (tcRef.current) tcRef.current.textContent = timecode(transport.frameInt, s.project.seq.fps);
      }
      if (overDirty.current) {
        overDirty.current = false;
        const ctx = overRef.current!.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawOverlay(ctx, { view: v, playhead: transport.frame, fps: s.project.seq.fps, ...overlay.current, hoverX: hover.current.x, razor: s.tool === 'razor' });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- scroll sync
  const contentFrames = Math.max(sequenceEnd(seq) + Math.round(seq.fps * 30), (size.w / zoom) * 1.05);
  const contentW = contentFrames * zoom;
  useEffect(() => {
    const el = hscrollRef.current;
    if (el && Math.abs(el.scrollLeft - scrollX) > 1) el.scrollLeft = scrollX;
  }, [scrollX, contentW]);
  useEffect(() => {
    const el = vscrollRef.current;
    if (el && Math.abs(el.scrollTop - scrollY) > 1) el.scrollTop = scrollY;
  }, [scrollY]);

  const setScroll = useCallback((x: number | null, y: number | null) => {
    const s = getState();
    const v = cv();
    const lay = layoutRows(s.project.seq);
    const maxY = Math.max(0, lay.total - (v.height - RULER_H));
    const patch: Partial<{ scrollX: number; scrollY: number }> = {};
    if (x !== null) patch.scrollX = Math.max(0, x);
    if (y !== null) patch.scrollY = Math.max(0, Math.min(maxY, y));
    useVideo.setState(patch);
  }, []);

  const setZoomAt = useCallback((z: number, anchorX: number) => {
    const v = cv();
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const f = xToFrame(v, anchorX);
    useVideo.setState({ zoom: nz, scrollX: Math.max(0, f * nz - anchorX) });
  }, []);

  // Expose zoom helpers for keyboard shortcuts.
  useEffect(() => {
    timelineApi.zoomBy = (k: number) => {
      const v = cv();
      const px = frameToX(v, transport.frame);
      setZoomAt(v.zoom * k, px >= 0 && px <= v.width ? px : v.width / 2);
    };
    timelineApi.fit = () => {
      const v = cv();
      const end = Math.max(sequenceEnd(getState().project.seq), 30);
      useVideo.setState({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (v.width - 30) / end)), scrollX: 0 });
    };
    timelineApi.reveal = (f: number) => {
      const v = cv();
      const x = frameToX(v, f);
      if (x < 0 || x > v.width - 10) useVideo.setState({ scrollX: Math.max(0, f * v.zoom - v.width / 3) });
    };
    return () => {
      timelineApi.zoomBy = timelineApi.fit = timelineApi.reveal = null;
    };
  }, [setZoomAt]);

  // Wheel (non-passive so we can preventDefault).
  useEffect(() => {
    const el = overRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const v = cv();
      if (e.altKey || e.ctrlKey) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
        setZoomAt(v.zoom * k, x);
        return;
      }
      // Premiere-style: the wheel scrolls time; Shift+wheel scrolls tracks.
      if (e.shiftKey) setScroll(null, v.scrollY + (e.deltaY || e.deltaX));
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) setScroll(v.scrollX + e.deltaX, null);
      else setScroll(v.scrollX + e.deltaY, null);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setScroll, setZoomAt]);

  // ---- hit testing
  const hitTest = (x: number, y: number): Hit => {
    const s = getState();
    const sq = s.project.seq;
    const v = cv();
    if (y < RULER_H) {
      let marker: Marker | null = null;
      for (const m of sq.markers) if (Math.abs(frameToX(v, m.frame) - x) <= 6 && y >= 12) marker = m;
      return { kind: 'ruler', marker };
    }
    const lay = layoutRows(sq);
    const row = rowAt(lay, v, y);
    if (!row) return { kind: 'empty', row: null };
    const sorted = seqIndex(sq).byTrack.get(row.track.id) ?? [];
    const top = rowTop(v, row);
    const bodyTop = top + 1 + (row.h - 2 >= 26 ? LABEL_H : 0);
    // Transitions (drawn on top).
    if (y >= bodyTop && row.track.kind === 'video') {
      for (const c of sorted) {
        if (!c.transIn && !c.transOut) continue;
        for (const edge of ['in', 'out'] as const) {
          const reg = transitionRegion(c, edge, sorted);
          if (!reg) continue;
          const x0 = frameToX(v, reg.start);
          const x1 = frameToX(v, reg.end);
          if (x < x0 - 3 || x > x1 + 3) continue;
          const side = Math.abs(x - x0) <= 4 ? 'start' : Math.abs(x - x1) <= 4 ? 'end' : 'body';
          return { kind: 'trans', clip: c, edge, row, side, cut: reg.cut };
        }
      }
    }
    const f = xToFrame(v, x);
    let i = clipIndexAt(sorted, Math.floor(f));
    // Allow grabbing a tail edge from just outside the clip.
    if (i < 0) {
      const j = clipIndexAt(sorted, Math.floor(xToFrame(v, x - 4)));
      if (j >= 0 && Math.abs(frameToX(v, clipEnd(sorted[j])) - x) <= 4) i = j;
    }
    if (i < 0) return { kind: 'empty', row };
    const c = sorted[i];
    const x0 = frameToX(v, c.start);
    const x1 = frameToX(v, clipEnd(c));
    const w = x1 - x0;
    const clipTop = top + 1;
    if (y < clipTop + 10 && w > 30 && (s.selection.includes(c.id) || hover.current.clip === c.id)) {
      const fi = x0 + c.fadeIn * v.zoom + 4;
      const fo = x1 - c.fadeOut * v.zoom - 4;
      if (Math.abs(x - fi) <= 5) return { kind: 'clip', clip: c, row, part: 'fadeIn' };
      if (Math.abs(x - fo) <= 5) return { kind: 'clip', clip: c, row, part: 'fadeOut' };
    }
    const edgeW = Math.min(EDGE_PX, w / 3);
    if (x - x0 <= edgeW) return { kind: 'clip', clip: c, row, part: 'head' };
    if (x1 - x <= edgeW) return { kind: 'clip', clip: c, row, part: 'tail' };
    return { kind: 'clip', clip: c, row, part: 'body' };
  };

  const cursorFor = (h: Hit, tl: string, meta: boolean): string => {
    if (tl === 'razor' && h.kind === 'clip') return 'crosshair';
    if (h.kind === 'clip') {
      if (h.part === 'head' || h.part === 'tail') return tl === 'ripple' || meta ? 'col-resize' : 'ew-resize';
      if (h.part === 'fadeIn' || h.part === 'fadeOut') return 'pointer';
      return 'default';
    }
    if (h.kind === 'trans') return h.side === 'body' ? 'pointer' : 'ew-resize';
    if (h.kind === 'ruler') return h.marker ? 'grab' : 'text';
    return 'default';
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = overRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const snapFrames = () => 8 / cv().zoom;

  // ---- pointer handlers
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    useVideo.setState({ focus: 'timeline' });
    const { x, y } = local(e);
    const h = hitTest(x, y);
    const s = getState();
    const sq = s.project.seq;
    const v = cv();
    const meta = e.metaKey || e.ctrlKey;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 1) return;
    if (h.kind === 'ruler') {
      if (h.marker) {
        drag.current = { kind: 'marker', id: h.marker.id, moved: false, frame: h.marker.frame };
        transport.seek(h.marker.frame);
        return;
      }
      if (transport.playing) transport.pause();
      transport.setScrubbing(true);
      drag.current = { kind: 'scrub' };
      transport.seek(Math.max(0, Math.round(xToFrame(v, x))));
      return;
    }
    if (h.kind === 'trans') {
      useVideo.setState({ transition: { clipId: h.clip.id, edge: h.edge }, selection: [], gap: null });
      if (h.side !== 'body') {
        const t = h.edge === 'in' ? h.clip.transIn! : h.clip.transOut!;
        const factor = h.cut && t.align === 'center' ? 2 : 1;
        drag.current = { kind: 'transDur', clip: h.clip, edge: h.edge, side: h.side, x0: x, start: t.duration, factor, key: uid('td') };
      }
      return;
    }
    if (h.kind === 'clip') {
      const c = h.clip;
      const track = h.row.track;
      if (s.tool === 'razor') {
        if (track.locked) return toast('Track is locked.', 'warn', 1500);
        let f = Math.round(xToFrame(v, x));
        if (s.snapping) {
          const sd = snapDelta([f], snapPoints(sq, new Set(), transport.frameInt), snapFrames());
          if (sd) f += sd.delta;
        }
        A.razorAt(c.id, f, e.shiftKey);
        return;
      }
      if (h.part === 'fadeIn' || h.part === 'fadeOut') {
        if (track.locked) return;
        drag.current = { kind: 'fade', clip: c, edge: h.part === 'fadeIn' ? 'in' : 'out', key: uid('fd') };
        return;
      }
      // Selection
      const alt = e.altKey;
      const isSel = s.selection.includes(c.id);
      let toggleOnUp = false;
      if (e.shiftKey || meta) {
        if (isSel && h.part === 'body') toggleOnUp = true;
        else if (!isSel) A.selectClips([c.id], 'add', alt);
      } else if (!isSel || alt) A.selectClips([c.id], 'replace', alt);
      if (track.locked) return;
      if (h.part === 'head' || h.part === 'tail') {
        const edgeAt = h.part === 'head' ? c.start : clipEnd(c);
        const group = s.linkedSelection && !alt ? withLinked(sq, [c.id]) : new Set([c.id]);
        const lockedTracks = new Set(sq.tracks.filter((t) => t.locked).map((t) => t.id));
        const ids = new Set([...group].filter((id) => {
          const x2 = sq.clips.find((k) => k.id === id);
          // Linked partners on locked tracks stay untouched.
          return !!x2 && !lockedTracks.has(x2.trackId) && (h.part === 'head' ? x2.start === edgeAt : clipEnd(x2) === edgeAt);
        }));
        drag.current = { kind: 'trim', anchor: c, ids, edge: h.part, ripple: s.tool === 'ripple' || meta, x0: x, delta: 0 };
        return;
      }
      const ids = new Set(getState().selection);
      ids.add(c.id);
      const locked = new Set(sq.tracks.filter((t) => t.locked).map((t) => t.id));
      for (const id of [...ids]) if (locked.has(sq.clips.find((k) => k.id === id)?.trackId ?? '')) ids.delete(id);
      drag.current = { kind: 'move', anchor: c, ids, x0: x, y0: y, moved: false, dF: 0, dV: 0, dA: 0, alt, toggleOnUp };
      return;
    }
    // Empty area
    drag.current = { kind: 'empty', x0: x, y0: y, row: h.row, shift: e.shiftKey || meta, marquee: false, x1: x, y1: y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const d = drag.current;
    const s = getState();
    const sq = s.project.seq;
    const v = cv();
    if (!d) {
      const h = hitTest(x, y);
      overRef.current!.style.cursor = cursorFor(h, s.tool, e.metaKey || e.ctrlKey);
      const hc = h.kind === 'clip' ? h.clip.id : null;
      if (hc !== hover.current.clip) {
        hover.current.clip = hc;
        baseDirty.current = true;
      }
      if (s.tool === 'razor') {
        hover.current.x = h.kind === 'clip' ? x : null;
        overDirty.current = true;
      }
      return;
    }
    const lookup = mediaLookup(s.project);
    overlay.current = { ghosts: [], snapX: null, marquee: null, label: null };
    if (d.kind === 'scrub') {
      let f = Math.max(0, Math.round(xToFrame(v, x)));
      if (e.shiftKey && s.snapping) {
        const sd = snapDelta([f], snapPoints(sq, new Set(), -1), snapFrames());
        if (sd) {
          f += sd.delta;
          overlay.current.snapX = frameToX(v, sd.point);
        }
      }
      transport.seek(f);
      // Edge auto-scroll while scrubbing.
      if (x > v.width - 10) setScroll(v.scrollX + 20, null);
      else if (x < 10) setScroll(v.scrollX - 20, null);
    } else if (d.kind === 'marker') {
      const f = Math.max(0, Math.round(xToFrame(v, x)));
      if (f !== d.frame) {
        d.moved = true;
        d.frame = f;
        overlay.current.snapX = frameToX(v, f);
        overlay.current.label = { x: x + 10, y: 2, text: timecode(f, sq.fps) };
      }
    } else if (d.kind === 'move') {
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
      d.moved = true;
      const moving = sq.clips.filter((c) => d.ids.has(c.id));
      if (!moving.length) return;
      let dF = Math.round((x - d.x0) / v.zoom);
      const gStart = Math.min(...moving.map((c) => c.start));
      const gEnd = Math.max(...moving.map(clipEnd));
      dF = Math.max(dF, -gStart);
      if (s.snapping) {
        const sd = snapDelta([gStart + dF, gEnd + dF], snapPoints(sq, d.ids, transport.frameInt), snapFrames());
        if (sd) {
          dF += sd.delta;
          overlay.current.snapX = frameToX(v, sd.point);
        }
      }
      // Track delta from the row under the pointer.
      const lay = layoutRows(sq);
      const row = rowAt(lay, v, y);
      const anchorTrack = sq.tracks.find((t) => t.id === d.anchor.trackId)!;
      let dT = d.anchor.trackId === anchorTrack.id ? (anchorTrack.kind === 'video' ? d.dV : d.dA) : 0;
      if (row && row.track.kind === anchorTrack.kind) {
        const list = tracksOf(sq, anchorTrack.kind);
        dT = list.indexOf(row.track) - list.indexOf(anchorTrack);
      }
      d.dF = dF;
      d.dV = clampTrackDelta(sq, moving, 'video', dT);
      d.dA = clampTrackDelta(sq, moving, 'audio', dT);
      const vt = tracksOf(sq, 'video');
      const at = tracksOf(sq, 'audio');
      for (const c of moving) {
        const t = sq.tracks.find((k) => k.id === c.trackId)!;
        const list = t.kind === 'video' ? vt : at;
        const dest = list[list.indexOf(t) + (t.kind === 'video' ? d.dV : d.dA)];
        const r = dest && lay.byTrack.get(dest.id);
        if (!r) continue;
        const m = lookup(c.mediaId);
        overlay.current.ghosts.push({ x: frameToX(v, c.start + dF), y: rowTop(v, r) + 1, w: c.duration * v.zoom, h: r.h - 2, color: CLIP_COLORS[t.kind === 'audio' ? 'audio' : m?.kind ?? 'video'] });
      }
      overlay.current.label = { x: x + 12, y: Math.max(RULER_H, y - 26), text: `${dF >= 0 ? '+' : '-'}${timecode(Math.abs(dF), sq.fps)}${d.alt ? '  (copy)' : ''}` };
    } else if (d.kind === 'trim') {
      let delta = Math.round((x - d.x0) / v.zoom);
      const a = d.anchor;
      const edgeFrame = (d.edge === 'head' ? a.start : clipEnd(a)) + delta;
      if (s.snapping) {
        const sd = snapDelta([edgeFrame], snapPoints(sq, d.ids, transport.frameInt), snapFrames());
        if (sd) {
          delta += sd.delta;
          overlay.current.snapX = frameToX(v, sd.point);
        }
      }
      // Clamp against media length and (non-ripple) neighbours.
      for (const id of d.ids) {
        const c = sq.clips.find((k) => k.id === id);
        if (!c) continue;
        const m = lookup(c.mediaId);
        if (d.edge === 'head') {
          delta = Math.min(delta, c.duration - 1);
          delta = Math.max(delta, -headroomFrames(c, m, sq.fps));
          if (!d.ripple) {
            delta = Math.max(delta, -c.start);
            const prevEnd = sq.clips.filter((k) => k.trackId === c.trackId && k.id !== c.id && clipEnd(k) <= c.start).reduce((acc, k) => Math.max(acc, clipEnd(k)), 0);
            delta = Math.max(delta, prevEnd - c.start);
          }
        } else {
          delta = Math.max(delta, 1 - c.duration);
          delta = Math.min(delta, maxClipFrames(c, m, sq.fps) - c.duration);
          if (!d.ripple) {
            const nextStart = sq.clips.filter((k) => k.trackId === c.trackId && k.id !== c.id && k.start >= clipEnd(c)).reduce((acc, k) => Math.min(acc, k.start), Infinity);
            delta = Math.min(delta, nextStart - clipEnd(c));
          }
        }
      }
      d.delta = delta;
      const lay = layoutRows(sq);
      for (const id of d.ids) {
        const c = sq.clips.find((k) => k.id === id);
        const r = c && lay.byTrack.get(c.trackId);
        if (!c || !r) continue;
        let s0 = c.start;
        let e0 = clipEnd(c);
        if (d.edge === 'head') {
          if (d.ripple) e0 -= delta;
          else s0 += delta;
        } else e0 += delta;
        overlay.current.ghosts.push({ x: frameToX(v, s0), y: rowTop(v, r) + 1, w: (e0 - s0) * v.zoom, h: r.h - 2, color: d.ripple ? '#e0b040' : '#ffffff' });
      }
      const newDur = a.duration + (d.edge === 'head' ? -delta : delta);
      overlay.current.label = { x: x + 12, y: Math.max(RULER_H, y - 26), text: `${delta >= 0 ? '+' : '-'}${timecode(Math.abs(delta), sq.fps)}   Duration ${timecode(newDur, sq.fps)}${d.ripple ? '  Ripple' : ''}` };
    } else if (d.kind === 'fade') {
      const c = sq.clips.find((k) => k.id === d.clip.id);
      if (!c) return;
      const x0 = frameToX(v, c.start);
      const x1 = frameToX(v, clipEnd(c));
      const val = Math.max(0, Math.min(c.duration, Math.round((d.edge === 'in' ? x - x0 : x1 - x) / v.zoom)));
      liveEdit(d.key, d.edge === 'in' ? 'Fade In' : 'Fade Out', (p) => mapClips(p, c.id, (k) => (d.edge === 'in' ? { ...k, fadeIn: val } : { ...k, fadeOut: val })));
      overlay.current.label = { x: x + 12, y: Math.max(RULER_H, y - 26), text: `Fade ${d.edge === 'in' ? 'In' : 'Out'} ${timecode(val, sq.fps)}` };
    } else if (d.kind === 'transDur') {
      const df = Math.round((x - d.x0) / v.zoom) * (d.side === 'end' ? 1 : -1);
      const dur = Math.max(1, d.start + df * d.factor);
      liveEdit(d.key, 'Transition Duration', (p) =>
        mapClips(p, d.clip.id, (k) => {
          const t = d.edge === 'in' ? k.transIn : k.transOut;
          if (!t) return k;
          return { ...k, [d.edge === 'in' ? 'transIn' : 'transOut']: { ...t, duration: dur } };
        }),
      );
      overlay.current.label = { x: x + 12, y: Math.max(RULER_H, y - 26), text: `Duration ${timecode(dur, sq.fps)}` };
    } else if (d.kind === 'empty') {
      if (!d.marquee && Math.hypot(x - d.x0, y - d.y0) < 4) return;
      d.marquee = true;
      d.x1 = x;
      d.y1 = y;
      overlay.current.marquee = { x0: d.x0, y0: d.y0, x1: x, y1: y };
    }
    overDirty.current = true;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    overlay.current = { ghosts: [], snapX: null, marquee: null, label: null };
    overDirty.current = true;
    if (!d) return;
    const s = getState();
    const sq = s.project.seq;
    const v = cv();
    if (d.kind === 'scrub') transport.setScrubbing(false);
    else if (d.kind === 'marker' && d.moved) edit('Move Marker', (p) => ({ ...p, seq: { ...p.seq, markers: p.seq.markers.map((m) => (m.id === d.id ? { ...m, frame: d.frame } : m)).sort((a, b) => a.frame - b.frame) } }));
    else if (d.kind === 'move') {
      if (!d.moved) {
        if (d.toggleOnUp) A.selectClips([d.anchor.id], 'toggle', d.alt);
        return;
      }
      if (!d.dF && !d.dV && !d.dA) return;
      if (d.alt) {
        // Duplicate
        const links = new Map<string, string>();
        const copies = sq.clips
          .filter((c) => d.ids.has(c.id))
          .map((c) => {
            let linkId: string | null = null;
            if (c.linkId) {
              if (!links.has(c.linkId)) links.set(c.linkId, uid('l'));
              linkId = links.get(c.linkId)!;
            }
            return { ...c, id: uid('c'), linkId };
          });
        const withCopies = { ...sq, clips: [...sq.clips, ...copies] };
        const moved = moveClips(withCopies, new Set(copies.map((c) => c.id)), d.dF, d.dV, d.dA, mediaLookup(s.project));
        if (!moved) return toast('Destination track is locked.', 'warn');
        edit('Duplicate', (p) => withSeq(p, moved));
        useVideo.setState({ selection: copies.map((c) => c.id) });
        return;
      }
      const moved = moveClips(sq, d.ids, d.dF, d.dV, d.dA, mediaLookup(s.project));
      if (!moved) return toast('Destination track is locked.', 'warn');
      edit('Move', (p) => withSeq(p, moved));
    } else if (d.kind === 'trim') {
      if (!d.delta) return;
      if (d.ripple) edit('Ripple Trim', (p) => withSeq(p, rippleTrim(p.seq, d.ids, d.edge, d.delta, mediaLookup(p))));
      else
        edit('Trim', (p) => {
          const lk = mediaLookup(p);
          return mapClips(p, d.ids, (c) => (d.edge === 'head' ? trimHead(c, c.start + d.delta, lk(c.mediaId), p.seq.fps) : trimTail(c, clipEnd(c) + d.delta, lk(c.mediaId), p.seq.fps)));
        });
    } else if (d.kind === 'fade' || d.kind === 'transDur') endLiveEdit();
    else if (d.kind === 'empty') {
      if (d.marquee) {
        const lay = layoutRows(sq);
        const fa = xToFrame(v, Math.min(d.x0, d.x1));
        const fb = xToFrame(v, Math.max(d.x0, d.x1));
        const ya = Math.min(d.y0, d.y1);
        const yb = Math.max(d.y0, d.y1);
        const ids: string[] = [];
        for (const c of sq.clips) {
          const r = lay.byTrack.get(c.trackId);
          if (!r) continue;
          const top = rowTop(v, r);
          if (top + r.h < ya || top > yb) continue;
          if (clipEnd(c) < fa || c.start > fb) continue;
          ids.push(c.id);
        }
        A.selectClips(ids, d.shift ? 'add' : 'replace');
      } else if (d.row) {
        const f = Math.floor(xToFrame(v, d.x0));
        const g = gapAt(sq, d.row.track.id, f);
        if (g && !d.row.track.locked) useVideo.setState({ gap: { trackId: d.row.track.id, start: g.start, end: g.end }, selection: [], transition: null });
        else if (!d.shift) A.deselectAll();
      } else if (!d.shift) A.deselectAll();
    }
    void e;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const h = hitTest(x, y);
    if (h.kind === 'ruler' && h.marker) void openMarkerDialog(h.marker);
    else if (h.kind === 'trans') void openTransitionDialog(h.clip.id, h.edge);
    else if (h.kind === 'clip' && h.part === 'body' && getState().tool !== 'razor') {
      const m = getState().project.media.find((k) => k.id === h.clip.mediaId);
      if (m && m.kind !== 'adjustment') useVideo.setState({ sourceId: m.id, topLeftTab: 'source' });
    }
  };

  // ---- context menus
  const onContextMenu = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const h = hitTest(x, y);
    const s = getState();
    const sq = s.project.seq;
    const v = cv();
    const f = Math.round(xToFrame(v, x));
    let items: MenuItem[] = [];
    if (h.kind === 'ruler') {
      if (h.marker) {
        const m = h.marker;
        items = [
          { label: 'Edit Marker…', onClick: () => void openMarkerDialog(m) },
          { label: 'Delete Marker', onClick: () => A.removeMarker(m.id) },
        ];
      } else
        items = [
          { label: 'Add Marker', shortcut: 'M', onClick: () => (transport.seek(f), A.addMarker()) },
          { separator: true },
          { label: 'Mark In', shortcut: 'I', onClick: () => A.setSeqInOut('in', f) },
          { label: 'Mark Out', shortcut: 'O', onClick: () => A.setSeqInOut('out', f) },
          { label: 'Clear In and Out', shortcut: '⌥X', disabled: sq.inPoint === null && sq.outPoint === null, onClick: () => A.setSeqInOut('clear') },
        ];
    } else if (h.kind === 'trans') {
      const c = h.clip;
      const t = h.edge === 'in' ? c.transIn! : c.transOut!;
      useVideo.setState({ transition: { clipId: c.id, edge: h.edge }, selection: [] });
      const setT = (patch: Partial<typeof t>, label: string) => edit(label, (p) => mapClips(p, c.id, (k) => ({ ...k, [h.edge === 'in' ? 'transIn' : 'transOut']: { ...t, ...patch } })));
      items = [
        { label: 'Set Transition Duration…', onClick: () => void openTransitionDialog(c.id, h.edge) },
        {
          label: 'Type',
          submenu: (Object.keys(TRANSITION_LABELS) as TransitionType[]).map((ty) => ({ label: TRANSITION_LABELS[ty], checked: t.type === ty, onClick: () => setT({ type: ty }, 'Change Transition') })),
        },
        ...(h.cut
          ? [
              {
                label: 'Alignment',
                submenu: (['center', 'start', 'end'] as const).map((al) => ({ label: al === 'center' ? 'Center at Cut' : al === 'start' ? 'Start at Cut' : 'End at Cut', checked: t.align === al, onClick: () => setT({ align: al }, 'Transition Alignment') })),
              },
            ]
          : []),
        ...(t.type === 'wipe' || t.type === 'slide' || t.type === 'push'
          ? [
              {
                label: 'Direction',
                submenu: [
                  [0, 'From Left'],
                  [180, 'From Right'],
                  [90, 'From Top'],
                  [270, 'From Bottom'],
                ].map(([dv, l]) => ({ label: l as string, checked: t.direction === dv, onClick: () => setT({ direction: dv as number }, 'Transition Direction') })),
              },
            ]
          : []),
        { separator: true },
        { label: 'Clear', danger: true, onClick: () => A.deleteSelection(false) },
      ];
    } else if (h.kind === 'clip') {
      const c = h.clip;
      if (!s.selection.includes(c.id)) A.selectClips([c.id], 'replace', e.altKey);
      const sel = A.selectedClips();
      const isVideo = h.row.track.kind === 'video';
      const allEnabled = sel.every((k) => k.enabled);
      const m = s.project.media.find((k) => k.id === c.mediaId);
      const transSub = (edge: 'in' | 'out'): MenuItem[] => (Object.keys(TRANSITION_LABELS) as TransitionType[]).map((ty) => ({ label: TRANSITION_LABELS[ty], onClick: () => A.addTransition(c.id, edge, ty) }));
      items = [
        { label: 'Cut', shortcut: '⌘X', onClick: () => A.cutSelection() },
        { label: 'Copy', shortcut: '⌘C', onClick: () => A.copySelection() },
        { label: 'Paste', shortcut: '⌘V', onClick: () => A.pasteAtPlayhead() },
        { label: 'Clear', shortcut: '⌫', onClick: () => A.deleteSelection(false) },
        { label: 'Ripple Delete', shortcut: '⇧⌫', onClick: () => A.deleteSelection(true) },
        { separator: true },
        { label: 'Split at Click Point', onClick: () => A.razorAt(c.id, f, false) },
        { label: 'Split at Playhead', shortcut: '⌘K', onClick: () => A.splitAtPlayhead() },
        { separator: true },
        { label: 'Enable', checked: allEnabled, shortcut: '⇧E', onClick: () => A.toggleEnable() },
        sel.some((k) => k.linkId) ? { label: 'Unlink', onClick: () => A.unlinkSelection() } : { label: 'Link', disabled: sel.length < 2, onClick: () => A.linkSelection() },
        { separator: true },
        { label: 'Speed/Duration…', shortcut: '⌥R', onClick: () => void openSpeedDialog(sel) },
        ...(isVideo
          ? [
              { label: 'Scale to Frame Size', checked: sel.every((k) => k.fit), onClick: () => A.toggleFit() },
              { label: 'Add Transition at In', submenu: transSub('in') },
              { label: 'Add Transition at Out', submenu: transSub('out') },
              { label: 'Add Lumetri Color', onClick: () => A.addEffectToClips(sel.map((k) => k.id), 'lumetri') },
            ]
          : [
              { label: 'Fade In (1s)', onClick: () => A.addTransition(c.id, 'in', 'crossDissolve') },
              { label: 'Fade Out (1s)', onClick: () => A.addTransition(c.id, 'out', 'crossDissolve') },
            ]),
        {
          label: 'Remove Fades & Transitions',
          disabled: !sel.some((k) => k.fadeIn || k.fadeOut || k.transIn || k.transOut),
          onClick: () => edit('Remove Fades', (p) => mapClips(p, new Set(sel.map((k) => k.id)), (k) => ({ ...k, fadeIn: 0, fadeOut: 0, transIn: null, transOut: null }))),
        },
        { separator: true },
        {
          label: 'Rename…',
          onClick: async () => {
            const n = await promptDialog('Rename Clip', c.name);
            if (n) A.renameClip(c.id, n);
          },
        },
        { label: 'Reveal in Project', onClick: () => useVideo.setState({ bottomLeftTab: 'project', binSelection: [c.mediaId] }) },
        { label: 'Open in Source Monitor', disabled: !m || m.kind === 'adjustment', onClick: () => useVideo.setState({ sourceId: c.mediaId, topLeftTab: 'source' }) },
        ...(m?.path && api.isElectron ? [{ label: api.isMac ? 'Reveal in Finder' : 'Show in Explorer', onClick: () => api.reveal(m.path!) }] : []),
      ];
    } else {
      const row = h.row;
      const g = row ? gapAt(sq, row.track.id, Math.floor(xToFrame(v, x))) : null;
      if (g && row) useVideo.setState({ gap: { trackId: row.track.id, start: g.start, end: g.end }, selection: [], transition: null });
      items = [
        { label: 'Ripple Delete', disabled: !g, onClick: () => A.deleteSelection(true) },
        { label: 'Paste', shortcut: '⌘V', onClick: () => A.pasteAtPlayhead() },
        { separator: true },
        { label: 'Add Video Track', onClick: () => A.addTrack('video') },
        { label: 'Add Audio Track', onClick: () => A.addTrack('audio') },
      ];
    }
    openContextMenu(e, items);
  };

  // ---- drag & drop (bin items, effects, OS files)
  const dropInfo = (e: React.DragEvent) => {
    const { x, y } = local(e);
    const s = getState();
    const sq = s.project.seq;
    const v = cv();
    let f = Math.max(0, Math.round(xToFrame(v, x)));
    if (s.snapping) {
      const sd = snapDelta([f], snapPoints(sq, new Set(), transport.frameInt), snapFrames());
      if (sd) f += sd.delta;
    }
    const lay = layoutRows(sq);
    const row = rowAt(lay, v, y);
    return { x, y, f, row, sq, v, lay };
  };

  const onDragOver = (e: React.DragEvent) => {
    const p = getDragPayload();
    const files = e.dataTransfer.types.includes('Files');
    if (!p && !files && !e.dataTransfer.types.includes(DND_MIME)) return;
    e.preventDefault();
    const { f, row, sq, v, lay, x, y } = dropInfo(e);
    overlay.current = { ghosts: [], snapX: null, marquee: null, label: null };
    if (p?.kind === 'media') {
      e.dataTransfer.dropEffect = 'copy';
      const lookup = mediaLookup(getState().project);
      let t = f;
      const vt = tracksOf(sq, 'video');
      const at = tracksOf(sq, 'audio');
      const vi = row?.track.kind === 'video' ? vt.indexOf(row.track) : 0;
      const ai = row?.track.kind === 'audio' ? at.indexOf(row.track) : 0;
      for (const id of p.ids) {
        const m = lookup(id);
        if (!m) continue;
        const { frames } = A.placementFrames(m, sq, p.inSec, p.outSec);
        const hasV = m.kind !== 'audio';
        const hasA = m.hasAudio && (m.kind === 'video' || m.kind === 'audio');
        if (hasV && vt[vi]) {
          const r = lay.byTrack.get(vt[vi].id)!;
          overlay.current.ghosts.push({ x: frameToX(v, t), y: rowTop(v, r) + 1, w: frames * v.zoom, h: r.h - 2, color: CLIP_COLORS[m.kind] });
        }
        if (hasA && at[ai]) {
          const r = lay.byTrack.get(at[ai].id)!;
          overlay.current.ghosts.push({ x: frameToX(v, t), y: rowTop(v, r) + 1, w: frames * v.zoom, h: r.h - 2, color: CLIP_COLORS.audio });
        }
        t += frames;
      }
      overlay.current.snapX = frameToX(v, f);
      overlay.current.label = { x: x + 12, y: Math.max(RULER_H, y - 26), text: `${e.metaKey || e.ctrlKey ? 'Insert' : 'Overwrite'} at ${timecode(f, sq.fps)}` };
    } else if (p?.kind === 'transition' || p?.kind === 'effect') {
      const h = hitTest(x, y);
      e.dataTransfer.dropEffect = h.kind === 'clip' ? 'copy' : 'none';
      if (h.kind === 'clip') {
        const r = h.row;
        const c = h.clip;
        const x0 = frameToX(v, c.start);
        const x1 = frameToX(v, clipEnd(c));
        if (p.kind === 'transition') {
          const edge = x - x0 < x1 - x ? 'in' : 'out';
          const w = Math.min(x1 - x0, 30 * v.zoom);
          overlay.current.ghosts.push({ x: edge === 'in' ? x0 : x1 - w, y: rowTop(v, r) + 1, w, h: r.h - 2, color: '#7d86a8' });
        } else overlay.current.ghosts.push({ x: x0, y: rowTop(v, r) + 1, w: x1 - x0, h: r.h - 2, color: '#e8c547' });
      }
    } else {
      e.dataTransfer.dropEffect = 'copy';
      overlay.current.snapX = frameToX(v, f);
    }
    overDirty.current = true;
  };

  const onDragLeave = () => {
    overlay.current = { ghosts: [], snapX: null, marquee: null, label: null };
    overDirty.current = true;
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const p = getDragPayload();
    const { f, row, sq, x, y } = dropInfo(e);
    onDragLeave();
    const vt = tracksOf(sq, 'video');
    const at = tracksOf(sq, 'audio');
    const vIndex = row?.track.kind === 'video' ? vt.indexOf(row.track) : undefined;
    const aIndex = row?.track.kind === 'audio' ? at.indexOf(row.track) : undefined;
    const mode = e.metaKey || e.ctrlKey ? 'insert' : 'overwrite';
    if (p?.kind === 'media') {
      const lookup = mediaLookup(getState().project);
      const items = p.ids.map((id) => lookup(id)).filter((m): m is NonNullable<typeof m> => !!m);
      await A.placeMedia(
        items.map((m) => ({ media: m, inSec: p.ids.length === 1 ? p.inSec : undefined, outSec: p.ids.length === 1 ? p.outSec : undefined })),
        f,
        mode,
        { vIndex: vIndex ?? (aIndex !== undefined ? Math.min(aIndex, vt.length - 1) : undefined), aIndex: aIndex ?? (vIndex !== undefined ? Math.min(vIndex, at.length) : undefined) },
      );
      return;
    }
    if (p?.kind === 'transition' || p?.kind === 'effect') {
      const h = hitTest(x, y);
      if (h.kind !== 'clip') return;
      if (p.kind === 'transition') {
        const v = cv();
        const x0 = frameToX(v, h.clip.start);
        const x1 = frameToX(v, clipEnd(h.clip));
        A.addTransition(h.clip.id, x - x0 < x1 - x ? 'in' : 'out', p.type);
      } else {
        const ids = getState().selection.includes(h.clip.id) ? getState().selection : [h.clip.id];
        A.addEffectToClips(ids, p.type);
        A.selectClips([h.clip.id]);
        useVideo.setState({ topLeftTab: 'effectControls' });
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      const paths = files.map((fl) => api.pathForFile(fl)).filter((pp) => kindOf(pp));
      const items = await importPaths(paths);
      if (items.length) await A.placeMedia(items.map((m) => ({ media: m })), f, mode, { vIndex, aIndex });
    }
  };

  // ---- track headers
  const lay = layout;
  const headerRows = lay.rows;

  return (
    <div className="vid-tl">
      <div className="vid-tl-bar">
        <TimecodeField spanRef={tcRef} fps={seq.fps} />
        <div className="sep-v" />
        <ToolButton icon="move" title="Selection Tool (V)" active={tool === 'select'} onClick={() => useVideo.setState({ tool: 'select' })} />
        <ToolButton icon="ripple" title="Ripple Edit Tool (B)" active={tool === 'ripple'} onClick={() => useVideo.setState({ tool: 'ripple' })} />
        <ToolButton icon="razor" title="Razor Tool (C)" active={tool === 'razor'} onClick={() => useVideo.setState({ tool: 'razor' })} />
        <div className="sep-v" />
        <ToolButton icon="magnet" title="Snap in Timeline (S)" active={snapping} onClick={() => useVideo.setState({ snapping: !snapping })} />
        <ToolButton icon="link" title="Linked Selection" active={linkedSelection} onClick={() => useVideo.setState({ linkedSelection: !linkedSelection })} />
        <ToolButton icon="marker" title="Add Marker (M)" onClick={() => A.addMarker()} />
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 10.5 }}>
          {seq.name} · {seq.width}×{seq.height} · {seq.fps} fps
        </span>
        <div className="sep-v" />
        <ToolButton icon="zoomOut" title="Zoom Out (-)" onClick={() => timelineApi.zoomBy?.(1 / 1.5)} />
        <input
          type="range"
          className="vid-zoom"
          min={0}
          max={1000}
          value={Math.round(((Math.log(zoom) - Math.log(MIN_ZOOM)) / (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM))) * 1000)}
          onChange={(e) => {
            const t = Number(e.target.value) / 1000;
            const z = Math.exp(Math.log(MIN_ZOOM) + t * (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM)));
            const v = cv();
            const px = frameToX(v, transport.frame);
            setZoomAt(z, px >= 0 && px <= v.width ? px : v.width / 2);
          }}
          title="Zoom"
        />
        <ToolButton icon="zoomIn" title="Zoom In (=)" onClick={() => timelineApi.zoomBy?.(1.5)} />
        <ToolButton icon="fullscreen" title="Zoom to Sequence (\)" onClick={() => timelineApi.fit?.()} />
      </div>
      <div className="vid-tl-body">
        <div className="vid-tl-headers" style={{ width: HEADER_W }}>
          <div className="vid-tl-headers-inner" style={{ transform: `translateY(${-scrollY}px)` }}>
            {headerRows.map((r) => (
              <TrackHeader key={r.track.id} track={r.track} top={RULER_H + r.y} selected={selectedTracks.includes(r.track.id)} />
            ))}
            <div className="vid-tl-divider" style={{ top: RULER_H + lay.dividerY }} />
          </div>
          <div className="vid-tl-headers-ruler">
            <button className="icon-btn small" title="Add Video Track" onClick={() => A.addTrack('video')}>
              <Icon name="plus" size={12} />
            </button>
            <span className="faint" style={{ fontSize: 10 }}>
              V
            </span>
            <button className="icon-btn small" title="Add Audio Track" onClick={() => A.addTrack('audio')}>
              <Icon name="plus" size={12} />
            </button>
            <span className="faint" style={{ fontSize: 10 }}>
              A
            </span>
          </div>
        </div>
        <div
          className="vid-tl-canvas"
          ref={wrapRef}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => void onDrop(e)}
        >
          <canvas ref={baseRef} />
          <canvas
            ref={overRef}
            className="over"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (hover.current.clip || hover.current.x !== null) {
                hover.current = { clip: null, x: null };
                baseDirty.current = overDirty.current = true;
              }
            }}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
          />
        </div>
        <div className="vid-tl-vscroll" ref={vscrollRef} onScroll={(e) => setScroll(null, (e.target as HTMLDivElement).scrollTop)}>
          <div style={{ height: lay.total, width: 1 }} />
        </div>
      </div>
      <div className="vid-tl-hscroll" style={{ marginLeft: HEADER_W }} ref={hscrollRef} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollLeft, null)}>
        <div style={{ width: contentW, height: 1 }} />
      </div>
    </div>
  );
}

export { timelineApi };

function ToolButton({ icon, title, active, onClick }: { icon: Parameters<typeof Icon>[0]['name']; title: string; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cx('icon-btn small', active && 'active')} title={title} onClick={onClick} onMouseDown={(e) => e.preventDefault()}>
      <Icon name={icon} size={14} />
    </button>
  );
}

function TimecodeField({ spanRef, fps }: { spanRef: React.RefObject<HTMLSpanElement | null>; fps: number }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null)
    return (
      <input
        className="input mono vid-tc-input"
        autoFocus
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const f = parseTimecode(editing, fps, transport.frameInt);
            if (f !== null) transport.seek(Math.max(0, f));
            setEditing(null);
          }
          if (e.key === 'Escape') setEditing(null);
        }}
      />
    );
  return (
    <span className="vid-tc" ref={spanRef} title="Playhead position — click to type a timecode" onClick={() => setEditing(timecode(transport.frameInt, fps))}>
      {timecode(transport.frameInt, fps)}
    </span>
  );
}

function TrackHeader({ track: t, top, selected }: { track: Track; top: number; selected: boolean }) {
  const resize = (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = t.height;
    let last = h0;
    // The project before the drag (= the current undo state) and the last live (history-less) one we set.
    const p0 = getState().project;
    let live: Project | null = null;
    const move = (ev: PointerEvent) => {
      const h = Math.max(24, Math.min(200, Math.round(h0 + ev.clientY - y0)));
      if (h === last) return;
      last = h;
      // Live, no undo step for each pixel.
      const cur = getState().project;
      live = { ...cur, seq: { ...cur.seq, tracks: cur.seq.tracks.map((x) => (x.id === t.id ? { ...x, height: h } : x)) } };
      useVideo.setState({ project: live });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const cur = getState().project;
      // Restore the pre-drag project object itself (not a copy) so it still matches the undo history and
      // the saved state; only rebuild if something else changed the project meanwhile.
      if (cur === live) useVideo.setState({ project: p0 });
      else if (live) useVideo.setState({ project: { ...cur, seq: { ...cur.seq, tracks: cur.seq.tracks.map((x) => (x.id === t.id ? { ...x, height: h0 } : x)) } } });
      if (last !== h0) A.updateTrack(t.id, { height: last }, 'Track Height');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const toggleSel = (e: React.MouseEvent) => {
    const s = getState();
    const has = s.selectedTracks.includes(t.id);
    if (e.shiftKey || e.metaKey || e.ctrlKey) useVideo.setState({ selectedTracks: has ? s.selectedTracks.filter((x) => x !== t.id) : [...s.selectedTracks, t.id] });
    else useVideo.setState({ selectedTracks: has && s.selectedTracks.length === 1 ? [] : [t.id] });
  };
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      {
        label: 'Rename…',
        onClick: async () => {
          const n = await promptDialog('Rename Track', t.name);
          if (n) A.updateTrack(t.id, { name: n }, 'Rename Track');
        },
      },
      { separator: true },
      { label: 'Add Video Track', onClick: () => A.addTrack('video') },
      { label: 'Add Audio Track', onClick: () => A.addTrack('audio') },
      { label: 'Delete Track', danger: true, onClick: () => void A.removeTrack(t.id) },
      { separator: true },
      {
        label: 'Track Height',
        submenu: [
          ['Small', 30],
          ['Medium', t.kind === 'video' ? 52 : 44],
          ['Large', 84],
          ['Extra Large', 130],
        ].map(([l, h]) => ({ label: l as string, checked: t.height === h, onClick: () => A.updateTrack(t.id, { height: h as number }, 'Track Height') })),
      },
      ...(t.kind === 'audio'
        ? [
            {
              label: 'Track Volume',
              submenu: [6, 3, 0, -3, -6, -12, -20, -96].map((db) => ({ label: db <= -96 ? '−∞ dB' : `${db > 0 ? '+' : ''}${db} dB`, checked: t.volume === db, onClick: () => A.updateTrack(t.id, { volume: db }, 'Track Volume') })),
            },
          ]
        : []),
    ]);
  const btn = (on: boolean, label: React.ReactNode, title: string, onClick: () => void, cls = '') => (
    <button type="button" className={cx('vid-th-btn', on && 'on', cls)} title={title} onClick={(e) => (e.stopPropagation(), onClick())} onMouseDown={(e) => e.preventDefault()}>
      {label}
    </button>
  );
  return (
    <div className={cx('vid-th', selected && 'selected', t.kind)} style={{ top, height: t.height }} onClick={toggleSel} onContextMenu={menu}>
      <div className="vid-th-row">
        {btn(t.locked, <Icon name={t.locked ? 'lock' : 'unlock'} size={12} />, 'Toggle Track Lock', () => A.updateTrack(t.id, { locked: !t.locked }, t.locked ? 'Unlock Track' : 'Lock Track'))}
        {btn(t.syncLock, <Icon name="link" size={11} />, 'Toggle Sync Lock', () => A.updateTrack(t.id, { syncLock: !t.syncLock }, 'Sync Lock'), 'sync')}
        <span className={cx('vid-th-name', selected && 'sel')}>{t.name}</span>
        {t.kind === 'video' ? (
          btn(!t.hidden, <Icon name={t.hidden ? 'eyeOff' : 'eye'} size={12} />, 'Toggle Track Output', () => A.updateTrack(t.id, { hidden: !t.hidden }, 'Toggle Track Output'))
        ) : (
          <>
            {btn(t.muted, 'M', 'Mute Track', () => A.updateTrack(t.id, { muted: !t.muted }, 'Mute Track'), 'mute')}
            {btn(t.solo, 'S', 'Solo Track', () => A.updateTrack(t.id, { solo: !t.solo }, 'Solo Track'), 'solo')}
          </>
        )}
      </div>
      {t.kind === 'audio' && t.height >= 40 && t.volume !== 0 && <div className="vid-th-vol faint">{t.volume <= -96 ? '−∞' : `${t.volume > 0 ? '+' : ''}${t.volume}`} dB</div>}
      <div className="vid-th-resize" onPointerDown={resize} />
    </div>
  );
}
