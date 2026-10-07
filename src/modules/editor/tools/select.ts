import { bus } from '../model/bus';
import { rectFromPoints } from '../model/geom';
import { Selection, SelectionMode } from '../model/selection';
import { edState, touch } from '../model/store';
import { applySelection, deselect, magicWand } from '../ops/select';
import type { Tool, ToolEnv, ToolPointer } from './types';
import { strokeHalo } from './types';

/** Selection mode from the options bar, overridden by modifiers held at mouse-down (Photoshop). */
export function modeFor(p: ToolPointer, base: SelectionMode): SelectionMode {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return base;
}

// ---------------------------------------------------------------------------------------------
// Marquee (rectangular / elliptical)

interface MarqueeDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mode: SelectionMode;
  shiftAtStart: boolean;
  altAtStart: boolean;
  moveSel: { sel: Selection; lx: number; ly: number } | null;
}
let mq: MarqueeDrag | null = null;

function marqueeRect(p: ToolPointer | null, d: MarqueeDrag) {
  const o = edState().opts.marquee;
  let { x0, y0, x1, y1 } = d;
  let w = x1 - x0;
  let h = y1 - y0;
  const square = p ? p.shift && !d.shiftAtStart : false;
  if (o.style === 'ratio' || square) {
    const ratio = square ? 1 : o.ratioW / Math.max(0.001, o.ratioH);
    const aw = Math.abs(w);
    const ah = Math.abs(h);
    if (aw / ratio > ah) h = Math.sign(h || 1) * (aw / ratio);
    else w = Math.sign(w || 1) * ah * ratio;
  } else if (o.style === 'size') {
    w = o.ratioW;
    h = o.ratioH;
  }
  const fromCenter = p ? p.alt && !d.altAtStart : false;
  if (fromCenter) {
    x0 -= w;
    y0 -= h;
    w *= 2;
    h *= 2;
  }
  x1 = x0 + w;
  y1 = y0 + h;
  return rectFromPoints(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
}

function makeMarquee(ellipse: boolean): Tool {
  return {
    cursor: (env, p) => {
      const s = env.doc.selection;
      if (p && s && !p.shift && !p.alt && s.valueAt(p.x, p.y) > 0 && edState().opts.marquee.mode === 'new') return 'move';
      return 'crosshair';
    },
    down(env, p) {
      const o = edState().opts.marquee;
      const s = env.doc.selection;
      const mode = modeFor(p, o.mode);
      if (mode === 'new' && s && s.valueAt(p.x, p.y) > 0) {
        mq = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, mode, shiftAtStart: p.shift, altAtStart: p.alt, moveSel: { sel: s, lx: 0, ly: 0 } };
        return;
      }
      if (o.style === 'size') {
        mq = { x0: p.x, y0: p.y, x1: p.x + o.ratioW, y1: p.y + o.ratioH, mode, shiftAtStart: p.shift, altAtStart: p.alt, moveSel: null };
      } else mq = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, mode, shiftAtStart: p.shift, altAtStart: p.alt, moveSel: null };
      bus.requestOverlay();
    },
    move(env, p) {
      if (!mq) return;
      if (mq.moveSel) {
        const dx = Math.round(p.x - mq.x0);
        const dy = Math.round(p.y - mq.y0);
        if (dx !== mq.moveSel.lx || dy !== mq.moveSel.ly) {
          mq.moveSel.lx = dx;
          mq.moveSel.ly = dy;
          env.doc.selection = mq.moveSel.sel.translate(dx, dy);
          env.doc.invalidate();
        }
        return;
      }
      if (edState().opts.marquee.style === 'size') {
        mq.x0 = p.x;
        mq.y0 = p.y;
        mq.x1 = p.x + edState().opts.marquee.ratioW;
        mq.y1 = p.y + edState().opts.marquee.ratioH;
      } else {
        mq.x1 = p.x;
        mq.y1 = p.y;
      }
      bus.requestOverlay();
    },
    up(env, p) {
      const d = mq;
      mq = null;
      bus.requestOverlay();
      if (!d) return;
      const doc = env.doc;
      if (d.moveSel) {
        if (d.moveSel.lx || d.moveSel.ly) {
          // The undo baseline still holds the original selection.
          doc.commit('Move Selection');
          touch();
        } else if (d.mode === 'new') deselect(doc);
        return;
      }
      const r = marqueeRect(p, d);
      const o = edState().opts.marquee;
      if (r.w < 1 || r.h < 1 || (o.style === 'normal' && Math.hypot(p.sx - env.toScreen(d.x0, d.y0)[0], p.sy - env.toScreen(d.x0, d.y0)[1]) < 3)) {
        if (d.mode === 'new') deselect(doc);
        return;
      }
      const shape = ellipse ? Selection.ellipse(doc.width, doc.height, r, o.feather, o.antialias) : Selection.rect(doc.width, doc.height, r, o.feather);
      applySelection(doc, shape, d.mode, ellipse ? 'Elliptical Marquee' : 'Rectangular Marquee');
    },
    overlay(env, ctx) {
      if (!mq || mq.moveSel) return;
      const r = marqueeRect(null, mq);
      const [x0, y0] = env.toScreen(r.x, r.y);
      const [x1, y1] = env.toScreen(r.x + r.w, r.y + r.h);
      strokeHalo(
        ctx,
        () => {
          ctx.beginPath();
          if (ellipse) ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
          else ctx.rect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
        },
        '#fff',
        [4, 4],
      );
      // live size readout
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      const label = `W: ${r.w} px  H: ${r.h} px`;
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(30,30,32,0.9)';
      ctx.fillRect(x1 + 12, y1 + 12, tw, 20);
      ctx.fillStyle = '#e8e8ea';
      ctx.fillText(label, x1 + 18, y1 + 26);
    },
    busy: () => !!mq,
  };
}

