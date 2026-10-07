/**
 * Healing: seamless cloning via a membrane (pyramid push-pull) — the texture (high
 * frequencies) comes from the source, the smooth colour/brightness field is interpolated from
 * the destination around the healed area, so the patch blends in without visible seams.
 */

/** Fills unknown pixels (weight 0) of a 3-channel float image from known neighbours. */
export function pushPull(val: Float32Array, wgt: Float32Array, w: number, h: number) {
  const levels: { v: Float32Array; k: Float32Array; w: number; h: number }[] = [{ v: val, k: wgt, w, h }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const p = levels[levels.length - 1];
    const cw = Math.max(1, Math.ceil(p.w / 2));
    const ch = Math.max(1, Math.ceil(p.h / 2));
    const v = new Float32Array(cw * ch * 3);
    const k = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sk = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = y * 2 + dy;
          if (yy >= p.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = x * 2 + dx;
            if (xx >= p.w) continue;
            const i = yy * p.w + xx;
            const kk = p.k[i];
            sr += p.v[i * 3] * kk;
            sg += p.v[i * 3 + 1] * kk;
            sb += p.v[i * 3 + 2] * kk;
            sk += kk;
          }
        }
        const j = y * cw + x;
        if (sk > 0) {
          v[j * 3] = sr / sk;
          v[j * 3 + 1] = sg / sk;
          v[j * 3 + 2] = sb / sk;
        }
        k[j] = Math.min(1, sk);
      }
    }
    levels.push({ v, k, w: cw, h: ch });
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const f = levels[li];
    const c = levels[li + 1];
    for (let y = 0; y < f.h; y++) {
      // bilinear sample of the coarse level at the fine pixel centre
      const cy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(cy);
      const y1 = Math.min(c.h - 1, y0 + 1);
      const fy = cy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const kk = f.k[i];
        if (kk >= 1) continue;
        const cx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx);
        const x1 = Math.min(c.w - 1, x0 + 1);
        const fx = cx - x0;
        for (let ch = 0; ch < 3; ch++) {
          const a = c.v[(y0 * c.w + x0) * 3 + ch];
          const b = c.v[(y0 * c.w + x1) * 3 + ch];
          const cc = c.v[(y1 * c.w + x0) * 3 + ch];
          const d = c.v[(y1 * c.w + x1) * 3 + ch];
          const up = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
          f.v[i * 3 + ch] = f.v[i * 3 + ch] * kk + up * (1 - kk);
        }
        f.k[i] = 1;
      }
    }
  }
}

/**
 * Heals `dst` (RGBA region) using `src` (same size, aligned source pixels) where `alpha` (0..1,
 * stroke coverage) > 0. Returns the healed RGBA (dst untouched outside the stroke).
 */
export function healRegion(dst: Uint8ClampedArray, src: Uint8ClampedArray, alpha: Float32Array, w: number, h: number): Uint8ClampedArray {
  const n = w * h;
  const diff = new Float32Array(n * 3);
  const wgt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (alpha[i] < 0.02) {
      wgt[i] = 1;
      diff[i * 3] = dst[i * 4] - src[i * 4];
      diff[i * 3 + 1] = dst[i * 4 + 1] - src[i * 4 + 1];
      diff[i * 3 + 2] = dst[i * 4 + 2] - src[i * 4 + 2];
    }
  }
  pushPull(diff, wgt, w, h);
  const out = new Uint8ClampedArray(dst);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const healed = src[i * 4 + c] + diff[i * 3 + c];
      out[i * 4 + c] = dst[i * 4 + c] + (healed - dst[i * 4 + c]) * a;
    }
    out[i * 4 + 3] = dst[i * 4 + 3] + (src[i * 4 + 3] - dst[i * 4 + 3]) * a;
  }
  return out;
}

/**
 * Picks a source offset for spot healing: the nearby patch whose surroundings best match the
 * ring around the stroke. `img` covers `area`; the stroke occupies `r` (both in the same space).
 */
export function findSpotSource(
  img: Uint8ClampedArray,
  area: { x: number; y: number; w: number; h: number },
  r: { x: number; y: number; w: number; h: number },
  alpha: Float32Array,
  size: number,
): [number, number] | null {
  const D = Math.max(r.w, r.h) * 0.75 + size * 0.35 + 4;
  const candidates: [number, number][] = [];
  for (const k of [1, 1.6, 2.3]) {
    const n = k === 1 ? 12 : 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (k === 1 ? 0 : Math.PI / n);
      candidates.push([Math.round(Math.cos(a) * D * k), Math.round(Math.sin(a) * D * k)]);
    }
  }
  let best: [number, number] | null = null;
  let bestScore = Infinity;
  const step = Math.max(1, Math.floor(Math.sqrt((r.w * r.h) / 6000)));
  // Mean brightness of the ring around the stroke (what a good source interior should look like).
  let ringSum = 0;
  let ringN = 0;
  for (let y = 0; y < r.h; y += step) {
    for (let x = 0; x < r.w; x += step) {
      if (alpha[y * r.w + x] >= 0.02) continue;
      const di = ((r.y - area.y + y) * area.w + (r.x - area.x + x)) * 4;
      ringSum += img[di] + img[di + 1] + img[di + 2];
      ringN++;
    }
  }
  const ringMean = ringN ? ringSum / ringN : 0;
  for (const [ox, oy] of candidates) {
    const sx0 = r.x + ox;
    const sy0 = r.y + oy;
    if (sx0 < area.x || sy0 < area.y || sx0 + r.w > area.x + area.w || sy0 + r.h > area.y + area.h) continue;
    let ssd = 0;
    let cnt = 0;
    let inner = 0;
    let innerCnt = 0;
    for (let y = 0; y < r.h; y += step) {
      for (let x = 0; x < r.w; x += step) {
        const ai = y * r.w + x;
        const di = ((r.y - area.y + y) * area.w + (r.x - area.x + x)) * 4;
        const si = ((sy0 - area.y + y) * area.w + (sx0 - area.x + x)) * 4;
        const dr = img[di] - img[si];
        const dg = img[di + 1] - img[si + 1];
        const db = img[di + 2] - img[si + 2];
        const e = dr * dr + dg * dg + db * db;
        if (alpha[ai] < 0.02) {
          ssd += e;
          cnt++;
        } else {
          // penalise sources whose interior differs from the surroundings (other blemishes)
          inner += Math.abs(img[si] + img[si + 1] + img[si + 2] - ringMean);
          innerCnt++;
        }
      }
    }
    if (!cnt) continue;
    const score = ssd / cnt + (innerCnt ? (inner / innerCnt) * 0.5 : 0) + Math.hypot(ox, oy) * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = [ox, oy];
    }
  }
  return best;
}
