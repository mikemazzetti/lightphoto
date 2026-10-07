import { cachedShader, copyTexture, RenderTarget, Texture } from '@/core/gl/gl';
import { GLSL_COLOR, GLSL_NOISE } from '@/core/gl/glsl';
import type { Compositor } from './compositor';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv; out vec4 o;
`;

type Src = Texture | RenderTarget;

/** Separable Gaussian (or box) blur pass; handles premultiplication across passes. */
const BLUR_FS =
  HEAD +
  `
uniform sampler2D uSrc;
uniform vec2 uDir;      // texel step
uniform float uSigma;
uniform int uRadius;
uniform int uBox;
uniform int uPremulIn;
uniform int uUnpremulOut;
vec4 tap(vec2 uv) { vec4 c = texture(uSrc, uv); if (uPremulIn == 1) c.rgb *= c.a; return c; }
void main() {
  vec4 acc = vec4(0.0); float wsum = 0.0;
  float k = 1.0 / (2.0 * uSigma * uSigma);
  for (int i = -96; i <= 96; i++) {
    if (i < -uRadius || i > uRadius) continue;
    float w = uBox == 1 ? 1.0 : exp(-float(i * i) * k);
    acc += tap(vUv + uDir * float(i)) * w;
    wsum += w;
  }
  acc /= wsum;
  if (uUnpremulOut == 1) acc.rgb = acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0);
  o = acc;
}`;

const DOWN_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform int uPremulIn;
vec4 tap(vec2 uv) { vec4 c = texture(uSrc, uv); if (uPremulIn == 1) c.rgb *= c.a; return c; }
void main() {
  o = 0.25 * (tap(vUv + vec2(-uTexel.x, -uTexel.y)) + tap(vUv + vec2(uTexel.x, -uTexel.y)) + tap(vUv + vec2(-uTexel.x, uTexel.y)) + tap(vUv + uTexel));
}`;

const UNPREMUL_FS =
  HEAD +
  `
uniform sampler2D uSrc;
void main() { vec4 c = texture(uSrc, vUv); o = vec4(c.a > 1e-5 ? c.rgb / c.a : vec3(0.0), c.a); }`;

const MOTION_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform vec2 uStep; uniform int uN;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 256; i++) {
    if (i >= uN) break;
    float t = float(i) / max(1.0, float(uN - 1)) - 0.5;
    vec4 c = texture(uSrc, vUv + uStep * t);
    acc += vec4(c.rgb * c.a, c.a);
  }
  acc /= float(uN);
  o = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
}`;

const UNSHARP_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform sampler2D uBlur; uniform float uAmount; uniform float uThreshold; uniform int uHighPass;
void main() {
  vec4 c = texture(uSrc, vUv); vec4 b = texture(uBlur, vUv);
  vec3 d = c.rgb - b.rgb;
  if (uHighPass == 1) { o = vec4(clamp(0.5 + d, 0.0, 1.0), c.a); return; }
  float m = max(max(abs(d.r), abs(d.g)), abs(d.b));
  float k = smoothstep(uThreshold, uThreshold + 2.0 / 255.0, m);
  o = vec4(clamp(c.rgb + d * uAmount * k, 0.0, 1.0), c.a);
}`;

const NOISE_FS =
  HEAD +
  GLSL_NOISE +
  `
uniform sampler2D uSrc; uniform vec2 uSize; uniform float uAmount; uniform int uGauss; uniform int uMono; uniform float uSeed;
float rnd(vec2 p, float s) { return hash12(p * 1.37 + vec2(s * 17.1, s * 3.7)); }
float sampleNoise(vec2 p, float s) {
  if (uGauss == 1) { float u1 = max(rnd(p, s), 1e-6); float u2 = rnd(p, s + 11.0); return sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2) * 0.5; }
  return rnd(p, s) - 0.5;
}
void main() {
  vec4 c = texture(uSrc, vUv);
  vec2 p = floor(vUv * uSize);
  vec3 n = uMono == 1 ? vec3(sampleNoise(p, uSeed)) : vec3(sampleNoise(p, uSeed), sampleNoise(p, uSeed + 1.7), sampleNoise(p, uSeed + 3.1));
  o = vec4(clamp(c.rgb + n * uAmount, 0.0, 1.0), c.a);
}`;

