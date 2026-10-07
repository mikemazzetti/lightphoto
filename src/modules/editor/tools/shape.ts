import { baseLayer, Doc } from '../model/doc';
import { rasterizeVector } from '../model/rasterize';
import { edState, touch } from '../model/store';
import type { Layer, ShapeType } from '../model/types';
import { commit, nextLayerName } from '../ops/layers';
import type { Tool } from './types';

const NAMES: Record<ShapeType, string> = { rect: 'Rectangle', rounded: 'Rounded Rectangle', ellipse: 'Ellipse', line: 'Line' };

let draft: { doc: Doc; layer: Layer; x0: number; y0: number; type: ShapeType } | null = null;

function makeShapeTool(type: ShapeType): Tool {
  return {
    cursor: () => 'crosshair',
    down(env, p) {
      const doc = env.doc;
      const o = edState().opts.shape;
      const l = baseLayer('shape', nextLayerName(doc, NAMES[type]));
      const fg = edState().fg;
      l.shape = {
        type,
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
        radius: o.radius,
        fill: type === 'line' ? null : o.fill ? { ...o.fill } : null,
        stroke: type === 'line' ? { ...(o.stroke ?? o.fill ?? fg) } : o.stroke ? { ...o.stroke } : null,
        strokeWidth: type === 'line' ? o.lineWidth : o.strokeWidth,
      };
      if (!l.shape.fill && !l.shape.stroke) l.shape.fill = { ...fg };
      rasterizeVector(l);
      const i = doc.indexOf(doc.activeLayerId);
      doc.layers.splice(i < 0 ? doc.layers.length : i + 1, 0, l);
      doc.activeLayerId = l.id;
      doc.editMask = false;
      doc.touchLayer(l);
      draft = { doc, layer: l, x0: p.x, y0: p.y, type };
    },
    move(_env, p) {
      const d = draft;
      if (!d || !d.layer.shape) return;
      let w = p.x - d.x0;
      let h = p.y - d.y0;
      if (d.type === 'line') {
        if (p.shift) {
          const a = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(w, h);
          w = Math.cos(a) * len;
          h = Math.sin(a) * len;
        }
        d.layer.shape = { ...d.layer.shape, x: d.x0, y: d.y0, w, h };
      } else {
        if (p.shift) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        let x = Math.min(d.x0, d.x0 + w);
        let y = Math.min(d.y0, d.y0 + h);
        let aw = Math.abs(w);
        let ah = Math.abs(h);
        if (p.alt) {
          x = d.x0 - aw;
          y = d.y0 - ah;
          aw *= 2;
          ah *= 2;
        }
        d.layer.shape = { ...d.layer.shape, x: Math.round(x), y: Math.round(y), w: Math.round(aw), h: Math.round(ah) };
      }
      rasterizeVector(d.layer);
      d.doc.touchLayer(d.layer);
    },
    up() {
      const d = draft;
      draft = null;
      if (!d || !d.layer.shape) return;
      const s = d.layer.shape;
      const tiny = d.type === 'line' ? Math.hypot(s.w, s.h) < 2 : s.w < 2 || s.h < 2;
      if (tiny) {
        const i = d.doc.indexOf(d.layer.id);
        d.doc.layers.splice(i, 1);
        d.doc.activeLayerId = d.doc.layers[Math.max(0, i - 1)]?.id ?? '';
        d.doc.invalidate();
        touch();
        return;
      }
      commit(d.doc, `${NAMES[d.type]} Tool`);
    },
    deactivate() {
      if (draft) {
        const d = draft;
        draft = null;
        const i = d.doc.indexOf(d.layer.id);
        if (i >= 0) d.doc.layers.splice(i, 1);
        d.doc.invalidate();
      }
    },
    busy: () => !!draft,
  };
}

export const shapeTools = {
  shapeRect: makeShapeTool('rect'),
  shapeRounded: makeShapeTool('rounded'),
  shapeEllipse: makeShapeTool('ellipse'),
  shapeLine: makeShapeTool('line'),
};
