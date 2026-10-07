import { create } from 'zustand';
import { bus } from '../model/bus';
import { baseLayer, Doc } from '../model/doc';
import { rasterizeVector } from '../model/rasterize';
import { edState, touch, useEditor } from '../model/store';
import type { Layer, TextProps } from '../model/types';
import { commit } from '../ops/layers';
import type { Tool } from './types';

/** Text being edited in the on-canvas textarea. */
export const useTextEdit = create<{ docId: string | null; layerId: string | null; isNew: boolean; original: TextProps | null }>(() => ({
  docId: null,
  layerId: null,
  isNew: false,
  original: null,
}));

export function textEditing(): boolean {
  return !!useTextEdit.getState().layerId;
}

function editDoc(): Doc | null {
  const st = useTextEdit.getState();
  return useEditor.getState().docs.find((d) => d.id === st.docId) ?? null;
}

export function beginTextEdit(doc: Doc, l: Layer, isNew: boolean) {
  if (textEditing()) commitTextEdit();
  doc.activeLayerId = l.id;
  doc.editMask = false;
  doc.preview = { layerId: l.id, hide: true };
  doc.invalidate();
  useTextEdit.setState({ docId: doc.id, layerId: l.id, isNew, original: JSON.parse(JSON.stringify(l.text)) });
  useEditor.setState({ session: 'text' });
  touch();
}

/** Live update from the textarea / options bar. */
export function updateEditingText(patch: Partial<TextProps>) {
  const st = useTextEdit.getState();
  const doc = editDoc();
  const l = doc?.layer(st.layerId ?? '');
  if (!doc || !l?.text) return;
  l.text = { ...l.text, ...patch };
  useTextEdit.setState({ ...st });
}

function end() {
  const st = useTextEdit.getState();
  const doc = editDoc();
  useTextEdit.setState({ docId: null, layerId: null, isNew: false, original: null });
  useEditor.setState({ session: null });
  if (doc) {
    if (doc.preview?.layerId === st.layerId) doc.preview = null;
    doc.invalidate();
  }
  bus.requestOverlay();
  touch();
}

export function commitTextEdit() {
  const st = useTextEdit.getState();
  const doc = editDoc();
  const l = doc?.layer(st.layerId ?? '');
  if (!doc || !l || !l.text) return end();
  const empty = !l.text.text.trim();
  if (empty) {
    // Empty text: drop the layer (a new one never reached history; an existing one is deleted).
    const i = doc.indexOf(l.id);
    doc.layers.splice(i, 1);
    doc.activeLayerId = doc.layers[Math.max(0, i - 1)]?.id ?? '';
    end();
    if (!st.isNew) commit(doc, 'Delete Layer');
    return;
  }
  if (!st.isNew && JSON.stringify(st.original) === JSON.stringify(l.text)) return end();
  const firstLine = l.text.text.split('\n')[0].slice(0, 40);
  if (st.isNew || l.name === (st.original?.text.split('\n')[0].slice(0, 40) ?? '')) l.name = firstLine || 'Text';
  rasterizeVector(l);
  doc.touchLayer(l);
  end();
  commit(doc, st.isNew ? 'Type Layer' : 'Edit Type Layer');
}

export function cancelTextEdit() {
  const st = useTextEdit.getState();
  const doc = editDoc();
  const l = doc?.layer(st.layerId ?? '');
  if (doc && l) {
    if (st.isNew) {
      const i = doc.indexOf(l.id);
      doc.layers.splice(i, 1);
      doc.activeLayerId = doc.layers[Math.max(0, i - 1)]?.id ?? '';
    } else if (st.original) {
      l.text = st.original;
      rasterizeVector(l);
    }
  }
  end();
}

function textLayerAt(doc: Doc, x: number, y: number): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (l.kind !== 'text' || !l.visible || !l.surf) continue;
    if (x >= l.x && y >= l.y && x < l.x + l.surf.width && y < l.y + l.surf.height) return l;
  }
  return null;
}

export const textTool: Tool = {
  cursor: (env, p) => (p && textLayerAt(env.doc, p.x, p.y) ? 'text' : 'text'),
  down(env, p) {
    const doc = env.doc;
    if (textEditing()) {
      commitTextEdit();
      return;
    }
    const hitL = textLayerAt(doc, p.x, p.y);
    if (hitL) {
      beginTextEdit(doc, hitL, false);
      return;
    }
    const s = edState();
    const o = s.opts.text;
    const l = baseLayer('text', 'Text');
    l.text = {
      text: '',
      font: o.font,
      size: o.size,
      weight: o.weight,
      italic: o.italic,
      color: { ...s.fg },
      align: o.align,
      lineHeight: o.lineHeight,
      tracking: o.tracking,
      x: Math.round(p.x),
      y: Math.round(p.y - o.size * o.lineHeight * 0.75),
    };
    rasterizeVector(l);
    const i = doc.indexOf(doc.activeLayerId);
    doc.layers.splice(i < 0 ? doc.layers.length : i + 1, 0, l);
    beginTextEdit(doc, l, true);
  },
  key(_env, e) {
    if (!textEditing()) return false;
    if (e.key === 'Escape') {
      commitTextEdit();
      return true;
    }
    return false;
  },
  deactivate() {
    if (textEditing()) commitTextEdit();
  },
};
