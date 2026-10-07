/** Imperative timeline view controls (registered while the Timeline is mounted). */
export const timelineApi: { zoomBy: ((k: number) => void) | null; fit: (() => void) | null; reveal: ((f: number) => void) | null } = { zoomBy: null, fit: null, reveal: null };
