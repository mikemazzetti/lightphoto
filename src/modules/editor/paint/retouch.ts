import { falloff } from './dab';

/** CPU dab operations for Blur / Sharpen / Smudge / Dodge / Burn / Sponge. */

export type RetouchTool = 'blur' | 'sharpen' | 'smudge' | 'dodge' | 'burn' | 'sponge';

export interface RetouchParams {
  tool: RetouchTool;
  strength: number; // 0..1
  hardness: number; // 0..1
  range: 'shadows' | 'midtones' | 'highlights';
  spongeMode: 'saturate' | 'desaturate';
  protectTones: boolean;
}

export interface SmudgeState {
  buf: Float32Array | null;
  size: number;
}

/** Box-blurs a w×h RGBA float window in place (separable, radius r). */
function boxBlurWindow(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 4 + c] = acc * k;
        acc += src[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c] - src[(y * w + Math.max(0, x - r)) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = acc * k;
        acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c] - tmp[(Math.max(0, y - r) * w + x) * 4 + c];
      }
    }
  }
  return out;
}

/**
 * Applies one dab centred at (cx, cy) (coordinates of `img`'s pixel grid, i.e. region-local),
 * radius r. `sel(x, y)` returns the selection weight 0..1 for region-local pixels.
 */
export function retouchDab(img: ImageData, cx: number, cy: number, r: number, p: RetouchParams, sel: ((x: number, y: number) => number) | null, smudge: SmudgeState) {
  const { width: W, height: H, data } = img;
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(W, Math.ceil(cx + r) + 1);
  const y1 = Math.min(H, Math.ceil(cy + r) + 1);
  if (x1 <= x0 || y1 <= y0) return;
  const hard = p.hardness;
  const weight = (x: number, y: number) => {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(0.5, r);
    let w = falloff(d, hard);
    if (w > 0 && sel) w *= sel(x, y);
    return w;
  };

  if (p.tool === 'blur' || p.tool === 'sharpen') {
    const br = p.tool === 'blur' ? Math.max(1, Math.round(r / 6)) : 1;
    const wx0 = Math.max(0, x0 - br);
    const wy0 = Math.max(0, y0 - br);
    const wx1 = Math.min(W, x1 + br);
    const wy1 = Math.min(H, y1 + br);
    const ww = wx1 - wx0;
    const wh = wy1 - wy0;
    const win = new Float32Array(ww * wh * 4);
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const s = ((wy0 + y) * W + wx0 + x) * 4;
        const a = data[s + 3] / 255;
        const d = (y * ww + x) * 4;
        win[d] = data[s] * a;
        win[d + 1] = data[s + 1] * a;
        win[d + 2] = data[s + 2] * a;
        win[d + 3] = data[s + 3];
      }
    }
    const bl = boxBlurWindow(win, ww, wh, br);
    const k = p.tool === 'blur' ? p.strength * 0.6 : p.strength * 0.35;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const w = weight(x, y) * k;
        if (w <= 0) continue;
        const s = (y * W + x) * 4;
        const d = ((y - wy0) * ww + (x - wx0)) * 4;
        const ba = bl[d + 3];
        if (p.tool === 'blur') {
          const na = data[s + 3] + (ba - data[s + 3]) * w;
          const inv = ba > 0 ? 255 / ba : 0;
          for (let c = 0; c < 3; c++) data[s + c] = data[s + c] + (bl[d + c] * inv - data[s + c]) * w;
          data[s + 3] = na;
        } else {
          const inv = ba > 0 ? 255 / ba : 0;
          for (let c = 0; c < 3; c++) {
            const v = data[s + c];
            data[s + c] = v + (v - bl[d + c] * inv) * w * 2;
          }
        }
      }
    }
    return;
  }

  if (p.tool === 'smudge') {
    const D = Math.ceil(r * 2) + 2;
    const ox = Math.round(cx) - (D >> 1);
    const oy = Math.round(cy) - (D >> 1);
    if (!smudge.buf || smudge.size !== D) {
      smudge.size = D;
      smudge.buf = new Float32Array(D * D * 4);
      for (let y = 0; y < D; y++)
        for (let x = 0; x < D; x++) {
          const sx = Math.min(W - 1, Math.max(0, ox + x));
          const sy = Math.min(H - 1, Math.max(0, oy + y));
          const s = (sy * W + sx) * 4;
          for (let c = 0; c < 4; c++) smudge.buf[(y * D + x) * 4 + c] = data[s + c];
        }
      return;
    }
    const buf = smudge.buf;
    for (let y = 0; y < D; y++) {
      const py = oy + y;
      if (py < 0 || py >= H) continue;
      for (let x = 0; x < D; x++) {
        const px = ox + x;
        if (px < 0 || px >= W) continue;
        const w = weight(px, py) * p.strength;
        const s = (py * W + px) * 4;
        const b = (y * D + x) * 4;
        for (let c = 0; c < 4; c++) {
          const v = data[s + c] + (buf[b + c] - data[s + c]) * w;
          data[s + c] = v;
          // the finger keeps carrying paint, slowly picking up the canvas
          buf[b + c] = buf[b + c] + (v - buf[b + c]) * (1 - p.strength * 0.9);
        }
      }
    }
    return;
  }

  // dodge / burn / sponge
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const w = weight(x, y);
      if (w <= 0) continue;
      const s = (y * W + x) * 4;
      let r0 = data[s] / 255;
      let g0 = data[s + 1] / 255;
      let b0 = data[s + 2] / 255;
      const l = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
      if (p.tool === 'sponge') {
        const k = w * p.strength * 0.15 * (p.spongeMode === 'saturate' ? 1 : -1);
        r0 = l + (r0 - l) * (1 + k);
        g0 = l + (g0 - l) * (1 + k);
        b0 = l + (b0 - l) * (1 + k);
        if (p.protectTones) {
          const mx = Math.max(r0, g0, b0);
          const mn = Math.min(r0, g0, b0);
          if (mx > 1 || mn < 0) continue; // vibrance-style: never clip
        }
      } else {
        const rw = p.range === 'shadows' ? (1 - l) * (1 - l) : p.range === 'highlights' ? l * l : 1 - (2 * l - 1) * (2 * l - 1);
        const k = w * p.strength * rw * 0.12;
        const gamma = p.tool === 'dodge' ? 1 / (1 + k * 2) : 1 + k * 2;
        if (p.protectTones) {
          const nl = Math.pow(Math.max(l, 1e-4), gamma);
          const ratio = nl / Math.max(l, 1e-4);
          r0 *= ratio;
          g0 *= ratio;
          b0 *= ratio;
        } else {
          r0 = Math.pow(r0, gamma);
          g0 = Math.pow(g0, gamma);
          b0 = Math.pow(b0, gamma);
        }
      }
      data[s] = r0 * 255;
      data[s + 1] = g0 * 255;
      data[s + 2] = b0 * 255;
    }
  }
}
