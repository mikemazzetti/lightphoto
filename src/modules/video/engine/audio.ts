/**
 * Web Audio graph for the timeline:
 *   clip source(s) → clip gain (volume dB + keyframes + fades) → stereo pan → track gain (mute/solo/
 *   volume) → master → analysers (meters) → destination
 *
 * Audio is decoded on the fly (mediabunny AudioBufferSink) and scheduled sample-accurately as
 * AudioBufferSourceNodes, a little ahead of the playhead. Files mediabunny can't decode fall back to a
 * fully decoded buffer (decodeAudioData) or, last resort / pitch-preserving speed changes, to a
 * MediaElementAudioSource. The same scheduling code renders offline for export.
 */
import { api } from '@/platform/api';
import { audioGainAt, audioGainIsStatic, trackGain } from '../model/evaluate';
import { paramAt } from '../model/keyframes';
import { clipEnd } from '../model/ops';
import { exactFps } from '../model/time';
import type { Clip, MediaItem, Sequence } from '../model/types';
import { AudioProvider, audioChunks, getAudioProvider } from './media';

type Ctx = BaseAudioContext;

export interface ScheduleOpts {
  seq: Sequence;
  /** Timeline frame that plays at ctx time `t0`. */
  frame0: number;
  t0: number;
  /** Stop scheduling at this timeline frame (exclusive). */
  endFrame: number;
  /** Seconds of look-ahead for live playback (Infinity = schedule everything, offline). */
  lookahead: number;
  allowElement: boolean;
}

/** One clip's playback: gain/pan nodes plus scheduled buffer sources. */
export class ClipVoice {
  readonly gain: GainNode;
  readonly pan: StereoPannerNode;
  private sources = new Set<AudioBufferSourceNode>();
  private stopped = false;
  private element: HTMLAudioElement | null = null;
  private elementSrc: MediaElementAudioSourceNode | null = null;
  done: Promise<void> = Promise.resolve();

  constructor(
    readonly ctx: Ctx,
    dest: AudioNode,
    readonly clip: Clip,
    readonly media: MediaItem,
    readonly o: ScheduleOpts,
  ) {
    this.gain = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.gain.connect(this.pan);
    this.pan.connect(dest);
  }

  private fps() {
    return exactFps(this.o.seq.fps);
  }

  /** Context time at which timeline frame `f` plays. */
  private when(f: number) {
    return this.o.t0 + (f - this.o.frame0) / this.fps();
  }

  private automation(localStart: number, localEnd: number) {
    const c = this.clip;
    const t0 = this.when(c.start + localStart);
    const dur = (localEnd - localStart) / this.fps();
    if (dur <= 0) return;
    if (audioGainIsStatic(c)) this.gain.gain.setValueAtTime(audioGainAt(c, localStart), Math.max(0, t0));
    else {
      const n = Math.max(2, Math.min(20000, Math.ceil(localEnd - localStart) + 1));
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = audioGainAt(c, localStart + ((localEnd - localStart) * i) / (n - 1));
      this.gain.gain.setValueAtTime(curve[0], Math.max(0, t0 - 0.001));
      this.gain.gain.setValueCurveAtTime(curve, Math.max(0, t0), dur);
    }
    const kp = c.kf.pan;
    if (kp?.length) {
      const n = Math.max(2, Math.min(20000, Math.ceil(localEnd - localStart) + 1));
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = Math.max(-1, Math.min(1, paramAt(c, 'pan', localStart + ((localEnd - localStart) * i) / (n - 1)) / 100));
      this.pan.pan.setValueCurveAtTime(curve, Math.max(0, t0), dur);
    } else this.pan.pan.value = Math.max(-1, Math.min(1, c.pan / 100));
  }

  /** Starts scheduling. Resolves when every chunk has been scheduled (or the voice stopped). */
  start(provider: AudioProvider) {
    const c = this.clip;
    const fps = this.fps();
    const localStart = Math.max(0, this.o.frame0 - c.start);
    const localEnd = Math.min(c.duration, this.o.endFrame - c.start);
    if (localEnd <= localStart) return;
    // Live: the provider may resolve after the scheduled start. Automation events in the past get clamped
    // to "now" by Web Audio (shifting fades/keyframes late), so start the curves at the current position.
    let autoStart = localStart;
    if (Number.isFinite(this.o.lookahead)) {
      const late = this.ctx.currentTime - this.when(c.start + localStart);
      if (late > 0) autoStart = Math.min(localEnd, localStart + late * fps);
    }
    this.automation(autoStart, localEnd);
    const srcStart = c.inPoint + (localStart / fps) * c.speed;
    const srcEnd = c.inPoint + (localEnd / fps) * c.speed;
    const useElement = this.o.allowElement && (provider.kind === 'none' || (c.speed !== 1 && c.maintainPitch));
    if (useElement) {
      this.startElement(srcStart, srcEnd, localStart);
      return;
    }
    if (provider.kind === 'none') return;
    this.done = this.pump(provider, srcStart, srcEnd);
  }

