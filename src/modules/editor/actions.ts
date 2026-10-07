import { toast } from '@/state/app';
import { promptDialog } from '@/ui/overlays';
import type { Doc } from './model/doc';
import { activeDoc, edState, groupOf, setBg, setFg, setOpts, setRetouchOpts, setTool, ToolId, TOOL_GROUPS, touch, useEditor } from './model/store';
import type { AdjustType } from './model/types';
import { ADJUST_NAMES, autoLevels, defaultAdjust } from './render/adjustments';
import { FILTERS, FilterDef } from './render/filters';
import { closeDoc } from './ops/docs';
import { clearSelection, copyPixels, fillArea, flipOrRotateLayer, moveSelectedPixels, nudgeLayer, nudgeSelection } from './ops/edit';
import { pasteFromSystem } from './io/clipboard';
import { cropToSelection, rotateCanvas, trimTransparent } from './ops/image';
import {
  addMask,
  applyMask,
  arrangeLayer,
  deleteLayer,
  deleteMask,
  duplicateLayer,
  flattenImage,
  layerViaCopy,
  MaskMode,
  mergeDown,
  mergeVisible,
  newAdjustmentLayer,
  newFillLayer,
  newLayer,
  pixelTarget,
  rasterizeLayer,
  renameLayer,
  toggleClip,
  toggleMaskEnabled,
  toggleMaskLink,
} from './ops/layers';
import { adjustProcess, applyAdjustmentNow, applyProcess } from './ops/process';
import { deselect, inverseSelection, reselect, selectAll, selectionFromLayer } from './ops/select';
import { getTool } from './tools';
import { cancelTransform, commitTransform, startTransform, transformActive } from './tools/transform';
import { cancelTextEdit, commitTextEdit, textEditing } from './tools/text';
import { brushOptsKey } from './tools/paint';
import { commitCrop } from './tools/crop';
import { viewCommands } from './ui/CanvasView';
import { newDocDialog, imageSizeDialog, canvasSizeDialog, exportDialog } from './ui/dialogs/docDialogs';
import { fillDialog, strokeDialog, modifySelectionDialog } from './ui/dialogs/editDialogs';
import { adjustDialog, samplePixelsOf } from './ui/dialogs/AdjustDialog';
import { filterDialog, repeatLastFilter } from './ui/dialogs/FilterDialog';
import { cameraRawDialog } from './ui/dialogs/CameraRawDialog';
import { colorRangeDialog } from './ui/dialogs/ColorRangeDialog';
import { FxKey, layerStyleDialog } from './ui/dialogs/LayerStyleDialog';
import { openDialog as openFilesDialog, placeDialog, saveBack, saveDoc } from './io/files';
import { viewportSize } from './ops/docs';

/** Finishes interactive sessions (transform, text) before running another command. */
export function settleSessions(commitThem = true) {
  if (transformActive()) (commitThem ? commitTransform : cancelTransform)();
  if (textEditing()) commitTextEdit();
}

/**
 * Gets ready to move through history: open transform / type sessions are cancelled (committing
 * them would drop the redo branch). False while a dialog is open or a tool drag is in progress.
 */
export function readyForHistory(): boolean {
  if (useEditor.getState().modal || getTool(edState().tool).busy?.()) return false;
  if (transformActive()) cancelTransform();
  if (textEditing()) cancelTextEdit();
  return true;
}

/** Undo / Step Backward: cancelling an open session counts as the step. */
function stepBack(d: Doc) {
  const session = transformActive() || textEditing();
  if (readyForHistory() && !session) d.undo();
}

function stepAhead(d: Doc) {
  if (readyForHistory()) d.redo();
}

const D =
  <A extends unknown[]>(fn: (d: Doc, ...a: A) => unknown, settle = true) =>
  (...a: A) => {
    const d = activeDoc();
    if (!d) return;
    if (useEditor.getState().modal) return;
    if (settle) settleSessions();
    const r = fn(d, ...a);
    if (r instanceof Promise) r.catch((e) => toast(String(e?.message ?? e), 'error')).finally(() => touch());
    else touch();
  };

export function switchTool(id: ToolId) {
  const s = edState();
  if (s.tool === id) return;
  if (transformActive()) commitTransform();
  try {
    getTool(s.tool).deactivate?.(null);
  } catch {
    /* ignore */
  }
  setTool(id);
}

