import type { Tool, ToolPointer } from './types';

let last: [number, number] | null = null;

export const handTool: Tool = {
  cursor: () => (last ? 'grabbing' : 'grab'),
  down(_env, p) {
    last = [p.sx, p.sy];
  },
  move(env, p) {
    if (!last) return;
    env.panBy(p.sx - last[0], p.sy - last[1]);
    last = [p.sx, p.sy];
  },
  up() {
    last = null;
  },
};

let zoomStart: { sx: number; sy: number; scale: number; moved: boolean } | null = null;

export const zoomTool: Tool = {
  cursor: (_env, p) => (p?.alt ? 'zoom-out' : 'zoom-in'),
  down(env, p) {
    zoomStart = { sx: p.sx, sy: p.sy, scale: env.view.scale, moved: false };
  },
  move(env, p) {
    if (!zoomStart) return;
    const dx = p.sx - zoomStart.sx;
    if (Math.abs(dx) > 3) zoomStart.moved = true;
    if (zoomStart.moved) env.zoomAt(zoomStart.scale * Math.exp(dx * 0.01), zoomStart.sx, zoomStart.sy);
  },
  up(env, p: ToolPointer) {
    if (zoomStart && !zoomStart.moved) env.zoomStep(p.alt ? -1 : 1, p.sx, p.sy);
    zoomStart = null;
  },
};
