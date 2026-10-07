/**
 * Video frame sources for live playback. Each visible clip gets its own voice (so cuts between two
 * pieces of the same file and transitions work), backed by a muted HTMLVideoElement (hardware
 * decode, native seeking). Files the browser can't play fall back to mediabunny decoding.
 */
import { CanvasSink, WrappedCanvas } from 'mediabunny';
import type { Texture } from '@/core/gl/gl';
import { api } from '@/platform/api';
import type { MediaItem } from '../model/types';
import { getInput } from './media';

/** Paths the <video> element failed on (use the decoder path for them). */
const elementUnsupported = new Set<string>();

export interface FrameVoice {
  readonly clipId: string;
  lastUse: number;
  /** Keep the frame at `target` (seconds) on screen; play/pause as requested. */
  sync(target: number, play: boolean, rate: number, scrub: boolean): void;
  /** Uploads a new frame into `tex` if one arrived. Returns whether `tex` holds a frame. */
  upload(tex: Texture): boolean;
  readonly size: [number, number];
  idle(): void;
  dispose(): void;
}

export function createVoice(clipId: string, media: MediaItem, host: HTMLElement, wake: () => void): FrameVoice {
  if (elementUnsupported.has(media.path!)) return new DecoderVoice(clipId, media, wake);
  return new ElementVoice(clipId, media, host, wake);
}

export const voiceFailed = (v: FrameVoice) => v instanceof ElementVoice && v.failed;

class ElementVoice implements FrameVoice {
  readonly el: HTMLVideoElement;
  lastUse = performance.now();
  failed = false;
  private newFrame = true;
  private uploaded = false;
  private pending: number | null = null;
  private requested = -1;
  private hasRVFC: boolean;
  private srcFps: number;
  private disposed = false;

  constructor(
    readonly clipId: string,
    readonly media: MediaItem,
    host: HTMLElement,
    private wake: () => void,
  ) {
    const el = document.createElement('video');
    el.crossOrigin = 'anonymous';
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.disablePictureInPicture = true;
    (el as any).disableRemotePlayback = true;
    el.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    el.src = api.fileUrl(media.path!);
    host.appendChild(el);
    this.el = el;
    this.srcFps = media.fps || 30;
    this.hasRVFC = 'requestVideoFrameCallback' in el;
    if (this.hasRVFC) this.watchFrames();
    el.addEventListener('seeked', this.onSeeked);
    el.addEventListener('loadeddata', this.onLoaded);
    el.addEventListener('error', this.onError);
  }

  get size(): [number, number] {
    return [this.media.width || this.el.videoWidth, this.media.height || this.el.videoHeight];
  }

  private watchFrames() {
    const cb = () => {
      if (this.disposed) return;
      this.newFrame = true;
      this.wake();
      (this.el as any).requestVideoFrameCallback(cb);
    };
    (this.el as any).requestVideoFrameCallback(cb);
  }

  private onLoaded = () => {
    this.newFrame = true;
    if (this.pending !== null) {
      const t = this.pending;
      this.pending = null;
      this.seek(t, false);
    }
    this.wake();
  };

  private onSeeked = () => {
    this.newFrame = true;
    if (this.pending !== null) {
      const t = this.pending;
      this.pending = null;
      this.seek(t, false);
    }
    this.wake();
  };

  private onError = () => {
    const code = this.el.error?.code;
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE) {
      elementUnsupported.add(this.media.path!);
      this.failed = true;
      this.wake();
    }
  };

  private seek(t: number, fast: boolean) {
    const el = this.el;
    if (el.readyState < 1) {
      this.pending = t;
      return;
    }
    if (el.seeking) {
      this.pending = t;
      return;
    }
    this.requested = t;
    if (fast && typeof el.fastSeek === 'function') el.fastSeek(t);
    else el.currentTime = t;
  }

  sync(target: number, play: boolean, rate: number, scrub: boolean) {
    this.lastUse = performance.now();
    const el = this.el;
    if (this.failed) return;
    const tol = 0.45 / this.srcFps;
    if (play) {
      const base = Math.max(0.0625, Math.min(16, rate));
      if (el.readyState < 1) {
        this.pending = target;
        return;
      }
      if (el.paused) {
        if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
        el.playbackRate = base;
        void el.play().catch(() => {});
        return;
      }
      const drift = el.currentTime - target;
      if (Math.abs(drift) > 0.35) {
        el.currentTime = target + 0.03 * base;
        el.playbackRate = base;
      } else if (Math.abs(drift) > 1 / this.srcFps) el.playbackRate = base * (1 - Math.max(-0.15, Math.min(0.15, drift * 1.5)));
      else if (el.playbackRate !== base) el.playbackRate = base;
      // rVFC may not fire for invisible elements in every Chromium build: re-upload while playing.
      this.newFrame = true;
      return;
    }
    if (!el.paused) el.pause();
    const there = Math.abs(el.currentTime - target) < tol;
    if (there && !el.seeking) return;
    if (el.seeking && Math.abs(this.requested - target) < 1e-4) return;
    this.seek(target, scrub);
  }

  upload(tex: Texture): boolean {
    if (this.failed) return false;
    if ((this.newFrame || !this.uploaded) && this.el.readyState >= 2 && this.el.videoWidth > 0) {
      try {
        tex.upload(this.el);
        this.uploaded = true;
        this.newFrame = false;
      } catch (e) {
        console.warn('video upload failed', e);
      }
    }
    return this.uploaded;
  }

  idle() {
    if (!this.el.paused) this.el.pause();
  }

  dispose() {
    this.disposed = true;
    this.el.removeEventListener('seeked', this.onSeeked);
    this.el.removeEventListener('loadeddata', this.onLoaded);
    this.el.removeEventListener('error', this.onError);
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el.remove();
  }
}