const BILATERAL_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform int uRadius; uniform float uSigmaS; uniform float uSigmaR;
void main() {
  vec4 c0 = texture(uSrc, vUv);
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int y = -8; y <= 8; y++) {
    if (y < -uRadius || y > uRadius) continue;
    for (int x = -8; x <= 8; x++) {
      if (x < -uRadius || x > uRadius) continue;
      vec4 c = texture(uSrc, vUv + vec2(x, y) * uTexel);
      vec3 d = c.rgb - c0.rgb;
      float w = exp(-float(x * x + y * y) / (2.0 * uSigmaS * uSigmaS) - dot(d, d) / (2.0 * uSigmaR * uSigmaR));
      acc += c.rgb * w; wsum += w;
    }
  }
  o = vec4(acc / wsum, c0.a);
}`;

const MEDIAN_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform int uRadius;
float v[49];
float med(int n) {
  // partial selection sort up to the middle element
  int mid = n / 2;
  for (int i = 0; i <= 24; i++) {
    if (i > mid) break;
    int mi = i;
    for (int j = i + 1; j < 49; j++) { if (j >= n) break; if (v[j] < v[mi]) mi = j; }
    float t = v[i]; v[i] = v[mi]; v[mi] = t;
  }
  return v[mid];
}
void main() {
  vec4 c0 = texture(uSrc, vUv);
  vec3 outc;
  for (int ch = 0; ch < 3; ch++) {
    int n = 0;
    for (int y = -3; y <= 3; y++) {
      if (y < -uRadius || y > uRadius) continue;
      for (int x = -3; x <= 3; x++) {
        if (x < -uRadius || x > uRadius) continue;
        vec4 c = texture(uSrc, vUv + vec2(x, y) * uTexel);
        v[n] = ch == 0 ? c.r : ch == 1 ? c.g : c.b;
        n++;
      }
    }
    float m = med(n);
    if (ch == 0) outc.r = m; else if (ch == 1) outc.g = m; else outc.b = m;
  }
  o = vec4(outc, c0.a);
}`;

const MOSAIC_DOWN_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform vec2 uSrcSize; uniform float uCell;
void main() {
  vec2 cell0 = floor(gl_FragCoord.xy) * uCell;
  float stepPx = max(1.0, uCell / 12.0);
  vec4 acc = vec4(0.0); float n = 0.0;
  for (int y = 0; y < 12; y++) {
    for (int x = 0; x < 12; x++) {
      vec2 p = cell0 + (vec2(x, y) + 0.5) * stepPx;
      if (p.x >= cell0.x + uCell || p.y >= cell0.y + uCell || p.x >= uSrcSize.x || p.y >= uSrcSize.y) continue;
      vec4 c = texture(uSrc, p / uSrcSize);
      acc += vec4(c.rgb * c.a, c.a); n += 1.0;
    }
  }
  acc /= max(n, 1.0);
  o = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
}`;

const MOSAIC_UP_FS =
  HEAD +
  `
uniform sampler2D uSmall; uniform vec2 uSize; uniform float uCell;
void main() { ivec2 p = ivec2(floor(floor(vUv * uSize) / uCell)); o = texelFetch(uSmall, p, 0); }`;

const EMBOSS_FS =
  HEAD +
  GLSL_COLOR +
  `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform vec2 uDirection; uniform float uHeight; uniform float uAmount;
void main() {
  vec4 c = texture(uSrc, vUv);
  vec2 d = uDirection * uTexel * uHeight;
  vec3 a = texture(uSrc, vUv + d).rgb, b = texture(uSrc, vUv - d).rgb;
  float e = luma(b - a) * uAmount;
  o = vec4(vec3(clamp(0.5 + e, 0.0, 1.0)), c.a);
}`;

const EDGES_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform vec2 uTexel;
vec3 t(float x, float y) { return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb; }
void main() {
  vec3 gx = -t(-1.,-1.) - 2.0*t(-1.,0.) - t(-1.,1.) + t(1.,-1.) + 2.0*t(1.,0.) + t(1.,1.);
  vec3 gy = -t(-1.,-1.) - 2.0*t(0.,-1.) - t(1.,-1.) + t(-1.,1.) + 2.0*t(0.,1.) + t(1.,1.);
  vec3 g = sqrt(gx * gx + gy * gy);
  o = vec4(clamp(1.0 - g, 0.0, 1.0), texture(uSrc, vUv).a);
}`;

