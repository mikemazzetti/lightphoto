/** Canvas rendering of the timeline (ruler, tracks, clips, waveforms, filmstrips, markers). */
import { seqIndex } from '../model/evaluate';
import { clipEnd, isBounded } from '../model/ops';
import { dbToGain, exactFps, timecode } from '../model/time';
import type { Clip, MediaItem, Sequence } from '../model/types';
import { filmstrips, peaks } from '../engine/media';
import type { GapSel, TransitionSel } from '../state/store';
import { CLIP_COLORS, DIVIDER_H, frameToX, LABEL_H, Layout, Row, RULER_H, rowTop, rulerStep, transitionRegion, View, xToFrame } from './layout';

export interface DrawState {
  seq: Sequence;
  media: (id: string) => MediaItem | undefined;
  layout: Layout;
  view: View;
  selection: Set<string>;
  transition: TransitionSel | null;
  gap: GapSel | null;
  selectedTracks: Set<string>;
  hoverClip: string | null;
}

const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif';
const FONT_SMALL = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif';

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (k >= 0) {
    r += (255 - r) * k;
    g += (255 - g) * k;
    b += (255 - b) * k;
  } else {
    r *= 1 + k;
    g *= 1 + k;
    b *= 1 + k;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

let hatch: CanvasPattern | null = null;
function hatchPattern(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  if (hatch) return hatch;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const x = c.getContext('2d')!;
  x.strokeStyle = color;
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(-2, 10);
  x.lineTo(10, -2);
  x.stroke();
  hatch = ctx.createPattern(c, 'repeat');
  return hatch;
}

export function drawTimeline(ctx: CanvasRenderingContext2D, st: DrawState) {
  const { view: v, layout, seq } = st;
  const W = v.width;
  const H = v.height;
  ctx.fillStyle = '#18181a';
  ctx.fillRect(0, 0, W, H);

  // ---- track rows
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_H, W, H - RULER_H);
  ctx.clip();
  for (const r of layout.rows) {
    const y = rowTop(v, r);
    if (y > H || y + r.h < RULER_H) continue;
    const sel = st.selectedTracks.has(r.track.id);
    ctx.fillStyle = sel ? '#24262e' : r.track.kind === 'video' ? '#1d1d20' : '#1b1d1c';
    ctx.fillRect(0, y, W, r.h);
    ctx.fillStyle = '#111113';
    ctx.fillRect(0, y + r.h - 1, W, 1);
  }
  const dy = RULER_H + layout.dividerY - v.scrollY;
  ctx.fillStyle = '#0d0d0e';
  ctx.fillRect(0, dy, W, DIVIDER_H);

  // In/Out shading
  if (seq.inPoint !== null || seq.outPoint !== null) {
    const a = frameToX(v, seq.inPoint ?? 0);
    const b = seq.outPoint !== null ? frameToX(v, seq.outPoint) : W;
    ctx.fillStyle = 'rgba(120,150,255,0.06)';
    ctx.fillRect(a, RULER_H, b - a, H - RULER_H);
  }

  // Gap selection
  if (st.gap) {
    const r = layout.byTrack.get(st.gap.trackId);
    if (r) {
      const y = rowTop(v, r);
      ctx.fillStyle = 'rgba(61,139,253,0.22)';
      const x0 = frameToX(v, st.gap.start);
      ctx.fillRect(x0, y + 1, frameToX(v, st.gap.end) - x0, r.h - 2);
    }
  }

  // ---- clips
  const f0 = Math.floor(xToFrame(v, 0)) - 1;
  const f1 = Math.ceil(xToFrame(v, W)) + 1;
  const ix = seqIndex(seq);
  for (const r of layout.rows) {
    const y = rowTop(v, r);
    if (y > H || y + r.h < RULER_H) continue;
    const sorted = ix.byTrack.get(r.track.id);
    if (!sorted) continue;
    for (const c of sorted) {
      if (clipEnd(c) < f0 || c.start > f1) continue;
      drawClip(ctx, st, c, r, y);
    }
    // transitions on top
    for (const c of sorted) {
      if ((!c.transIn && !c.transOut) || clipEnd(c) < f0 - 200 || c.start > f1 + 200) continue;
      for (const edge of ['in', 'out'] as const) {
        const reg = transitionRegion(c, edge, sorted);
        if (!reg) continue;
        drawTransition(ctx, st, c, edge, reg, y, r.h);
      }
    }
    if (r.track.locked) {
      const p = hatchPattern(ctx, 'rgba(255,255,255,0.05)');
      if (p) {
        ctx.fillStyle = p;
        ctx.fillRect(0, y, W, r.h - 1);
      }
    }
  }
  // Markers lines through tracks
  for (const m of seq.markers) {
    const x = Math.round(frameToX(v, m.frame)) + 0.5;
    if (x < -2 || x > W + 2) continue;
    ctx.strokeStyle = m.color + '55';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  ctx.restore();

  drawRuler(ctx, st);
}

function drawRuler(ctx: CanvasRenderingContext2D, st: DrawState) {
  const { view: v, seq } = st;
  const W = v.width;
  ctx.fillStyle = '#202023';
  ctx.fillRect(0, 0, W, RULER_H);
  ctx.fillStyle = '#0e0e10';
  ctx.fillRect(0, RULER_H - 1, W, 1);
  // In/out bar
  if (seq.inPoint !== null || seq.outPoint !== null) {
    const a = frameToX(v, seq.inPoint ?? 0);
    const b = seq.outPoint !== null ? frameToX(v, seq.outPoint) : W;
    ctx.fillStyle = 'rgba(110,140,255,0.35)';
    ctx.fillRect(a, RULER_H - 8, b - a, 7);
    ctx.fillStyle = '#9fb4ff';
    if (seq.inPoint !== null) ctx.fillRect(Math.round(a), RULER_H - 12, 2, 11);
    if (seq.outPoint !== null) ctx.fillRect(Math.round(b) - 2, RULER_H - 12, 2, 11);
  }
  const { major, minor } = rulerStep(v.zoom, seq.fps);
  const f0 = Math.max(0, Math.floor(xToFrame(v, 0) / minor) * minor);
  const f1 = xToFrame(v, W);
  ctx.strokeStyle = '#5a5a60';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let f = f0; f <= f1; f += minor) {
    const x = Math.round(frameToX(v, f)) + 0.5;
    const isMajor = f % major === 0;
    ctx.moveTo(x, isMajor ? 13 : RULER_H - 6);
    ctx.lineTo(x, RULER_H - 1);
  }
  ctx.stroke();
  ctx.fillStyle = '#9a9aa2';
  ctx.font = FONT_SMALL;
  ctx.textBaseline = 'top';
  const m0 = Math.max(0, Math.floor(xToFrame(v, -80) / major) * major);
  for (let f = m0; f <= f1; f += major) {
    const x = Math.round(frameToX(v, f));
    ctx.fillText(timecode(f, seq.fps), x + 4, 3);
  }
  // Markers
  for (const m of seq.markers) {
    const x = Math.round(frameToX(v, m.frame));
    if (x < -10 || x > W + 10) continue;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.moveTo(x - 5, 14);
    ctx.lineTo(x + 5, 14);
    ctx.lineTo(x + 5, 21);
    ctx.lineTo(x, 26);
    ctx.lineTo(x - 5, 21);
    ctx.closePath();
    ctx.fill();
    if (m.name && major * v.zoom > 40) {
      ctx.fillStyle = '#dcdce0';
      ctx.fillText(m.name, x + 7, 16);
    }
  }
}

