import { GLSL_BLEND, GLSL_COLOR, GLSL_NOISE } from '@/core/gl/glsl';

/**
 * Places a (processed) source onto the accumulator: inverse motion transform, crop, opacity and
 * blend mode, producing premultiplied output. `uM` maps sequence pixels → source uv.
 */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uAcc;
uniform mat3 uM;
uniform vec2 uSeq;
uniform vec4 uCrop;
uniform float uOpacity;
uniform int uBlend;
uniform float uPremul;
uniform float uHasAcc;
uniform float uSolidOn;
uniform vec4 uSolid;
${GLSL_NOISE}
${GLSL_BLEND}
void main() {
  vec2 P = vUv * uSeq;
  vec2 uv = (uM * vec3(P, 1.0)).xy;
  vec2 lo = uCrop.xy;
  vec2 hi = vec2(1.0) - uCrop.zw;
  vec2 fw = max(fwidth(uv), vec2(1e-6));
  vec2 m = smoothstep(lo - fw * 0.5, lo + fw * 0.5, uv) * (vec2(1.0) - smoothstep(hi - fw * 0.5, hi + fw * 0.5, uv));
  float cov = m.x * m.y;
  vec4 s = uSolidOn > 0.5 ? uSolid : texture(uSrc, clamp(uv, vec2(0.0), vec2(1.0)));
  if (uPremul > 0.5) s.rgb = s.a > 1e-5 ? s.rgb / s.a : vec3(0.0);
  float a = s.a * cov * uOpacity;
  if (uBlend == 1) a = hash12(gl_FragCoord.xy) < a ? 1.0 : 0.0;
  vec4 d = uHasAcc > 0.5 ? texture(uAcc, vUv) : vec4(0.0);
  vec3 db = d.a > 1e-5 ? d.rgb / d.a : vec3(0.0);
  vec3 cs = s.rgb;
  if (uBlend > 1) cs = mix(s.rgb, clamp(blendMode(uBlend, db, s.rgb), 0.0, 1.0), d.a);
  o = vec4(cs * a + d.rgb * (1.0 - a), a + d.a * (1.0 - a));
}`;

/** Combines two premultiplied layers. Types: 0 dissolve, 1 dip to colour, 2 wipe, 3 slide, 4 push. */
export const TRANSITION_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uHasA;
uniform float uHasB;
uniform int uType;
uniform float uP;
uniform vec2 uDir;
uniform vec3 uColor;
uniform float uSoft;
vec4 tap(sampler2D t, float has, vec2 uv) {
  if (has < 0.5 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(t, uv);
}
void main() {
  vec2 uv = vUv;
  float p = uP;
  if (uType == 3) {
    vec4 A = tap(uA, uHasA, uv);
    vec4 B = tap(uB, uHasB, uv + uDir * (1.0 - p));
    o = B + A * (1.0 - B.a);
    return;
  }
  if (uType == 4) {
    vec4 A = tap(uA, uHasA, uv - uDir * p);
    vec4 B = tap(uB, uHasB, uv + uDir * (1.0 - p));
    o = B + A * (1.0 - B.a);
    return;
  }
  vec4 A = tap(uA, uHasA, uv);
  vec4 B = tap(uB, uHasB, uv);
  if (uType == 1) {
    vec4 C = vec4(uColor, 1.0);
    o = p < 0.5 ? mix(A, C, p * 2.0) : mix(C, B, p * 2.0 - 1.0);
  } else if (uType == 2) {
    float coord = dot(uv - 0.5, uDir) / (abs(uDir.x) + abs(uDir.y)) + 0.5;
    float e = p * (1.0 + 2.0 * uSoft) - uSoft;
    float m = 1.0 - smoothstep(e - uSoft, e + uSoft, coord);
    o = mix(A, B, m);
  } else {
    o = mix(A, B, p);
  }
}`;