const KUWAHARA_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform int uRadius;
void main() {
  vec4 c0 = texture(uSrc, vUv);
  vec3 m[4]; vec3 s[4]; float n[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); n[k] = 0.0; }
  for (int y = -10; y <= 10; y++) {
    if (y < -uRadius || y > uRadius) continue;
    for (int x = -10; x <= 10; x++) {
      if (x < -uRadius || x > uRadius) continue;
      vec3 c = texture(uSrc, vUv + vec2(x, y) * uTexel).rgb;
      if (x <= 0 && y <= 0) { m[0] += c; s[0] += c * c; n[0] += 1.0; }
      if (x >= 0 && y <= 0) { m[1] += c; s[1] += c * c; n[1] += 1.0; }
      if (x <= 0 && y >= 0) { m[2] += c; s[2] += c * c; n[2] += 1.0; }
      if (x >= 0 && y >= 0) { m[3] += c; s[3] += c * c; n[3] += 1.0; }
    }
  }
  float best = 1e9; vec3 res = c0.rgb;
  for (int k = 0; k < 4; k++) {
    vec3 mean = m[k] / n[k];
    vec3 var = abs(s[k] / n[k] - mean * mean);
    float v = var.r + var.g + var.b;
    if (v < best) { best = v; res = mean; }
  }
  o = vec4(res, c0.a);
}`;

const VIGNETTE_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform float uAmount; uniform float uSize; uniform float uFeather; uniform float uRound; uniform vec2 uAspect;
void main() {
  vec4 c = texture(uSrc, vUv);
  vec2 p = (vUv - 0.5) * 2.0;
  p = mix(p, p * uAspect, uRound);
  float d = length(p);
  float v = smoothstep(uSize, uSize + max(uFeather, 0.01), d);
  vec3 r = uAmount < 0.0 ? c.rgb * (1.0 + uAmount * v) : mix(c.rgb, vec3(1.0), uAmount * v);
  o = vec4(r, c.a);
}`;

const CLOUDS_FS =
  HEAD +
  GLSL_NOISE +
  `
uniform vec2 uSize; uniform vec3 uFg; uniform vec3 uBg; uniform float uScale; uniform float uSeed;
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 7; i++) { s += a * valueNoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }
void main() {
  vec2 p = vUv * uSize / uScale + uSeed * 13.7;
  float n = clamp(fbm(p) * 1.1 - 0.05, 0.0, 1.0);
  o = vec4(mix(uBg, uFg, n), 1.0);
}`;

const ALPHA_FROM_FS =
  HEAD +
  `
uniform sampler2D uSrc; uniform sampler2D uAlpha;
void main() { o = vec4(texture(uSrc, vUv).rgb, texture(uAlpha, vUv).a); }`;

// ---------------------------------------------------------------------------------------------

function sh(c: Compositor, key: string, fs: string) {
  return cachedShader(c.gl, `ed-f-${key}`, fs);
}

