import type { MenuItem } from '@/state/app';
import { shortcutLabel } from '@/app/commands';
import { A } from '../actions';
import { activeDoc, edState } from '../model/store';
import { ADJUST_TYPES } from '../render/adjustments';
import { FILTER_GROUPS, FILTERS } from '../render/filters';
import { canRasterize } from '../ops/layers';
import { pasteFromSystem } from '../io/clipboard';
import { lastFilter } from './dialogs/FilterDialog';

const k = (combo: string) => shortcutLabel(combo);

export function fileMenu(): MenuItem[] {
  const d = activeDoc();
  return [
    { label: 'New…', shortcut: k('mod+n'), onClick: A.newDoc },
    { label: 'Open…', shortcut: k('mod+o'), onClick: A.open },
    { label: 'Place Embedded…', onClick: A.place, disabled: !d },
    { separator: true },
    { label: 'Close', onClick: A.close, disabled: !d },
    { label: 'Save', shortcut: k('mod+s'), onClick: A.save, disabled: !d },
    { label: 'Save As…', shortcut: k('shift+mod+s'), onClick: A.saveAs, disabled: !d },
    ...(d?.onSaveBack ? [{ label: 'Save Back to Source', onClick: A.saveBack }] : []),
    { separator: true },
    { label: 'Export As…', shortcut: k('shift+mod+e'), onClick: A.exportAs, disabled: !d },
  ];
}

export function editMenu(): MenuItem[] {
  const d = activeDoc();
  const sel = !!d?.selection;
  const undoLabel = d && d.canUndo ? `Undo ${d.steps[d.index - 1]?.label ?? ''}` : 'Undo';
  const redoLabel = d && d.canRedo ? `Redo ${d.steps[d.index]?.label ?? ''}` : 'Redo';
  return [
    { label: undoLabel, shortcut: k('mod+z'), onClick: A.undo, disabled: !d?.canUndo },
    { label: redoLabel, shortcut: k('shift+mod+z'), onClick: A.redo, disabled: !d?.canRedo },
    { label: 'Step Backward', shortcut: k('alt+mod+z'), onClick: A.stepBackward, disabled: !d?.canUndo },
    { label: 'Step Forward', shortcut: k('shift+alt+mod+z'), onClick: A.stepForward, disabled: !d?.canRedo },
    { separator: true },
    { label: 'Cut', shortcut: k('mod+x'), onClick: A.cut, disabled: !d },
    { label: 'Copy', shortcut: k('mod+c'), onClick: A.copy, disabled: !d },
    { label: 'Copy Merged', shortcut: k('shift+mod+c'), onClick: A.copyMerged, disabled: !d },
    { label: 'Paste', shortcut: k('mod+v'), onClick: () => void pasteFromSystem(false) },
    { label: 'Paste in Place', shortcut: k('shift+mod+v'), onClick: A.pasteInPlace },
    { label: 'Clear', shortcut: 'Delete', onClick: A.clear, disabled: !d },
    { separator: true },
    { label: 'Fill…', shortcut: k('shift+f5'), onClick: A.fill, disabled: !d },
    { label: 'Stroke…', onClick: A.stroke, disabled: !sel },
    { separator: true },
    { label: 'Free Transform', shortcut: k('mod+t'), onClick: A.freeTransform, disabled: !d },
    {
      label: 'Transform',
      disabled: !d,
      submenu: [
        { label: 'Rotate 180°', onClick: A.rotLayer180 },
        { label: 'Rotate 90° Clockwise', onClick: A.rotLayer90 },
        { label: 'Rotate 90° Counter Clockwise', onClick: A.rotLayerCCW },
        { separator: true },
        { label: 'Flip Horizontal', onClick: A.flipLayerH },
        { label: 'Flip Vertical', onClick: A.flipLayerV },
      ],
    },
  ];
}

