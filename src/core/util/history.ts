/**
 * Generic undo/redo stack of labelled snapshots. Use for small, cheap-to-copy state (develop
 * settings, timeline JSON). For pixel edits, store patches (before/after ImageData of the dirty
 * rect) as the snapshot payload instead of whole images.
 */
export interface HistoryEntry<T> {
  label: string;
  state: T;
  time: number;
}

export class History<T> {
  entries: HistoryEntry<T>[] = [];
  index = -1;
  constructor(readonly limit = 200) {}

  /** Clears and sets the initial state. */
  reset(state: T, label = 'Open') {
    this.entries = [{ label, state, time: Date.now() }];
    this.index = 0;
  }

  /** Records a new state, discarding any redo branch. Coalesces with the previous entry when `merge` matches its label. */
  push(state: T, label: string, merge = false) {
    // Only coalesce at the tip: merging into an entry with a redo branch would resurrect stale states.
    if (merge && this.index > 0 && this.index === this.entries.length - 1 && this.entries[this.index].label === label) {
      this.entries[this.index] = { label, state, time: Date.now() };
      return;
    }
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ label, state, time: Date.now() });
    if (this.entries.length > this.limit) this.entries.splice(1, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
  }

  get current(): T | undefined {
    return this.entries[this.index]?.state;
  }
  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.entries.length - 1;
  }
  undo(): T | undefined {
    if (!this.canUndo) return undefined;
    this.index--;
    return this.current;
  }
  redo(): T | undefined {
    if (!this.canRedo) return undefined;
    this.index++;
    return this.current;
  }
  goto(i: number): T | undefined {
    if (i < 0 || i >= this.entries.length) return undefined;
    this.index = i;
    return this.current;
  }
}
