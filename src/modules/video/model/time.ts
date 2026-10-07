/** Frame-rate and timecode helpers. */

export const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

/** Exact rational rate for NTSC-style nominal values (23.976 → 24000/1001 …). */
export function exactFps(fps: number): number {
  if (Math.abs(fps - 23.976) < 0.01) return 24000 / 1001;
  if (Math.abs(fps - 29.97) < 0.01) return 30000 / 1001;
  if (Math.abs(fps - 59.94) < 0.01) return 60000 / 1001;
  if (Math.abs(fps - 47.952) < 0.01) return 48000 / 1001;
  if (Math.abs(fps - 119.88) < 0.02) return 120000 / 1001;
  return fps;
}

/** Nominal integer frames per second used for timecode display. */
export const nominalFps = (fps: number) => Math.round(fps);

/** Snaps a measured frame rate to the closest common rate (within 1%). */
export function snapFps(measured: number): number {
  if (!Number.isFinite(measured) || measured <= 0) return 0;
  const common = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 15, 12, 10];
  let best = measured;
  let bestErr = Infinity;
  for (const c of common) {
    const err = Math.abs(exactFps(c) - measured) / c;
    if (err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  return bestErr < 0.01 ? best : Math.round(measured * 1000) / 1000;
}

export const framesToSeconds = (frames: number, fps: number) => frames / exactFps(fps);
/** Frame index containing `sec` (floor, robust to float noise). */
export const secondsToFrame = (sec: number, fps: number) => Math.floor(sec * exactFps(fps) + 1e-6);
/** Nearest frame boundary. */
export const secondsToFrameRound = (sec: number, fps: number) => Math.round(sec * exactFps(fps));

/** HH:MM:SS:FF (non-drop-frame). Negative values get a leading minus. */
export function timecode(frames: number, fps: number): string {
  const sign = frames < 0 ? '-' : '';
  let f = Math.floor(Math.abs(frames) + 1e-6);
  const nf = nominalFps(fps) || 30;
  const ff = f % nf;
  f = Math.floor(f / nf);
  const ss = f % 60;
  f = Math.floor(f / 60);
  const mm = f % 60;
  const hh = Math.floor(f / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${sign}${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Short form used for durations in lists, e.g. "0:12:05" → mm:ss:ff, dropping leading zero hours. */
export function shortTimecode(frames: number, fps: number): string {
  const tc = timecode(frames, fps);
  return tc.startsWith('00:') ? tc.slice(3) : tc;
}

/** Seconds → timecode at a media's own rate (falls back to 30 for stills/unknown). */
export const secondsTimecode = (sec: number, fps: number) => timecode(Math.floor(sec * exactFps(fps || 30) + 1e-6), fps || 30);

/**
 * Parses user input into frames. Accepts "HH:MM:SS:FF", "MM:SS:FF", "SS:FF", plain frame counts ("120"),
 * seconds with suffix ("2.5s"), and relative offsets ("+10", "-1:00").
 */
export function parseTimecode(input: string, fps: number, relativeTo = 0): number | null {
  let s = input.trim();
  if (!s) return null;
  let rel = 0;
  if (s[0] === '+' || s[0] === '-') {
    rel = s[0] === '+' ? 1 : -1;
    s = s.slice(1).trim();
  }
  let frames: number;
  if (/^\d+(\.\d+)?s$/i.test(s)) frames = Math.round(parseFloat(s) * exactFps(fps));
  else if (/^\d+$/.test(s)) frames = parseInt(s, 10);
  else {
    const parts = s.split(/[:;.]/).map((x) => parseInt(x, 10));
    if (parts.some((x) => !Number.isFinite(x))) return null;
    const nf = nominalFps(fps) || 30;
    while (parts.length < 4) parts.unshift(0);
    const [hh, mm, ss, ff] = parts.slice(-4);
    frames = ((hh * 60 + mm) * 60 + ss) * nf + ff;
  }
  if (rel) return relativeTo + rel * frames;
  return frames;
}

export const dbToGain = (db: number) => (db <= -96 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0.0000158 ? -96 : 20 * Math.log10(g));

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
