import type { BlendMode } from '@/core/gl/glsl';
import type { CurvePoint } from '@/core/develop/settings';
import type { RGBA } from '@/core/util/color';
import type { Mat2D } from './geom';
import type { Surface } from './surface';

export type { Rect, Mat2D } from './geom';
export type { RGBA };

export type LayerKind = 'raster' | 'text' | 'shape' | 'fill' | 'adjustment';

export interface TextProps {
  text: string;
  font: string;
  size: number; // px
  weight: number; // 100..900
  italic: boolean;
  color: RGBA;
  align: 'left' | 'center' | 'right';
  lineHeight: number; // multiplier
  tracking: number; // px
  /** Top-left of the text box in document pixels (before `xform`). */
  x: number;
  y: number;
}

export type ShapeType = 'rect' | 'rounded' | 'ellipse' | 'line';

export interface ShapeProps {
  type: ShapeType;
  /** Box (or line from (x,y) to (x+w,y+h)) in document pixels (before `xform`). */
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
}

export interface DropShadowFx {
  enabled: boolean;
  color: RGBA;
  opacity: number; // 0..1
  angle: number; // degrees (light source direction, Photoshop convention)
  distance: number;
  size: number;
  spread: number; // 0..100
}
export interface OuterGlowFx {
  enabled: boolean;
  color: RGBA;
  opacity: number;
  size: number;
  spread: number;
}
export interface StrokeFx {
  enabled: boolean;
  color: RGBA;
  opacity: number;
  size: number;
  position: 'outside' | 'inside' | 'center';
}
export interface LayerStyle {
  dropShadow?: DropShadowFx;
  outerGlow?: OuterGlowFx;
  stroke?: StrokeFx;
}

export interface LayerMask {
  /** Grayscale mask (R=G=B, A=255); white reveals. */
  surf: Surface;
  /** Position of the mask canvas in document pixels. */
  x: number;
  y: number;
  /** Value outside the mask canvas. */
  defaultColor: 0 | 255;
  enabled: boolean;
  linked: boolean;
  density: number; // 0..1
  feather: number; // px (applied at composite time)
}

// ---------------------------------------------------------------------------------------------
// Adjustments (non-destructive layers + destructive Image ▸ Adjustments share these params)

export interface LevelsChannel {
  inBlack: number; // 0..255
  inWhite: number;
  gamma: number; // 0.1..9.99
  outBlack: number;
  outWhite: number;
}

export type AdjustParams =
  | { type: 'brightness'; brightness: number; contrast: number; legacy: boolean }
  | { type: 'levels'; rgb: LevelsChannel; r: LevelsChannel; g: LevelsChannel; b: LevelsChannel }
  | { type: 'curves'; rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] }
  | { type: 'exposure'; exposure: number; offset: number; gamma: number }
  | { type: 'hueSat'; hue: number; saturation: number; lightness: number; colorize: boolean }
  | { type: 'colorBalance'; shadows: [number, number, number]; midtones: [number, number, number]; highlights: [number, number, number]; preserveLum: boolean }
  | { type: 'vibrance'; vibrance: number; saturation: number }
  | { type: 'bw'; reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tintColor: RGBA }
  | { type: 'photoFilter'; color: RGBA; density: number; preserveLum: boolean }
  | { type: 'invert' }
  | { type: 'posterize'; levels: number }
  | { type: 'threshold'; level: number }
  | { type: 'gradientMap'; stops: GradientStop[]; reverse: boolean };

export type AdjustType = AdjustParams['type'];

export interface GradientStop {
  pos: number; // 0..1
  color: RGBA;
}

// ---------------------------------------------------------------------------------------------

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number; // 0..1
  fillOpacity: number; // 0..1
  blendMode: BlendMode;
  lockTransparency: boolean;
  lockPixels: boolean;
  lockPosition: boolean;
  lockAll: boolean;
  /** Clipped to the nearest non-clipped layer below. */
  clip: boolean;
  /** Pixels (raster) or rasterisation (text/shape). null for fill/adjustment layers. */
  surf: Surface | null;
  /** Position of `surf` in the document. */
  x: number;
  y: number;
  mask: LayerMask | null;
  style: LayerStyle | null;
  /** Extra transform for text/shape layers (free transform keeps them editable). */
  xform: Mat2D | null;
  text?: TextProps;
  shape?: ShapeProps;
  fillColor?: RGBA;
  adjust?: AdjustParams;
  /** Content version — bumped (from a global counter) whenever anything about the layer changes. */
  v: number;
}

export interface ViewState {
  x: number;
  y: number;
  scale: number;
}
