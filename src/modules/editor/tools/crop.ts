import { bus } from '../model/bus';
import type { Doc } from '../model/doc';
import { Rect } from '../model/geom';
import { edState } from '../model/store';
import { cropDoc } from '../ops/image';
import type { Tool, ToolEnv, ToolPointer } from './types';
import { ACCENT, drawHandle } from './types';

interface CropState {
  doc: Doc;
  r: Rect;
  docW: number;
  docH: number;
}
let crop: CropState | null = null;
let drag: null | { kind: 'new' | 'move' | 'handle'; hx: number; hy: number; start: Rect; px: number; py: number } = null;

function ensure(doc: Doc) {
  if (!crop || crop.doc !== doc || crop.docW !== doc.width || crop.docH !== doc.height) crop = { doc, r: { x: 0, y: 0, w: doc.width, h: doc.height }, docW: doc.width, docH: doc.height };
  return crop;
}

function ratio(doc: Doc): number | null {
  const r = edState().opts.crop.ratio;
  if (r === 'free') return null;
  if (r === 'original') return doc.width / doc.height;
  const [a, b] = r.split(':').map(Number);
  return a / b;
}

const HANDLES: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

function handlePos(r: Rect, hx: number, hy: number): [number, number] {
  return [r.x + ((hx + 1) / 2) * r.w, r.y + ((hy + 1) / 2) * r.h];
}

function hit(env: ToolEnv, c: CropState, p: ToolPointer) {
  for (const [hx, hy] of HANDLES) {
    const [x, y] = env.toScreen(...handlePos(c.r, hx, hy));
    if (Math.hypot(x - p.sx, y - p.sy) < 9) return { kind: 'handle' as const, hx, hy };
  }
  const r = c.r;
  if (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h) return { kind: 'move' as const, hx: 0, hy: 0 };
  return { kind: 'new' as const, hx: 0, hy: 0 };
}

const CURSOR: Record<string, string> = { '-1,-1': 'nwse-resize', '1,1': 'nwse-resize', '1,-1': 'nesw-resize', '-1,1': 'nesw-resize', '0,-1': 'ns-resize', '0,1': 'ns-resize', '-1,0': 'ew-resize', '1,0': 'ew-resize' };

export function commitCrop(doc: Doc) {
  const c = crop;
  if (!c || c.doc !== doc) return;
  const r = { x: Math.round(c.r.x), y: Math.round(c.r.y), w: Math.round(c.r.w), h: Math.round(c.r.h) };
  crop = null;
  bus.requestOverlay();
  if (r.x === 0 && r.y === 0 && r.w === doc.width && r.h === doc.height) return;
  if (r.w < 1 || r.h < 1) return;
  cropDoc(doc, r, edState().opts.crop.deletePixels);
}

export function cancelCrop() {
  crop = null;
  drag = null;
  bus.requestOverlay();
}

export const cropTool: Tool = {
  cursor(env, p) {
    if (!p) return 'crosshair';
    const c = ensure(env.doc);
    const h = drag ?? hit(env, c, p);
    return h.kind === 'handle' ? CURSOR[`${h.hx},${h.hy}`] : h.kind === 'move' ? 'move' : 'crosshair';
  },
  down(env, p) {
    const c = ensure(env.doc);
    const h = hit(env, c, p);
    drag = { ...h, start: { ...c.r }, px: p.x, py: p.y };
    if (h.kind === 'new') c.r = { x: p.x, y: p.y, w: 0, h: 0 };
  },
  move(env, p) {
    if (!drag || !crop) return;
    const c = crop;
    const doc = env.doc;
    const s = drag.start;
    const k = ratio(doc) ?? (p.shift ? (drag.kind === 'new' ? 1 : s.w / Math.max(1, s.h)) : null);
    if (drag.kind === 'move') {
      const dx = p.x - drag.px;
      const dy = p.y - drag.py;
      c.r = { ...s, x: Math.max(Math.min(s.x + dx, doc.width - s.w), Math.min(0, doc.width - s.w)), y: Math.max(Math.min(s.y + dy, doc.height - s.h), Math.min(0, doc.height - s.h)) };
    } else if (drag.kind === 'new') {
      let w = p.x - drag.px;
      let h = p.y - drag.py;
      if (k) {
        if (Math.abs(w) / k > Math.abs(h)) h = Math.sign(h || 1) * (Math.abs(w) / k);
        else w = Math.sign(w || 1) * Math.abs(h) * k;
      }
      c.r = { x: Math.min(drag.px, drag.px + w), y: Math.min(drag.py, drag.py + h), w: Math.abs(w), h: Math.abs(h) };
    } else {
      let x0 = s.x;
      let y0 = s.y;
      let x1 = s.x + s.w;
      let y1 = s.y + s.h;
      if (drag.hx < 0) x0 = p.x;
      if (drag.hx > 0) x1 = p.x;
      if (drag.hy < 0) y0 = p.y;
      if (drag.hy > 0) y1 = p.y;
      let w = Math.max(1, Math.abs(x1 - x0));
      let h = Math.max(1, Math.abs(y1 - y0));
      if (k) {
        if (drag.hx && drag.hy) {
          if (w / k > h) h = w / k;
          else w = h * k;
        } else if (drag.hx) h = w / k;
        else w = h * k;
        if (drag.hx < 0) x0 = x1 - w;
        else x1 = x0 + w;
        if (drag.hy < 0) y0 = y1 - h;
        else if (drag.hy > 0) y1 = y0 + h;
        else {
          const cy = s.y + s.h / 2;
          y0 = cy - h / 2;
          y1 = cy + h / 2;
        }
        if (!drag.hx) {
          const cx = s.x + s.w / 2;
          x0 = cx - w / 2;
          x1 = cx + w / 2;
        }
      }
      c.r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
    bus.requestOverlay();
  },
  up() {
    if (crop && drag?.kind === 'new' && (crop.r.w < 2 || crop.r.h < 2)) crop.r = { ...drag.start };
    drag = null;
    bus.requestOverlay();
  },
  dblclick(env) {
    commitCrop(env.doc);
  },
  key(env, e) {
    if (e.key === 'Enter') {
      commitCrop(env.doc);
      return true;
    }
    if (e.key === 'Escape') {
      cancelCrop();
      return true;
    }
    return false;
  },
  overlay(env, ctx) {
    const c = ensure(env.doc);
    const [x0, y0] = env.toScreen(c.r.x, c.r.y);
    const [x1, y1] = env.toScreen(c.r.x + c.r.w, c.r.y + c.r.h);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, env.width, env.height);
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const gx = Math.round(x0 + ((x1 - x0) * i) / 3) + 0.5;
      const gy = Math.round(y0 + ((y1 - y0) * i) / 3) + 0.5;
      ctx.moveTo(gx, y0);
      ctx.lineTo(gx, y1);
      ctx.moveTo(x0, gy);
      ctx.lineTo(x1, gy);
    }
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
    ctx.restore();
    for (const [hx, hy] of HANDLES) drawHandle(ctx, x0 + ((hx + 1) / 2) * (x1 - x0), y0 + ((hy + 1) / 2) * (y1 - y0), 8);
    ctx.save();
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    const label = `${Math.round(c.r.w)} × ${Math.round(c.r.h)} px`;
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(30,30,32,0.9)';
    ctx.fillRect(x1 - tw, y1 + 8, tw, 20);
    ctx.fillStyle = '#e8e8ea';
    ctx.fillText(label, x1 - tw + 6, y1 + 22);
    ctx.restore();
  },
  deactivate() {
    crop = null;
    drag = null;
  },
  busy: () => !!drag,
};
