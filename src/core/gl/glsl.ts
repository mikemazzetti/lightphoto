/** Reusable GLSL snippets. Concatenate into shader sources. */

export const GLSL_COLOR = /* glsl */ `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgbToLinear(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5, d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 c) {
  if (c.y < 1e-6) return vec3(c.z);
  float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
  float p = 2.0 * c.z - q;
  return vec3(hue2rgb(p, q, c.x + 1.0/3.0), hue2rgb(p, q, c.x), hue2rgb(p, q, c.x - 1.0/3.0));
}
// OKLab (Björn Ottosson). Input/output: linear sRGB.
vec3 linearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = sign(l) * pow(abs(l), 1.0/3.0); m = sign(m) * pow(abs(m), 1.0/3.0); s = sign(s) * pow(abs(s), 1.0/3.0);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLinear(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
`;

export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/** Photoshop-style blend modes. `b` = backdrop, `s` = source, both straight (non-premultiplied) sRGB 0..1. */
export const GLSL_BLEND = /* glsl */ `
float blendOverlayC(float b, float s) { return b < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s); }
float blendSoftLightC(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float blendColorDodgeC(float b, float s) { return b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float blendColorBurnC(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float blendVividLightC(float b, float s) { return s <= 0.5 ? blendColorBurnC(b, 2.0 * s) : blendColorDodgeC(b, 2.0 * (s - 0.5)); }
float blendLinearLightC(float b, float s) { return clamp(b + 2.0 * s - 1.0, 0.0, 1.0); }
float blendPinLightC(float b, float s) { return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0); }
float blendHardMixC(float b, float s) { return b + s >= 1.0 ? 1.0 : 0.0; }
float lumN(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lumN(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lumN(c))); }
float satN(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  vec3 r = vec3(0.0);
  if (mx > mn) r = (c - mn) * s / (mx - mn);
  return r;
}
// mode ids: 0 normal,1 dissolve,2 darken,3 multiply,4 color burn,5 linear burn,6 darker color,
// 7 lighten,8 screen,9 color dodge,10 linear dodge(add),11 lighter color,12 overlay,13 soft light,
// 14 hard light,15 vivid light,16 linear light,17 pin light,18 hard mix,19 difference,20 exclusion,
// 21 subtract,22 divide,23 hue,24 saturation,25 color,26 luminosity
vec3 blendMode(int m, vec3 b, vec3 s) {
  if (m == 2) return min(b, s);
  if (m == 3) return b * s;
  if (m == 4) return vec3(blendColorBurnC(b.r, s.r), blendColorBurnC(b.g, s.g), blendColorBurnC(b.b, s.b));
  if (m == 5) return max(b + s - 1.0, 0.0);
  if (m == 6) return lumN(s) < lumN(b) ? s : b;
  if (m == 7) return max(b, s);
  if (m == 8) return b + s - b * s;
  if (m == 9) return vec3(blendColorDodgeC(b.r, s.r), blendColorDodgeC(b.g, s.g), blendColorDodgeC(b.b, s.b));
  if (m == 10) return min(b + s, 1.0);
  if (m == 11) return lumN(s) > lumN(b) ? s : b;
  if (m == 12) return vec3(blendOverlayC(b.r, s.r), blendOverlayC(b.g, s.g), blendOverlayC(b.b, s.b));
  if (m == 13) return vec3(blendSoftLightC(b.r, s.r), blendSoftLightC(b.g, s.g), blendSoftLightC(b.b, s.b));
  if (m == 14) return vec3(blendOverlayC(s.r, b.r), blendOverlayC(s.g, b.g), blendOverlayC(s.b, b.b));
  if (m == 15) return vec3(blendVividLightC(b.r, s.r), blendVividLightC(b.g, s.g), blendVividLightC(b.b, s.b));
  if (m == 16) return vec3(blendLinearLightC(b.r, s.r), blendLinearLightC(b.g, s.g), blendLinearLightC(b.b, s.b));
  if (m == 17) return vec3(blendPinLightC(b.r, s.r), blendPinLightC(b.g, s.g), blendPinLightC(b.b, s.b));
  if (m == 18) return vec3(blendHardMixC(b.r, s.r), blendHardMixC(b.g, s.g), blendHardMixC(b.b, s.b));
  if (m == 19) return abs(b - s);
  if (m == 20) return b + s - 2.0 * b * s;
  if (m == 21) return max(b - s, 0.0);
  if (m == 22) return vec3(s.r > 0.0 ? min(b.r / s.r, 1.0) : 1.0, s.g > 0.0 ? min(b.g / s.g, 1.0) : 1.0, s.b > 0.0 ? min(b.b / s.b, 1.0) : 1.0);
  if (m == 23) return setLum(setSat(s, satN(b)), lumN(b));
  if (m == 24) return setLum(setSat(b, satN(s)), lumN(b));
  if (m == 25) return setLum(s, lumN(b));
  if (m == 26) return setLum(b, lumN(s));
  return s;
}
`;

export const BLEND_MODES = [
  'normal', 'dissolve', 'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color',
  'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color', 'overlay', 'soft-light',
  'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', 'difference', 'exclusion',
  'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];
export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: 'Normal', dissolve: 'Dissolve', darken: 'Darken', multiply: 'Multiply', 'color-burn': 'Color Burn',
  'linear-burn': 'Linear Burn', 'darker-color': 'Darker Color', lighten: 'Lighten', screen: 'Screen',
  'color-dodge': 'Color Dodge', 'linear-dodge': 'Linear Dodge (Add)', 'lighter-color': 'Lighter Color',
  overlay: 'Overlay', 'soft-light': 'Soft Light', 'hard-light': 'Hard Light', 'vivid-light': 'Vivid Light',
  'linear-light': 'Linear Light', 'pin-light': 'Pin Light', 'hard-mix': 'Hard Mix', difference: 'Difference',
  exclusion: 'Exclusion', subtract: 'Subtract', divide: 'Divide', hue: 'Hue', saturation: 'Saturation',
  color: 'Color', luminosity: 'Luminosity',
};
/** Menu grouping (Photoshop order), separators between groups. */
export const BLEND_MODE_GROUPS: BlendMode[][] = [
  ['normal', 'dissolve'],
  ['darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color'],
  ['lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color'],
  ['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix'],
  ['difference', 'exclusion', 'subtract', 'divide'],
  ['hue', 'saturation', 'color', 'luminosity'],
];
export const blendModeId = (m: BlendMode) => BLEND_MODES.indexOf(m);
