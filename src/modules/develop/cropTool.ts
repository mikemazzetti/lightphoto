import { apply, ASPECT_PRESETS, maxCrop, outputToOriented } from '@/core/develop/geometry';
import type { Crop, DevelopSettings } from '@/core/develop/settings';
import { commit, DevelopState, setLive, useDevelop } from './store';
import { getController, type VPos, type ViewerController } from './controller';
import { CURSORS } from './cursors';

/**
 * Crop & Straighten tool. While active the viewer renders the whole straightened frame and the
 * crop rectangle (normalised in the oriented frame) is edited live in `settings.crop`.
 */

export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Hit = Handle | 'move' | 'rotate';

let session: { crop: Crop; angle: number } | null = null;
/** Angle-slider drag in progress: the crop it started from (and the photo it belongs to). */
let angleDrag: { photoId: string | null; base: Crop; auto: boolean } | null = null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Crop lies inside the frame and inside the rotated image. W/H = oriented pixel size. */
export function cropValid(c: Crop, angle: number, W: number, H: number): boolean {
  const e = 1e-4;
  if (c.w <= 0 || c.h <= 0 || c.x < -e || c.y < -e || c.x + c.w > 1 + e || c.y + c.h > 1 + e) return false;
  if (Math.abs(angle) < 1e-6) return true;
  const m = outputToOriented(W, H, { orientation: 0, angle, crop: c });
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const [u, v] = apply(m, x, y);
    if (u < -e || u > 1 + e || v < -e || v > 1 + e) return false;
  }
  return true;
}

/** Shrinks (and if needed re-centres) a crop about its centre until it is valid. */
export function shrinkToValid(c: Crop, angle: number, W: number, H: number): Crop {
  if (cropValid(c, angle, W, H)) return c;
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  const at = (k: number, t: number): Crop => {
    const mx = cx + (0.5 - cx) * t;
    const my = cy + (0.5 - cy) * t;
    return { x: mx - (c.w * k) / 2, y: my - (c.h * k) / 2, w: c.w * k, h: c.h * k };
  };
  let t = 0;
  if (!cropValid(at(0.01, 0), angle, W, H)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (cropValid(at(0.01, mid), angle, W, H)) hi = mid;
      else lo = mid;
    }
    t = hi;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (cropValid(at(mid, t), angle, W, H)) lo = mid;
    else hi = mid;
  }
  return at(Math.max(lo, 1e-3), t);
}

const lerpCrop = (a: Crop, b: Crop, t: number): Crop => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });

/** Largest t∈[0,1] such that lerp(from, to, t) is valid (from must be valid). */
function towards(from: Crop, to: Crop, angle: number, W: number, H: number): Crop {
  if (cropValid(to, angle, W, H)) return to;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (cropValid(lerpCrop(from, to, mid), angle, W, H)) lo = mid;
    else hi = mid;
  }
  return lerpCrop(from, to, lo);
}

/** Aspect ratio (px w/h) for the selected preset, matched to the image orientation; null = free. */
export function aspectFor(st: Pick<DevelopState, 'cropAspect' | 'cropPortrait'>, W: number, H: number): number | null {
  const p = ASPECT_PRESETS.find((a) => a.label === st.cropAspect);
  if (!p || p.value === null) return null;
  let a = p.value === -1 ? W / H : p.value;
  if (p.value !== -1 && a !== 1 && a >= 1 !== W >= H) a = 1 / a;
  if (st.cropPortrait && a !== 1) a = 1 / a;
  return a;
}

const cropAspectPx = (c: Crop, W: number, H: number) => (c.w * W) / Math.max(1e-9, c.h * H);

function lockedAspect(st: DevelopState, c: Crop, W: number, H: number, shift: boolean): number | null {
  const a = aspectFor(st, W, H);
  if (a) return a;
  // Free: the lock (or Shift) keeps the current proportions.
  return st.cropLocked || shift ? cropAspectPx(c, W, H) : null;
}

const near = (a: Crop, b: Crop) => Math.abs(a.x - b.x) < 2e-3 && Math.abs(a.y - b.y) < 2e-3 && Math.abs(a.w - b.w) < 2e-3 && Math.abs(a.h - b.h) < 2e-3;

