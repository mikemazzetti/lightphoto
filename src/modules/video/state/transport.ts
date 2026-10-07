/**
 * Program transport: the playhead lives here (outside React) so playback can run at 60 Hz without
 * re-rendering components. Canvas views subscribe and redraw in requestAnimationFrame; React views
 * read the throttled `playhead` mirror in the store.
 */

type Listener = () => void;

export class Transport {
  /** Current frame (fractional during playback). */
  frame = 0;
  playing = false;
  /** Shuttle rate (1 = normal, negative = reverse). */
  rate = 1;
  /** True while the user drags the playhead (enables fast seeking). */
  scrubbing = false;
  /** Increments on every explicit seek (lets the player tell seeks apart from clock ticks). */
  seekSeq = 0;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Explicit seek (user action). */
  seek(frame: number) {
    this.frame = Math.max(0, Math.round(frame));
    this.seekSeq++;
    this.emit();
  }

  /** Clock tick from the player (no seek). */
  tick(frame: number) {
    this.frame = frame;
    this.emit();
  }

  play(rate = 1) {
    this.rate = rate;
    this.playing = true;
    this.seekSeq++;
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    // Stay on the frame that was on screen (playback shows floor(frame); rounding could step past it).
    this.frame = this.frameInt;
    this.seekSeq++;
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play(1);
  }

  setScrubbing(v: boolean) {
    this.scrubbing = v;
    if (!v) {
      this.seekSeq++;
      this.emit();
    }
  }

  get frameInt() {
    return Math.floor(this.frame + 1e-6);
  }
}

export const transport = new Transport();