/** Tool shortcut: pressing the key again (or Shift+key) cycles the group's tools. */
export function toolKey(key: string, cycle: boolean) {
  const g = TOOL_GROUPS.find((x) => x.key === key);
  if (!g) return;
  const s = edState();
  const cur = s.groupTool[g.id] ?? g.tools[0];
  if (cycle && groupOf(s.tool).id === g.id) {
    const i = g.tools.indexOf(s.tool);
    switchTool(g.tools[(i + 1) % g.tools.length]);
  } else switchTool(cur);
}

// ---------------------------------------------------------------------------------------------

export const A = {
  // File
  newDoc: () => void newDocDialog(),
  open: () => void openFilesDialog(),
  place: () => void placeDialog(),
  save: D((d) => saveDoc(d)),
  saveAs: D((d) => saveDoc(d, true)),
  exportAs: D((d) => exportDialog(d)),
  close: D((d) => closeDoc(d.id)),
  saveBack: D((d) => saveBack(d)),

  // Edit
  undo: D(stepBack, false),
  redo: D(stepAhead, false),
  stepBackward: D(stepBack, false),
  stepForward: D(stepAhead, false),
  copy: D((d) => copyPixels(d, false)),
  copyMerged: D((d) => copyPixels(d, true)),
  cut: D((d) => copyPixels(d, false, true)),
  pasteInPlace: D(() => pasteFromSystem(true)),
  clear: D((d) => clearSelection(d)),
  fill: D((d) => fillDialog(d)),
  fillFg: D((d) => fillArea(d, edState().fg, { preserveTransparency: false })),
  fillBg: D((d) => fillArea(d, edState().bg, { preserveTransparency: false })),
  stroke: D((d) => strokeDialog(d)),
  freeTransform: D((d) => void startTransform(d), false),
  flipLayerH: D((d) => flipOrRotateLayer(d, 'flipH')),
  flipLayerV: D((d) => flipOrRotateLayer(d, 'flipV')),
  rotLayer90: D((d) => flipOrRotateLayer(d, 'rot90')),
  rotLayerCCW: D((d) => flipOrRotateLayer(d, 'rot-90')),
  rotLayer180: D((d) => flipOrRotateLayer(d, 'rot180')),

  // Image
  adjust: (t: AdjustType) => D((d) => adjustDialog(d, t))(),
  invert: D((d) => applyAdjustmentNow(d, { type: 'invert' }, 'Invert')),
  desaturate: D((d) => applyAdjustmentNow(d, { type: 'hueSat', hue: 0, saturation: -100, lightness: 0, colorize: false }, 'Desaturate')),
  auto: (mode: 'tone' | 'contrast' | 'color') =>
    D(async (d) => {
      const t = await pixelTarget(d);
      if (!t) return;
      const px = samplePixelsOf(t.surf, 1024);
      applyProcess(d, t, adjustProcess(autoLevels(px, mode)), mode === 'tone' ? 'Auto Tone' : mode === 'contrast' ? 'Auto Contrast' : 'Auto Color');
    })(),
  imageSize: D((d) => imageSizeDialog(d)),
  canvasSize: D((d) => canvasSizeDialog(d)),
  rotateCanvas: (op: Parameters<typeof rotateCanvas>[1]) => D((d) => rotateCanvas(d, op))(),
  crop: D((d) => {
    if (edState().tool === 'crop') return commitCrop(d);
    cropToSelection(d);
  }),
  trim: D((d) => trimTransparent(d)),

  // Layer
  newLayer: D((d) => void newLayer(d)),
  layerViaCopy: D((d) => layerViaCopy(d)),
  layerViaCut: D((d) => layerViaCopy(d, true)),
  newFill: D((d) => void newFillLayer(d, edState().fg)),
  newAdjustment: (t: AdjustType) => D((d) => void newAdjustmentLayer(d, t, defaultAdjust(t, edState().fg, edState().bg)))(),
  duplicate: D((d) => void duplicateLayer(d)),
  deleteLayer: D((d) => deleteLayer(d)),
  rename: D(async (d) => {
    const l = d.activeLayer;
    if (!l) return;
    const name = await promptDialog('Rename Layer', l.name, { label: 'Name' });
    if (name) renameLayer(d, l.id, name);
  }),
  mask: (m: MaskMode) => D((d) => addMask(d, m))(),
  applyMask: D((d) => applyMask(d)),
  deleteMask: D((d) => deleteMask(d)),
  toggleMask: D((d) => toggleMaskEnabled(d)),
  linkMask: D((d) => toggleMaskLink(d)),
  clip: D((d) => toggleClip(d)),
  arrange: (how: Parameters<typeof arrangeLayer>[1]) => D((d) => arrangeLayer(d, how))(),
  mergeDown: D((d) => mergeDown(d)),
  mergeVisible: D((d) => mergeVisible(d)),
  flatten: D((d) => flattenImage(d)),
  rasterize: D((d) => {
    if (!rasterizeLayer(d)) toast('This layer cannot be rasterized.', 'info');
  }),
  layerStyle: (k: FxKey) => D((d) => layerStyleDialog(d, k))(),
  clearStyle: D((d) => {
    const l = d.activeLayer;
    if (!l?.style) return;
    l.style = null;
    d.touchLayer(l);
    d.commit('Clear Layer Style');
  }),

  // Select
  selectAll: D((d) => selectAll(d)),
  deselect: D((d) => deselect(d)),
  reselect: D((d) => reselect(d)),
  inverse: D((d) => inverseSelection(d)),
  colorRange: D((d) => colorRangeDialog(d)),
  modify: (k: Parameters<typeof modifySelectionDialog>[1]) => D((d) => modifySelectionDialog(d, k))(),
  loadTransparency: D((d) => selectionFromLayer(d)),

  // Filter
  filter: (f: FilterDef) => D((d) => filterDialog(d, f))(),
  lastFilter: D((d) => repeatLastFilter(d)),
  cameraRaw: D((d) => cameraRawDialog(d)),

  // View
  zoomIn: () => viewCommands.zoomIn(),
  zoomOut: () => viewCommands.zoomOut(),
  fit: () => viewCommands.fit(),
  actual: () => viewCommands.actual(),
  toggleGrid: () => useEditor.setState((s) => ({ showGrid: !s.showGrid })),

  // Colours
  swapColors: () => {
    const s = edState();
    useEditor.setState({ fg: s.bg, bg: s.fg });
  },
  resetColors: () => {
    setFg({ r: 0, g: 0, b: 0, a: 1 });
    setBg({ r: 255, g: 255, b: 255, a: 1 });
  },
};

