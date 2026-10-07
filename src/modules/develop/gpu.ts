import { cachedShader, GL, RenderTarget, Texture } from '@/core/gl/gl';
import type { Histogram } from '@/core/develop/engine';

/** Box-filtered downsample (up to 8×8 bilinear taps) — clean small previews of big renders. */
const DOWNSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
void main() {
  vec2 foot = uSrcSize / uDstSize;
  vec2 n = clamp(ceil(foot / 2.0), vec2(1.0), vec2(8.0));
  vec2 stepPx = foot / n;
  vec2 start = vUv * uSrcSize - foot * 0.5 + stepPx * 0.5;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 8; y++) {
    if (float(y) >= n.y) break;
    for (int x = 0; x < 8; x++) {
      if (float(x) >= n.x) break;
      acc += texture(uSrc, (start + vec2(float(x), float(y)) * stepPx) / uSrcSize);
    }
  }
  o = vec4((acc / (n.x * n.y)).rgb, 1.0);
}`;

/** Downsamples `src` to fit within `max`×`max` and reads it back as ImageData (rows top-first). */
export class PreviewReader {
  private rt: RenderTarget | null = null;
  constructor(readonly gl: GL) {}

  read(src: RenderTarget | Texture, max = 256): ImageData {
    const sw = src.width;
    const sh = src.height;
    const k = Math.min(1, max / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k));
    const h = Math.max(1, Math.round(sh * k));
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.dispose();
      this.rt = new RenderTarget(this.gl, w, h, 'rgba8', 'linear');
    }
    cachedShader(this.gl, 'develop-downsample', DOWNSAMPLE_FS).draw(this.rt, { uSrc: src, uSrcSize: [sw, sh], uDstSize: [w, h] });
    const px = this.rt.read() as Uint8Array;
    return new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), w, h);
  }

  dispose() {
    this.rt?.dispose();
    this.rt = null;
  }
}

/** 256-bin RGB + luminance histogram (same shape as DevelopEngine.histogram()). */
export function histogramOf(img: ImageData): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  const px = img.data;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < px.length; i += 4) {
    const R = px[i];
    const G = px[i + 1];
    const B = px[i + 2];
    r[R]++;
    g[G]++;
    b[B]++;
    l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    if (R >= 254 || G >= 254 || B >= 254) hi++;
    if (R <= 1 && G <= 1 && B <= 1) lo++;
  }
  let max = 1;
  for (let i = 1; i < 255; i++) max = Math.max(max, r[i], g[i], b[i]);
  const n = Math.max(1, px.length / 4);
  return { r, g, b, l, max, clipHigh: hi / n, clipLow: lo / n };
}
