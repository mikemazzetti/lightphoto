import { create } from 'zustand';
import type { BlendMode } from '@/core/gl/glsl';
import { api } from '@/platform/api';
import type { RGBA } from '@/core/util/color';
import type { Doc } from './doc';
import type { SelectionMode } from './selection';
import type { GradientStop, ShapeType } from './types';

export type ToolId =
  | 'move'
  | 'marqueeRect'
  | 'marqueeEllipse'
  | 'lasso'
  | 'lassoPoly'
  | 'wand'
  | 'crop'
  | 'eyedropper'
  | 'spotHeal'
  | 'heal'
  | 'brush'
  | 'pencil'
  | 'clone'
  | 'eraser'
  | 'gradient'
  | 'bucket'
  | 'blur'
  | 'sharpen'
  | 'smudge'
  | 'dodge'
  | 'burn'
  | 'sponge'
  | 'text'
  | 'shapeRect'
  | 'shapeRounded'
  | 'shapeEllipse'
  | 'shapeLine'
  | 'hand'
  | 'zoom';

export interface ToolGroup {
  id: string;
  key: string;
  tools: ToolId[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'move', key: 'v', tools: ['move'] },
  { id: 'marquee', key: 'm', tools: ['marqueeRect', 'marqueeEllipse'] },
  { id: 'lasso', key: 'l', tools: ['lasso', 'lassoPoly'] },
  { id: 'wand', key: 'w', tools: ['wand'] },
  { id: 'crop', key: 'c', tools: ['crop'] },
  { id: 'eyedropper', key: 'i', tools: ['eyedropper'] },
  { id: 'heal', key: 'j', tools: ['spotHeal', 'heal'] },
  { id: 'brush', key: 'b', tools: ['brush', 'pencil'] },
  { id: 'stamp', key: 's', tools: ['clone'] },
  { id: 'eraser', key: 'e', tools: ['eraser'] },
  { id: 'gradient', key: 'g', tools: ['gradient', 'bucket'] },
  { id: 'blur', key: 'r', tools: ['blur', 'sharpen', 'smudge'] },
  { id: 'dodge', key: 'o', tools: ['dodge', 'burn', 'sponge'] },
  { id: 'text', key: 't', tools: ['text'] },
  { id: 'shape', key: 'u', tools: ['shapeRect', 'shapeRounded', 'shapeEllipse', 'shapeLine'] },
  { id: 'hand', key: 'h', tools: ['hand'] },
  { id: 'zoom', key: 'z', tools: ['zoom'] },
];

export const TOOL_LABELS: Record<ToolId, string> = {
  move: 'Move Tool',
  marqueeRect: 'Rectangular Marquee Tool',
  marqueeEllipse: 'Elliptical Marquee Tool',
  lasso: 'Lasso Tool',
  lassoPoly: 'Polygonal Lasso Tool',
  wand: 'Magic Wand Tool',
  crop: 'Crop Tool',
  eyedropper: 'Eyedropper Tool',
  spotHeal: 'Spot Healing Brush Tool',
  heal: 'Healing Brush Tool',
  brush: 'Brush Tool',
  pencil: 'Pencil Tool',
  clone: 'Clone Stamp Tool',
  eraser: 'Eraser Tool',
  gradient: 'Gradient Tool',
  bucket: 'Paint Bucket Tool',
  blur: 'Blur Tool',
  sharpen: 'Sharpen Tool',
  smudge: 'Smudge Tool',
  dodge: 'Dodge Tool',
  burn: 'Burn Tool',
  sponge: 'Sponge Tool',
  text: 'Horizontal Type Tool',
  shapeRect: 'Rectangle Tool',
  shapeRounded: 'Rounded Rectangle Tool',
  shapeEllipse: 'Ellipse Tool',
  shapeLine: 'Line Tool',
  hand: 'Hand Tool',
  zoom: 'Zoom Tool',
};

export const groupOf = (t: ToolId) => TOOL_GROUPS.find((g) => g.tools.includes(t))!;

// ---------------------------------------------------------------------------------------------
// Tool options

export interface BrushOpts {
  size: number;
  hardness: number; // 0..100
  opacity: number; // 0..100
  flow: number; // 0..100
  spacing: number; // % of size
  smoothing: number; // 0..100
  pressureSize: boolean;
  pressureOpacity: boolean;
  blend: BlendMode;
}

export interface CloneOpts extends BrushOpts {
  aligned: boolean;
  sampleAll: boolean;
}

export interface HealOpts {
  size: number;
  hardness: number;
  spacing: number;
  aligned: boolean;
  sampleAll: boolean;
}

export interface RetouchOpts {
  size: number;
  hardness: number;
  strength: number; // 0..100 (blur/sharpen/smudge) or exposure (dodge/burn) or flow (sponge)
  spacing: number;
  sampleAll: boolean;
  range: 'shadows' | 'midtones' | 'highlights';
  spongeMode: 'saturate' | 'desaturate';
  protectTones: boolean;
}

