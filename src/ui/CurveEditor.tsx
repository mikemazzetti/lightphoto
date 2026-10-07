import { useEffect, useMemo, useRef, useState } from 'react';
import type { CurvePoint } from '@/core/develop/settings';
import { makeCurve } from '@/core/develop/curve';

/**
 * Point-curve editor (Lightroom / Photoshop Curves). Click to add a point, drag to move,
 * double-click (or drag off the graph) to delete. Endpoints are fixed in x.
 * `histogram` (256 bins, optional) is drawn behind the curve.
 */
export function CurveEditor({
  points,
  onChange,
  onCommit,
  color = '#e8e8ea',
  histogram,
  size = 236,
}: {
  points: CurvePoint[];
  onChange: (p: CurvePoint[]) => void;
  onCommit?: (p: CurvePoint[]) => void;
  color?: string;
  histogram?: Uint32Array | null;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const sorted = useMemo(() => [...points].sort((a, b) => a[0] - b[0]), [points]);

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#141415';
    ctx.fillRect(0, 0, size, size);
    if (histogram) {
      let max = 1;
      for (let i = 2; i < 254; i++) max = Math.max(max, histogram[i]);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, size);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * size, size - Math.min(1, histogram[i] / max) * size * 0.9);
      ctx.lineTo(size, size);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = Math.round((i / 4) * size) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.stroke();
    const f = makeCurve(sorted);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i <= size; i++) {
      const y = f(i / size);
      if (i === 0) ctx.moveTo(i, size - y * size);
      else ctx.lineTo(i, size - y * size);
    }
    ctx.stroke();
    sorted.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x * size, size - y * size, i === active ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === active ? color : '#1d1d1f';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }, [sorted, color, histogram, size, active]);

  const toPt = (e: { clientX: number; clientY: number }): CurvePoint => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const el = ref.current!;
    const [px, py] = toPt(e);
    let pts = sorted.map((p) => [...p] as CurvePoint);
    let idx = pts.findIndex(([x, y]) => Math.hypot((x - px) * size, (y - py) * size) < 9);
    if (idx < 0) {
      pts.push([px, py]);
      pts.sort((a, b) => a[0] - b[0]);
      idx = pts.findIndex((p) => p[0] === px && p[1] === py);
      onChange(pts);
    }
    setActive(idx);
    el.setPointerCapture(e.pointerId);
    let removed = false;
    const move = (ev: PointerEvent) => {
      const [x, y] = toPt(ev);
      const r = el.getBoundingClientRect();
      const outside = ev.clientX < r.left - 20 || ev.clientX > r.right + 20 || ev.clientY < r.top - 20 || ev.clientY > r.bottom + 20;
      const isEnd = idx === 0 || idx === pts.length - 1;
      const next = pts.map((p) => [...p] as CurvePoint);
      if (outside && !isEnd && pts.length > 2) {
        next.splice(idx, 1);
        removed = true;
        onChange(next);
        return;
      }
      removed = false;
      const lo = idx > 0 ? pts[idx - 1][0] + 0.01 : 0;
      const hi = idx < pts.length - 1 ? pts[idx + 1][0] - 0.01 : 1;
      next[idx] = [idx === 0 ? Math.min(x, hi) : idx === pts.length - 1 ? Math.max(x, lo) : Math.min(hi, Math.max(lo, x)), y];
      if (idx === 0 && pts.length > 1) next[idx][0] = Math.min(next[idx][0], hi);
      pts = next;
      onChange(next);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setActive(null);
      if (removed) pts.splice(idx, 1);
      onCommit?.(pts);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const [px, py] = toPt(e);
    const idx = sorted.findIndex(([x, y]) => Math.hypot((x - px) * size, (y - py) * size) < 9);
    if (idx > 0 && idx < sorted.length - 1) {
      const next = sorted.filter((_, i) => i !== idx);
      onChange(next);
      onCommit?.(next);
    }
  };

  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: 4, cursor: 'crosshair', display: 'block', touchAction: 'none' }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} />;
}
