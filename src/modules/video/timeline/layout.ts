import type { Clip, MediaKind, Sequence, Track } from '../model/types';
import { clipEnd } from '../model/ops';
import { cutTransition } from '../model/evaluate';

export const RULER_H = 30;
export const DIVIDER_H = 6;
export const HEADER_W = 168;
export const LABEL_H = 15;
export const EDGE_PX = 7;

export interface Row {
  track: Track;
  /** Top in content coordinates (0 = first track under the ruler). */
  y: number;
  h: number;
}

export interface Layout {
  rows: Row[];
  byTrack: Map<string, Row>;
  dividerY: number;
  total: number;
}

const layoutCache = new WeakMap<Track[], Layout>();

/** Video tracks top-down (Vn … V1), a divider, then audio tracks (A1 … An). */
export function layoutRows(seq: Sequence): Layout {
  const cached = layoutCache.get(seq.tracks);
  if (cached) return cached;
  const rows: Row[] = [];
  let y = 4;
  const vt = seq.tracks.filter((t) => t.kind === 'video').reverse();
  const at = seq.tracks.filter((t) => t.kind === 'audio');
  for (const t of vt) {
    rows.push({ track: t, y, h: t.height });
    y += t.height;
  }
  const dividerY = y;
  y += DIVIDER_H;
  for (const t of at) {
    rows.push({ track: t, y, h: t.height });
    y += t.height;
  }
  const l: Layout = { rows, byTrack: new Map(rows.map((r) => [r.track.id, r])), dividerY, total: y + 40 };
  layoutCache.set(seq.tracks, l);
  return l;
}

export interface View {
  zoom: number;
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
}

export const frameToX = (v: View, f: number) => f * v.zoom - v.scrollX;
export const xToFrame = (v: View, x: number) => (x + v.scrollX) / v.zoom;
export const rowTop = (v: View, r: Row) => RULER_H + r.y - v.scrollY;

export function rowAt(l: Layout, v: View, y: number): Row | null {
  const cy = y - RULER_H + v.scrollY;
  for (const r of l.rows) if (cy >= r.y && cy < r.y + r.h) return r;
  return null;
}

export const CLIP_COLORS: Record<MediaKind, string> = {
  video: '#6c74d8',
  image: '#8d6bd0',
  audio: '#3c9a68',
  title: '#cf5f95',
  matte: '#7d7d84',
  adjustment: '#b58a3a',
};

/** Region (frames) a transition occupies on the timeline, for drawing/hit-testing. */
export function transitionRegion(c: Clip, edge: 'in' | 'out', sorted: Clip[]): { start: number; end: number; cut: boolean } | null {
  if (edge === 'in') {
    if (!c.transIn) return null;
    const prev = sorted.find((x) => clipEnd(x) === c.start && x.id !== c.id);
    const d = Math.max(1, c.transIn.duration);
    if (prev) {
      const off = c.transIn.align === 'start' ? 0 : c.transIn.align === 'end' ? d : Math.floor(d / 2);
      const s = Math.max(prev.start, c.start - off);
      return { start: s, end: Math.min(clipEnd(c), s + d), cut: true };
    }
    return { start: c.start, end: c.start + Math.min(d, c.duration), cut: false };
  }
  if (!c.transOut) return null;
  const next = sorted.find((x) => x.start === clipEnd(c) && x.id !== c.id);
  const d = Math.max(1, c.transOut.duration);
  if (next) {
    if (cutTransition(c, next) !== c.transOut) return null;
    const off = c.transOut.align === 'start' ? 0 : c.transOut.align === 'end' ? d : Math.floor(d / 2);
    const s = Math.max(c.start, clipEnd(c) - off);
    return { start: s, end: Math.min(clipEnd(next), s + d), cut: true };
  }
  return { start: clipEnd(c) - Math.min(d, c.duration), end: clipEnd(c), cut: false };
}

/** Nice ruler step (frames) so labels are at least `minPx` apart. */
export function rulerStep(zoom: number, fps: number, minPx = 90): { major: number; minor: number } {
  const nf = Math.round(fps) || 30;
  const steps = [1, 2, 5, 10, Math.round(nf / 2), nf, nf * 2, nf * 5, nf * 10, nf * 15, nf * 30, nf * 60, nf * 120, nf * 300, nf * 600, nf * 1800, nf * 3600];
  let major = steps[steps.length - 1];
  for (const s of steps)
    if (s * zoom >= minPx) {
      major = s;
      break;
    }
  let minor = major;
  for (const div of [10, 5, 4, 2]) {
    const m = major / div;
    if (Number.isInteger(m) && m * zoom >= 7) {
      minor = m;
      break;
    }
  }
  return { major, minor };
}
