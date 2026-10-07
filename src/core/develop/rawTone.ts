import { makeCurve } from './curve';

/**
 * Default "camera look" tone curve for RAW files: maps scene-linear sensor values (1.0 = clipping,
 * no auto-brightening) to display (sRGB-encoded) values. Applied once at decode, after which the
 * rest of the pipeline treats RAWs like any other image.
 *
 * Fitted to macOS's RAW engine (what Preview / Photos show): midtones and highlights from
 * pixel-for-pixel matches of smooth, unclipped regions of Sony RX100 V ARWs; the shadow toe tuned
 * so whole-image shadow levels (medians of night scenes) line up as well. Shadows roll off into a soft toe rather than clipping, so
 * the Shadows / Blacks sliders can still recover them.
 *
 * Points are (linear, display). The LUT is indexed by sqrt(linear) for fine shadow resolution.
 */
export const RAW_TONE_POINTS: [number, number][] = [
  [0, 0],
  [0.002, 0.0004],
  [0.0045, 0.0012],
  [0.0078, 0.0018],
  [0.0156, 0.006],
  [0.022, 0.012],
  [0.031, 0.024],
  [0.044, 0.05],
  [0.0625, 0.09],
  [0.088, 0.136],
  [0.125, 0.192],
  [0.177, 0.262],
  [0.25, 0.363],
  [0.354, 0.468],
  [0.5, 0.68],
  [0.707, 0.86],
  [1, 1],
];

export const RAW_TONE_LUT_SIZE = 1024;

let baked: Float32Array | null = null;

/** Display values over x = sqrt(linear) ∈ [0, 1] (RAW_TONE_LUT_SIZE entries). */
export function rawToneLut(): Float32Array {
  if (baked) return baked;
  const f = makeCurve(RAW_TONE_POINTS.map(([l, d]) => [Math.sqrt(l), d]));
  baked = new Float32Array(RAW_TONE_LUT_SIZE);
  for (let i = 0; i < RAW_TONE_LUT_SIZE; i++) baked[i] = f(i / (RAW_TONE_LUT_SIZE - 1));
  return baked;
}