/** Crop for a new straighten angle: re-maximised when the crop was "auto" (max for its aspect), else shrunk to fit. */
function cropForAngle(base: Crop, auto: boolean, angle: number, W: number, H: number): Crop {
  if (auto) return maxCrop(cropAspectPx(base, W, H), angle, W, H);
  return shrinkToValid(base, angle, W, H);
}
function isAuto(c: Crop, angle: number, W: number, H: number) {
  return near(c, maxCrop(cropAspectPx(c, W, H), angle, W, H));
}

function hitTest(c: ViewerController, p: VPos, crop: Crop): Hit {
  const [x0, y0] = c.fromOut(crop.x, crop.y);
  const [x1, y1] = c.fromOut(crop.x + crop.w, crop.y + crop.h);
  const r = 9;
  const inX = p.cx >= x0 - r && p.cx <= x1 + r;
  const inY = p.cy >= y0 - r && p.cy <= y1 + r;
  if (inX && inY) {
    const L = Math.abs(p.cx - x0) <= r;
    const R = Math.abs(p.cx - x1) <= r;
    const T = Math.abs(p.cy - y0) <= r;
    const B = Math.abs(p.cy - y1) <= r;
    if (T && L) return 'nw';
    if (T && R) return 'ne';
    if (B && L) return 'sw';
    if (B && R) return 'se';
    if (T) return 'n';
    if (B) return 's';
    if (L) return 'w';
    if (R) return 'e';
  }
  if (p.cx > x0 && p.cx < x1 && p.cy > y0 && p.cy < y1) return 'move';
  return 'rotate';
}

const HANDLE_CURSOR: Record<Hit, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  move: 'move',
  rotate: CURSORS.rotate,
};

export function hoverCursor(c: ViewerController, p: VPos, st: DevelopState): string {
  if (st.straighten) return 'crosshair';
  return HANDLE_CURSOR[hitTest(c, p, st.settings!.crop)];
}

function resizeCrop(c0: Crop, h: Handle, u: number, v: number, aspect: number | null, W: number, H: number, fromCenter: boolean): Crop {
  let x0 = c0.x * W;
  let y0 = c0.y * H;
  let x1 = (c0.x + c0.w) * W;
  let y1 = (c0.y + c0.h) * H;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const px = u * W;
  const py = v * H;
  const min = Math.max(8, 0.015 * Math.max(W, H));
  const L = h.includes('w');
  const R = h.includes('e');
  const T = h.includes('n');
  const B = h.includes('s');
  if (fromCenter) {
    if (L || R) {
      const d = Math.max(min / 2, Math.abs(px - cx));
      x0 = cx - d;
      x1 = cx + d;
    }
    if (T || B) {
      const d = Math.max(min / 2, Math.abs(py - cy));
      y0 = cy - d;
      y1 = cy + d;
    }
  } else {
    if (L) x0 = Math.min(px, x1 - min);
    if (R) x1 = Math.max(px, x0 + min);
    if (T) y0 = Math.min(py, y1 - min);
    if (B) y1 = Math.max(py, y0 + min);
  }
  if (aspect) {
    let w = x1 - x0;
    let hh = y1 - y0;
    if ((L || R) && (T || B)) {
      if (w / hh > aspect) hh = w / aspect;
      else w = hh * aspect;
    } else if (L || R) hh = w / aspect;
    else w = hh * aspect;
    if (fromCenter) {
      x0 = cx - w / 2;
      x1 = cx + w / 2;
      y0 = cy - hh / 2;
      y1 = cy + hh / 2;
    } else {
      if (L) x0 = x1 - w;
      else if (R) x1 = x0 + w;
      else {
        x0 = cx - w / 2;
        x1 = cx + w / 2;
      }
      if (T) y0 = y1 - hh;
      else if (B) y1 = y0 + hh;
      else {
        y0 = cy - hh / 2;
        y1 = cy + hh / 2;
      }
    }
  }
  return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}

const cur = () => useDevelop.getState().settings!;

