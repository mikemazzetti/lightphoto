import { GLSL_COLOR, GLSL_NOISE } from '../gl/glsl';

/** Converts 16-bit (gamma-encoded sRGB) integer RGB into linear RGBA16F. */
export const DECODE16_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 vUv; out vec4 o;
uniform usampler2D uSrc;
uniform float uLinearInput;
// Optional camera tone curve for scene-linear RAW data: display value indexed by sqrt(linear).
uniform sampler2D uTone;
uniform float uToneOn;
${GLSL_COLOR}
float tone(float x) {
  const float N = 1024.0;
  return texture(uTone, vec2(sqrt(clamp(x, 0.0, 1.0)) * (N - 1.0) / N + 0.5 / N, 0.5)).r;
}
void main() {
  ivec2 sz = textureSize(uSrc, 0);
  uvec4 v = texelFetch(uSrc, ivec2(vUv * vec2(sz)), 0);
  vec3 c = vec3(v.rgb) / 65535.0;
  if (uLinearInput < 0.5) c = srgbToLinear(c);
  else if (uToneOn > 0.5) c = srgbToLinear(vec3(tone(c.r), tone(c.g), tone(c.b)));
  o = vec4(c, 1.0);
}`;

/**
 * Geometry pass: samples the (mipmapped, linear) source through the crop/rotate/flip matrix,
 * applies lens corrections, writes linear RGB + log2 luminance in alpha.
 */
export const LENS_LUT_N = 256;

export const BASE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform mat3 uGeom;
uniform vec2 uSrcSize;
uniform float uDistortion;
uniform float uLensVig;
uniform float uSrcIsSrgbData; // 1 when the source texture holds sRGB-encoded data in a non-sRGB format
// Built-in lens profile LUT over r = 0..1 (half-diagonal): (green factor - 1, red/green - 1, blue/green - 1, gain - 1).
uniform sampler2D uLensLut;
uniform float uLensOn;
${GLSL_COLOR}

// Minification-aware sampling with explicit gradients. When shrinking by more than 1.5×, four taps
// at the footprint's quadrant centres, each one mip level finer, form a box filter of the right
// size — noticeably sharper than plain trilinear. Near or above 1:1 it is bicubic (exact at 1:1).
// No implicit derivatives, so it's valid in any control flow.
// Catmull-Rom bicubic in 9 bilinear taps (exact at texel centres, sharper than bilinear between
// them — matters because lens correction / straighten shift most pixels by fractional amounts).
vec3 sampleBicubic(vec2 uv, vec2 ts) {
  vec2 p = uv * ts;
  vec2 t1 = floor(p - 0.5) + 0.5;
  vec2 f = p - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 a = (t1 - 1.0) / ts, b = (t1 + w2 / w12) / ts, c = (t1 + 2.0) / ts;
  vec3 r = (textureLod(uSrc, vec2(a.x, a.y), 0.0).rgb * w0.x + textureLod(uSrc, vec2(b.x, a.y), 0.0).rgb * w12.x + textureLod(uSrc, vec2(c.x, a.y), 0.0).rgb * w3.x) * w0.y
         + (textureLod(uSrc, vec2(a.x, b.y), 0.0).rgb * w0.x + textureLod(uSrc, vec2(b.x, b.y), 0.0).rgb * w12.x + textureLod(uSrc, vec2(c.x, b.y), 0.0).rgb * w3.x) * w12.y
         + (textureLod(uSrc, vec2(a.x, c.y), 0.0).rgb * w0.x + textureLod(uSrc, vec2(b.x, c.y), 0.0).rgb * w12.x + textureLod(uSrc, vec2(c.x, c.y), 0.0).rgb * w3.x) * w3.y;
  return max(r, 0.0);
}

vec3 sampleSrc(vec2 uv, vec2 dx, vec2 dy) {
  vec2 ts = vec2(textureSize(uSrc, 0));
  float fp = max(length(dx * ts), length(dy * ts));
  if (fp < 1.5) return sampleBicubic(uv, ts);
  vec2 hx = dx * 0.5, hy = dy * 0.5;
  vec2 a = 0.25 * (dx + dy), b = 0.25 * (dx - dy);
  return 0.25 * (textureGrad(uSrc, uv + a, hx, hy).rgb + textureGrad(uSrc, uv - a, hx, hy).rgb +
                 textureGrad(uSrc, uv + b, hx, hy).rgb + textureGrad(uSrc, uv - b, hx, hy).rgb);
}

void main() {
  vec2 suv = (uGeom * vec3(vUv, 1.0)).xy;
  float mx = max(uSrcSize.x, uSrcSize.y);
  vec2 asp = uSrcSize / mx;
  vec2 d = (suv - 0.5) * 2.0 * asp;
  float r2 = dot(d, d);
  float rc2 = dot(asp, asp);
  if (uDistortion != 0.0) {
    float k = uDistortion;
    float f = (1.0 + k * r2) / (k > 0.0 ? (1.0 + k * rc2) : 1.0);
    suv = 0.5 + (suv - 0.5) * f;
  }
  vec2 dx = dFdx(suv), dy = dFdy(suv);
  vec3 c;
  float gain = 1.0;
  if (uLensOn > 0.5) {
    // Radial model: the output pixel at radius r samples the source at r * factor(r), per channel.
    float r = length((suv - 0.5) * uSrcSize) / (0.5 * length(uSrcSize));
    float n = ${LENS_LUT_N}.0;
    vec4 l = texture(uLensLut, vec2(clamp(r, 0.0, 1.0) * (n - 1.0) / n + 0.5 / n, 0.5));
    float fg = 1.0 + l.r;
    vec2 v = suv - 0.5;
    c = vec3(sampleSrc(0.5 + v * fg * (1.0 + l.g), dx * fg, dy * fg).r,
             sampleSrc(0.5 + v * fg, dx * fg, dy * fg).g,
             sampleSrc(0.5 + v * fg * (1.0 + l.b), dx * fg, dy * fg).b);
    gain = 1.0 + l.a;
    suv = 0.5 + v * fg;
  } else {
    c = sampleSrc(suv, dx, dy);
  }
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) c = vec3(0.0);
  if (uSrcIsSrgbData > 0.5) c = srgbToLinear(c);
  c *= gain;
  if (uLensVig != 0.0) c *= 1.0 + uLensVig * (r2 / rc2);
  c = max(c, 0.0);
  o = vec4(c, log2(max(luma(c), 1.0e-5)));
}`;