export const marqueeRectTool = makeMarquee(false);
export const marqueeEllipseTool = makeMarquee(true);

// ---------------------------------------------------------------------------------------------
// Lasso / polygonal lasso

let lasso: { pts: [number, number][]; mode: SelectionMode } | null = null;
let poly: { pts: [number, number][]; mode: SelectionMode; hover: [number, number] | null } | null = null;

function finishPolygon(env: ToolEnv, pts: [number, number][], mode: SelectionMode, label: string) {
  const o = edState().opts.lasso;
  const doc = env.doc;
  if (pts.length < 3) {
    if (mode === 'new') deselect(doc);
    return;
  }
  applySelection(doc, Selection.polygon(doc.width, doc.height, pts, o.feather, o.antialias), mode, label);
}

export const lassoTool: Tool = {
  cursor: () => 'crosshair',
  down(_env, p) {
    lasso = { pts: [[p.x, p.y]], mode: modeFor(p, edState().opts.lasso.mode) };
  },
  move(_env, p) {
    if (!lasso) return;
    for (const q of p.points) {
      const l = lasso.pts[lasso.pts.length - 1];
      if (Math.hypot(q.x - l[0], q.y - l[1]) >= 0.75) lasso.pts.push([q.x, q.y]);
    }
    bus.requestOverlay();
  },
  up(env) {
    const l = lasso;
    lasso = null;
    bus.requestOverlay();
    if (l) finishPolygon(env, l.pts, l.mode, 'Lasso');
  },
  overlay(env, ctx) {
    if (!lasso || lasso.pts.length < 2) return;
    strokeHalo(ctx, () => {
      ctx.beginPath();
      lasso!.pts.forEach(([x, y], i) => {
        const [sx, sy] = env.toScreen(x, y);
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      });
    });
  },
  busy: () => !!lasso,
};

export const polyLassoTool: Tool = {
  cursor: () => 'crosshair',
  down(env, p) {
    if (!poly) {
      poly = { pts: [[p.x, p.y]], mode: modeFor(p, edState().opts.lasso.mode), hover: null };
      bus.requestOverlay();
      return;
    }
    const [fx, fy] = env.toScreen(poly.pts[0][0], poly.pts[0][1]);
    if (poly.pts.length > 2 && Math.hypot(p.sx - fx, p.sy - fy) < 8) {
      const pp = poly;
      poly = null;
      finishPolygon(env, pp.pts, pp.mode, 'Polygonal Lasso');
    } else poly.pts.push([p.x, p.y]);
    bus.requestOverlay();
  },
  hover(_env, p) {
    if (!poly) return;
    poly.hover = [p.x, p.y];
    bus.requestOverlay();
  },
  move(_env, p) {
    if (!poly) return;
    poly.hover = [p.x, p.y];
    bus.requestOverlay();
  },
  dblclick(env) {
    if (!poly) return;
    const pp = poly;
    poly = null;
    finishPolygon(env, pp.pts, pp.mode, 'Polygonal Lasso');
    bus.requestOverlay();
  },
  key(env, e) {
    if (!poly) return false;
    if (e.key === 'Enter') {
      const pp = poly;
      poly = null;
      finishPolygon(env, pp.pts, pp.mode, 'Polygonal Lasso');
    } else if (e.key === 'Escape') poly = null;
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      poly.pts.pop();
      if (!poly.pts.length) poly = null;
    } else return false;
    bus.requestOverlay();
    return true;
  },
  overlay(env, ctx) {
    if (!poly) return;
    const pts = poly.hover ? [...poly.pts, poly.hover] : poly.pts;
    strokeHalo(ctx, () => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = env.toScreen(x, y);
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      });
    });
    const [fx, fy] = env.toScreen(poly.pts[0][0], poly.pts[0][1]);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.arc(fx, fy, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  },
  deactivate() {
    poly = null;
  },
  busy: () => !!poly,
};

// ---------------------------------------------------------------------------------------------

export const wandTool: Tool = {
  cursor: () => 'crosshair',
  down(env, p) {
    const o = edState().opts.wand;
    magicWand(env.doc, p.x, p.y, { ...o, mode: modeFor(p, o.mode) });
  },
};
