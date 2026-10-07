import type { BlendMode } from '@/core/gl/glsl';
import type { RenderTarget, Texture } from '@/core/gl/gl';
import { uid } from '@/core/util/async';
import { bus } from './bus';
import { Mat2D, Rect, rectInflate, rectIntersect, rectUnion, rectEmpty } from './geom';
import { Selection } from './selection';
import { nextSeq, Surface } from './surface';
import type { Layer, LayerMask, ViewState } from './types';

// ---------------------------------------------------------------------------------------------
// Layer helpers

const jsonClone = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/** Copies a layer's metadata (pixel surfaces are shared by reference). */
export function copyLayer(l: Layer): Layer {
  return {
    ...l,
    mask: l.mask ? { ...l.mask } : null,
    style: jsonClone(l.style),
    xform: l.xform ? ([...l.xform] as Mat2D) : null,
    text: jsonClone(l.text),
    shape: jsonClone(l.shape),
    fillColor: jsonClone(l.fillColor),
    adjust: jsonClone(l.adjust),
  };
}

export function baseLayer(kind: Layer['kind'], name: string): Layer {
  return {
    id: uid('L'),
    name,
    kind,
    visible: true,
    opacity: 1,
    fillOpacity: 1,
    blendMode: 'normal',
    lockTransparency: false,
    lockPixels: false,
    lockPosition: false,
    lockAll: false,
    clip: false,
    surf: null,
    x: 0,
    y: 0,
    mask: null,
    style: null,
    xform: null,
    v: nextSeq(),
  };
}

export function rasterLayer(name: string, surf: Surface, x = 0, y = 0): Layer {
  const l = baseLayer('raster', name);
  l.surf = surf;
  l.x = x;
  l.y = y;
  return l;
}

/** Document-space rect covered by the layer's surface. */
export function layerRect(l: Layer): Rect | null {
  return l.surf ? { x: l.x, y: l.y, w: l.surf.width, h: l.surf.height } : null;
}

export function maskRect(m: LayerMask): Rect {
  return { x: m.x, y: m.y, w: m.surf.width, h: m.surf.height };
}

/**
 * How far (px) a pixel change on the layer can show up once mask feather and layer effects are
 * applied (mirrors featheredMask's blur and renderFx's padding).
 */
function changeReach(l: Layer): number {
  let d = 0;
  const s = l.style;
  if (s?.dropShadow?.enabled) d = Math.max(d, s.dropShadow.distance + s.dropShadow.size * 1.5 + 2);
  if (s?.outerGlow?.enabled) d = Math.max(d, s.outerGlow.size * 1.5 + 2);
  if (s?.stroke?.enabled) d = Math.max(d, s.stroke.size + 2);
  if (l.mask?.enabled && l.mask.feather > 0.3) d = Math.max(d, l.mask.feather * 1.5 + 2);
  return Math.ceil(d);
}

export const isPixelLayer = (l: Layer) => l.kind === 'raster';
export const hasPixels = (l: Layer) => !!l.surf;

// ---------------------------------------------------------------------------------------------
// History

export interface DocSnapshot {
  width: number;
  height: number;
  layers: Layer[];
  activeLayerId: string;
  selection: Selection | null;
  editMask: boolean;
}

/** Region of a surface. Swap semantics: holds the "other" state; applying swaps it with the current pixels. */
export interface PixelPatch {
  surf: Surface;
  x: number;
  y: number;
  data: ImageData;
}

export interface Step {
  label: string;
  before?: DocSnapshot;
  after?: DocSnapshot;
  patches: PixelPatch[];
  bytes: number;
  time: number;
  mergeKey?: string;
  /** Identifies the state after this step (changes when a merge alters it). */
  id: number;
}

export const HISTORY_LIMIT = 50;
export const HISTORY_BUDGET = 1.5 * 1024 * 1024 * 1024;

function swapPatch(p: PixelPatch) {
  const r = { x: p.x, y: p.y, w: p.data.width, h: p.data.height };
  const cur = p.surf.ctx.getImageData(r.x, r.y, r.w, r.h);
  p.surf.ctx.putImageData(p.data, r.x, r.y);
  p.data = cur;
  p.surf.touch(r);
}

/** Captures the region `r` (surface coordinates, clipped) as a patch holding the *current* pixels. */
export function capturePatch(surf: Surface, r: Rect): PixelPatch | null {
  const c = rectIntersect(r, { x: 0, y: 0, w: surf.width, h: surf.height });
  if (!c) return null;
  return { surf, x: c.x, y: c.y, data: surf.ctx.getImageData(c.x, c.y, c.w, c.h) };
}