export function pointerDown(c: ViewerController, e: PointerEvent, p: VPos, st: DevelopState) {
  const s = st.settings!;
  const [W, H] = c.orientedSize(s);
  if (st.straighten || e.metaKey || e.ctrlKey) return straightenDrag(c, e, p, W, H);
  const hit = hitTest(c, p, s.crop);
  const start = { ...s.crop };
  const angle0 = s.angle;
  if (hit === 'rotate') {
    const [ccx, ccy] = c.fromOut(start.x + start.w / 2, start.y + start.h / 2);
    const a0 = Math.atan2(p.cy - ccy, p.cx - ccx);
    const auto = isAuto(start, angle0, W, H);
    c.drag(
      e,
      (ev) => {
        const q = c.pos(ev);
        let da = ((Math.atan2(q.cy - ccy, q.cx - ccx) - a0) * 180) / Math.PI;
        da = ((da + 540) % 360) - 180;
        let angle = clamp(angle0 + da, -45, 45);
        angle = ev.shiftKey ? Math.round(angle) : Math.round(angle * 100) / 100;
        c.hud = `${angle > 0 ? '+' : ''}${angle.toFixed(1)}°`;
        setLive({ ...cur(), angle, crop: cropForAngle(start, auto, angle, W, H) });
      },
      () => {
        c.hud = null;
      },
      'rotate',
    );
    return;
  }
  if (hit === 'move') {
    c.drag(
      e,
      (ev) => {
        const q = c.pos(ev);
        const du = (q.cx - p.cx) / (W * c.view.scale);
        const dv = (q.cy - p.cy) / (H * c.view.scale);
        // Slide each axis separately so the box glides along the image edges.
        let next = towards(start, { ...start, x: start.x + du }, angle0, W, H);
        next = towards(next, { ...next, y: next.y + dv }, angle0, W, H);
        setLive({ ...cur(), crop: next });
      },
      undefined,
      'move',
    );
    return;
  }
  c.drag(
    e,
    (ev) => {
      const q = c.pos(ev);
      const [u, v] = c.toOut(q.cx, q.cy);
      const aspect = lockedAspect(useDevelop.getState(), start, W, H, ev.shiftKey);
      const target = resizeCrop(start, hit, u, v, aspect, W, H, ev.altKey);
      setLive({ ...cur(), crop: towards(start, target, angle0, W, H) });
    },
    undefined,
    'resize',
  );
}

function straightenDrag(c: ViewerController, e: PointerEvent, p: VPos, W: number, H: number) {
  let b = p;
  c.ruler = [p, b];
  c.drag(
    e,
    (ev) => {
      b = c.pos(ev);
      c.ruler = [p, b];
      const dx = b.cx - p.cx;
      const dy = b.cy - p.cy;
      c.hud = Math.hypot(dx, dy) > 10 ? `${(-lineTilt(dx, dy)).toFixed(1)}°` : null;
      c.requestOverlay();
    },
    () => {
      c.ruler = null;
      c.hud = null;
      const dx = b.cx - p.cx;
      const dy = b.cy - p.cy;
      useDevelop.setState({ straighten: false });
      if (Math.hypot(dx, dy) < 10) return;
      const s = cur();
      const angle = clamp(Math.round((s.angle - lineTilt(dx, dy)) * 100) / 100, -45, 45);
      setLive({ ...s, angle, crop: cropForAngle(s.crop, isAuto(s.crop, s.angle, W, H), angle, W, H) });
    },
    'straighten',
  );
}

/** Tilt of a drawn line relative to the nearest horizontal/vertical, in degrees (clockwise +). */
function lineTilt(dx: number, dy: number) {
  let th = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (th > 90) th -= 180;
  if (th < -90) th += 180;
  if (th > 45) th -= 90;
  else if (th < -45) th += 90;
  return th;
}

