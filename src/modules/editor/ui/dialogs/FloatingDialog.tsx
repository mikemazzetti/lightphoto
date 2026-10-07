import { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Checkbox } from '@/ui/controls';
import { useEditor } from '../../model/store';

let lastPos: { x: number; y: number } | null = null;

/**
 * A draggable, non-blocking dialog for live-preview operations: the canvas stays visible (and
 * zoom/pan keep working) while tools are disabled through `modal`.
 */
export function FloatingDialog({
  title,
  children,
  onOk,
  onCancel,
  okLabel = 'OK',
  preview,
  onPreview,
  width = 340,
  extraButtons,
}: {
  title: string;
  children: ReactNode;
  onOk: () => void;
  onCancel: () => void;
  okLabel?: string;
  preview?: boolean;
  onPreview?: (v: boolean) => void;
  width?: number;
  extraButtons?: ReactNode;
}) {
  const [pos, setPos] = useState(() => lastPos ?? { x: Math.max(20, window.innerWidth - width - 330), y: 96 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    useEditor.setState({ modal: true });
    return () => useEditor.setState({ modal: false });
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        e.stopPropagation();
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        setTimeout(onOk, 0);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onOk, onCancel]);
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const ox = e.clientX - pos.x;
    const oy = e.clientY - pos.y;
    const move = (ev: PointerEvent) => {
      const p = { x: Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - ox)), y: Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - oy)) };
      lastPos = p;
      setPos(p);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return createPortal(
    <div ref={ref} className="ed-float-dialog" style={{ left: pos.x, top: pos.y, width }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="ed-float-head" onPointerDown={startDrag}>
        {title}
      </div>
      <div className="ed-float-body">{children}</div>
      <div className="ed-float-foot">
        {onPreview && (
          <Checkbox checked={!!preview} onChange={onPreview}>
            Preview
          </Checkbox>
        )}
        {extraButtons}
        <span className="spacer" />
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onOk}>
          {okLabel}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

/** Label + control row used by dialogs. */
export function Row({ label, children, width = 110 }: { label: ReactNode; children: ReactNode; width?: number }) {
  return (
    <div className="ed-row" style={{ gridTemplateColumns: `${width}px 1fr` }}>
      <label>{label}</label>
      <div className="row">{children}</div>
    </div>
  );
}