  /** Context time at which source time `s` plays. */
  private whenSrc(s: number) {
    const c = this.clip;
    return this.when(c.start) + (s - c.inPoint) / c.speed;
  }

  private async pump(provider: AudioProvider, srcStart: number, srcEnd: number) {
    const c = this.clip;
    const ctx = this.ctx;
    const live = Number.isFinite(this.o.lookahead);
    // Fetch a little before srcStart so the first chunk covers it.
    try {
      for await (const { buffer, timestamp } of audioChunks(provider, Math.max(0, srcStart - 0.05), srcEnd + 0.05)) {
        if (this.stopped) return;
        const ts = timestamp;
        const te = ts + buffer.duration;
        const a = Math.max(ts, srcStart);
        const b = Math.min(te, srcEnd);
        if (b <= a) {
          if (ts >= srcEnd) break;
          continue;
        }
        let when = this.whenSrc(a);
        let offset = a - ts;
        let dur = b - a;
        if (live) {
          const late = ctx.currentTime - when;
          if (late > 0) {
            const skip = late * c.speed;
            if (skip >= dur) continue;
            offset += skip;
            dur -= skip;
            when = ctx.currentTime;
          }
        }
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = c.speed;
        node.connect(this.gain);
        node.start(Math.max(0, when), offset, dur);
        this.sources.add(node);
        node.onended = () => this.sources.delete(node);
        // Stay at most `lookahead` seconds ahead of the clock.
        if (live) {
          while (!this.stopped && this.whenSrc(b) - ctx.currentTime > this.o.lookahead) await new Promise((r) => setTimeout(r, 120));
        }
      }
    } catch (e) {
      if (!this.stopped) console.warn('audio decode', this.media.name, e);
    }
  }

  private startElement(srcStart: number, srcEnd: number, localStart: number) {
    if (!(this.ctx instanceof AudioContext) || !this.media.path) return;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = api.fileUrl(this.media.path);
    (el as any).preservesPitch = this.clip.maintainPitch;
    el.playbackRate = this.clip.speed;
    this.element = el;
    try {
      this.elementSrc = this.ctx.createMediaElementSource(el);
      this.elementSrc.connect(this.gain);
    } catch {
      return;
    }
    const begin = () => {
      if (this.stopped) return;
      el.currentTime = srcStart;
      void el.play().catch(() => {});
    };
    const delay = (this.when(this.clip.start + localStart) - (this.ctx as AudioContext).currentTime) * 1000;
    if (delay > 5) setTimeout(begin, delay);
    else begin();
    const endDelay = (this.whenSrc(srcEnd) - (this.ctx as AudioContext).currentTime) * 1000;
    setTimeout(() => el.pause(), Math.max(0, endDelay));
  }

  /** Expected source time right now (for element drift correction). */
  syncElement() {
    const el = this.element;
    if (!el || el.paused || !(this.ctx instanceof AudioContext)) return;
    const c = this.clip;
    const expected = c.inPoint + (this.ctx.currentTime - this.when(c.start)) * c.speed;
    if (Math.abs(el.currentTime - expected) > 0.12) el.currentTime = expected;
  }

  stop() {
    this.stopped = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    this.sources.clear();
    if (this.element) {
      this.element.pause();
      this.element.removeAttribute('src');
      this.element.load();
    }
    this.elementSrc?.disconnect();
    try {
      this.gain.gain.cancelScheduledValues(0);
    } catch {
      /* ignore */
    }
    this.gain.disconnect();
    this.pan.disconnect();
  }
}

/** Builds the track → master part of the graph in any context. */
export function buildTrackBus(ctx: Ctx, seq: Sequence, dest: AudioNode): Map<string, GainNode> {
  const m = new Map<string, GainNode>();
  for (const t of seq.tracks) {
    if (t.kind !== 'audio') continue;
    const g = ctx.createGain();
    g.gain.value = trackGain(seq, t);
    g.connect(dest);
    m.set(t.id, g);
  }
  return m;
}

