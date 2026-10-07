/**
 * Tiny event hub that lets non-React code (tools, painting, compositor) talk to the mounted
 * canvas view and to panels without going through React state on hot paths.
 */
type Fn<T = void> = (v: T) => void;

class Emitter<T> {
  private fns = new Set<Fn<T>>();
  on(fn: Fn<T>) {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }
  emit(v: T) {
    for (const f of this.fns) f(v);
  }
}

export interface CursorInfo {
  x: number;
  y: number;
  rgba: [number, number, number, number] | null;
}

export const bus = {
  /** Asks the active canvas view to render on the next animation frame. */
  requestFrame: () => {},
  /** Asks the active canvas view to redraw its tool overlay. */
  requestOverlay: () => {},
  /** Forces a full re-composite of the active document (deferred work finished). */
  invalidate: () => {},
  /** View (zoom/pan) of the active document changed. */
  view: new Emitter<void>(),
  /** Cursor moved over the canvas (image coordinates + colour). */
  cursor: new Emitter<CursorInfo | null>(),
  /** A composite was rendered (navigator refresh etc). */
  rendered: new Emitter<void>(),
};

export function setFrameRequester(frame: () => void, overlay: () => void, invalidate: () => void = () => {}) {
  bus.requestFrame = frame;
  bus.requestOverlay = overlay;
  bus.invalidate = invalidate;
}