// ---------------------------------------------------------------------------------------------
// Brush size / hardness / opacity keys

export function adjustBrush(kind: 'size' | 'hardness', dir: 1 | -1) {
  const s = edState();
  const k = brushOptsKey(s.tool);
  if (!k) return false;
  const cur = k.key === 'retouch' ? s.opts.retouch[k.retouch] : s.opts[k.key];
  if (kind === 'size') {
    const v = cur.size;
    const step = v < 10 ? 1 : v < 50 ? 5 : v < 100 ? 10 : v < 300 ? 25 : 50;
    const next = Math.max(1, Math.min(5000, Math.round(v + dir * step)));
    if (k.key === 'retouch') setRetouchOpts(k.retouch, { size: next });
    else setOpts(k.key, { size: next } as never);
  } else {
    const next = Math.max(0, Math.min(100, cur.hardness + dir * 25));
    if (k.key === 'retouch') setRetouchOpts(k.retouch, { hardness: next });
    else setOpts(k.key, { hardness: next } as never);
  }
  return true;
}

/** 1 = 10% … 0 = 100% (tool opacity for painting tools, layer opacity otherwise). */
export function numberKey(n: number) {
  const pct = n === 0 ? 100 : n * 10;
  const s = edState();
  const t = s.tool;
  if (t === 'brush' || t === 'pencil' || t === 'eraser' || t === 'clone') return setOpts(t, { opacity: pct });
  if (t === 'gradient') return setOpts('gradient', { opacity: pct });
  if (t === 'bucket') return setOpts('bucket', { opacity: pct });
  if (t === 'blur' || t === 'sharpen' || t === 'smudge' || t === 'dodge' || t === 'burn' || t === 'sponge') return setRetouchOpts(t, { strength: pct });
  const d = activeDoc();
  const l = d?.activeLayer;
  if (d && l) {
    l.opacity = pct / 100;
    d.touchLayer(l);
    d.commit('Opacity Change', { mergeKey: `opacity:${l.id}` });
    touch();
  }
}

export function arrowKey(dx: number, dy: number) {
  const d = activeDoc();
  if (!d || useEditor.getState().modal) return false;
  const t = edState().tool;
  if (transformActive()) return false;
  if (t === 'move') {
    if (d.selection && d.activeLayer?.kind === 'raster' && !d.editMask) void moveSelectedPixels(d, dx, dy);
    else nudgeLayer(d, dx, dy);
    touch();
    return true;
  }
  if ((t === 'marqueeRect' || t === 'marqueeEllipse' || t === 'lasso' || t === 'lassoPoly' || t === 'wand') && d.selection) {
    nudgeSelection(d, dx, dy);
    touch();
    return true;
  }
  return false;
}

export { ADJUST_NAMES, FILTERS };