export interface SelectOpts {
  mode: SelectionMode;
  feather: number;
  antialias: boolean;
  style: 'normal' | 'ratio' | 'size';
  ratioW: number;
  ratioH: number;
}

export interface WandOpts {
  mode: SelectionMode;
  tolerance: number;
  contiguous: boolean;
  sampleAll: boolean;
  antialias: boolean;
}

export interface GradientOpts {
  type: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  preset: 'fgbg' | 'fgtrans' | 'bw' | 'custom';
  custom: GradientStop[];
  opacity: number;
  reverse: boolean;
  dither: boolean;
  blend: BlendMode;
}

export interface BucketOpts {
  source: 'fg' | 'bg';
  opacity: number;
  tolerance: number;
  contiguous: boolean;
  sampleAll: boolean;
  antialias: boolean;
  blend: BlendMode;
}

export interface TextOpts {
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  tracking: number;
}

export interface ShapeOpts {
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
  radius: number;
  lineWidth: number;
}

export interface CropOpts {
  ratio: 'free' | 'original' | '1:1' | '4:3' | '3:2' | '16:9' | '5:4' | '4:5' | '2:3';
  deletePixels: boolean;
}

export interface ToolOptions {
  brush: BrushOpts;
  pencil: BrushOpts;
  eraser: BrushOpts & { eraserMode: 'brush' | 'pencil' };
  clone: CloneOpts;
  heal: HealOpts;
  retouch: Record<'blur' | 'sharpen' | 'smudge' | 'dodge' | 'burn' | 'sponge', RetouchOpts>;
  marquee: SelectOpts;
  lasso: SelectOpts;
  wand: WandOpts;
  gradient: GradientOpts;
  bucket: BucketOpts;
  text: TextOpts;
  shape: ShapeOpts;
  crop: CropOpts;
  move: { autoSelect: boolean };
  eyedropper: { sampleSize: 1 | 3 | 5 | 11; sampleAll: boolean };
}

const brushDefaults = (size: number, hardness: number): BrushOpts => ({
  size,
  hardness,
  opacity: 100,
  flow: 100,
  spacing: 12,
  smoothing: 10,
  pressureSize: true,
  pressureOpacity: false,
  blend: 'normal',
});

const retouchDefaults = (strength: number): RetouchOpts => ({
  size: 60,
  hardness: 0,
  strength,
  spacing: 15,
  sampleAll: false,
  range: 'midtones',
  spongeMode: 'desaturate',
  protectTones: true,
});

export function defaultToolOptions(): ToolOptions {
  return {
    brush: brushDefaults(30, 50),
    pencil: { ...brushDefaults(4, 100), smoothing: 0, pressureSize: false, spacing: 5 },
    eraser: { ...brushDefaults(60, 50), eraserMode: 'brush' },
    clone: { ...brushDefaults(80, 30), aligned: true, sampleAll: false },
    heal: { size: 40, hardness: 70, spacing: 15, aligned: true, sampleAll: false },
    retouch: {
      blur: retouchDefaults(50),
      sharpen: retouchDefaults(50),
      smudge: retouchDefaults(50),
      dodge: retouchDefaults(30),
      burn: retouchDefaults(30),
      sponge: retouchDefaults(50),
    },
    marquee: { mode: 'new', feather: 0, antialias: true, style: 'normal', ratioW: 1, ratioH: 1 },
    lasso: { mode: 'new', feather: 0, antialias: true, style: 'normal', ratioW: 1, ratioH: 1 },
    wand: { mode: 'new', tolerance: 32, contiguous: true, sampleAll: false, antialias: true },
    gradient: {
      type: 'linear',
      preset: 'fgbg',
      custom: [
        { pos: 0, color: { r: 255, g: 120, b: 0, a: 1 } },
        { pos: 1, color: { r: 40, g: 80, b: 255, a: 1 } },
      ],
      opacity: 100,
      reverse: false,
      dither: true,
      blend: 'normal',
    },
    bucket: { source: 'fg', opacity: 100, tolerance: 32, contiguous: true, sampleAll: false, antialias: true, blend: 'normal' },
    text: { font: 'Helvetica', size: 48, weight: 400, italic: false, align: 'left', lineHeight: 1.2, tracking: 0 },
    shape: { fill: { r: 61, g: 139, b: 253, a: 1 }, stroke: null, strokeWidth: 4, radius: 24, lineWidth: 6 },
    crop: { ratio: 'free', deletePixels: true },
    move: { autoSelect: false },
    eyedropper: { sampleSize: 1, sampleAll: true },
  };
}

export const DEFAULT_SWATCHES = [
  '#000000', '#ffffff', '#808080', '#c0c0c0', '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ff80', '#00ffff', '#0080ff',
  '#0000ff', '#8000ff', '#ff00ff', '#ff0080', '#7f1d1d', '#9a3412', '#a16207', '#3f6212', '#166534', '#115e59', '#1e3a8a', '#581c87',
  '#f5d0c5', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#f1c27d', '#2d1e12', '#4a2c1a',
];

