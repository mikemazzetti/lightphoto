import { memo, useEffect, useRef, useState } from 'react';
import { openContextMenu, openMenu, MenuItem } from '@/state/app';
import { BLEND_MODE_GROUPS, BLEND_MODE_LABELS, BlendMode } from '@/core/gl/glsl';
import { cx } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import type { Doc } from '../../model/doc';
import type { Layer } from '../../model/types';
import { touch, useActiveDoc } from '../../model/store';
import { ADJUST_TYPES } from '../../render/adjustments';
import { A } from '../../actions';
import { canRasterize, commit, moveLayer, renameLayer, selectLayer, setLayerProps, toggleMaskEnabled } from '../../ops/layers';
import { selectionFromLayer } from '../../ops/select';
import { Scrub } from '../OptionsBar';
import { EdIcon } from '../icons';

// ---------------------------------------------------------------------------------------------
// Thumbnails

const THUMB = 34;

function drawChecker(ctx: CanvasRenderingContext2D, w: number, h: number, s = 4) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ccc';
  for (let y = 0; y < h; y += s) for (let x = (y / s) % 2 ? s : 0; x < w; x += s * 2) ctx.fillRect(x, y, s, s);
}

export const LayerThumb = memo(function LayerThumb({ doc, layer, mask, version }: { doc: Doc; layer: Layer; mask?: boolean; version: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(THUMB / doc.width, THUMB / doc.height);
    const w = Math.max(4, Math.round(doc.width * k));
    const h = Math.max(4, Math.round(doc.height * k));
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'medium';
    if (mask && layer.mask) {
      const m = layer.mask;
      ctx.fillStyle = m.defaultColor ? '#fff' : '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(m.surf.canvas, m.x * k, m.y * k, m.surf.width * k, m.surf.height * k);
      return;
    }
    drawChecker(ctx, w, h);
    if (layer.kind === 'fill' && layer.fillColor) {
      ctx.fillStyle = `rgb(${layer.fillColor.r},${layer.fillColor.g},${layer.fillColor.b})`;
      ctx.fillRect(0, 0, w, h);
    } else if (layer.surf) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      ctx.drawImage(layer.surf.canvas, layer.x * k, layer.y * k, layer.surf.width * k, layer.surf.height * k);
      ctx.restore();
    }
  }, [doc, layer, mask, version]);
  if (layer.kind === 'adjustment' && !mask) {
    return (
      <span className="ed-thumb ed-thumb-adj" title={layer.adjust?.type}>
        <EdIcon name="adjustLayer" size={18} />
      </span>
    );
  }
  return (
    <span className="ed-thumb">
      <canvas ref={ref} />
    </span>
  );
});

// ---------------------------------------------------------------------------------------------

export function blendMenuItems(current: BlendMode, onPick: (m: BlendMode) => void): MenuItem[] {
  const out: MenuItem[] = [];
  BLEND_MODE_GROUPS.forEach((g, i) => {
    if (i) out.push({ separator: true });
    for (const m of g) out.push({ label: BLEND_MODE_LABELS[m], checked: m === current, onClick: () => onPick(m) });
  });
  return out;
}

