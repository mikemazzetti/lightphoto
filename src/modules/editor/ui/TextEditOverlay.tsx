import { useEffect, useReducer, useRef } from 'react';
import { bus } from '../model/bus';
import { IDENTITY, matMul, matTranslate } from '../model/geom';
import { cssFamily, layoutText } from '../model/rasterize';
import { useEditor } from '../model/store';
import { commitTextEdit, updateEditingText, useTextEdit } from '../tools/text';

/** On-canvas text editing: a transparent textarea laid exactly over the text layer. */
export function TextEditOverlay() {
  const st = useTextEdit();
  const docs = useEditor((s) => s.docs);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => bus.view.on(force), []);
  const doc = docs.find((d) => d.id === st.docId);
  const l = doc?.layer(st.layerId ?? '');
  const t = l?.text;

  useEffect(() => {
    if (!st.layerId) return;
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }, [st.layerId]);

  if (!doc || !l || !t) return null;
  const v = doc.view;
  const L = layoutText(t);
  const pad = 2;
  const extra = t.size * 1.5;
  const shift = t.align === 'center' ? extra / 2 : t.align === 'right' ? extra : 0;
  // view ∘ layer transform ∘ text origin (offsets in text space so they scale with zoom)
  const m = matMul([v.scale, 0, 0, v.scale, v.x, v.y], matMul(l.xform ?? IDENTITY, matTranslate(t.x - pad - shift, t.y - pad)));
  return (
    <textarea
      ref={ref}
      className="ed-text-edit"
      spellCheck={false}
      value={t.text}
      wrap="off"
      onChange={(e) => {
        updateEditingText({ text: e.target.value });
        force();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || e.key === 'Escape') {
          e.preventDefault();
          commitTextEdit();
        }
      }}
      style={{
        transform: `matrix(${m.join(',')})`,
        width: L.boxW + extra + pad * 2,
        height: L.boxH + pad * 2,
        left: 0,
        top: 0,
        padding: pad,
        font: `${t.italic ? 'italic ' : ''}${t.weight} ${t.size}px ${cssFamily(t.font)}`,
        lineHeight: `${L.lineH}px`,
        letterSpacing: `${t.tracking}px`,
        color: `rgb(${t.color.r},${t.color.g},${t.color.b})`,
        caretColor: `rgb(${t.color.r},${t.color.g},${t.color.b})`,
        textAlign: t.align,
        outlineWidth: Math.max(1, 1 / v.scale),
      }}
    />
  );
}
