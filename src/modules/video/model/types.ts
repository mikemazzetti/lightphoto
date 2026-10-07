/**
 * Video project data model. Everything here is plain JSON (persisted in .lpv files, autosaved,
 * snapshotted for undo). Treat all objects as IMMUTABLE: edits create new objects/arrays so undo
 * snapshots share unchanged structure.
 *
 * Time units
 *  - Timeline positions (clip.start, clip.duration, fades, transitions, keyframes, markers, in/out)
 *    are integer frames at the sequence frame rate.
 *  - Source positions (clip.inPoint, media.duration, media marks) are seconds.
 */
import type { BlendMode } from '@/core/gl/glsl';
import type { DevelopSettings } from '@/core/develop/settings';

export type MediaKind = 'video' | 'audio' | 'image' | 'title' | 'matte' | 'adjustment';
export type TrackKind = 'video' | 'audio';

export interface TitleSpec {
  text: string;
  font: string;
  /** Font size in px for a 1080-line frame (scaled with the sequence height). */
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Anchor position of the text block, normalised 0..1 of the frame. */
  x: number;
  y: number;
  lineHeight: number;
  tracking: number;
  stroke: { on: boolean; color: string; width: number };
  shadow: { on: boolean; color: string; blur: number; dx: number; dy: number; opacity: number };
  box: { on: boolean; color: string; opacity: number; padding: number };
}

export interface MediaItem {
  id: string;
  kind: MediaKind;
  name: string;
  path?: string;
  /** Seconds. 0 for unbounded items (stills, titles, mattes, adjustment layers). */
  duration: number;
  width: number;
  height: number;
  /** Native frame rate (0 = unknown / still). */
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  size?: number;
  mtime?: number;
  /** Generated items. */
  title?: TitleSpec;
  color?: string;
  /** Source monitor In/Out marks (seconds). */
  markIn?: number | null;
  markOut?: number | null;
  missing?: boolean;
  /** Probe failed with mediabunny; metadata came from a <video> element. */
  probeFallback?: boolean;
}

export type TransitionType = 'crossDissolve' | 'dipToBlack' | 'dipToWhite' | 'wipe' | 'slide' | 'push';
export type TransitionAlign = 'center' | 'start' | 'end';
export interface Transition {
  type: TransitionType;
  /** Frames. */
  duration: number;
  align: TransitionAlign;
  /** Direction for wipe / slide / push: 0 = from left, 90 = from top, 180 = from right, 270 = from bottom. */
  direction: number;
}

export interface Keyframe {
  /** Frame relative to clip start. */
  t: number;
  v: number;
  /** Interpolation to the next keyframe. */
  ease?: 'linear' | 'hold' | 'ease';
}

export interface Motion {
  /** Offset of the anchor from the frame centre, in sequence pixels. */
  x: number;
  y: number;
  /** Percent. */
  scale: number;
  uniform: boolean;
  /** Width scale (percent) when non-uniform; `scale` is then the height. */
  scaleW: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** Anchor offset from the source centre, in source pixels. */
  anchorX: number;
  anchorY: number;
  /** Percent of source width/height cropped from each edge. */
  cropL: number;
  cropT: number;
  cropR: number;
  cropB: number;
}

export type FxType = 'blur' | 'sharpen' | 'bw' | 'invert' | 'tint' | 'mirror' | 'hflip' | 'vflip' | 'crop' | 'brightness' | 'posterize';

export interface Effect {
  id: string;
  type: FxType;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
}

export interface Lumetri {
  enabled: boolean;
  s: DevelopSettings;
  /** Creative › Faded Film, 0..100. */
  faded: number;
}