function LayerRow({ doc, l, index, dragState }: { doc: Doc; l: Layer; index: number; dragState: React.MutableRefObject<{ id: string | null }> }) {
  const active = doc.activeLayerId === l.id;
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<'above' | 'below' | null>(null);
  const version = `${l.v}:${l.surf?.id}:${l.surf?.version}:${doc.width}x${doc.height}`;
  const mversion = `${l.mask?.surf.id}:${l.mask?.surf.version}:${l.mask?.x}:${l.mask?.y}`;
  const locked = l.lockAll || l.lockPixels || l.lockPosition || l.lockTransparency;

  const ctxMenu = (e: React.MouseEvent) => {
    selectLayer(doc, l.id, doc.editMask);
    openContextMenu(e, [
      { label: 'Duplicate Layer', onClick: A.duplicate },
      { label: 'Delete Layer', onClick: A.deleteLayer, disabled: doc.layers.length < 2 },
      { label: 'Rename Layer…', onClick: () => setEditing(true) },
      { separator: true },
      { label: 'Select Pixels', onClick: () => selectionFromLayer(doc, l.id) },
      { label: 'Rasterize Layer', onClick: A.rasterize, disabled: !canRasterize(l) },
      { label: l.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', onClick: A.clip, disabled: index === 0 },
      { separator: true },
      ...(l.mask
        ? [
            { label: l.mask.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', onClick: A.toggleMask },
            { label: 'Apply Layer Mask', onClick: A.applyMask, disabled: l.kind === 'adjustment' || l.kind === 'fill' },
            { label: 'Delete Layer Mask', onClick: A.deleteMask },
          ]
        : [{ label: 'Add Layer Mask', onClick: () => A.mask(doc.selection ? 'selection' : 'reveal') }]),
      { separator: true },
      { label: 'Blending Options…', submenu: blendMenuItems(l.blendMode, (m) => setLayerProps(doc, l.id, { blendMode: m }, 'Blending Change')) },
      { label: 'Layer Style', disabled: !l.surf, submenu: [{ label: 'Drop Shadow…', onClick: () => A.layerStyle('dropShadow') }, { label: 'Outer Glow…', onClick: () => A.layerStyle('outerGlow') }, { label: 'Stroke…', onClick: () => A.layerStyle('stroke') }, { label: 'Clear Layer Style', onClick: A.clearStyle, disabled: !l.style }] },
      { separator: true },
      { label: 'Merge Down', onClick: A.mergeDown, disabled: index === 0 },
      { label: 'Merge Visible', onClick: A.mergeVisible },
      { label: 'Flatten Image', onClick: A.flatten },
    ]);
  };

  return (
    <div
      className={cx('ed-layer', active && 'active', !l.visible && 'hidden', drop && `drop-${drop}`)}
      draggable={!editing}
      onDragStart={(e) => {
        dragState.current.id = l.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-layer', l.id);
      }}
      onDragEnd={() => {
        dragState.current.id = null;
        setDrop(null);
      }}
      onDragOver={(e) => {
        if (!dragState.current.id) return;
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setDrop(e.clientY < r.top + r.height / 2 ? 'above' : 'below');
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        e.preventDefault();
        const id = dragState.current.id;
        const where = drop;
        setDrop(null);
        if (!id || id === l.id) return;
        const from = doc.indexOf(id);
        // list is shown top→bottom = highest index first
        let to = where === 'above' ? index + 1 : index;
        if (from < to) to--;
        moveLayer(doc, id, to);
      }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          selectionFromLayer(doc, l.id, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'new');
          return;
        }
        selectLayer(doc, l.id, false);
      }}
      onContextMenu={ctxMenu}
    >
      <button
        type="button"
        className="ed-eye"
        title={l.visible ? 'Hide layer' : 'Show layer'}
        onClick={(e) => {
          e.stopPropagation();
          if (e.altKey) {
            // Alt-click: show only this layer (toggle back)
            const others = doc.layers.filter((x) => x !== l);
            const solo = others.some((x) => x.visible);
            for (const x of others) {
              x.visible = !solo;
              doc.touchLayer(x);
            }
            l.visible = true;
            doc.touchLayer(l);
            commit(doc, solo ? 'Show Only This Layer' : 'Show All Layers');
            return;
          }
          setLayerProps(doc, l.id, { visible: !l.visible }, l.visible ? 'Hide Layer' : 'Show Layer');
        }}
      >
        <Icon name={l.visible ? 'eye' : 'eyeOff'} size={14} />
      </button>
      {l.clip && <span className="ed-clip-arrow" title="Clipped to the layer below">↳</span>}
      <span
        className={cx('ed-thumb-wrap', active && !doc.editMask && 'target')}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.stopPropagation();
          selectLayer(doc, l.id, false);
        }}
      >
        <LayerThumb doc={doc} layer={l} version={version} />
      </span>
      {l.mask && (
        <>
          <span className={cx('ed-mask-link', !l.mask.linked && 'off')} title={l.mask.linked ? 'Mask linked (click to unlink)' : 'Mask unlinked'} onClick={(e) => (e.stopPropagation(), selectLayer(doc, l.id, doc.editMask), A.linkMask())}>
            <EdIcon name="chain" size={10} />
          </span>
          <span
            className={cx('ed-thumb-wrap', active && doc.editMask && 'target', !l.mask.enabled && 'disabled')}
            title="Layer mask — click to edit, Shift-click to disable, ⌘-click to load as selection"
            onClick={(e) => {
              e.stopPropagation();
              if (e.shiftKey) {
                toggleMaskEnabled(doc, l.id);
                return;
              }
              if (e.metaKey || e.ctrlKey) {
                selectionFromLayer(doc, l.id, 'new', true);
                return;
              }
              selectLayer(doc, l.id, true);
            }}
          >
            <LayerThumb doc={doc} layer={l} mask version={mversion} />
          </span>
        </>
      )}
      <span className="ed-layer-name" onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))}>
        {editing ? (
          <input
            className="input"
            autoFocus
            defaultValue={l.name}
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                (e.target as HTMLInputElement).value = l.name;
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={(e) => {
              renameLayer(doc, l.id, e.target.value);
              setEditing(false);
            }}
          />
        ) : (
          <>
            <span className={cx('ellipsis', l.kind === 'text' && 'ed-text-name')}>{l.kind === 'text' ? <b className="ed-tchip">T</b> : null}{l.name}</span>
          </>
        )}
      </span>
      {l.style && (
        <span className="ed-fx-badge" title="Layer style — double-click to edit" onDoubleClick={(e) => (e.stopPropagation(), A.layerStyle('dropShadow'))}>
          fx
        </span>
      )}
      {locked && (
        <span className="ed-lock-badge" title="Locked">
          <Icon name="lock" size={11} />
        </span>
      )}
    </div>
  );
}