export function imageMenu(): MenuItem[] {
  const d = activeDoc();
  return [
    {
      label: 'Adjustments',
      disabled: !d,
      submenu: [
        ...ADJUST_TYPES.map((a) => ({ label: a.label, shortcut: a.shortcut ? k(a.shortcut) : undefined, onClick: () => (a.type === 'invert' ? A.invert() : A.adjust(a.type)) })),
        { separator: true },
        { label: 'Desaturate', shortcut: k('shift+mod+u'), onClick: A.desaturate },
      ],
    },
    { separator: true },
    { label: 'Auto Tone', shortcut: k('shift+mod+l'), onClick: () => A.auto('tone'), disabled: !d },
    { label: 'Auto Contrast', shortcut: k('alt+shift+mod+l'), onClick: () => A.auto('contrast'), disabled: !d },
    { label: 'Auto Color', shortcut: k('shift+mod+b'), onClick: () => A.auto('color'), disabled: !d },
    { separator: true },
    { label: 'Image Size…', shortcut: k('alt+mod+i'), onClick: A.imageSize, disabled: !d },
    { label: 'Canvas Size…', shortcut: k('alt+mod+c'), onClick: A.canvasSize, disabled: !d },
    {
      label: 'Image Rotation',
      disabled: !d,
      submenu: [
        { label: '180°', onClick: () => A.rotateCanvas('180') },
        { label: '90° Clockwise', onClick: () => A.rotateCanvas('cw') },
        { label: '90° Counter Clockwise', onClick: () => A.rotateCanvas('ccw') },
        { separator: true },
        { label: 'Flip Canvas Horizontal', onClick: () => A.rotateCanvas('flipH') },
        { label: 'Flip Canvas Vertical', onClick: () => A.rotateCanvas('flipV') },
      ],
    },
    { label: 'Crop', onClick: A.crop, disabled: !d || (!d.selection && edState().tool !== 'crop') },
    { label: 'Trim Transparent Pixels', onClick: A.trim, disabled: !d },
  ];
}

