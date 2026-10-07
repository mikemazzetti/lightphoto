import { hexToRgba } from '@/core/util/color';
import type { TitleSpec } from '../model/types';

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const rgbaCss = (hex: string, alpha = 1) => {
  const c = hexToRgba(hex);
  return `rgba(${c.r},${c.g},${c.b},${c.a * alpha})`;
};

/** Renders a title as a full-frame transparent canvas (w×h = sequence frame size). */
export function renderTitle(spec: TitleSpec, w: number, h: number, into?: Canvas2D): Canvas2D {
  const c = into && into.width === w && into.height === h ? into : makeCanvas(w, h);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const k = h / 1080;
  const size = Math.max(1, spec.size * k);
  ctx.font = `${spec.italic ? 'italic ' : ''}${spec.weight} ${size}px ${spec.font}`;
  (ctx as any).letterSpacing = `${spec.tracking * k}px`;
  ctx.textBaseline = 'middle';
  const lines = spec.text.split('\n');
  const lh = size * spec.lineHeight;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(1, ...widths);
  const blockH = lh * lines.length;
  const ax = spec.x * w;
  const ay = spec.y * h;
  // Block box (top-left) for the chosen alignment.
  const left = spec.align === 'left' ? ax : spec.align === 'right' ? ax - blockW : ax - blockW / 2;
  const top = ay - blockH / 2;
  if (spec.box.on) {
    const pad = spec.box.padding * k;
    ctx.fillStyle = rgbaCss(spec.box.color, spec.box.opacity);
    const r = Math.min(pad, 12 * k);
    const x = left - pad;
    const y = top - pad * 0.6;
    const bw = blockW + pad * 2;
    const bh = blockH + pad * 1.2;
    ctx.beginPath();
    if ((ctx as any).roundRect) (ctx as any).roundRect(x, y, bw, bh, r);
    else ctx.rect(x, y, bw, bh);
    ctx.fill();
  }
  ctx.textAlign = spec.align;
  const tx = ax;
  lines.forEach((line, i) => {
    const y = top + lh * (i + 0.5);
    if (spec.shadow.on) {
      ctx.shadowColor = rgbaCss(spec.shadow.color, spec.shadow.opacity);
      ctx.shadowBlur = spec.shadow.blur * k;
      ctx.shadowOffsetX = spec.shadow.dx * k;
      ctx.shadowOffsetY = spec.shadow.dy * k;
    }
    if (spec.stroke.on && spec.stroke.width > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = spec.stroke.width * 2 * k;
      ctx.strokeStyle = rgbaCss(spec.stroke.color);
      ctx.strokeText(line, tx, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = rgbaCss(spec.color);
    ctx.fillText(line, tx, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  });
  return c;
}

export const titleKey = (spec: TitleSpec, w: number, h: number) => `${w}x${h}|${JSON.stringify(spec)}`;