export function LayersPanel() {
  const doc = useActiveDoc();
  const dragState = useRef<{ id: string | null }>({ id: null });
  if (!doc) return <div className="ed-panel-empty">No document</div>;
  const l = doc.activeLayer;
  const rows = doc.layers.map((x, i) => ({ x, i })).reverse();
  const lockBtn = (key: 'lockTransparency' | 'lockPixels' | 'lockPosition' | 'lockAll', icon: React.ReactNode, title: string) => (
    <button
      type="button"
      className={cx('ed-lock-btn', l?.[key] && 'active')}
      title={title}
      disabled={!l}
      onClick={() => l && setLayerProps(doc, l.id, { [key]: !l[key] } as Partial<Layer>, 'Lock Change')}
    >
      {icon}
    </button>
  );
  const newAdjItems: MenuItem[] = [
    { label: 'Solid Color…', onClick: A.newFill },
    { separator: true },
    ...ADJUST_TYPES.map((a) => ({ label: a.label.replace('…', ''), onClick: () => A.newAdjustment(a.type) })),
  ];
  return (
    <div className="ed-layers">
      <div className="ed-layers-top">
        <button
          type="button"
          className="ed-blend-btn"
          disabled={!l}
          onClick={(e) => {
            if (!l) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(r.left, r.bottom + 2, blendMenuItems(l.blendMode, (m) => setLayerProps(doc, l.id, { blendMode: m }, 'Blending Change')));
          }}
        >
          <span className="ellipsis">{l ? BLEND_MODE_LABELS[l.blendMode] : 'Normal'}</span>
          <Icon name="chevronDown" size={11} />
        </button>
        <Scrub label="Opacity" value={Math.round((l?.opacity ?? 1) * 100)} min={0} max={100} suffix="%" onChange={(v) => l && setLayerProps(doc, l.id, { opacity: v / 100 }, 'Opacity Change', `opacity:${l.id}`)} width={42} />
      </div>
      <div className="ed-layers-top">
        <span className="faint">Lock:</span>
        {lockBtn('lockTransparency', <EdIcon name="alpha" size={12} />, 'Lock transparent pixels')}
        {lockBtn('lockPixels', <Icon name="brush" size={12} />, 'Lock image pixels')}
        {lockBtn('lockPosition', <Icon name="move" size={12} />, 'Lock position')}
        {lockBtn('lockAll', <Icon name="lock" size={12} />, 'Lock all')}
        <span className="spacer" />
        <Scrub label="Fill" value={Math.round((l?.fillOpacity ?? 1) * 100)} min={0} max={100} suffix="%" onChange={(v) => l && setLayerProps(doc, l.id, { fillOpacity: v / 100 }, 'Fill Opacity Change', `fill:${l.id}`)} width={42} />
      </div>
      <div className="ed-layer-list" onClick={(e) => e.target === e.currentTarget && touch()}>
        {rows.map(({ x, i }) => (
          <LayerRow key={x.id} doc={doc} l={x} index={i} dragState={dragState} />
        ))}
      </div>
      <div className="ed-layers-bottom">
        <button
          type="button"
          title="Add a layer style"
          disabled={!l?.surf}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(r.left, r.top - 120, [
              { label: 'Drop Shadow…', onClick: () => A.layerStyle('dropShadow') },
              { label: 'Outer Glow…', onClick: () => A.layerStyle('outerGlow') },
              { label: 'Stroke…', onClick: () => A.layerStyle('stroke') },
            ]);
          }}
        >
          <Icon name="fx" size={15} />
        </button>
        <button type="button" title="Add layer mask (from selection if any)" disabled={!l || !!l.mask} onClick={() => A.mask(doc.selection ? 'selection' : 'reveal')}>
          <EdIcon name="maskAdd" size={15} />
        </button>
        <button
          type="button"
          title="Create new fill or adjustment layer"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(r.left, r.top - 380, newAdjItems);
          }}
        >
          <EdIcon name="adjustLayer" size={15} />
        </button>
        <button type="button" title="Create a new layer (⇧⌘N)" onClick={A.newLayer}>
          <EdIcon name="newLayer" size={15} />
        </button>
        <button type="button" title="Duplicate layer (⌘J)" disabled={!l} onClick={A.duplicate}>
          <Icon name="copy" size={14} />
        </button>
        <button type="button" title="Delete layer" disabled={!l || doc.layers.length < 2} onClick={A.deleteLayer}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}
