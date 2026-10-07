import { GLSL_BLEND, GLSL_COLOR, GLSL_NOISE } from '@/core/gl/glsl';

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv; out vec4 o;
`;

/**
 * Shared adjustment code. One function handles every adjustment type; per-channel tone maps
 * (brightness/contrast, levels, curves, exposure, invert, posterize) are baked into uLut.
 */
export const GLSL_ADJUST = /* glsl */ `
uniform int uAdj;
uniform sampler2D uLut;
uniform vec4 uA0;
uniform vec4 uA1;
uniform vec4 uA2;
uniform vec4 uA3;

vec3 lut3(vec3 c) {
  vec3 i = clamp(c, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
  return vec3(texture(uLut, vec2(i.r, 0.5)).r, texture(uLut, vec2(i.g, 0.5)).g, texture(uLut, vec2(i.b, 0.5)).b);
}
float lumaY(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 adjHueSat(vec3 c) {
  vec3 r;
  if (uA0.w > 0.5) {
    float l = lumaY(c);
    r = hsl2rgb(vec3(fract(uA0.x), clamp(uA0.y, 0.0, 1.0), l));
  } else {
    vec3 hsl = rgb2hsl(c);
    hsl.x = fract(hsl.x + uA0.x + 1.0);
    float s = hsl.y;
    float S = uA0.y;
    hsl.y = S >= 0.0 ? clamp(s * (1.0 + S) + (1.0 - s) * S * s, 0.0, 1.0) : s * (1.0 + S);
    r = hsl2rgb(hsl);
  }
  float L = uA0.z;
  r = L >= 0.0 ? mix(r, vec3(1.0), L) : mix(r, vec3(0.0), -L);
  return clamp(r, 0.0, 1.0);
}

vec3 adjBalance(vec3 c) {
  float l = lumaY(c);
  float ws = 1.0 - smoothstep(0.0, 0.55, l);
  float wh = smoothstep(0.45, 1.0, l);
  float wm = clamp(1.0 - ws - wh, 0.0, 1.0);
  vec3 d = uA0.xyz * ws * 0.45 + uA1.xyz * wm * 0.55 + uA2.xyz * wh * 0.45;
  vec3 r = clamp(c + d - (d.r + d.g + d.b) / 3.0 * 0.0, 0.0, 1.0);
  if (uA3.x > 0.5) r = clamp(r + (l - lumaY(r)), 0.0, 1.0);
  return r;
}

vec3 adjVibrance(vec3 c) {
  float l = lumaY(c);
  c = mix(vec3(l), c, 1.0 + uA0.y);
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float sat = mx - mn;
  float v = uA0.x;
  float skin = (c.r > c.g && c.g > c.b) ? clamp((c.r - c.b) * 2.0, 0.0, 1.0) * 0.5 : 0.0;
  float amt = v > 0.0 ? v * (1.0 - sat) * (1.0 - skin) * 1.4 : v;
  return clamp(mix(vec3(lumaY(c)), c, 1.0 + amt), 0.0, 1.0);
}

vec3 adjBW(vec3 c) {
  // Photoshop's Black & White: gray = min + (mid-min)*w(secondary) + (max-mid)*w(primary)
  float R = uA0.x, Y = uA0.y, G = uA0.z, C = uA0.w, B = uA1.x, M = uA1.y;
  float r = c.r, g = c.g, b = c.b;
  float mx = max(max(r, g), b), mn = min(min(r, g), b);
  float mid = r + g + b - mx - mn;
  float wp, ws;
  if (mx == r) { wp = R; ws = (mid == g) ? Y : M; }
  else if (mx == g) { wp = G; ws = (mid == r) ? Y : C; }
  else { wp = B; ws = (mid == g) ? C : M; }
  float gray = clamp(mn + (mid - mn) * ws + (mx - mid) * wp, 0.0, 1.0);
  vec3 o3 = vec3(gray);
  if (uA1.z > 0.5) o3 = setLum(uA2.rgb, gray);
  return clamp(o3, 0.0, 1.0);
}

vec3 adjPhotoFilter(vec3 c) {
  vec3 f = mix(c, c * uA0.rgb * 1.6, uA0.w);
  if (uA1.x > 0.5) f *= lumaY(c) / max(lumaY(f), 1e-4);
  return clamp(f, 0.0, 1.0);
}

vec3 adjust(vec3 c) {
  if (uAdj == 0) return lut3(c);
  if (uAdj == 1) return adjHueSat(c);
  if (uAdj == 2) return adjBalance(c);
  if (uAdj == 3) return adjVibrance(c);
  if (uAdj == 4) return adjBW(c);
  if (uAdj == 5) return adjPhotoFilter(c);
  if (uAdj == 6) return vec3(step(uA0.x, lumaY(c) + 1e-5));
  if (uAdj == 7) {
    float l = clamp(lumaY(c), 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    return texture(uLut, vec2(l, 0.5)).rgb;
  }
  return c;
}
`;

const SAMPLE = /* glsl */ `
// Samples a texture positioned in document space through an affine doc→uv matrix; transparent outside.
vec4 sampleAt(sampler2D t, mat3 m, vec2 px) {
  vec2 uv = (m * vec3(px, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(t, uv);
}
float maskAt(sampler2D t, mat3 m, vec2 px, float def) {
  vec2 uv = (m * vec3(px, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return def;
  return texture(t, uv).r;
}
`;

/** Composites one pixel layer (raster/text/shape/fill) onto the accumulated result. */
export const LAYER_FS =
  HEAD +
  GLSL_COLOR +
  GLSL_BLEND +
  GLSL_NOISE +
  SAMPLE +
  /* glsl */ `
uniform sampler2D uBack;
uniform vec4 uArea;          // x, y, w, h of the target in document pixels
uniform vec2 uDocSize;
uniform sampler2D uSrc; uniform mat3 uSrcMat; uniform int uSolid; uniform vec4 uSolidColor;
uniform sampler2D uMask; uniform mat3 uMaskMat; uniform int uMaskOn; uniform float uMaskDefault; uniform float uMaskDensity;
uniform sampler2D uClip; uniform mat3 uClipMat; uniform int uClipOn; uniform int uClipSolid;
uniform sampler2D uClipMask; uniform mat3 uClipMaskMat; uniform int uClipMaskOn; uniform float uClipMaskDefault; uniform float uClipMaskDensity;
uniform float uOpacity;
uniform int uMode;
uniform sampler2D uStroke; uniform int uStrokeMode; uniform float uStrokeOpacity; uniform int uStrokeBlend; uniform int uStrokeTarget; uniform int uLockAlpha;
uniform sampler2D uSel; uniform int uSelOn;
uniform int uKnockMaskView;  // 1 = show the mask as grayscale instead of the layer
void main() {
  vec2 px = uArea.xy + vUv * uArea.zw;
  vec2 duv = px / uDocSize;
  vec4 b = texture(uBack, vUv);
  vec4 s = uSolid == 1 ? uSolidColor : sampleAt(uSrc, uSrcMat, px);
  float mraw = uMaskOn == 1 ? maskAt(uMask, uMaskMat, px, uMaskDefault) : 1.0;
  if (uStrokeMode != 0) {
    vec4 st = texture(uStroke, duv);
    float sa = st.a * uStrokeOpacity;
    if (uSelOn == 1) sa *= texture(uSel, duv).r;
    if (uStrokeTarget == 1) {
      mraw = mix(mraw, st.r, sa);
    } else if (uStrokeMode == 1) {
      vec3 cs = mix(st.rgb, blendMode(uStrokeBlend, s.rgb, st.rgb), s.a);
      if (uLockAlpha == 1) s.rgb = mix(s.rgb, cs, sa);
      else {
        float a = sa + s.a * (1.0 - sa);
        s.rgb = a > 0.0 ? (cs * sa + s.rgb * s.a * (1.0 - sa)) / a : vec3(0.0);
        s.a = a;
      }
    } else if (uStrokeMode == 2) {
      s.a *= 1.0 - sa;
    }
  }
  if (uKnockMaskView == 1) { o = vec4(vec3(mraw), 1.0); return; }
  float m = mix(1.0, mraw, uMaskDensity);
  if (uClipOn == 1) {
    float ca = uClipSolid == 1 ? 1.0 : sampleAt(uClip, uClipMat, px).a;
    if (uClipMaskOn == 1) ca *= mix(1.0, maskAt(uClipMask, uClipMaskMat, px, uClipMaskDefault), uClipMaskDensity);
    s.a *= ca;
  }
  float a = s.a * m * uOpacity;
  if (uMode == 1) a = hash12(floor(px) + 0.37) < a ? 1.0 : 0.0;
  vec3 cs = uMode <= 1 ? s.rgb : mix(s.rgb, blendMode(uMode, b.rgb, s.rgb), b.a);
  float ao = a + b.a * (1.0 - a);
  vec3 co = ao > 0.0 ? (cs * a + b.rgb * b.a * (1.0 - a)) / ao : vec3(0.0);
  o = vec4(co, ao);
}`;

/** Applies an adjustment layer to the accumulated result. */
export const ADJ_LAYER_FS =
  HEAD +
  GLSL_COLOR +
  GLSL_BLEND +
  SAMPLE +
  GLSL_ADJUST +
  /* glsl */ `
uniform sampler2D uBack;
uniform vec4 uArea;
uniform vec2 uDocSize;
uniform sampler2D uMask; uniform mat3 uMaskMat; uniform int uMaskOn; uniform float uMaskDefault; uniform float uMaskDensity;
uniform sampler2D uClip; uniform mat3 uClipMat; uniform int uClipOn; uniform int uClipSolid;
uniform sampler2D uClipMask; uniform mat3 uClipMaskMat; uniform int uClipMaskOn; uniform float uClipMaskDefault; uniform float uClipMaskDensity;
uniform float uOpacity;
uniform int uMode;
uniform sampler2D uStroke; uniform int uStrokeMode; uniform float uStrokeOpacity; uniform sampler2D uSel; uniform int uSelOn;
void main() {
  vec2 px = uArea.xy + vUv * uArea.zw;
  vec2 duv = px / uDocSize;
  vec4 b = texture(uBack, vUv);
  float mraw = uMaskOn == 1 ? maskAt(uMask, uMaskMat, px, uMaskDefault) : 1.0;
  if (uStrokeMode != 0) {
    vec4 st = texture(uStroke, duv);
    float sa = st.a * uStrokeOpacity;
    if (uSelOn == 1) sa *= texture(uSel, duv).r;
    mraw = mix(mraw, st.r, sa);
  }
  float k = uOpacity * mix(1.0, mraw, uMaskDensity);
  if (uClipOn == 1) {
    k *= uClipSolid == 1 ? 1.0 : sampleAt(uClip, uClipMat, px).a;
    if (uClipMaskOn == 1) k *= mix(1.0, maskAt(uClipMask, uClipMaskMat, px, uClipMaskDefault), uClipMaskDensity);
  }
  vec3 a = adjust(b.rgb);
  vec3 r = uMode <= 1 ? a : blendMode(uMode, b.rgb, a);
  o = vec4(mix(b.rgb, r, k), b.a);
}`;

/** Destructive adjustment over a layer texture (alpha untouched). */
export const ADJ_APPLY_FS =
  HEAD +
  GLSL_COLOR +
  GLSL_BLEND +
  GLSL_ADJUST +
  /* glsl */ `
uniform sampler2D uSrc;
void main() { vec4 c = texture(uSrc, vUv); o = vec4(adjust(c.rgb), c.a); }`;

/**
 * Blends a processed layer texture with the original through the selection (filters /
 * adjustments "respect the selection"). Both textures share the layer's pixel grid.
 */
export const SEL_MIX_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uOrig;
uniform sampler2D uProc;
uniform sampler2D uSel;
uniform int uSelOn;
uniform vec2 uOrigin;    // layer surface origin in document pixels
uniform vec2 uSize;      // layer surface size
uniform vec2 uDocSize;
uniform int uKeepAlpha;
uniform float uAmount;   // fade
void main() {
  vec4 a = texture(uOrig, vUv);
  vec4 p = texture(uProc, vUv);
  float k = uAmount;
  if (uSelOn == 1) {
    vec2 duv = (uOrigin + vUv * uSize) / uDocSize;
    k *= (duv.x < 0.0 || duv.y < 0.0 || duv.x > 1.0 || duv.y > 1.0) ? 0.0 : texture(uSel, duv).r;
  }
  if (uKeepAlpha == 1) { o = vec4(mix(a.rgb, p.rgb, k), a.a); return; }
  // Straight alpha: mix premultiplied colours (no dark fringes from transparent pixels' rgb).
  vec4 m = mix(vec4(a.rgb * a.a, a.a), vec4(p.rgb * p.a, p.a), k);
  o = vec4(m.a > 1e-5 ? m.rgb / m.a : vec3(0.0), m.a);
}`;

/** Final display: checkerboard, pasteboard, nearest/linear sampling, pixel grid, marching ants. */
export const PRESENT_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uImg;
uniform sampler2D uSel;
uniform vec2 uDocSize;
uniform vec3 uView;      // device px of doc origin (x, y) and device px per doc px
uniform vec2 uCanvas;
uniform float uTime;
uniform int uAnts;
uniform int uGrid;
uniform int uNearest;
uniform vec3 uBg;
uniform float uDpr;
uniform int uMaskView;   // reserved
bool selAt(vec2 sp) {
  vec2 dp = (sp - uView.xy) / uView.z;
  if (dp.x < 0.0 || dp.y < 0.0 || dp.x >= uDocSize.x || dp.y >= uDocSize.y) return false;
  return texelFetch(uSel, ivec2(floor(dp)), 0).r >= 0.5;
}
void main() {
  vec2 sp = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 dp = (sp - uView.xy) / uView.z;
  // Sampled in uniform control flow so mip selection has valid derivatives at the canvas edge.
  vec4 c = uNearest == 1 ? texelFetch(uImg, ivec2(clamp(floor(dp), vec2(0.0), uDocSize - 1.0)), 0) : texture(uImg, dp / uDocSize);
  vec3 col;
  bool inside = dp.x >= 0.0 && dp.y >= 0.0 && dp.x < uDocSize.x && dp.y < uDocSize.y;
  if (!inside) {
    col = uBg;
    // soft drop shadow around the canvas
    vec2 q = max(max(-dp, dp - uDocSize), 0.0) * uView.z / uDpr;
    float d = length(q);
    col *= 1.0 - 0.35 * exp(-d * 0.35);
  } else {
    float cs = 8.0 * uDpr;
    float ck = mod(floor(sp.x / cs) + floor(sp.y / cs), 2.0);
    vec3 checker = mix(vec3(1.0), vec3(0.8), ck);
    col = mix(checker, c.rgb, c.a);
    if (uGrid == 1 && uView.z >= 8.0 * uDpr) {
      vec2 f = fract(dp);
      vec2 d = min(f, 1.0 - f) * uView.z;
      if (min(d.x, d.y) < 0.75) col = mix(col, vec3(0.55), 0.45);
    }
  }
  if (uAnts == 1) {
    bool s0 = selAt(sp);
    bool edge = s0 != selAt(sp + vec2(1.0, 0.0)) || s0 != selAt(sp + vec2(0.0, 1.0)) || s0 != selAt(sp - vec2(1.0, 0.0)) || s0 != selAt(sp - vec2(0.0, 1.0));
    if (edge) {
      float t = mod(floor((sp.x + sp.y) / (4.0 * uDpr) + uTime), 2.0);
      col = t < 1.0 ? vec3(0.0) : vec3(1.0);
    }
  }
  o = vec4(col, 1.0);
}`;

/** Copies `uSrc` (sampled at the target's area) — used for region copies between targets. */
export const COPY_AREA_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uSrc;
uniform vec4 uSrcRect;   // uv rect in the source covering the target
void main() { o = texture(uSrc, uSrcRect.xy + vUv * uSrcRect.zw); }`;

/** Downsampled thumbnail of the composite (box filter over the mip chain). */
export const THUMB_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uSrc;
uniform vec3 uBg;
uniform int uChecker;
uniform vec2 uSize;
void main() {
  vec4 c = texture(uSrc, vUv);
  vec3 bg = uBg;
  if (uChecker == 1) {
    vec2 p = floor(vUv * uSize / 4.0);
    bg = mix(vec3(1.0), vec3(0.8), mod(p.x + p.y, 2.0));
  }
  o = vec4(mix(bg, c.rgb, c.a), 1.0);
}`;

/** Gradient tool / gradient fill. */
export const GRADIENT_FS =
  HEAD +
  GLSL_NOISE +
  /* glsl */ `
uniform sampler2D uSrc;      // layer (or mask) pixels
uniform sampler2D uRamp;     // 256x1 gradient colours (straight alpha)
uniform vec2 uOrigin;        // layer origin in doc px
uniform vec2 uSize;          // layer size
uniform vec2 uP0;
uniform vec2 uP1;
uniform int uType;           // 0 linear 1 radial 2 angle 3 reflected 4 diamond
uniform float uOpacity;
uniform int uBlend;
uniform int uDither;
uniform int uLockAlpha;
uniform int uMaskTarget;
uniform sampler2D uSel; uniform int uSelOn; uniform vec2 uDocSize;
${GLSL_COLOR}
${GLSL_BLEND}
void main() {
  vec2 px = uOrigin + vUv * uSize;
  vec2 d = uP1 - uP0;
  float L = max(length(d), 1e-4);
  vec2 v = px - uP0;
  float t;
  if (uType == 0) t = dot(v, d) / (L * L);
  else if (uType == 1) t = length(v) / L;
  else if (uType == 2) { float a0 = atan(d.y, d.x); float a = atan(v.y, v.x); t = fract((a0 - a) / 6.2831853 + 1.0); }
  else if (uType == 3) t = abs(dot(v, d) / (L * L));
  else { vec2 dn = d / L; vec2 nn = vec2(-dn.y, dn.x); t = (abs(dot(v, dn)) + abs(dot(v, nn))) / L; }
  t = clamp(t, 0.0, 1.0);
  vec4 g = texture(uRamp, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  if (uDither == 1) g.rgb += (hash12(px) - 0.5) / 255.0;
  vec4 s = texture(uSrc, vUv);
  float k = uOpacity * g.a;
  if (uSelOn == 1) {
    vec2 duv = px / uDocSize;
    k *= (duv.x < 0.0 || duv.y < 0.0 || duv.x > 1.0 || duv.y > 1.0) ? 0.0 : texture(uSel, duv).r;
  }
  if (uMaskTarget == 1) {
    float gv = dot(g.rgb, vec3(0.299, 0.587, 0.114));
    o = vec4(vec3(mix(s.r, gv, k)), 1.0);
    return;
  }
  vec3 cs = mix(g.rgb, blendMode(uBlend, s.rgb, g.rgb), s.a);
  if (uLockAlpha == 1) { o = vec4(mix(s.rgb, cs, k), s.a); return; }
  float a = k + s.a * (1.0 - k);
  vec3 c = a > 0.0 ? (cs * k + s.rgb * s.a * (1.0 - k)) / a : vec3(0.0);
  o = vec4(c, a);
}`;