function drawClip(ctx: CanvasRenderingContext2D, st: DrawState, c: Clip, r: Row, rowY: number) {
  const v = st.view;
  const m = st.media(c.mediaId);
  const x0 = frameToX(v, c.start);
  const x1 = frameToX(v, clipEnd(c));
  const vx0 = Math.max(x0, -4);
  const vx1 = Math.min(x1, v.width + 4);
  if (vx1 <= vx0) return;
  const y = rowY + 1;
  const h = r.h - 2;
  const isAudioTrack = r.track.kind === 'audio';
  const kind = isAudioTrack ? 'audio' : m?.kind ?? 'video';
  const base = CLIP_COLORS[kind];
  const selected = st.selection.has(c.id);
  const w = Math.max(1, x1 - x0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(vx0, y, vx1 - vx0, h);
  ctx.clip();
  // Body
  ctx.fillStyle = c.enabled ? shade(base, selected ? 0.18 : -0.35) : '#3a3a3e';
  ctx.fillRect(x0, y, w, h);
  const bodyY = y + (h >= 26 ? LABEL_H : 0);
  const bodyH = y + h - bodyY;
  if (m && !m.missing) {
    if (!isAudioTrack && m.kind === 'video' && bodyH >= 14) drawFilmstrip(ctx, st, c, m, x0, x1, bodyY, bodyH);
    else if (isAudioTrack && bodyH >= 8) drawWaveform(ctx, st, c, m, x0, x1, bodyY, bodyH, shade(base, selected ? 0.55 : 0.15));
    else if (!isAudioTrack && m.kind === 'matte' && bodyH >= 6) {
      ctx.fillStyle = c.color ?? m.color ?? '#000';
      ctx.fillRect(x0 + 2, bodyY + 2, Math.min(w - 4, 28), bodyH - 4);
    }
  }
  if (m?.missing) {
    ctx.fillStyle = 'rgba(200,40,40,0.55)';
    ctx.fillRect(x0, y, w, h);
  }
  // Label bar
  if (h >= 26) {
    ctx.fillStyle = c.enabled ? shade(base, selected ? 0.05 : -0.5) : '#2c2c30';
    ctx.fillRect(x0, y, w, LABEL_H);
  }
  // Fades
  const fadeStroke = selected ? '#ffffff' : 'rgba(255,255,255,0.7)';
  if (c.fadeIn > 0) {
    const fx = x0 + c.fadeIn * v.zoom;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(fx, y);
    ctx.lineTo(x0, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = fadeStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y + h);
    ctx.lineTo(fx, y);
    ctx.stroke();
  }
  if (c.fadeOut > 0) {
    const fx = x1 - c.fadeOut * v.zoom;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(fx, y);
    ctx.lineTo(x1, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = fadeStroke;
    ctx.beginPath();
    ctx.moveTo(fx, y);
    ctx.lineTo(x1, y + h);
    ctx.stroke();
  }
  // Fade handles (hover / selected)
  if ((selected || st.hoverClip === c.id) && w > 30 && h >= 20) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(x0 + c.fadeIn * v.zoom) + 1, y + 1, 6, 6);
    ctx.fillRect(Math.round(x1 - c.fadeOut * v.zoom) - 7, y + 1, 6, 6);
  }
  // Text
  if (w > 18 && h >= 14) {
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const tx = Math.max(x0, 0) + 5;
    let label = '';
    const hasFx = !isAudioTrack && (c.fx.some((e) => e.enabled) || !!c.lumetri?.enabled);
    if (hasFx) label += 'fx ';
    label += c.name;
    if (c.speed !== 1) label += ` [${Math.round(c.speed * 100)}%]`;
    if (m?.missing) label = 'Media Offline — ' + label;
    if (!c.enabled) label = '⊘ ' + label;
    ctx.fillStyle = c.enabled ? '#f2f2f5' : '#9a9aa0';
    ctx.fillText(label, tx + (selected && st.hoverClip === c.id ? 8 : 0), y + Math.min(LABEL_H, h) / 2 + 0.5, Math.max(10, x1 - tx - 4));
    if (hasFx) {
      ctx.fillStyle = '#e8c547';
      ctx.fillText('fx', tx + (selected && st.hoverClip === c.id ? 8 : 0), y + Math.min(LABEL_H, h) / 2 + 0.5);
    }
  }
  ctx.restore();
  // Border
  ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, Math.round(w) - 1), h - 1);
  if (c.linkId && selected) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(x0) + 1, y + h - 3, Math.max(1, Math.round(w) - 2), 2);
  }
}

