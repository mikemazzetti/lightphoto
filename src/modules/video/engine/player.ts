/**
 * Live program playback: master clock, video voices, audio engine and the render loop that draws
 * the composite into the Program monitor canvas. Nothing here touches React during playback.
 */
import type { RenderTarget, Texture } from '@/core/gl/gl';
import { evalLayer, LayerEval, planFrame, TrackPlan } from '../model/evaluate';
import { sequenceEnd } from '../model/ops';
import { exactFps } from '../model/time';
import type { MediaItem, Project, Sequence } from '../model/types';
import { getState, mediaLookup, useVideo, VideoState } from '../state/store';
import { transport } from '../state/transport';
import { AudioEngine, MeterLevels } from './audio';
import { Compositor, LayerSource } from './compositor';
import { loadImage } from './media';
import { createVoice, FrameVoice, voiceFailed } from './voices';

const MAX_VOICES = 10;

/** True when the clips on audio tracks are the same objects (immutable updates ⇒ unchanged). */
function sameAudio(a: Sequence, b: Sequence): boolean {
  if (a.clips === b.clips && a.tracks === b.tracks) return true;
  const ta = new Set(a.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
  const tb = new Set(b.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
  if (ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  const ca = a.clips.filter((c) => ta.has(c.trackId));
  const cb = b.clips.filter((c) => tb.has(c.trackId));
  if (ca.length !== cb.length) return false;
  const set = new Set(cb);
  return ca.every((c) => set.has(c));
}

interface Clock {
  perf0: number;
  frame0: number;
  rate: number;
  seq: number;
}

export class Player {
  readonly comp: Compositor;
  readonly audio: AudioEngine;
  private voices = new Map<string, { voice: FrameVoice; tex: Texture; path: string | undefined }>();
  private images = new Map<string, ImageBitmap | 'loading' | 'error'>();
  private raf = 0;
  private clock: Clock | null = null;
  private dirty = true;
  private lastFrame = NaN;
  private unsubs: (() => void)[] = [];
  private result: RenderTarget | null = null;
  private disposed = false;
  private lastProject: Project;
  private meterLevels: MeterLevels = { peak: [0, 0], rms: [0, 0] };
  private lastPlan: TrackPlan[] = [];
  /** Called after each presented frame (overlay redraw). */
  onFrame: (() => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private host: HTMLElement,
  ) {
    this.comp = new Compositor(canvas);
    this.audio = new AudioEngine();
    this.lastProject = getState().project;
    this.unsubs.push(transport.subscribe(this.onTransport));
    this.unsubs.push(useVideo.subscribe(this.onStore));
    this.raf = requestAnimationFrame(this.tick);
  }

  wake = () => {
    this.dirty = true;
  };

  get meters() {
    return this.meterLevels;
  }

  get plan() {
    return this.lastPlan;
  }

  private onStore = (s: VideoState, prev: VideoState) => {
    if (s.project !== prev.project) {
      this.dirty = true;
      const a = s.project.seq;
      const b = prev.project.seq;
      if (this.clock) {
        // Video voices follow edits by themselves; only audio scheduling needs a restart.
        if (s.project.media !== prev.project.media || a.fps !== b.fps || !sameAudio(a, b)) this.restartClock(transport.frame);
        else if (a.tracks !== b.tracks) this.audio.updateTracks(a);
      }
    }
    if (s.playbackRes !== prev.playbackRes || s.monitorZoom !== prev.monitorZoom || s.mediaVersion !== prev.mediaVersion) this.dirty = true;
  };

  private onTransport = () => {
    this.dirty = true;
    if (transport.playing && !this.clock) this.startClock(transport.frame);
    else if (!transport.playing && this.clock) this.stopClock();
    else if (transport.playing && this.clock && this.clock.seq !== transport.seekSeq) this.startClock(transport.frame);
  };

  /** [start, end) range playback runs in. */
  private range(seq: Sequence): [number, number, boolean] {
    const s = getState();
    const end = Math.max(1, sequenceEnd(seq));
    if (s.loop && seq.inPoint !== null && seq.outPoint !== null && seq.outPoint > seq.inPoint) return [seq.inPoint, seq.outPoint, true];
    if (s.loop) return [0, end, true];
    return [0, end, false];
  }

  private startClock(frame: number) {
    frame = Math.floor(frame + 1e-6);
    const seq = getState().project.seq;
    const [lo, hi] = this.range(seq);
    const rate = transport.rate;
    if (rate > 0 && frame >= hi - 1) frame = lo;
    if (rate > 0 && getState().loop && (frame < lo || frame >= hi)) frame = lo;
    transport.frame = frame;
    this.clock = { perf0: performance.now(), frame0: frame, rate, seq: transport.seekSeq };
    if (rate === 1) {
      const ctx = this.audio.ctx;
      const suspended = ctx.state !== 'running';
      const t0 = this.audio.start(seq, mediaLookup(), frame);
      const lead = t0 - ctx.currentTime + this.audio.latency;
      this.clock.perf0 = performance.now() + lead * 1000;
      // A suspended context's clock is frozen until resume() settles, so the audio was scheduled late
      // relative to the video clock: re-align both once it runs.
      if (suspended) {
        const clock = this.clock;
        void ctx
          .resume()
          .then(() => {
            if (!this.disposed && this.clock === clock && ctx.state === 'running') this.startClock(transport.frame);
          })
          .catch(() => {});
      }
    } else this.audio.stop();
  }

  private restartClock(frame: number) {
    if (!this.clock) return;
    this.startClock(frame);
  }

  private stopClock() {
    this.clock = null;
    this.audio.stop();
    for (const v of this.voices.values()) v.voice.idle();
  }

  private tick = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    if (this.comp.lost) return;
    const s = getState();
    const seq = s.project.seq;
    let f = transport.frame;
    if (this.clock) {
      const c = this.clock;
      const fps = exactFps(seq.fps);
      f = c.frame0 + (Math.max(0, performance.now() - c.perf0) / 1000) * fps * c.rate;
      const [lo, hi, looping] = this.range(seq);
      if (c.rate > 0 && f >= hi) {
        if (looping) {
          transport.frame = lo;
          this.startClock(lo);
          f = lo;
        } else {
          transport.pause();
          transport.seek(hi);
          f = hi;
        }
      } else if (c.rate < 0 && f <= 0) {
        transport.pause();
        transport.seek(0);
        f = 0;
      } else transport.tick(f);
      this.audio.scan();
    }
    const fi = Math.floor(f + 1e-6);
    const lookup = mediaLookup(s.project);
    const plan = planFrame(seq, lookup, fi);
    this.lastPlan = plan;
    this.syncVoices(plan, fi, seq, lookup);
    if (fi !== this.lastFrame || this.dirty) {
      this.dirty = false;
      this.lastFrame = fi;
      this.render(plan, seq, s);
    }
    this.meterLevels = this.audio.meters();
    void now;
  };

  private layersOf(plan: TrackPlan[]): LayerEval[] {
    const out: LayerEval[] = [];
    for (const tp of plan) {
      const it = tp.item;
      if (it.kind === 'transition') {
        if (it.a) out.push(it.a);
        if (it.b) out.push(it.b);
      } else out.push(it.layer);
    }
    return out;
  }

  private voiceFor(clipId: string, media: MediaItem) {
    let v = this.voices.get(clipId);
    // Failed element, or the clip's media now points at another file (Replace Footage / relink / undo).
    if (v && (voiceFailed(v.voice) || v.path !== media.path)) {
      v.voice.dispose();
      v.tex.dispose();
      this.voices.delete(clipId);
      v = undefined;
    }
    if (!v) {
      v = { voice: createVoice(clipId, media, this.host, this.wake), tex: this.comp.createTexture(), path: media.path };
      this.voices.set(clipId, v);
    }
    return v;
  }

  private syncVoices(plan: TrackPlan[], fi: number, seq: Sequence, lookup: (id: string) => MediaItem | undefined) {
    // Elements start rolling only once the clock does (it waits for the audio lead-in).
    const playing = !!this.clock && performance.now() >= this.clock.perf0 - 10;
    const rate = this.clock?.rate ?? 1;
    const forward = playing && rate > 0;
    const needed = new Set<string>();
    for (const l of this.layersOf(plan)) {
      if (l.media.kind !== 'video' || !l.media.path) continue;
      needed.add(l.clip.id);
      const v = this.voiceFor(l.clip.id, l.media);
      v.voice.sync(l.srcTime + 0.001, forward, rate * l.clip.speed, transport.scrubbing);
    }
    // Pre-roll clips that start soon so their first frame is decoded when they cut in.
    if (this.clock && rate > 0) {
      const horizon = fi + Math.ceil(exactFps(seq.fps) * 1.2);
      const videoTracks = new Set(seq.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id));
      for (const c of seq.clips) {
        if (c.start <= fi || c.start > horizon || !videoTracks.has(c.trackId) || !c.enabled || needed.has(c.id)) continue;
        const m = lookup(c.mediaId);
        if (!m || m.kind !== 'video' || !m.path || m.missing) continue;
        needed.add(c.id);
        const v = this.voiceFor(c.id, m);
        v.voice.sync(Math.max(0, evalLayer(c, m, c.start, seq.fps).srcTime) + 0.001, false, 1, false);
      }
    }
    for (const [id, v] of this.voices) if (!needed.has(id)) v.voice.idle();
    if (this.voices.size > MAX_VOICES) {
      const idle = [...this.voices.entries()].filter(([id]) => !needed.has(id)).sort((a, b) => a[1].voice.lastUse - b[1].voice.lastUse);
      for (const [id, v] of idle.slice(0, this.voices.size - MAX_VOICES)) {
        v.voice.dispose();
        v.tex.dispose();
        this.voices.delete(id);
      }
    }
    // Drop voices of deleted clips.
    if (this.voices.size) {
      for (const [id, v] of this.voices) {
        if (needed.has(id)) continue;
        if (!seq.clips.some((c) => c.id === id)) {
          v.voice.dispose();
          v.tex.dispose();
          this.voices.delete(id);
        }
      }
    }
  }

  private source = (layer: LayerEval): LayerSource | null => {
    const m = layer.media;
    if (m.kind === 'image' && m.path) {
      const b = this.images.get(m.path);
      if (b === undefined) {
        this.images.set(m.path, 'loading');
        loadImage(m.path)
          .then((bmp) => {
            this.images.set(m.path!, bmp);
            this.dirty = true;
          })
          .catch(() => this.images.set(m.path!, 'error'));
        return null;
      }
      if (typeof b === 'string') return null;
      return { kind: 'tex', tex: this.comp.imageTexture(m.path, b), w: m.width || b.width, h: m.height || b.height };
    }
    if (m.kind === 'video') {
      const v = this.voices.get(layer.clip.id);
      if (!v) return null;
      if (!v.voice.upload(v.tex)) return null;
      const [w, h] = v.voice.size;
      return { kind: 'tex', tex: v.tex, w: w || v.tex.width, h: h || v.tex.height };
    }
    return null;
  };

  /** Device-pixel rect of the frame inside the canvas. */
  viewRect(seq: Sequence = getState().project.seq): [number, number, number, number] {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const z = getState().monitorZoom;
    const dpr = window.devicePixelRatio || 1;
    const k = z > 0 ? (z / 100) * dpr : Math.min((cw - 8 * dpr) / seq.width, (ch - 8 * dpr) / seq.height);
    const w = seq.width * k;
    const h = seq.height * k;
    return [Math.round((cw - w) / 2), Math.round((ch - h) / 2), Math.round(w), Math.round(h)];
  }

  private render(plan: TrackPlan[], seq: Sequence, s: VideoState) {
    const rect = this.viewRect(seq);
    // Never render more pixels than the monitor shows (unless zoomed in).
    const displayScale = rect[2] / seq.width;
    const scale = Math.min(s.playbackRes, Math.max(0.2, displayScale));
    try {
      this.result = this.comp.render({ plan, seqW: seq.width, seqH: seq.height, scale, bg: seq.bg, source: this.source });
      this.comp.present(this.result, rect, [0.055, 0.055, 0.06]);
    } catch (e) {
      console.error('render failed', e);
    }
    this.onFrame?.();
  }

  /** Forces a redraw on the next tick (e.g. after a canvas resize). */
  invalidate() {
    this.dirty = true;
  }

  /** Renders the current frame at full sequence resolution and returns it as a PNG blob. */
  async snapshot(): Promise<Blob> {
    const s = getState();
    const seq = s.project.seq;
    const plan = planFrame(seq, mediaLookup(s.project), transport.frameInt);
    const res = this.comp.render({ plan, seqW: seq.width, seqH: seq.height, scale: 1, bg: seq.bg, source: this.source });
    const img = res.toImageData();
    this.dirty = true;
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    this.audio.dispose();
    for (const v of this.voices.values()) {
      v.voice.dispose();
      v.tex.dispose();
    }
    this.voices.clear();
    this.comp.dispose();
    if (transport.playing) transport.pause();
  }
}