/** 2x box downsample (single bilinear tap at the texel corner). */
export const DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
void main() {
  vec2 h = uSrcTexel * 0.5;
  o = 0.25 * (texture(uSrc, vUv + vec2(-h.x, -h.y)) + texture(uSrc, vUv + vec2(h.x, -h.y)) +
              texture(uSrc, vUv + vec2(-h.x, h.y)) + texture(uSrc, vUv + vec2(h.x, h.y)));
}`;

/** Separable Gaussian. uDir = texel step along one axis; sigma in texels. */
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  float sigma = max(uSigma, 0.3);
  int r = int(min(ceil(sigma * 3.0), 24.0));
  float inv = 1.0 / (2.0 * sigma * sigma);
  vec4 acc = texture(uSrc, vUv);
  float wsum = 1.0;
  // Pairs of taps merged into one bilinear fetch.
  for (int i = 1; i <= 24; i += 2) {
    if (i > r) break;
    float w1 = exp(-float(i * i) * inv);
    float w2 = exp(-float((i + 1) * (i + 1)) * inv);
    float w = w1 + w2;
    float off = float(i) + w2 / w;
    acc += w * (texture(uSrc, vUv + uDir * off) + texture(uSrc, vUv - uDir * off));
    wsum += 2.0 * w;
  }
  o = acc / wsum;
}`;