export function draw(c: ViewerController, ctx: CanvasRenderingContext2D, st: DevelopState) {
  const crop = st.settings!.crop;
  const [x0, y0] = c.fromOut(crop.x, crop.y);
  const [x1, y1] = c.fromOut(crop.x + crop.w, crop.y + crop.h);
  const [vw, vh] = c.vpSize();
  const w = x1 - x0;
  const h = y1 - y0;
  ctx.save();
  ctx.fillStyle = 'rgba(8,8,10,0.66)';
  ctx.beginPath();
  ctx.rect(-2, -2, vw + 4, vh + 4);
  ctx.rect(x0, y0, w, h);
  ctx.fill('evenodd');

  const drag = c.dragging;
  const n = drag === 'rotate' || drag === 'straighten' ? 9 : 3;
  ctx.strokeStyle = drag ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < n; i++) {
    const gx = Math.round(x0 + (w * i) / n) + 0.5;
    const gy = Math.round(y0 + (h * i) / n) + 0.5;
    ctx.moveTo(gx, y0);
    ctx.lineTo(gx, y1);
    ctx.moveTo(x0, gy);
    ctx.lineTo(x1, gy);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w) - 1, Math.round(h) - 1);

  // Corner brackets and edge bars.
  const L = Math.min(18, w / 3, h / 3);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3;
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x0, y1, 1, -1],
    [x1, y1, -1, -1],
  ]) {
    ctx.moveTo(cx + sx * L, cy + sy * 1.5);
    ctx.lineTo(cx + sx * 1.5, cy + sy * 1.5);
    ctx.lineTo(cx + sx * 1.5, cy + sy * L);
  }
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const E = Math.min(9, w / 6, h / 6);
  ctx.moveTo(mx - E, y0 + 1.5);
  ctx.lineTo(mx + E, y0 + 1.5);
  ctx.moveTo(mx - E, y1 - 1.5);
  ctx.lineTo(mx + E, y1 - 1.5);
  ctx.moveTo(x0 + 1.5, my - E);
  ctx.lineTo(x0 + 1.5, my + E);
  ctx.moveTo(x1 - 1.5, my - E);
  ctx.lineTo(x1 - 1.5, my + E);
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (c.ruler) {
    const [a, b] = c.ruler;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.moveTo(a.cx, a.cy);
    ctx.lineTo(b.cx, b.cy);
    ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#ffd34d';
    ctx.stroke();
  }
  if (drag === 'resize' || drag === 'move') {
    const [W, H] = c.orientedSize(st.settings!);
    const txt = `${Math.round(crop.w * W)} × ${Math.round(crop.h * H)}`;
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(16,16,18,0.8)';
    const tw = ctx.measureText(txt).width + 12;
    ctx.fillRect(mx - tw / 2, y1 + 8, tw, 18);
    ctx.fillStyle = '#eee';
    ctx.fillText(txt, mx, y1 + 21);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Panel actions

function frameSize(s: DevelopSettings): [number, number] | null {
  const c = getController();
  // Right after a photo switch the engine still holds the previous photo's pixels (stage 'none').
  if (!c || !c.engine.hasSource || c.stage === 'none' || c.photoId !== useDevelop.getState().photoId) return null;
  return c.orientedSize(s);
}

export function enterCrop() {
  const st = useDevelop.getState();
  const s = st.settings;
  if (!s) return;
  if (st.tool === 'crop') return;
  session = { crop: { ...s.crop }, angle: s.angle };
  const patch: Partial<DevelopState> = { tool: 'crop', straighten: false, creating: null };
  const size = frameSize(s);
  if (size) {
    const [W, H] = size;
    const isFull = near(s.crop, FULL_CROP) || isAuto(s.crop, s.angle, W, H);
    const orig = Math.abs(cropAspectPx(s.crop, W, H) - W / H) < 0.01;
    if (isFull && orig) Object.assign(patch, { cropAspect: 'Original', cropPortrait: false, cropLocked: true });
    else if (!aspectFor(st, W, H) || Math.abs((aspectFor(st, W, H) ?? 0) - cropAspectPx(s.crop, W, H)) > 0.01) Object.assign(patch, { cropAspect: 'Free', cropPortrait: false, cropLocked: false });
  }
  useDevelop.setState({ ...patch, zoomMode: 'fit' });
}

/** Done / Enter: keeps the crop and records one history step. */
export function applyCrop() {
  const st = useDevelop.getState();
  if (st.tool !== 'crop') return;
  const s = st.settings;
  const changed = !!s && !!session && (!near(s.crop, session.crop) || s.angle !== session.angle);
  session = null;
  angleDrag = null;
  useDevelop.setState({ tool: 'none', straighten: false, zoomMode: 'fit' });
  if (changed) commit('Crop & Straighten');
}

/** Esc: restores the crop/angle from when the tool was opened. */
export function cancelCrop() {
  const st = useDevelop.getState();
  if (st.tool !== 'crop') return;
  if (session && st.settings) setLive({ ...st.settings, crop: session.crop, angle: session.angle });
  session = null;
  angleDrag = null;
  useDevelop.setState({ tool: 'none', straighten: false, zoomMode: 'fit' });
}

export function resetCrop() {
  const st = useDevelop.getState();
  const s = st.settings;
  if (!s) return;
  const size = frameSize(s);
  const a = size ? aspectFor(st, size[0], size[1]) : null;
  const crop = size && a && st.cropAspect !== 'Original' ? maxCrop(a, 0, size[0], size[1]) : FULL_CROP;
  setLive({ ...s, angle: 0, crop });
  if (st.tool !== 'crop') commit('Reset Crop');
}

export function setAspect(label: string, portrait = useDevelop.getState().cropPortrait) {
  useDevelop.setState({ cropAspect: label, cropPortrait: portrait, cropLocked: label !== 'Free' });
  const st = useDevelop.getState();
  const s = st.settings;
  if (!s) return;
  const size = frameSize(s);
  if (!size) return;
  const a = aspectFor(st, size[0], size[1]);
  if (!a) return;
  const next = maxCrop(a, s.angle, size[0], size[1]);
  setLive({ ...s, crop: next });
  if (st.tool !== 'crop') commit(`Crop Aspect ${label}`);
}

/** X: swaps the crop between landscape and portrait. */
export function swapAspect() {
  const st = useDevelop.getState();
  const s = st.settings;
  if (!s) return;
  const size = frameSize(s);
  if (!size) return;
  if (st.cropAspect === 'Free') {
    const [W, H] = size;
    const a = 1 / cropAspectPx(s.crop, W, H);
    setLive({ ...s, crop: maxCrop(a, s.angle, W, H) });
    return;
  }
  setAspect(st.cropAspect, !st.cropPortrait);
}

/** Angle slider (live). Keeps the crop maximised / inside the rotated image. */
export function setAngle(angle: number) {
  const { settings: s, photoId } = useDevelop.getState();
  if (!s) return;
  const size = frameSize(s);
  if (!size) return setLive({ ...s, angle });
  const [W, H] = size;
  // A drag that started on another photo (switched with ←/→ mid-drag) must not reuse its crop.
  if (!angleDrag || angleDrag.photoId !== photoId) angleDrag = { photoId, base: { ...s.crop }, auto: isAuto(s.crop, s.angle, W, H) };
  setLive({ ...s, angle, crop: cropForAngle(angleDrag.base, angleDrag.auto, angle, W, H) });
}
export function endAngle() {
  angleDrag = null;
  if (useDevelop.getState().tool !== 'crop') commit('Straighten');
}

const rotateCrop = (c: Crop, dir: 1 | -1): Crop => (dir > 0 ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w });
const mirrorCrop = (c: Crop, axis: 'h' | 'v'): Crop => (axis === 'h' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h });