/** Gaussian blur (sigma in px) of a straight-alpha texture; result straight alpha. */
export function gaussianBlur(c: Compositor, src: Src, w: number, h: number, sigma: number, box = false): RenderTarget {
  const blur = sh(c, 'blur', BLUR_FS);
  const out = c.pool.acquire(w, h);
  if (sigma < 0.3) {
    // Nothing to blur: a straight copy (the input is straight alpha already).
    copyTexture(c.gl, src, out);
    return out;
  }
  // Large radii: blur a downsampled copy.
  let level = 0;
  while (sigma / 2 ** level > 24 && level < 6) level++;
  if (level === 0) {
    const tmp = c.pool.acquire(w, h);
    const r = Math.min(96, Math.ceil(box ? sigma : sigma * 3));
    blur.draw(tmp, { uSrc: src, uDir: [1 / w, 0], uSigma: sigma, uRadius: r, uBox: box ? 1 : 0, uPremulIn: 1, uUnpremulOut: 0 });
    blur.draw(out, { uSrc: tmp, uDir: [0, 1 / h], uSigma: sigma, uRadius: r, uBox: box ? 1 : 0, uPremulIn: 0, uUnpremulOut: 1 });
    c.pool.release(tmp);
    return out;
  }
  const down = sh(c, 'down', DOWN_FS);
  let cur: Src = src;
  let cw = w;
  let ch = h;
  const chain: RenderTarget[] = [];
  for (let i = 0; i < level; i++) {
    const nw = Math.max(1, Math.ceil(cw / 2));
    const nh = Math.max(1, Math.ceil(ch / 2));
    const t = c.pool.acquire(nw, nh);
    down.draw(t, { uSrc: cur, uTexel: [0.5 / cw, 0.5 / ch], uPremulIn: i === 0 ? 1 : 0 });
    chain.push(t);
    cur = t;
    cw = nw;
    ch = nh;
  }
  const s2 = sigma / 2 ** level;
  const r = Math.min(96, Math.ceil(box ? s2 : s2 * 3));
  const t1 = c.pool.acquire(cw, ch);
  const t2 = c.pool.acquire(cw, ch);
  blur.draw(t1, { uSrc: cur, uDir: [1 / cw, 0], uSigma: s2, uRadius: r, uBox: box ? 1 : 0, uPremulIn: 0, uUnpremulOut: 0 });
  blur.draw(t2, { uSrc: t1, uDir: [0, 1 / ch], uSigma: s2, uRadius: r, uBox: box ? 1 : 0, uPremulIn: 0, uUnpremulOut: 0 });
  // Upsample (bilinear) + unpremultiply.
  sh(c, 'unpremul', UNPREMUL_FS).draw(out, { uSrc: t2 });
  chain.forEach((t) => c.pool.release(t));
  c.pool.release(t1);
  c.pool.release(t2);
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface FilterParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  default: number;
  suffix?: string;
  kind?: 'slider' | 'select' | 'check';
  options?: { value: number; label: string }[];
  curve?: 'pow2';
}

export interface FilterDef {
  id: string;
  label: string;
  group: 'Blur' | 'Sharpen' | 'Noise' | 'Pixelate' | 'Stylize' | 'Render' | 'Other';
  params: FilterParam[];
  /** Runs the filter. `ctx` carries the document colours and a random seed. */
  run: (c: Compositor, src: Texture, w: number, h: number, p: Record<string, number>, ctx: FilterContext) => RenderTarget;
  /** Applies immediately without a dialog. */
  instant?: boolean;
  keepAlpha?: boolean;
}

export interface FilterContext {
  fg: [number, number, number];
  bg: [number, number, number];
  seed: number;
}

const P = (key: string, label: string, min: number, max: number, def: number, extra: Partial<FilterParam> = {}): FilterParam => ({ key, label, min, max, default: def, ...extra });