/** Luminance (bilateral on log-lum) + colour (chroma from blurred) noise reduction. */
export const NR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uBase;
uniform sampler2D uBlur;
uniform vec2 uTexel;
uniform float uLumNR;
uniform float uColNR;
uniform float uScale;
${GLSL_COLOR}
void main() {
  vec4 c = texture(uBase, vUv);
  vec3 rgb = c.rgb;
  float lL = c.a;
  if (uLumNR > 0.0) {
    float sigmaR = mix(0.04, 0.5, uLumNR);
    float stepPx = max(0.75, (1.0 + uLumNR * 1.5) * uScale);
    float acc = 0.0, wsum = 0.0;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        float s = texture(uBase, vUv + vec2(float(x), float(y)) * uTexel * stepPx).a;
        float dr = (s - lL) / sigmaR;
        float w = exp(-0.5 * dr * dr - float(x * x + y * y) / 4.5);
        acc += s * w;
        wsum += w;
      }
    }
    float nl = mix(lL, acc / wsum, min(1.0, uLumNR * 1.25));
    rgb *= exp2(nl - lL);
    lL = nl;
  }
  if (uColNR > 0.0) {
    vec4 m = texture(uBlur, vUv);
    float L = exp2(lL), Lm = exp2(m.a);
    vec3 ch = rgb / max(L, 1.0e-5);
    vec3 chm = m.rgb / max(Lm, 1.0e-5);
    rgb = max(mix(ch, chm, uColNR), 0.0) * L;
  }
  o = vec4(rgb, lL);
}`;

export const MAX_LOCALS = 8;

/** The main develop pass: tone, presence, colour, grading, sharpening, effects, local masks. */
export const MAIN_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv; out vec4 o;

uniform sampler2D uImg;
uniform sampler2D uBlurS;
uniform sampler2D uBlurT;
uniform sampler2D uBlurC;
uniform sampler2D uBlurH;
uniform sampler2D uCurve;
uniform float uCurveOn;
uniform sampler2DArray uMasks;

uniform mat3 uGeom;
uniform float uSrcAspect;
uniform vec2 uOutSize;
uniform float uScale;
uniform float uNeutral;
uniform float uTempScale;
uniform float uTintScale;

uniform float uTemp, uTint, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTexture, uClarity, uDehaze, uVibrance, uSaturation;
uniform vec3 uProfile; // contrast, saturation, vibrance offsets
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform float uBW;
uniform float uBwMix[8];
uniform vec3 uGS;
uniform vec3 uGM;
uniform vec3 uGH;
uniform vec3 uGG;
uniform float uGBlend, uGBalance;
uniform vec4 uSharp;
uniform vec4 uVig;
uniform float uVigHL;
uniform vec3 uGrain;
uniform float uSeed;

uniform int uLocalN;
uniform int uLType[${MAX_LOCALS}];
uniform vec4 uLGeom[${MAX_LOCALS}];
uniform vec4 uLGeom2[${MAX_LOCALS}];
uniform vec4 uLA[${MAX_LOCALS}];
uniform vec4 uLB[${MAX_LOCALS}];
uniform vec4 uLC[${MAX_LOCALS}];
uniform float uLAmt[${MAX_LOCALS}];
// Mask overlay (Develop UI): index into the enabled locals whose mask is tinted, -1 = off.
uniform int uOverlay;
uniform vec4 uOverlayColor;

${GLSL_COLOR}
${GLSL_NOISE}

const float BAND[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

float localMask(int i, vec2 suv) {
  int t = uLType[i];
  vec4 g = uLGeom[i];
  vec4 g2 = uLGeom2[i];
  vec2 asp = vec2(uSrcAspect, 1.0);
  float m;
  if (t == 0) {
    vec2 a = g.xy * asp, b = g.zw * asp, p = suv * asp;
    vec2 ab = b - a;
    float tt = dot(p - a, ab) / max(dot(ab, ab), 1.0e-8);
    m = 1.0 - smoothstep(0.0, 1.0, tt);
  } else if (t == 1) {
    vec2 d = (suv - g.xy) * asp;
    float ca = cos(g2.x), sa = sin(g2.x);
    d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y);
    vec2 r = max(g.zw * asp, vec2(1.0e-5));
    float dd = length(d / r);
    float inner = min(1.0 - g2.y, 0.999);
    m = 1.0 - smoothstep(inner, 1.0, dd);
  } else {
    m = texture(uMasks, vec3(suv, g2.z)).r;
  }
  return g2.w > 0.5 ? 1.0 - m : m;
}

vec3 gamutClip(vec3 c) {
  float Y = luma(c);
  float mx = max(max(c.r, c.g), c.b);
  if (mx > 1.0) {
    if (Y >= 1.0) return vec3(1.0);
    c = Y + (c - Y) * ((1.0 - Y) / (mx - Y));
  }
  return max(c, 0.0);
}

void main() {
  vec4 img = texture(uImg, vUv);
  vec3 c = max(img.rgb, 0.0);
  float dither = (hash12(gl_FragCoord.xy + fract(uSeed * 7.13)) - 0.5) / 255.0;
  if (uNeutral > 0.5) {
    o = vec4(clamp(linearToSrgb(c) + dither, 0.0, 1.0), 1.0);
    return;
  }
  vec2 suv = (uGeom * vec3(vUv, 1.0)).xy;

  // ---- Effective (global + local) parameters
  float temp = uTemp, tint = uTint, expo = uExposure, con = uContrast, hi = uHighlights, sh = uShadows;
  float wh = uWhites, bl = uBlacks, sat = uSaturation, cla = uClarity, deh = uDehaze, tex = uTexture;
  for (int i = 0; i < ${MAX_LOCALS}; i++) {
    if (i >= uLocalN) break;
    float m = localMask(i, suv) * uLAmt[i];
    if (m <= 0.0005) continue;
    expo += m * uLA[i].x; con += m * uLA[i].y; hi += m * uLA[i].z; sh += m * uLA[i].w;
    wh += m * uLB[i].x; bl += m * uLB[i].y; temp += m * uLB[i].z; tint += m * uLB[i].w;
    sat += m * uLC[i].x; cla += m * uLC[i].y; deh += m * uLC[i].z; tex += m * uLC[i].w;
  }

  // ---- White balance + exposure (linear light)
  float kT = temp / 100.0 * uTempScale;
  float kN = tint / 100.0 * uTintScale;
  vec3 wb = vec3(exp2(0.5 * kT), exp2(-kN), exp2(-0.5 * kT));
  wb /= luma(wb);
  vec3 gain = wb * exp2(expo);
  c *= gain;

  // ---- Dehaze (dark-channel prior on a heavily blurred copy)
  float dz = deh / 100.0;
  if (abs(dz) > 0.001) {
    vec3 hz = texture(uBlurH, vUv).rgb * gain;
    float dark = clamp(min(min(hz.r, hz.g), hz.b), 0.0, 1.0);
    if (dz > 0.0) {
      float t = 1.0 - dz * 0.92 * dark;
      c = max((c - (1.0 - t)) / max(t, 0.08), 0.0);
      c *= 1.0 + dz * 0.25 * dark; // mild exposure compensation
    } else {
      c = mix(c, vec3(0.62) * (0.6 + 0.4 * luma(hz)), -dz * 0.65);
    }
  }

  // ---- Tone (log2-luminance domain, local-adaptive)
  float Y = max(luma(c), 1.0e-6);
  float lY = log2(Y);
  float lBase = img.a;
  float dC = clamp(lBase - texture(uBlurC, vUv).a, -3.0, 3.0);
  float dT = clamp(lBase - texture(uBlurT, vUv).a, -2.0, 2.0);
  float dS = clamp(lBase - texture(uBlurS, vUv).a, -2.0, 2.0);
  float lLocal = lY - dC; // local mean, exposed
  float vLocal = exp2(mix(lLocal, lY, 0.3) / 2.2);
  float shMask = 1.0 - smoothstep(0.04, 0.62, vLocal);
  float hiMask = smoothstep(0.32, 0.98, vLocal);
  lY += (sh / 100.0) * shMask * 1.7;
  lY += (hi / 100.0) * hiMask * 1.5;

  float vNow = clamp(exp2(lY / 2.2), 0.0, 1.0);
  float mid = 1.0 - pow(abs(2.0 * vNow - 1.0), 2.0);
  lY += (cla / 100.0) * 0.6 * dC * mix(0.35, 1.0, mid);
  lY += (tex / 100.0) * 0.7 * dT;
  if (uSharp.x > 0.0) {
    float edge = abs(dT) + 0.25 * abs(dC);
    float mW = uSharp.z <= 0.001 ? 1.0 : smoothstep(uSharp.z * 0.2, uSharp.z * 0.2 + 0.08, edge);
    // Detail: low values soften the very largest swings (halo control) without cancelling edge sharpening.
    float d = dS / (1.0 + abs(dS) * (1.0 - uSharp.y) * 1.5);
    lY += uSharp.x * 1.4 * d * mW;
  }

  // Display-referred tone: contrast, whites, blacks.
  float v = exp2(lY / 2.2);
  float a = exp2((con / 100.0) * 1.15 + uProfile.x);
  if (v < 1.0 && abs(a - 1.0) > 1.0e-4) {
    float va = pow(v, a);
    v = va / (va + pow(1.0 - v, a));
  }
  float wW = wh / 100.0;
  if (v < 1.0) {
    float w = smoothstep(0.42, 1.0, v);
    v = 1.0 - pow(1.0 - v, exp2(wW * 0.9 * w));
  } else {
    v = 1.0 + (v - 1.0) * exp2(wW * 1.2);
  }
  float bB = bl / 100.0;
  float wl = 1.0 - smoothstep(0.0, 0.55, v);
  v = pow(max(v, 0.0), exp2(-bB * 0.85 * wl));
  float Y2 = pow(max(v, 0.0), 2.2);
  c *= Y2 / Y;
  c = gamutClip(c);

  vec3 d = linearToSrgb(c);
  if (uCurveOn > 0.5) {
    const float S = 1023.0 / 1024.0, B = 0.5 / 1024.0;
    d = vec3(texture(uCurve, vec2(d.r * S + B, 0.5)).r,
             texture(uCurve, vec2(d.g * S + B, 0.5)).g,
             texture(uCurve, vec2(d.b * S + B, 0.5)).b);
  }

  // ---- Colour: HSL mixer, vibrance/saturation, B&W, grading (OKLab)
  vec3 lin = srgbToLinear(d);
  vec3 lab = linearToOklab(lin);
  float C = length(lab.yz);
  float h = atan(lab.z, lab.y);
  float hueDeg = rgb2hsv(d).x * 360.0;
  int i0 = 7; int i1 = 0; float bt = 0.0;
  for (int i = 0; i < 8; i++) {
    if (hueDeg >= BAND[i] && hueDeg < BAND[i + 1]) {
      i0 = i; i1 = (i + 1) % 8;
      bt = (hueDeg - BAND[i]) / (BAND[i + 1] - BAND[i]);
    }
  }
  bt = bt * bt * (3.0 - 2.0 * bt);
  float chromaW = smoothstep(0.0, 0.1, C);
  if (uBW > 0.5) {
    float mixv = mix(uBwMix[i0], uBwMix[i1], bt) / 100.0;
    lab.x = clamp(lab.x + mixv * 0.35 * chromaW * (0.3 + lab.x), 0.0, 1.2);
    C = 0.0;
  } else {
    float hA = mix(uHslH[i0], uHslH[i1], bt);
    float sA = mix(uHslS[i0], uHslS[i1], bt);
    float lA = mix(uHslL[i0], uHslL[i1], bt);
    h += radians(hA * 0.3) * chromaW;
    C *= max(0.0, 1.0 + sA / 100.0);
    lab.x += lA / 100.0 * 0.22 * chromaW * lab.x;
    float skin = (i0 == 1 ? 1.0 - bt : (i1 == 1 ? bt : 0.0));
    float vib = uVibrance / 100.0 + uProfile.z;
    float satN = clamp(C / 0.22, 0.0, 1.0);
    C *= max(0.0, 1.0 + vib * (1.0 - satN) * (vib > 0.0 ? 1.0 - 0.6 * skin : 1.0));
    C *= max(0.0, 1.0 + sat / 100.0 + uProfile.y);
  }
  // Colour grading (3-way + global)
  float L = clamp(lab.x, 0.0, 1.0);
  float pivot = clamp(0.5 + uGBalance * 0.3, 0.12, 0.88);
  float pw = mix(2.6, 0.75, uGBlend);
  float ws = pow(clamp(1.0 - L / pivot, 0.0, 1.0), pw);
  float whw = pow(clamp((L - pivot) / (1.0 - pivot), 0.0, 1.0), pw);
  float wm = clamp(1.0 - ws - whw, 0.0, 1.0);
  vec3 g = ws * uGS + wm * uGM + whw * uGH + uGG;
  vec2 ab = vec2(cos(h), sin(h)) * C + g.xy * smoothstep(0.0, 0.08, L);
  lab = vec3(lab.x + g.z, ab);
  lin = gamutClip(oklabToLinear(lab));

  // ---- Post-crop vignette
  if (uVig.x != 0.0) {
    vec2 p = abs(vUv - 0.5) * 2.0;
    float aspect = uOutSize.x / uOutSize.y;
    float rnd = uVig.z;
    if (rnd > 0.0) { if (aspect > 1.0) p.x *= mix(1.0, aspect, rnd); else p.y *= mix(1.0, 1.0 / aspect, rnd); }
    float n = 2.0 + max(-rnd, 0.0) * 6.0;
    float dist = pow(pow(p.x, n) + pow(p.y, n), 1.0 / n);
    float start = mix(0.3, 1.35, uVig.y);
    float width = mix(0.04, 1.4, uVig.w);
    float w = smoothstep(start - width * 0.5, start + width * 0.5, dist);
    if (uVig.x < 0.0) {
      vec3 dk = lin * max(0.0, 1.0 + uVig.x * w);
      lin = mix(dk, lin, uVigHL * smoothstep(0.55, 1.0, luma(lin)) * w);
    } else {
      lin = mix(lin, vec3(1.0), uVig.x * w);
    }
  }

  d = linearToSrgb(lin);

  // ---- Grain
  if (uGrain.x > 0.0) {
    vec2 px = vUv * uOutSize / max(uScale, 1.0e-3);
    float sz = mix(0.7, 4.5, uGrain.y);
    vec2 gp = px / sz + uSeed * 13.0;
    float n1 = valueNoise(gp) - 0.5;
    float n2 = valueNoise(gp * 2.3 + 7.0) - 0.5;
    float nz = mix(n1, n1 * 0.6 + n2 * 0.8, uGrain.z) * 2.0;
    float Ld = luma(d);
    d += nz * uGrain.x * 0.16 * (4.0 * Ld * (1.0 - Ld) + 0.12);
  }

  if (uOverlay >= 0 && uOverlay < uLocalN) {
    float mo = clamp(localMask(uOverlay, suv), 0.0, 1.0);
    d = mix(d, uOverlayColor.rgb, mo * uOverlayColor.a);
  }

  o = vec4(clamp(d + dither, 0.0, 1.0), 1.0);
}`;

