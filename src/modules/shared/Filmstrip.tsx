import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LABEL_COLORS, Photo, useCatalog } from '@/state/catalog';
import { Icon } from '@/ui/Icon';
import { cx } from '@/ui/controls';
import { BitmapView, useThumbnail } from './thumbs';

const CELL_GAP = 4;

/**
 * Horizontal, virtualised strip of photos (Lightroom filmstrip). Selection semantics:
 * click = select one, ⌘/Ctrl-click = toggle, Shift-click = range.
 */
export function Filmstrip({
  ids,
  height = 92,
  onActivate,
  onDoubleClick,
  onContextMenu,
}: {
  ids: string[];
  height?: number;
  /** Called after the active photo changes via click. */
  onActivate?: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [width, setWidth] = useState(800);
  const selection = useCatalog((s) => s.selection);
  const activeId = useCatalog((s) => s.activeId);
  const photos = useCatalog((s) => s.photos);
  const cellH = height - 16;
  const cellW = Math.round(cellH * 1.35);
  const stride = cellW + CELL_GAP;

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the active photo in view.
  useEffect(() => {
    const el = ref.current;
    if (!el || !activeId) return;
    const i = ids.indexOf(activeId);
    if (i < 0) return;
    const x = i * stride;
    if (x < el.scrollLeft) el.scrollLeft = x - stride;
    else if (x + cellW > el.scrollLeft + el.clientWidth) el.scrollLeft = x + cellW - el.clientWidth + stride;
  }, [activeId, ids, stride, cellW]);

  const first = Math.max(0, Math.floor(scroll / stride) - 2);
  const last = Math.min(ids.length, Math.ceil((scroll + width) / stride) + 2);

  const click = (e: React.MouseEvent, id: string) => {
    const s = useCatalog.getState();
    if (e.shiftKey && s.activeId) {
      const a = ids.indexOf(s.activeId);
      const b = ids.indexOf(id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      useCatalog.setState({ selection: range });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const sel = s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id];
      useCatalog.setState({ selection: sel, activeId: id });
    } else useCatalog.setState({ selection: [id], activeId: id });
    onActivate?.(id);
  };

  return (
    <div
      ref={ref}
      onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollLeft)}
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) ref.current!.scrollLeft += e.deltaY;
      }}
      style={{ height, overflowX: 'auto', overflowY: 'hidden', background: 'var(--bg-1)', borderTop: '1px solid var(--border)', position: 'relative', flex: '0 0 auto' }}
    >
      <div style={{ width: ids.length * stride + 8, height: '100%', position: 'relative' }}>
        {ids.slice(first, last).map((id, k) => {
          const p = photos[id];
          if (!p) return null;
          return (
            <FilmCell
              key={id}
              photo={p}
              left={4 + (first + k) * stride}
              top={8}
              w={cellW}
              h={cellH}
              selected={selection.includes(id)}
              active={id === activeId}
              onClick={(e) => click(e, id)}
              onDoubleClick={() => onDoubleClick?.(id)}
              onContextMenu={(e) => onContextMenu?.(e, id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function FilmCell({ photo, left, top, w, h, selected, active, onClick, onDoubleClick, onContextMenu }: {
  photo: Photo; left: number; top: number; w: number; h: number; selected: boolean; active: boolean;
  onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void; onContextMenu: (e: React.MouseEvent) => void;
}) {
  const bmp = useThumbnail(photo, 384);
  return (
    <div
      className={cx('film-cell')}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={photo.name}
      style={{
        position: 'absolute', left, top, width: w, height: h, borderRadius: 4, overflow: 'hidden', cursor: 'pointer',
        background: selected ? '#3a3a3e' : '#222224',
        outline: active ? '2px solid var(--accent)' : selected ? '1px solid #5a5a60' : 'none',
        opacity: photo.flag === 'reject' ? 0.4 : 1,
      }}
    >
      <BitmapView bitmap={bmp} style={{ padding: 3 }} />
      <div style={{ position: 'absolute', left: 4, bottom: 2, display: 'flex', gap: 1, color: '#f5d90a' }}>
        {Array.from({ length: photo.rating }, (_, i) => <Icon key={i} name="starFill" size={8} />)}
      </div>
      {photo.flag === 'pick' && <Icon name="flagFill" size={10} style={{ position: 'absolute', right: 4, top: 4, color: '#fff' }} />}
      {photo.label && <div style={{ position: 'absolute', right: 4, bottom: 4, width: 8, height: 8, borderRadius: 2, background: LABEL_COLORS[photo.label] }} />}
    </div>
  );
}