/** mediabunny-backed frame source for containers/codecs the <video> element can't play. */
class DecoderVoice implements FrameVoice {
  lastUse = performance.now();
  private sink: CanvasSink | null = null;
  private first = 0;
  private frame: WrappedCanvas | null = null;
  private newFrame = false;
  private busy = false;
  private pendingT: number | null = null;
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private queue: WrappedCanvas[] = [];
  private pumping = false;
  private playing = false;
  private disposed = false;
  private ready: Promise<void>;

  constructor(
    readonly clipId: string,
    readonly media: MediaItem,
    private wake: () => void,
  ) {
    this.ready = (async () => {
      const input = await getInput(media.path!);
      const vt = await input.getPrimaryVideoTrack();
      if (!vt || !(await vt.canDecode())) throw new Error('Cannot decode video');
      this.first = await vt.getFirstTimestamp();
      this.sink = new CanvasSink(vt, { poolSize: 8 });
    })().catch((e) => console.warn('decoder voice', media.name, e));
  }

  get size(): [number, number] {
    return [this.media.width, this.media.height];
  }

  private async fetch(t: number) {
    if (this.busy) {
      this.pendingT = t;
      return;
    }
    this.busy = true;
    try {
      await this.ready;
      if (!this.sink || this.disposed) return;
      const c = await this.sink.getCanvas(this.first + t);
      if (c && !this.disposed) {
        this.frame = c;
        this.newFrame = true;
        this.wake();
      }
    } catch {
      /* ignore */
    } finally {
      this.busy = false;
      if (this.pendingT !== null) {
        const n = this.pendingT;
        this.pendingT = null;
        void this.fetch(n);
      }
    }
  }

  private async pump(t: number) {
    await this.ready;
    if (!this.sink || this.disposed) return;
    this.iter = this.sink.canvases(this.first + t);
    this.pumping = true;
    const it = this.iter;
    try {
      while (this.playing && this.iter === it) {
        if (this.queue.length >= 5) {
          await new Promise((r) => setTimeout(r, 8));
          continue;
        }
        const n = await it.next();
        if (n.done) break;
        this.queue.push(n.value);
      }
    } catch {
      /* stopped */
    } finally {
      this.pumping = false;
    }
  }

  sync(target: number, play: boolean, rate: number) {
    this.lastUse = performance.now();
    const t = this.first + target;
    if (play && rate > 0) {
      if (!this.playing) {
        this.playing = true;
        this.queue = [];
        void this.pump(target);
      }
      let best: WrappedCanvas | null = null;
      while (this.queue.length && this.queue[0].timestamp <= t + 0.001) best = this.queue.shift()!;
      if (best) {
        this.frame = best;
        this.newFrame = true;
      }
      // Fell far behind (or seeked): restart the iterator.
      if (this.queue.length && this.queue[0].timestamp > t + 1) this.restart(target);
      else if (this.frame && t - this.frame.timestamp > 1 && !this.queue.length && !this.pumping) this.restart(target);
      return;
    }
    if (this.playing) this.stopIter();
    if (!this.frame || Math.abs(this.frame.timestamp - t) > 0.5 / (this.media.fps || 30)) {
      if (!this.frame || this.frame.timestamp > t || t >= this.frame.timestamp + this.frame.duration) void this.fetch(target);
    }
  }

  private restart(target: number) {
    this.stopIter();
    this.playing = true;
    void this.pump(target);
  }

  private stopIter() {
    this.playing = false;
    void this.iter?.return();
    this.iter = null;
    this.queue = [];
  }

  upload(tex: Texture): boolean {
    if (this.frame && this.newFrame) {
      tex.upload(this.frame.canvas as TexImageSource);
      this.newFrame = false;
    }
    return !!this.frame;
  }

  idle() {
    if (this.playing) this.stopIter();
  }

  dispose() {
    this.disposed = true;
    this.stopIter();
  }
}
