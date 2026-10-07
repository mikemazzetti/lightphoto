import { useEffect, useRef } from 'react';
import { programApi } from './ProgramMonitor';

const MIN_DB = -60;
const MAX_DB = 6;
const TICKS = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54];

const toDb = (v: number) => (v <= 1e-6 ? -Infinity : 20 * Math.log10(v));

/** Master peak/RMS meters with peak hold and clip indicators (drawn from the player's analysers). */
export function AudioMeters() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const disp = [MIN_DB, MIN_DB];
    const rms = [MIN_DB, MIN_DB];
    const hold = [MIN_DB, MIN_DB];
    const holdT = [0, 0];
    const clip = [false, false];
    let last = performance.now();
    let idleFrames = 0;
    const c = ref.current!;
    const onClick = () => {
      clip[0] = clip[1] = false;
      idleFrames = 0;
    };
    c.addEventListener('click', onClick);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const lv = programApi.player?.meters;
      let active = false;
      for (let i = 0; i < 2; i++) {
        const p = lv ? toDb(lv.peak[i]) : -Infinity;
        const r = lv ? toDb(lv.rms[i]) : -Infinity;
        if (lv && lv.peak[i] >= 0.999) clip[i] = true;
        disp[i] = Math.max(Math.max(MIN_DB, p), disp[i] - 26 * dt);
        rms[i] = Math.max(Math.max(MIN_DB, r), rms[i] - 20 * dt);
        if (p > hold[i]) {
          hold[i] = p;
          holdT[i] = now;
        } else if (now - holdT[i] > 1500) hold[i] = Math.max(MIN_DB, hold[i] - 30 * dt);
        if (disp[i] > MIN_DB + 0.1 || hold[i] > MIN_DB + 0.1) active = true;
      }
      if (!active) {
        if (idleFrames++ > 2) return;
      } else idleFrames = 0;
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const top = 12;
      const bottom = h - 4;
      const H = bottom - top;
      const y = (db: number) => top + H * (1 - (Math.max(MIN_DB, Math.min(MAX_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB));
      const barW = Math.max(4, Math.floor((w - 18) / 2) - 1);
      const x0 = w - 2 * barW - 4;
      // Scale
      ctx.fillStyle = '#6f6f75';
      ctx.font = '8.5px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const t of TICKS) ctx.fillText(String(Math.abs(t)), x0 - 2, y(t));
      for (let i = 0; i < 2; i++) {
        const bx = x0 + i * (barW + 2);
        ctx.fillStyle = '#121214';
        ctx.fillRect(bx, top, barW, H);
        const grad = ctx.createLinearGradient(0, bottom, 0, top);
        grad.addColorStop(0, '#2f9e5a');
        grad.addColorStop((-18 - MIN_DB) / (MAX_DB - MIN_DB), '#46c96e');
        grad.addColorStop((-6 - MIN_DB) / (MAX_DB - MIN_DB), '#e5d34a');
        grad.addColorStop((0 - MIN_DB) / (MAX_DB - MIN_DB), '#e5484d');
        ctx.fillStyle = grad;
        const yp = y(disp[i]);
        ctx.globalAlpha = 0.55;
        ctx.fillRect(bx, yp, barW, bottom - yp);
        ctx.globalAlpha = 1;
        const yr = y(rms[i]);
        ctx.fillRect(bx, yr, barW, bottom - yr);
        if (hold[i] > MIN_DB) {
          ctx.fillStyle = hold[i] >= 0 ? '#ff5a5f' : '#e8e8ea';
          ctx.fillRect(bx, Math.round(y(hold[i])), barW, 1);
        }
        ctx.fillStyle = clip[i] ? '#e5484d' : '#2a2a2e';
        ctx.fillRect(bx, 2, barW, 7);
      }
      ctx.fillStyle = '#3a3a3e';
      ctx.fillRect(x0, Math.round(y(0)), 2 * barW + 2, 1);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      c.removeEventListener('click', onClick);
    };
  }, []);
  return <canvas ref={ref} className="vid-meters" title="Audio master meters (dBFS) — click to reset clip indicators" />;
}