function surfacesOf(s: DocSnapshot | undefined, out: Set<Surface>) {
  if (!s) return out;
  for (const l of s.layers) {
    if (l.surf) out.add(l.surf);
    if (l.mask) out.add(l.mask.surf);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Live editing state read by the compositor

export interface LiveStroke {
  surf: Surface; // document-sized stroke buffer
  layerId: string;
  target: 'pixels' | 'mask';
  mode: 'paint' | 'erase';
  opacity: number;
  blend: BlendMode;
  lockAlpha: boolean;
  clipToSelection: boolean;
}

export interface PreviewProcess {
  key: string;
  /** Takes the layer (or mask) texture and returns a processed texture of the same size. */
  run: (src: Texture | RenderTarget, layer: Layer) => Texture | RenderTarget;
}

export interface LayerPreview {
  layerId: string;
  hide?: boolean;
  /** Surface → document transform override (free transform preview). */
  matrix?: Mat2D;
  /** Pixel-processing preview (filters, adjustments, gradient). */
  process?: PreviewProcess;
  /** Same for the layer mask. */
  maskProcess?: PreviewProcess;
  /** Transformed floating pixels drawn right above the layer (moving / transforming a selection). */
  floating?: { surf: Surface; matrix: Mat2D };
}

let docSeq = 1;

export class Doc {
  readonly id = `doc${docSeq++}`;
  name: string;
  path?: string;
  width: number;
  height: number;
  layers: Layer[] = [];
  activeLayerId = '';
  /** Paint/edit the active layer's mask instead of its pixels. */
  editMask = false;
  selection: Selection | null = null;
  lastSelection: Selection | null = null;

  steps: Step[] = [];
  /** Number of applied steps (0 = the opened state). */
  index = 0;
  savedIndex = 0;
  /** Steps dropped from the start of the list (keeps savedIndex meaningful). */
  initialLabel = 'Open';
  private baseline: DocSnapshot | null = null;
  private stateSeq = 0;
  /** State id of index 0 (changes when old steps are dropped). */
  private baseState = 0;

  view: ViewState = { x: 0, y: 0, scale: 1 };
  fitted = true;

  // render invalidation
  renderVersion = 1;
  dirtyRect: Rect | null = null;
  dirtyAll = true;

  preview: LayerPreview | null = null;
  stroke: LiveStroke | null = null;
  private _strokeSurf: Surface | null = null;

  onSaveBack?: (canvas: HTMLCanvasElement | OffscreenCanvas) => void;

  constructor(name: string, width: number, height: number) {
    this.name = name;
    this.width = width;
    this.height = height;
  }

  get dirty() {
    return this.index !== this.savedIndex;
  }

  get activeLayer(): Layer | null {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? this.layers[this.layers.length - 1] ?? null;
  }

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  indexOf(id: string) {
    return this.layers.findIndex((l) => l.id === id);
  }

  /** Document-sized scratch surface used for live brush strokes. */
  get strokeSurf(): Surface {
    if (!this._strokeSurf || this._strokeSurf.width !== this.width || this._strokeSurf.height !== this.height) {
      this._strokeSurf = new Surface(this.width, this.height);
    }
    return this._strokeSurf;
  }

  // ------------------------------------------------------------------------------------------
  // Invalidation

  /** Marks a document-space region (or everything) for re-compositing and schedules a frame. */
  invalidate(r?: Rect | null) {
    this.renderVersion++;
    if (!r) this.dirtyAll = true;
    else if (!this.dirtyAll) {
      const c = rectIntersect(r, { x: 0, y: 0, w: this.width, h: this.height });
      if (c) this.dirtyRect = rectUnion(this.dirtyRect, c);
    }
    bus.requestFrame();
  }

  /** Records that a layer changed (metadata or pixels) — `r` in document space. */
  touchLayer(l: Layer, r?: Rect | null) {
    l.v = nextSeq();
    this.invalidate(r ? rectInflate(r, changeReach(l)) : null);
  }

  // ------------------------------------------------------------------------------------------
  // Snapshots

  snapshot(): DocSnapshot {
    return {
      width: this.width,
      height: this.height,
      layers: this.layers.map(copyLayer),
      activeLayerId: this.activeLayerId,
      selection: this.selection,
      editMask: this.editMask,
    };
  }

  restore(s: DocSnapshot) {
    this.width = s.width;
    this.height = s.height;
    this.layers = s.layers.map((l) => {
      const c = copyLayer(l);
      c.v = nextSeq();
      return c;
    });
    this.activeLayerId = s.activeLayerId;
    this.selection = s.selection;
    this.editMask = s.editMask && !!this.activeLayer?.mask;
    this.preview = null;
    this.stroke = null;
    this.invalidate();
  }

  /** Call once after the document is fully built (sets the undo baseline). */
  resetHistory(label = 'Open') {
    this.steps = [];
    this.index = 0;
    this.savedIndex = 0;
    this.initialLabel = label;
    this.baseState = ++this.stateSeq;
    this.baseline = this.snapshot();
  }

  // ------------------------------------------------------------------------------------------
  // Recording

  /**
   * Records an undoable step. Structural steps (default) store the before/after metadata
   * snapshots; pass `structural: false` for pure pixel edits (patches only).
   * `mergeKey` coalesces with the previous step if it has the same key (nudges, sliders).
   */
  commit(label: string, opts: { patches?: (PixelPatch | null)[]; structural?: boolean; mergeKey?: string } = {}) {
    const patches = (opts.patches ?? []).filter((p): p is PixelPatch => !!p);
    const structural = opts.structural ?? true;
    const after = structural ? this.snapshot() : undefined;
    const before = structural ? (this.baseline ?? after) : undefined;
    // Drop the redo branch.
    if (this.index < this.steps.length) {
      this.steps.length = this.index;
      if (this.savedIndex > this.index) this.savedIndex = -1;
    }
    const top = this.steps[this.steps.length - 1];
    if (opts.mergeKey && top && top.mergeKey === opts.mergeKey && this.index === this.steps.length && this.savedIndex !== this.index) {
      top.after = after ?? top.after;
      if (!top.before && before) top.before = before;
      top.patches.push(...patches);
      top.time = Date.now();
      top.bytes = this.stepBytes(top);
      top.id = ++this.stateSeq;
    } else {
      const step: Step = { label, before, after, patches, bytes: 0, time: Date.now(), mergeKey: opts.mergeKey, id: ++this.stateSeq };
      step.bytes = this.stepBytes(step);
      this.steps.push(step);
      this.index = this.steps.length;
      this.enforceLimits();
    }
    if (structural) this.baseline = after!;
    this.releaseOldSelectionCanvases();
    bus.requestFrame();
  }

  private stepBytes(s: Step): number {
    let bytes = 0;
    for (const p of s.patches) bytes += p.data.data.byteLength;
    if (s.before && s.after) {
      const a = surfacesOf(s.before, new Set());
      const b = surfacesOf(s.after, new Set());
      for (const x of a) if (!b.has(x)) bytes += x.bytes;
      for (const x of b) if (!a.has(x)) bytes += x.bytes;
      if (s.before.selection !== s.after.selection) bytes += (s.before.selection?.bytes ?? 0) + (s.after.selection?.bytes ?? 0);
    }
    return bytes + 512;
  }

  private enforceLimits() {
    let total = this.steps.reduce((a, s) => a + s.bytes, 0);
    while (this.steps.length > 1 && (this.steps.length > HISTORY_LIMIT || total > HISTORY_BUDGET)) {
      const s = this.steps.shift()!;
      total -= s.bytes;
      this.index--;
      this.savedIndex--;
      this.initialLabel = s.label;
      this.baseState = s.id;
    }
  }

  private releaseOldSelectionCanvases() {
    const s = this.steps[this.steps.length - 1];
    if (s?.before?.selection && s.before.selection !== this.selection) s.before.selection.releaseCanvas();
  }

  // ------------------------------------------------------------------------------------------
  // Undo / redo

  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.steps.length;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const s = this.steps[this.index - 1];
    for (let i = s.patches.length - 1; i >= 0; i--) swapPatch(s.patches[i]);
    if (s.before) this.restore(s.before);
    else this.invalidate();
    this.index--;
    this.baseline = this.snapshot();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const s = this.steps[this.index];
    if (s.after) this.restore(s.after);
    for (const p of s.patches) swapPatch(p);
    if (!s.after) this.invalidate();
    this.index++;
    this.baseline = this.snapshot();
    return true;
  }

  goto(i: number) {
    i = Math.max(0, Math.min(this.steps.length, i));
    while (this.index > i) this.undo();
    while (this.index < i) this.redo();
  }

  /** Identifies the current history state (stable while older steps are dropped). */
  get historyState(): number {
    return this.index ? this.steps[this.index - 1].id : this.baseState;
  }

  /** Marks a state as saved — pass `historyState` read before an async write. */
  markSaved(state = this.historyState) {
    if (state === this.baseState) this.savedIndex = 0;
    else {
      const i = this.steps.findIndex((s) => s.id === state);
      this.savedIndex = i < 0 ? -1 : i + 1;
    }
  }

  /** Bytes held by the document's layers (for the status bar). */
  get layerBytes() {
    let b = 0;
    for (const l of this.layers) {
      if (l.surf) b += l.surf.bytes;
      if (l.mask) b += l.mask.surf.bytes;
    }
    return b;
  }

  get historyBytes() {
    return this.steps.reduce((a, s) => a + s.bytes, 0);
  }
}

export function hasSelection(doc: Doc): boolean {
  return !!doc.selection && !rectEmpty(doc.selection.bounds);
}