export const FILTERS: FilterDef[] = [
  {
    id: 'gaussian',
    label: 'Gaussian Blur…',
    group: 'Blur',
    params: [P('radius', 'Radius', 0.1, 250, 4, { step: 0.1, suffix: ' px', curve: 'pow2' })],
    run: (c, src, w, h, p) => gaussianBlur(c, src, w, h, p.radius),
  },
  {
    id: 'box',
    label: 'Box Blur…',
    group: 'Blur',
    params: [P('radius', 'Radius', 1, 200, 5, { suffix: ' px', curve: 'pow2' })],
    run: (c, src, w, h, p) => gaussianBlur(c, src, w, h, p.radius, true),
  },
  {
    id: 'motion',
    label: 'Motion Blur…',
    group: 'Blur',
    params: [P('angle', 'Angle', -180, 180, 0, { suffix: '°' }), P('distance', 'Distance', 1, 500, 20, { suffix: ' px', curve: 'pow2' })],
    run: (c, src, w, h, p) => {
      const out = c.pool.acquire(w, h);
      const a = (-p.angle * Math.PI) / 180;
      const n = Math.max(2, Math.min(256, Math.ceil(p.distance)));
      sh(c, 'motion', MOTION_FS).draw(out, { uSrc: src, uStep: [(Math.cos(a) * p.distance) / w, (Math.sin(a) * p.distance) / h], uN: n });
      return out;
    },
  },
  {
    id: 'unsharp',
    label: 'Unsharp Mask…',
    group: 'Sharpen',
    params: [P('amount', 'Amount', 1, 500, 120, { suffix: '%' }), P('radius', 'Radius', 0.1, 64, 1.2, { step: 0.1, suffix: ' px', curve: 'pow2' }), P('threshold', 'Threshold', 0, 255, 2, { suffix: ' levels' })],
    keepAlpha: true,
    run: (c, src, w, h, p) => unsharp(c, src, w, h, p.radius, p.amount / 100, p.threshold / 255),
  },
  {
    id: 'sharpen',
    label: 'Sharpen',
    group: 'Sharpen',
    params: [],
    instant: true,
    keepAlpha: true,
    run: (c, src, w, h) => unsharp(c, src, w, h, 0.8, 0.6, 0),
  },
  {
    id: 'sharpenMore',
    label: 'Sharpen More',
    group: 'Sharpen',
    params: [],
    instant: true,
    keepAlpha: true,
    run: (c, src, w, h) => unsharp(c, src, w, h, 1.0, 1.4, 0),
  },
  {
    id: 'addNoise',
    label: 'Add Noise…',
    group: 'Noise',
    params: [
      P('amount', 'Amount', 0, 100, 12, { step: 0.5, suffix: '%' }),
      P('gauss', 'Distribution', 0, 1, 1, { kind: 'select', options: [{ value: 0, label: 'Uniform' }, { value: 1, label: 'Gaussian' }] }),
      P('mono', 'Monochromatic', 0, 1, 0, { kind: 'check' }),
    ],
    keepAlpha: true,
    run: (c, src, w, h, p, ctx) => {
      const out = c.pool.acquire(w, h);
      sh(c, 'noise', NOISE_FS).draw(out, { uSrc: src, uSize: [w, h], uAmount: (p.amount / 100) * 1.2, uGauss: p.gauss, uMono: p.mono, uSeed: ctx.seed });
      return out;
    },
  },
  {
    id: 'reduceNoise',
    label: 'Reduce Noise…',
    group: 'Noise',
    params: [P('strength', 'Strength', 0, 10, 6, { step: 0.1 }), P('details', 'Preserve Details', 0, 100, 40, { suffix: '%' })],
    keepAlpha: true,
    run: (c, src, w, h, p) => {
      const out = c.pool.acquire(w, h);
      const r = Math.max(1, Math.min(8, Math.round(1 + p.strength * 0.6)));
      sh(c, 'bilateral', BILATERAL_FS).draw(out, {
        uSrc: src,
        uTexel: [1 / w, 1 / h],
        uRadius: r,
        uSigmaS: r * 0.7,
        uSigmaR: Math.max(0.005, (p.strength / 10) * 0.16 * (1 - p.details / 140)),
      });
      return out;
    },
  },
  {
    id: 'median',
    label: 'Median…',
    group: 'Noise',
    params: [P('radius', 'Radius', 1, 2, 1, { suffix: ' px' })],
    keepAlpha: true,
    run: (c, src, w, h, p) => {
      const out = c.pool.acquire(w, h);
      sh(c, 'median', MEDIAN_FS).draw(out, { uSrc: src, uTexel: [1 / w, 1 / h], uRadius: Math.round(p.radius) });
      return out;
    },
  },
  {
    id: 'mosaic',
    label: 'Mosaic…',
    group: 'Pixelate',
    params: [P('cell', 'Cell Size', 2, 200, 12, { suffix: ' px', curve: 'pow2' })],
    run: (c, src, w, h, p) => {
      const cell = Math.max(2, Math.round(p.cell));
      const sw = Math.ceil(w / cell);
      const shh = Math.ceil(h / cell);
      const small = new RenderTarget(c.gl, sw, shh, 'rgba8', 'nearest');
      sh(c, 'mosaicDown', MOSAIC_DOWN_FS).draw(small, { uSrc: src, uSrcSize: [w, h], uCell: cell });
      const out = c.pool.acquire(w, h);
      sh(c, 'mosaicUp', MOSAIC_UP_FS).draw(out, { uSmall: small, uSize: [w, h], uCell: cell });
      small.dispose();
      return out;
    },
  },
  {
    id: 'emboss',
    label: 'Emboss…',
    group: 'Stylize',
    params: [P('angle', 'Angle', -180, 180, 135, { suffix: '°' }), P('height', 'Height', 1, 10, 3, { suffix: ' px' }), P('amount', 'Amount', 1, 500, 100, { suffix: '%' })],
    run: (c, src, w, h, p) => {
      const out = c.pool.acquire(w, h);
      const a = (p.angle * Math.PI) / 180;
      sh(c, 'emboss', EMBOSS_FS).draw(out, { uSrc: src, uTexel: [1 / w, 1 / h], uDirection: [Math.cos(a), -Math.sin(a)], uHeight: p.height, uAmount: (p.amount / 100) * 3 });
      return out;
    },
  },
  {
    id: 'findEdges',
    label: 'Find Edges',
    group: 'Stylize',
    params: [],
    instant: true,
    run: (c, src, w, h) => {
      const out = c.pool.acquire(w, h);
      sh(c, 'edges', EDGES_FS).draw(out, { uSrc: src, uTexel: [1 / w, 1 / h] });
      return out;
    },
  },
  {
    id: 'oilPaint',
    label: 'Oil Paint…',
    group: 'Stylize',
    params: [P('radius', 'Stylization', 1, 6, 3, { suffix: ' px' })],
    keepAlpha: true,
    run: (c, src, w, h, p) => {
      const out = c.pool.acquire(w, h);
      sh(c, 'kuwahara', KUWAHARA_FS).draw(out, { uSrc: src, uTexel: [1 / w, 1 / h], uRadius: Math.round(p.radius) });
      return out;
    },
  },
  {
    id: 'vignette',
    label: 'Vignette…',
    group: 'Render',
    params: [P('amount', 'Amount', -100, 100, -50, { suffix: '%' }), P('size', 'Midpoint', 0, 100, 55, { suffix: '%' }), P('feather', 'Feather', 0, 100, 60, { suffix: '%' }), P('round', 'Roundness', 0, 100, 100, { suffix: '%' })],
    keepAlpha: true,
    run: (c, src, w, h, p) => {
      const out = c.pool.acquire(w, h);
      const ar = w / h;
      sh(c, 'vignette', VIGNETTE_FS).draw(out, {
        uSrc: src,
        uAmount: p.amount / 100,
        uSize: (p.size / 100) * 1.2,
        uFeather: (p.feather / 100) * 1.2,
        uRound: p.round / 100,
        uAspect: ar >= 1 ? [ar, 1] : [1, 1 / ar],
      });
      return out;
    },
  },
  {
    id: 'clouds',
    label: 'Clouds',
    group: 'Render',
    params: [P('scale', 'Scale', 16, 2000, 256, { suffix: ' px', curve: 'pow2' })],
    run: (c, _src, w, h, p, ctx) => {
      const out = c.pool.acquire(w, h);
      sh(c, 'clouds', CLOUDS_FS).draw(out, { uSize: [w, h], uFg: ctx.fg, uBg: ctx.bg, uScale: p.scale, uSeed: ctx.seed });
      return out;
    },
  },
  {
    id: 'highPass',
    label: 'High Pass…',
    group: 'Other',
    params: [P('radius', 'Radius', 0.1, 250, 10, { step: 0.1, suffix: ' px', curve: 'pow2' })],
    keepAlpha: true,
    run: (c, src, w, h, p) => {
      const b = gaussianBlur(c, src, w, h, p.radius);
      const out = c.pool.acquire(w, h);
      sh(c, 'unsharp', UNSHARP_FS).draw(out, { uSrc: src, uBlur: b, uAmount: 1, uThreshold: 0, uHighPass: 1 });
      c.pool.release(b);
      return out;
    },
  },
];

export const FILTER_GROUPS = ['Blur', 'Sharpen', 'Noise', 'Pixelate', 'Stylize', 'Render', 'Other'] as const;

function unsharp(c: Compositor, src: Src, w: number, h: number, radius: number, amount: number, threshold: number): RenderTarget {
  const b = gaussianBlur(c, src, w, h, radius);
  const out = c.pool.acquire(w, h);
  sh(c, 'unsharp', UNSHARP_FS).draw(out, { uSrc: src, uBlur: b, uAmount: amount, uThreshold: threshold, uHighPass: 0 });
  c.pool.release(b);
  return out;
}

/** Copies `rgbSrc` into a pool target taking alpha from `alphaSrc`. */
export function withAlphaFrom(c: Compositor, rgbSrc: Src, alphaSrc: Src, w: number, h: number): RenderTarget {
  const out = c.pool.acquire(w, h);
  sh(c, 'alphaFrom', ALPHA_FROM_FS).draw(out, { uSrc: rgbSrc, uAlpha: alphaSrc });
  return out;
}

export const defaultFilterParams = (f: FilterDef) => Object.fromEntries(f.params.map((p) => [p.key, p.default]));
