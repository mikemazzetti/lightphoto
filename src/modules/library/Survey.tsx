import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { select, setActive, useCatalog } from '@/state/catalog';
import { openContextMenu } from '@/state/app';
import { Icon } from '@/ui/Icon';
import { cx } from '@/ui/controls';
import { BitmapView } from '@/modules/shared/thumbs';
import { flag, rate } from './actions';
import { photoMenu } from './menus';
import { loadPreview, peekPreview, previewBucket } from './render';
import { useGridThumb } from './thumbs';
import { getLibraryIds } from './ids';
import { setView } from './store';

const MAX_TILES = 12;

function tiling(n: number, w: number, h: number): { cols: number; rows: number } {
  // Pick the column count that maximises tile area for a ~3:2 photo.
  let best = { cols: 1, rows: n, area: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = w / cols;
    const th = h / rows - 26;
    const k = Math.min(tw / 3, th / 2);
    const area = k * k;
    if (area > best.area) best = { cols, rows, area };
  }
  return best;
}

/** Survey (N): the selected photos side by side; click makes one active, × drops it. */
export function Survey() {
  const selection = useCatalog((s) => s.selection);
  const activeId = useCatalog((s) => s.activeId);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ids = useMemo(() => {
    const set = new Set(selection);
    const visible = getLibraryIds().filter((id) => set.has(id));
    // Set lookup: with a select-all of a 20k catalog, Array.includes here was O(n²) (seconds).
    const shown = new Set(visible);
    for (const id of selection) if (!shown.has(id)) visible.push(id);
    return visible.slice(0, MAX_TILES);
  }, [selection]);

  const { cols, rows } = tiling(Math.max(1, ids.length), Math.max(1, box.w - 24), Math.max(1, box.h - 24));
  const tilePx = previewBucket(Math.max(box.w / cols, box.h / rows) * (window.devicePixelRatio || 1));

  if (ids.length < 2) {
    return (
      <div ref={ref} className="lib-survey">
        <div className="empty-state">
          <Icon name="compare" size={36} />
          <h2>Survey</h2>
          <p>Select two or more photos in the grid (⌘/Ctrl-click or Shift-click) to compare them side by side.</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="lib-survey" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
      {selection.length > MAX_TILES && <div className="hud lib-survey-more">Showing {MAX_TILES} of {selection.length} selected</div>}
      {ids.map((id) => (
        <SurveyTile key={id} id={id} active={id === activeId} px={tilePx} onRemove={() => select(selection.filter((x) => x !== id), activeId === id ? selection.find((x) => x !== id) ?? null : activeId)} />
      ))}
    </div>
  );
}

function SurveyTile({ id, active, px, onRemove }: { id: string; active: boolean; px: number; onRemove: () => void }) {
  const photo = useCatalog((s) => s.photos[id]);
  const thumb = useGridThumb(photo, 384, 0);
  const [preview, setPreview] = useState<ImageBitmap | null>(() => (photo ? peekPreview(photo, px) : null));
  useEffect(() => {
    if (!photo) return;
    let alive = true;
    loadPreview(photo, px).then(
      (b) => alive && setPreview(b),
      () => {},
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.path, photo?.settings, px]);
  if (!photo) return null;
  return (
    <div
      className={cx('lib-survey-tile', active && 'active', photo.flag === 'reject' && 'rejected')}
      onClick={() => setActive(id)}
      onDoubleClick={() => {
        setActive(id);
        setView('loupe');
      }}
      onContextMenu={(e) => {
        setActive(id);
        openContextMenu(e, photoMenu());
      }}
    >
      <div className="lib-survey-img">
        <BitmapView bitmap={preview ?? thumb} />
      </div>
      <div className="lib-survey-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className={cx('lib-ctl lib-flag', photo.flag && 'on', photo.flag === 'reject' && 'reject')} title="Pick / unflag" onClick={() => flag(photo.flag ? null : 'pick', [id])}>
          <Icon name={photo.flag === 'reject' ? 'reject' : photo.flag === 'pick' ? 'flagFill' : 'flag'} size={12} />
        </button>
        <span className="ellipsis lib-survey-name">{photo.name}</span>
        <div className="lib-stars">
          {[1, 2, 3, 4, 5].map((r) => (
            <button key={r} type="button" className={cx('lib-star', r <= photo.rating && 'on')} onClick={() => rate(photo.rating === r ? 0 : r, [id])}>
              {r <= photo.rating ? <Icon name="starFill" size={10} /> : <span className="lib-dot" />}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn small" title="Remove from survey (deselect)" onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}