/** Draws a result texture to the screen with pan/zoom, before/after split and clipping warnings. */
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uTex2;
uniform vec2 uCanvas;   // drawing buffer px
uniform vec2 uImgSize;  // displayed image size in canvas px at scale 1
uniform vec3 uView;     // offset x, offset y (canvas px, top-left), scale
uniform vec3 uBg;
uniform float uClip;
uniform float uSplit;   // <0 off; else split position 0..1 (left = uTex2)
uniform float uNearest;
void main() {
  vec2 frag = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 uv = (frag - uView.xy) / (uImgSize * uView.z);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(uBg, 1.0); return; }
  if (uNearest > 0.5) { vec2 ts = vec2(textureSize(uTex, 0)); uv = (floor(uv * ts) + 0.5) / ts; }
  vec4 c = (uSplit >= 0.0 && uv.x < uSplit) ? texture(uTex2, uv) : texture(uTex, uv);
  if (uSplit >= 0.0 && abs(uv.x - uSplit) * uImgSize.x * uView.z < 1.0) c = vec4(1.0);
  if (uClip > 0.5) {
    float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
    if (mx >= 0.998) c.rgb = vec3(1.0, 0.1, 0.1);
    else if (mn <= 0.002) c.rgb = vec3(0.15, 0.35, 1.0);
  }
  o = vec4(c.rgb, 1.0);
}`;