export interface Clip {
  id: string;
  mediaId: string;
  trackId: string;
  name: string;
  /** Frames. */
  start: number;
  duration: number;
  /** Seconds into the source. */
  inPoint: number;
  /** 1 = 100%. */
  speed: number;
  maintainPitch: boolean;
  enabled: boolean;
  /** Clips sharing a linkId move/trim/select together (V+A pairs). */
  linkId: string | null;
  /** Frames. */
  fadeIn: number;
  fadeOut: number;
  transIn: Transition | null;
  transOut: Transition | null;
  // video
  motion: Motion;
  /** 0..100. */
  opacity: number;
  blend: BlendMode;
  /** Scale to frame size (base scale that fits the source into the sequence frame). */
  fit: boolean;
  lumetri: Lumetri | null;
  fx: Effect[];
  title?: TitleSpec;
  color?: string;
  // audio
  /** dB. */
  volume: number;
  /** -100 (L) .. 100 (R). */
  pan: number;
  /** Animated parameters, keyed by param path (see keyframes.ts). */
  kf: Record<string, Keyframe[]>;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Video: output toggle (eye) off. */
  hidden: boolean;
  locked: boolean;
  muted: boolean;
  solo: boolean;
  syncLock: boolean;
  height: number;
  /** Track volume, dB (audio). */
  volume: number;
}

export interface Marker {
  id: string;
  frame: number;
  name: string;
  color: string;
  comment: string;
}

export interface Sequence {
  name: string;
  width: number;
  height: number;
  fps: number;
  bg: string;
  /** Video tracks (index 0 = V1, bottom) followed by audio tracks (A1, A2…); order within kind matters. */
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  inPoint: number | null;
  outPoint: number | null;
}

export interface Project {
  version: 1;
  name: string;
  media: MediaItem[];
  seq: Sequence;
}

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  crossDissolve: 'Cross Dissolve',
  dipToBlack: 'Dip to Black',
  dipToWhite: 'Dip to White',
  wipe: 'Wipe',
  slide: 'Slide',
  push: 'Push',
};

export const FX_LABELS: Record<FxType, string> = {
  blur: 'Gaussian Blur',
  sharpen: 'Sharpen',
  bw: 'Black & White',
  invert: 'Invert',
  tint: 'Tint',
  mirror: 'Mirror',
  hflip: 'Horizontal Flip',
  vflip: 'Vertical Flip',
  crop: 'Crop',
  brightness: 'Brightness & Contrast',
  posterize: 'Posterize',
};

export interface FxParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  suffix?: string;
}

/** Numeric parameters per effect (colors / booleans handled separately). */
export const FX_PARAMS: Record<FxType, FxParamDef[]> = {
  blur: [{ key: 'radius', label: 'Blurriness', min: 0, max: 200, step: 0.5, def: 10 }],
  sharpen: [{ key: 'amount', label: 'Amount', min: 0, max: 400, step: 1, def: 50 }],
  bw: [],
  invert: [{ key: 'mix', label: 'Blend', min: 0, max: 100, step: 1, def: 100, suffix: '%' }],
  tint: [{ key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, def: 100, suffix: '%' }],
  mirror: [
    { key: 'center', label: 'Center', min: 0, max: 100, step: 0.5, def: 50, suffix: '%' },
    { key: 'angle', label: 'Angle', min: 0, max: 360, step: 1, def: 0, suffix: '°' },
  ],
  hflip: [],
  vflip: [],
  crop: [
    { key: 'l', label: 'Left', min: 0, max: 100, step: 0.5, def: 0, suffix: '%' },
    { key: 't', label: 'Top', min: 0, max: 100, step: 0.5, def: 0, suffix: '%' },
    { key: 'r', label: 'Right', min: 0, max: 100, step: 0.5, def: 0, suffix: '%' },
    { key: 'b', label: 'Bottom', min: 0, max: 100, step: 0.5, def: 0, suffix: '%' },
    { key: 'feather', label: 'Edge Feather', min: 0, max: 200, step: 1, def: 0, suffix: 'px' },
  ],
  brightness: [
    { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, def: 0 },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, def: 0 },
  ],
  posterize: [{ key: 'levels', label: 'Level', min: 2, max: 32, step: 1, def: 6 }],
};

export const FX_TYPES = Object.keys(FX_LABELS) as FxType[];