/** Audio clips that should sound (enabled, on an audio track, media present). */
export function audibleClips(seq: Sequence, media: (id: string) => MediaItem | undefined): Clip[] {
  const audioTracks = new Set(seq.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
  return seq.clips.filter((c) => {
    if (!audioTracks.has(c.trackId) || !c.enabled) return false;
    const m = media(c.mediaId);
    return !!m && !m.missing && m.hasAudio;
  });
}

export interface MeterLevels {
  peak: [number, number];
  rms: [number, number];
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  private analysers: AnalyserNode[];
  private buf: Float32Array<ArrayBuffer>;
  private bus = new Map<string, GainNode>();
  private voices = new Map<string, ClipVoice>();
  private session: { seq: Sequence; frame0: number; t0: number; media: (id: string) => MediaItem | undefined } | null = null;
  private lastScan = 0;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    const split = this.ctx.createChannelSplitter(2);
    this.master.connect(split);
    this.master.connect(this.ctx.destination);
    this.analysers = [0, 1].map((i) => {
      const a = this.ctx.createAnalyser();
      a.fftSize = 1024;
      a.smoothingTimeConstant = 0;
      split.connect(a, i);
      return a;
    });
    this.buf = new Float32Array(1024);
  }

  get playing() {
    return !!this.session;
  }

  /** Output latency estimate (seconds) to align video with what's heard. */
  get latency() {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  /**
   * Starts playback of the sequence at `frame`; returns the context time at which that frame is
   * heard (callers align the video clock to it).
   */
  start(seq: Sequence, media: (id: string) => MediaItem | undefined, frame: number, lead = 0.08): number {
    this.stop();
    void this.ctx.resume();
    const t0 = this.ctx.currentTime + lead;
    this.session = { seq, frame0: frame, t0, media };
    this.rebuildBus(seq);
    this.scan(true);
    return t0;
  }

  private rebuildBus(seq: Sequence) {
    for (const g of this.bus.values()) g.disconnect();
    this.bus = buildTrackBus(this.ctx, seq, this.master);
  }

  /** Live mute/solo/volume changes without rescheduling. */
  updateTracks(seq: Sequence) {
    for (const t of seq.tracks) {
      const g = this.bus.get(t.id);
      if (g) g.gain.setTargetAtTime(trackGain(seq, t), this.ctx.currentTime, 0.015);
    }
  }

  /** Schedules clips that begin within the look-ahead window. Call every tick while playing. */
  scan(force = false) {
    const s = this.session;
    if (!s) return;
    const now = performance.now();
    if (!force && now - this.lastScan < 100) {
      for (const v of this.voices.values()) v.syncElement();
      return;
    }
    this.lastScan = now;
    const fps = exactFps(s.seq.fps);
    const ctxNow = this.ctx.currentTime;
    const curFrame = s.frame0 + (ctxNow - s.t0) * fps;
    const horizon = curFrame + 2.5 * fps;
    for (const c of audibleClips(s.seq, s.media)) {
      if (this.voices.has(c.id)) continue;
      if (clipEnd(c) <= Math.max(curFrame, s.frame0) || c.start > horizon) continue;
      const m = s.media(c.mediaId)!;
      const bus = this.bus.get(c.trackId);
      if (!bus) continue;
      const v = new ClipVoice(this.ctx, bus, c, m, { seq: s.seq, frame0: Math.max(s.frame0, Math.floor(curFrame)), t0: s.t0 + (Math.max(s.frame0, Math.floor(curFrame)) - s.frame0) / fps, endFrame: Infinity, lookahead: 1.5, allowElement: true });
      this.voices.set(c.id, v);
      void getAudioProvider(m).then((p) => {
        if (this.voices.get(c.id) === v && this.session === s) v.start(p);
      });
    }
    for (const v of this.voices.values()) v.syncElement();
  }

  stop() {
    for (const v of this.voices.values()) v.stop();
    this.voices.clear();
    this.session = null;
  }

  /** Peak / RMS per channel of what's playing right now. */
  meters(): MeterLevels {
    const peak: [number, number] = [0, 0];
    const rms: [number, number] = [0, 0];
    this.analysers.forEach((a, i) => {
      a.getFloatTimeDomainData(this.buf);
      let p = 0;
      let s = 0;
      for (let j = 0; j < this.buf.length; j++) {
        const v = this.buf[j];
        const av = v < 0 ? -v : v;
        if (av > p) p = av;
        s += v * v;
      }
      peak[i] = p;
      rms[i] = Math.sqrt(s / this.buf.length);
    });
    return { peak, rms };
  }

  dispose() {
    this.stop();
    void this.ctx.close();
  }
}

/**
 * Offline mix (export): `length` samples starting at (fractional) timeline frame `f0`. Chunks are
 * sample-exact so consecutive renders join seamlessly.
 */
export async function renderAudioRange(seq: Sequence, media: (id: string) => MediaItem | undefined, f0: number, length: number, sampleRate = 48000): Promise<AudioBuffer> {
  const fps = exactFps(seq.fps);
  const f1 = f0 + (length / sampleRate) * fps;
  const ctx = new OfflineAudioContext(2, Math.max(1, length), sampleRate);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const bus = buildTrackBus(ctx, seq, master);
  const voices: ClipVoice[] = [];
  for (const c of audibleClips(seq, media)) {
    if (clipEnd(c) <= f0 || c.start >= f1) continue;
    const g = bus.get(c.trackId);
    if (!g || g.gain.value === 0) continue;
    const m = media(c.mediaId)!;
    const v = new ClipVoice(ctx, g, c, m, { seq, frame0: f0, t0: 0, endFrame: f1, lookahead: Infinity, allowElement: false });
    v.start(await getAudioProvider(m));
    voices.push(v);
  }
  await Promise.all(voices.map((v) => v.done));
  return ctx.startRendering();
}