function drawFilmstrip(ctx: CanvasRenderingContext2D, st: DrawState, c: Clip, m: MediaItem, x0: number, x1: number, y: number, h: number) {
  const fs = filmstrips.get(m.id);
  if (!fs || !fs.frames.length) return;
  const v = st.view;
  const tw = Math.max(8, (h * fs.width) / fs.height);
  const fps = exactFps(st.seq.fps);
  const start = Math.max(x0, -tw);
  const startTile = Math.floor((start - x0) / tw);
  const end = Math.min(x1, v.width);
  ctx.globalAlpha = c.enabled ? 0.92 : 0.4;
  for (let i = startTile; x0 + i * tw < end; i++) {
    const x = x0 + i * tw;
    const local = (i * tw) / v.zoom;
    const t = c.inPoint + (local / fps) * c.speed;
    const idx = Math.max(0, Math.min(fs.frames.length - 1, Math.round(t / fs.interval)));
    const bmp = fs.frames[idx];
    if (bmp) ctx.drawImage(bmp, x, y, tw, h);
  }
  ctx.globalAlpha = 1;
}

function drawWaveform(ctx: CanvasRenderingContext2D, st: DrawState, c: Clip, m: MediaItem, x0: number, x1: number, y: number, h: number, color: string) {
  const pk = peaks.get(m.id);
  if (!pk) return;
  const v = st.view;
  const fps = exactFps(st.seq.fps);
  const secPerPx = (1 / v.zoom / fps) * c.speed;
  const bucketsPerPx = secPerPx * pk.rate;
  let lvl = 0;
  let scale = 1;
  while (lvl < pk.levels.length - 1 && bucketsPerPx / scale > 6) {
    lvl++;
    scale *= 10;
  }
  const data = pk.levels[lvl];
  const rate = pk.rate / scale;
  const gain = Math.min(4, dbToGain(c.volume));
  const mid = y + h / 2;
  const amp = h / 2 - 1;
  const xa = Math.max(Math.floor(x0), 0);
  const xb = Math.min(Math.ceil(x1), st.view.width);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let x = xa; x < xb; x++) {
    const ta = c.inPoint + (x - x0) * secPerPx;
    const tb = ta + secPerPx;
    let i0 = Math.floor(ta * rate);
    let i1 = Math.max(i0 + 1, Math.ceil(tb * rate));
    if (i0 < 0) i0 = 0;
    if (i1 > data.length) i1 = data.length;
    let mx = 0;
    for (let i = i0; i < i1; i++) if (data[i] > mx) mx = data[i];
    const a = Math.min(1, mx * gain) * amp;
    if (a < 0.4) continue;
    ctx.rect(x, mid - a, 1, a * 2);
  }
  ctx.fill();
  void isBounded;
}