// ---------------------------------------------------------------------------------------------

export interface EditorState {
  docs: Doc[];
  activeId: string | null;
  /** Bumped whenever document structure changes (layers, history, selection) — panels subscribe. */
  rev: number;
  tool: ToolId;
  /** Last used tool in each group (what the toolbox shows). */
  groupTool: Record<string, ToolId>;
  fg: RGBA;
  bg: RGBA;
  opts: ToolOptions;
  swatches: string[];
  showGrid: boolean;
  showRulers: boolean;
  /** A live-preview dialog is open: tools are disabled, pan/zoom still work. */
  modal: boolean;
  /** Tool-specific transient UI (e.g. "transforming", "editing text", "cropping"). */
  session: null | 'transform' | 'text' | 'crop';
  /** While a dialog wants colour samples from the canvas (Color Range…). */
  canvasPick: ((x: number, y: number, mods: { shift: boolean; alt: boolean }) => void) | null;
}

export const useEditor = create<EditorState>(() => ({
  docs: [],
  activeId: null,
  rev: 0,
  tool: 'brush',
  groupTool: Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.tools[0]])),
  fg: { r: 0, g: 0, b: 0, a: 1 },
  bg: { r: 255, g: 255, b: 255, a: 1 },
  opts: defaultToolOptions(),
  swatches: DEFAULT_SWATCHES,
  showGrid: true,
  showRulers: false,
  modal: false,
  session: null,
  canvasPick: null,
}));

export const edState = () => useEditor.getState();

/** Re-renders panels that depend on document structure. */
export function touch() {
  useEditor.setState((s) => ({ rev: s.rev + 1 }));
  syncDirty();
}

export function activeDoc(): Doc | null {
  const s = useEditor.getState();
  return s.docs.find((d) => d.id === s.activeId) ?? null;
}

export function useActiveDoc(): Doc | null {
  const docs = useEditor((s) => s.docs);
  const id = useEditor((s) => s.activeId);
  useEditor((s) => s.rev);
  return docs.find((d) => d.id === id) ?? null;
}

export function setTool(tool: ToolId) {
  const g = groupOf(tool);
  useEditor.setState((s) => ({ tool, groupTool: { ...s.groupTool, [g.id]: tool } }));
}

export function setOpts<K extends keyof ToolOptions>(key: K, patch: Partial<ToolOptions[K]>) {
  useEditor.setState((s) => ({ opts: { ...s.opts, [key]: { ...s.opts[key], ...patch } } }));
  schedulePersist();
}

export function setRetouchOpts(tool: keyof ToolOptions['retouch'], patch: Partial<RetouchOpts>) {
  useEditor.setState((s) => ({ opts: { ...s.opts, retouch: { ...s.opts.retouch, [tool]: { ...s.opts.retouch[tool], ...patch } } } }));
  schedulePersist();
}

export function setFg(fg: RGBA) {
  useEditor.setState({ fg: { ...fg, a: 1 } });
}
export function setBg(bg: RGBA) {
  useEditor.setState({ bg: { ...bg, a: 1 } });
}

let lastDirty: boolean | null = null;
export function syncDirty() {
  const d = useEditor.getState().docs.some((x) => x.dirty);
  if (d !== lastDirty) {
    lastDirty = d;
    api.setDirty(d);
  }
}

// ---------------------------------------------------------------------------------------------
// Persist tool options + swatches

const PERSIST_KEY = 'editor:prefs';
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const s = useEditor.getState();
    void api.storeSet(PERSIST_KEY, { opts: s.opts, swatches: s.swatches, showGrid: s.showGrid, fg: s.fg, bg: s.bg });
  }, 800);
}
export const persistPrefs = schedulePersist;

let loaded = false;
export async function loadPrefs() {
  if (loaded) return;
  loaded = true;
  try {
    const p = await api.storeGet<any>(PERSIST_KEY);
    if (!p) return;
    const def = defaultToolOptions();
    const opts: any = { ...def };
    for (const k of Object.keys(def) as (keyof ToolOptions)[]) {
      if (k === 'retouch') {
        opts.retouch = { ...def.retouch };
        for (const t of Object.keys(def.retouch) as (keyof ToolOptions['retouch'])[]) opts.retouch[t] = { ...def.retouch[t], ...(p.opts?.retouch?.[t] ?? {}) };
      } else opts[k] = { ...(def as any)[k], ...(p.opts?.[k] ?? {}) };
    }
    useEditor.setState({
      opts,
      swatches: Array.isArray(p.swatches) && p.swatches.length ? p.swatches : DEFAULT_SWATCHES,
      showGrid: p.showGrid ?? true,
      fg: p.fg ?? useEditor.getState().fg,
      bg: p.bg ?? useEditor.getState().bg,
    });
  } catch {
    /* ignore corrupt prefs */
  }
}

export type { ShapeType };