/** Rotates the orientation by ±90°, carrying the crop rectangle along. */
export function rotateOrientation(s: DevelopSettings, dir: 1 | -1): DevelopSettings {
  // Flips are applied after orientation, so a single mirror reverses the visual rotation direction.
  const od = s.flipH !== s.flipV ? -dir : dir;
  const o = (((s.orientation + od * 90) % 360) + 360) % 360;
  // Rotating while the crop tool is open: Esc must restore the original crop in the new frame.
  if (session && useDevelop.getState().tool === 'crop') session = { ...session, crop: rotateCrop(session.crop, dir) };
  return { ...s, orientation: o as DevelopSettings['orientation'], crop: rotateCrop(s.crop, dir) };
}

/** Mirrors the oriented frame; the crop and straighten angle mirror with it. */
export function flip(s: DevelopSettings, axis: 'h' | 'v'): DevelopSettings {
  if (session && useDevelop.getState().tool === 'crop') session = { crop: mirrorCrop(session.crop, axis), angle: -session.angle };
  if (axis === 'h') return { ...s, flipH: !s.flipH, angle: -s.angle, crop: mirrorCrop(s.crop, 'h') };
  return { ...s, flipV: !s.flipV, angle: -s.angle, crop: mirrorCrop(s.crop, 'v') };
}