function drawTransition(ctx: CanvasRenderingContext2D, st: DrawState, c: Clip, edge: 'in' | 'out', reg: { start: number; end: number; cut: boolean }, rowY: number, rowH: number) {
  const v = st.view;
  const x0 = frameToX(v, reg.start);
  const x1 = frameToX(v, reg.end);
  if (x1 < 0 || x0 > v.width) return;
  const h = rowH - 2;
  const y = rowY + 1 + (h >= 26 ? LABEL_H : 0);
  const bh = rowY + rowH - 1 - y;
  const sel = st.transition?.clipId === c.id && st.transition.edge === edge;
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, sel ? '#9db8ff' : '#7d86a8');
  g.addColorStop(1, sel ? '#5c7de6' : '#4a5170');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y, Math.max(2, x1 - x0), bh);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.moveTo(x0, y + bh);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.7)';
  ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, Math.round(x1 - x0) - 1), bh - 1);
  const t = edge === 'in' ? c.transIn : c.transOut;
  if (t && x1 - x0 > 40 && bh > 12) {
    ctx.fillStyle = '#ffffff';
    ctx.font = FONT_SMALL;
    ctx.textBaseline = 'middle';
    const names: Record<string, string> = { crossDissolve: 'Cross Dissolve', dipToBlack: 'Dip to Black', dipToWhite: 'Dip to White', wipe: 'Wipe', slide: 'Slide', push: 'Push' };
    ctx.fillText(names[t.type] ?? t.type, Math.max(x0, 0) + 4, y + bh / 2, x1 - Math.max(x0, 0) - 6);
  }
}

/** Playhead, ghosts, snap line, marquee — the cheap layer redrawn every frame. */
export interface OverlayState {
  view: View;
  playhead: number;
  fps: number;
  ghosts: { x: number; y: number; w: number; h: number; color: string }[];
  snapX: number | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  hoverX: number | null;
  razor: boolean;
  label: { x: number; y: number; text: string } | null;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayState) {
  const v = o.view;
  ctx.clearRect(0, 0, v.width, v.height);
  for (const g of o.ghosts) {
    ctx.fillStyle = g.color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(g.x) + 0.5, Math.round(g.y) + 0.5, Math.max(1, Math.round(g.w) - 1), Math.max(1, Math.round(g.h) - 1));
    ctx.setLineDash([]);
  }
  if (o.marquee) {
    const { x0, y0, x1, y1 } = o.marquee;
    ctx.fillStyle = 'rgba(61,139,253,0.12)';
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeStyle = 'rgba(120,170,255,0.9)';
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
  if (o.razor && o.hoverX !== null) {
    ctx.strokeStyle = 'rgba(255,90,90,0.9)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(o.hoverX) + 0.5, RULER_H);
    ctx.lineTo(Math.round(o.hoverX) + 0.5, v.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (o.snapX !== null) {
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(o.snapX) + 0.5, 0);
    ctx.lineTo(Math.round(o.snapX) + 0.5, v.height);
    ctx.stroke();
  }
  // Playhead
  const px = Math.round(frameToX(v, o.playhead)) + 0.5;
  if (px >= -8 && px <= v.width + 8) {
    ctx.strokeStyle = '#4d9bff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, RULER_H - 2);
    ctx.lineTo(px, v.height);
    ctx.stroke();
    ctx.fillStyle = '#4d9bff';
    ctx.beginPath();
    ctx.moveTo(px - 6, 2);
    ctx.lineTo(px + 6, 2);
    ctx.lineTo(px + 6, 12);
    ctx.lineTo(px, 18);
    ctx.lineTo(px - 6, 12);
    ctx.closePath();
    ctx.fill();
  }
  if (o.label) {
    ctx.font = FONT;
    const tw = ctx.measureText(o.label.text).width + 12;
    const x = Math.min(v.width - tw - 2, Math.max(2, o.label.x));
    ctx.fillStyle = 'rgba(20,20,22,0.92)';
    ctx.fillRect(x, o.label.y, tw, 18);
    ctx.strokeStyle = '#444';
    ctx.strokeRect(x + 0.5, o.label.y + 0.5, tw - 1, 17);
    ctx.fillStyle = '#eee';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.label.text, x + 6, o.label.y + 9.5);
  }
}