/** Single-pass per-pixel video effects (straight alpha in/out). */
export const FX_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform int uType;
uniform vec4 uP;
uniform vec4 uP2;
uniform vec3 uC1;
uniform vec3 uC2;
${GLSL_COLOR}
void main() {
  vec2 uv = vUv;
  // 1 bw, 2 invert, 3 tint, 4 mirror, 5 hflip, 6 vflip, 7 crop, 8 brightness, 9 posterize, 10 sharpen
  if (uType == 4) {
    vec2 q = uv * uSize;
    vec2 P = vec2(uP.x, 0.5) * uSize;
    vec2 n = vec2(cos(uP.y), sin(uP.y));
    float d = dot(q - P, n);
    if (d > 0.0) q -= 2.0 * d * n;
    uv = q / uSize;
  } else if (uType == 5) uv.x = 1.0 - uv.x;
  else if (uType == 6) uv.y = 1.0 - uv.y;
  vec4 c = texture(uTex, uv);
  if (uType == 11) c.rgb = c.a > 1e-5 ? c.rgb / c.a : vec3(0.0);
  else if (uType == 1) c.rgb = vec3(luma(c.rgb));
  else if (uType == 2) c.rgb = mix(c.rgb, 1.0 - c.rgb, uP.x);
  else if (uType == 3) c.rgb = mix(c.rgb, mix(uC1, uC2, luma(c.rgb)), uP.x);
  else if (uType == 7) {
    vec2 px = uv * uSize;
    float f = max(uP2.x, 0.0) + 1e-3;
    float l = uP.x * uSize.x, t = uP.y * uSize.y;
    float r = uSize.x - uP.z * uSize.x;
    float b = uSize.y - uP.w * uSize.y;
    float m = smoothstep(l, l + f, px.x) * (1.0 - smoothstep(r - f, r, px.x)) * smoothstep(t, t + f, px.y) * (1.0 - smoothstep(b - f, b, px.y));
    c.a *= m;
  } else if (uType == 8) {
    c.rgb = c.rgb + uP.x;
    c.rgb = (c.rgb - 0.5) * uP.y + 0.5;
    c.rgb = clamp(c.rgb, 0.0, 1.0);
  } else if (uType == 9) {
    float L = max(2.0, uP.x);
    c.rgb = floor(c.rgb * (L - 0.001)) / (L - 1.0);
  } else if (uType == 10) {
    vec2 tx = 1.0 / uSize;
    vec3 nb = texture(uTex, uv + vec2(tx.x, 0.0)).rgb + texture(uTex, uv - vec2(tx.x, 0.0)).rgb + texture(uTex, uv + vec2(0.0, tx.y)).rgb + texture(uTex, uv - vec2(0.0, tx.y)).rgb;
    c.rgb = clamp(c.rgb + (c.rgb - nb * 0.25) * uP.x, 0.0, 1.0);
  }
  o = c;
}`;

/** Separable gaussian (premultiplied accumulation, straight output). */
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uSigma;
uniform float uRepeat;
void main() {
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i);
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    vec2 uv = vUv + uStep * x;
    vec4 s = texture(uTex, uv);
    if (uRepeat < 0.5 && (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0)) s = vec4(0.0);
    s.rgb *= s.a;
    acc += s * w;
    ws += w;
  }
  acc /= ws;
  o = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
}`;

/** Restores source alpha after the develop engine and applies Creative › Faded Film. */
export const LUMETRI_POST_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uRes;
uniform sampler2D uSrc;
uniform float uFaded;
${GLSL_COLOR}
void main() {
  vec3 c = texture(uRes, vUv).rgb;
  float a = texture(uSrc, vUv).a;
  float f = uFaded / 100.0;
  if (f > 0.0) {
    vec3 lifted = vec3(0.11, 0.105, 0.1) + c * 0.84;
    lifted = mix(vec3(luma(lifted)), lifted, 0.9);
    c = mix(c, lifted, f);
  }
  o = vec4(c, a);
}`;

/** Draws the composite into the visible canvas with letterboxing. */
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec4 uRect;
uniform vec2 uCanvas;
uniform vec3 uBg;
void main() {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uCanvas;
  vec2 uv = (px - uRect.xy) / uRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(uBg, 1.0); return; }
  o = vec4(texture(uTex, uv).rgb, 1.0);
}`;
