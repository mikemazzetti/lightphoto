/** Concurrency limiter: `const q = limit(4); await q(() => work())`. */
export function limit(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    queue.shift()!();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a: A) => {
    clearTimeout(t);
    fn(...a);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Coalesces calls to at most one per animation frame (latest args win). */
export function rafThrottle<A extends unknown[]>(fn: (...a: A) => void) {
  let pending: A | null = null;
  let id = 0;
  const f = (...a: A) => {
    pending = a;
    if (!id)
      id = requestAnimationFrame(() => {
        id = 0;
        const p = pending!;
        pending = null;
        fn(...p);
      });
  };
  f.cancel = () => {
    cancelAnimationFrame(id);
    id = 0;
    pending = null;
  };
  return f;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Fast non-cryptographic string hash (FNV-1a, hex). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