export function layerMenu(): MenuItem[] {
  const d = activeDoc();
  const l = d?.activeLayer;
  const i = d && l ? d.indexOf(l.id) : -1;
  const sel = !!d?.selection;
  return [
    {
      label: 'New',
      disabled: !d,
      submenu: [
        { label: 'Layer', shortcut: k('shift+mod+n'), onClick: A.newLayer },
        { label: 'Layer via Copy', shortcut: k('mod+j'), onClick: A.layerViaCopy },
        { label: 'Layer via Cut', shortcut: k('shift+mod+j'), onClick: A.layerViaCut, disabled: !sel },
      ],
    },
    { label: 'Duplicate Layer', onClick: A.duplicate, disabled: !l },
    { label: 'Delete Layer', onClick: A.deleteLayer, disabled: !l || (d?.layers.length ?? 0) < 2 },
    { label: 'Rename Layer…', onClick: A.rename, disabled: !l },
    { separator: true },
    {
      label: 'Layer Style',
      disabled: !l || !l.surf,
      submenu: [
        { label: 'Drop Shadow…', onClick: () => A.layerStyle('dropShadow') },
        { label: 'Outer Glow…', onClick: () => A.layerStyle('outerGlow') },
        { label: 'Stroke…', onClick: () => A.layerStyle('stroke') },
        { separator: true },
        { label: 'Clear Layer Style', onClick: A.clearStyle, disabled: !l?.style },
      ],
    },
    { separator: true },
    { label: 'New Fill Layer (Solid Color)', onClick: A.newFill, disabled: !d },
    {
      label: 'New Adjustment Layer',
      disabled: !d,
      submenu: ADJUST_TYPES.map((a) => ({ label: a.label.replace('…', ''), onClick: () => A.newAdjustment(a.type) })),
    },
    { separator: true },
    {
      label: 'Layer Mask',
      disabled: !l,
      submenu: [
        { label: 'Reveal All', onClick: () => A.mask('reveal'), disabled: !!l?.mask },
        { label: 'Hide All', onClick: () => A.mask('hide'), disabled: !!l?.mask },
        { label: 'Reveal Selection', onClick: () => A.mask('selection'), disabled: !!l?.mask || !sel },
        { label: 'Hide Selection', onClick: () => A.mask('hideSelection'), disabled: !!l?.mask || !sel },
        { separator: true },
        { label: 'Delete', onClick: A.deleteMask, disabled: !l?.mask },
        { label: 'Apply', onClick: A.applyMask, disabled: !l?.mask || l?.kind === 'adjustment' || l?.kind === 'fill' },
        { separator: true },
        { label: l?.mask?.enabled === false ? 'Enable' : 'Disable', onClick: A.toggleMask, disabled: !l?.mask },
        { label: l?.mask?.linked === false ? 'Link' : 'Unlink', onClick: A.linkMask, disabled: !l?.mask },
      ],
    },
    { label: l?.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', shortcut: k('alt+mod+g'), onClick: A.clip, disabled: !l || i <= 0 },
    { separator: true },
    {
      label: 'Arrange',
      disabled: !l,
      submenu: [
        { label: 'Bring to Front', shortcut: k('shift+mod+]'), onClick: () => A.arrange('front') },
        { label: 'Bring Forward', shortcut: k('mod+]'), onClick: () => A.arrange('forward') },
        { label: 'Send Backward', shortcut: k('mod+['), onClick: () => A.arrange('backward') },
        { label: 'Send to Back', shortcut: k('shift+mod+['), onClick: () => A.arrange('back') },
      ],
    },
    { separator: true },
    { label: 'Rasterize', onClick: A.rasterize, disabled: !l || !canRasterize(l) },
    { separator: true },
    { label: 'Merge Down', shortcut: k('mod+e'), onClick: A.mergeDown, disabled: i <= 0 },
    { label: 'Merge Visible', shortcut: k('shift+alt+mod+e'), onClick: A.mergeVisible, disabled: !d || d.layers.filter((x) => x.visible).length < 2 },
    { label: 'Flatten Image', onClick: A.flatten, disabled: !d },
  ];
}

export function selectMenu(): MenuItem[] {
  const d = activeDoc();
  const sel = !!d?.selection;
  return [
    { label: 'All', shortcut: k('mod+a'), onClick: A.selectAll, disabled: !d },
    { label: 'Deselect', shortcut: k('mod+d'), onClick: A.deselect, disabled: !sel },
    { label: 'Reselect', shortcut: k('shift+mod+d'), onClick: A.reselect, disabled: !d?.lastSelection },
    { label: 'Inverse', shortcut: k('shift+mod+i'), onClick: A.inverse, disabled: !d },
    { separator: true },
    { label: 'Color Range…', onClick: A.colorRange, disabled: !d },
    { separator: true },
    {
      label: 'Modify',
      disabled: !sel,
      submenu: [
        { label: 'Border…', onClick: () => A.modify('border') },
        { label: 'Smooth…', onClick: () => A.modify('smooth') },
        { label: 'Expand…', onClick: () => A.modify('expand') },
        { label: 'Contract…', onClick: () => A.modify('contract') },
        { label: 'Feather…', shortcut: k('shift+f6'), onClick: () => A.modify('feather') },
      ],
    },
    { separator: true },
    { label: 'Load Selection from Layer Transparency', onClick: A.loadTransparency, disabled: !d },
  ];
}

export function filterMenu(): MenuItem[] {
  const d = activeDoc();
  const groups = FILTER_GROUPS.map((g) => ({
    label: g,
    disabled: !d,
    submenu: FILTERS.filter((f) => f.group === g).map((f) => ({ label: f.label, onClick: () => A.filter(f) })),
  }));
  return [
    { label: lastFilter ? `Last Filter (${lastFilter.def.label.replace('…', '')})` : 'Last Filter', shortcut: k('alt+mod+f'), onClick: A.lastFilter, disabled: !d || !lastFilter },
    { separator: true },
    { label: 'Camera Raw Filter…', shortcut: k('shift+mod+a'), onClick: A.cameraRaw, disabled: !d },
    { separator: true },
    ...groups,
  ];
}

export function viewMenu(): MenuItem[] {
  const s = edState();
  const d = activeDoc();
  return [
    { label: 'Zoom In', shortcut: k('mod+='), onClick: A.zoomIn, disabled: !d },
    { label: 'Zoom Out', shortcut: k('mod+-'), onClick: A.zoomOut, disabled: !d },
    { label: 'Fit on Screen', shortcut: k('mod+0'), onClick: A.fit, disabled: !d },
    { label: '100%', shortcut: k('mod+1'), onClick: A.actual, disabled: !d },
    { separator: true },
    { label: 'Pixel Grid', shortcut: k("mod+'"), checked: s.showGrid, onClick: A.toggleGrid },
  ];
}

export const MENUS: { label: string; items: () => MenuItem[] }[] = [
  { label: 'File', items: fileMenu },
  { label: 'Edit', items: editMenu },
  { label: 'Image', items: imageMenu },
  { label: 'Layer', items: layerMenu },
  { label: 'Select', items: selectMenu },
  { label: 'Filter', items: filterMenu },
  { label: 'View', items: viewMenu },
];
