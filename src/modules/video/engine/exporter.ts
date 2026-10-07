/**
 * Offline, frame-accurate export. Every output frame is composited by the same GPU compositor as
 * the monitor, from exact decoded source frames (mediabunny CanvasSink iterating sequential
 * timestamps per clip — no random seeks), then encoded with WebCodecs via mediabunny. Audio is
 * mixed in sample-exact chunks with OfflineAudioContext using the live graph logic.
 */
import {
  AudioBufferSource,
  AudioCodec,
  StreamTarget,
  type StreamTargetChunk,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoCodec,
  WebMOutputFormat,
  WrappedCanvas,
} from 'mediabunny';
import type { Texture } from '@/core/gl/gl';
import { api } from '@/platform/api';
import { LayerEval, planFrame } from '../model/evaluate';
import { exactFps } from '../model/time';
import type { MediaItem, Project } from '../model/types';
import { renderAudioRange } from './audio';
import { Compositor, LayerSource } from './compositor';
import { loadImage, openInput } from './media';

export interface ExportOptions {
  path: string;
  container: 'mp4' | 'webm';
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | null;
  width: number;
  height: number;
  fps: number;
  /** Quality preset or bits per second. */
  quality: Quality | number;
  audioBitrate: number;
  /** Sequence frame range [start, end). */
  start: number;
  end: number;
}

export interface ExportProgress {
  frame: number;
  total: number;
  elapsed: number;
}

interface ClipFrames {
  media: MediaItem;
  /** Output frame indices where this clip is visible, ascending. */
  frames: number[];
  times: number[];
}

/** Sequential frame reader for one clip. */
class FrameReader {
  private iter: AsyncGenerator<WrappedCanvas | null, void, unknown> | null = null;
  private el: HTMLVideoElement | null = null;
  private pos = 0;
  private current: TexImageSource | null = null;
  readonly tex: Texture;
  constructor(
    private info: ClipFrames,
    private getInput: (path: string) => Promise<Input>,
    comp: Compositor,
    private maxDim: number,
  ) {
    this.tex = comp.createTexture();
  }

  private async init() {
    const m = this.info.media;
    if (!m.probeFallback) {
      try {
        const input = await this.getInput(m.path!);
        const vt = await input.getPrimaryVideoTrack();
        if (vt && (await vt.canDecode())) {
          const first = await vt.getFirstTimestamp();
          const w = await vt.getDisplayWidth();
          const h = await vt.getDisplayHeight();
          const k = Math.min(1, this.maxDim / Math.max(w, h));
          const sink = new CanvasSink(vt, { poolSize: 3, ...(k < 1 ? { width: Math.round(w * k), height: Math.round(h * k), fit: 'fill' as const } : {}) });
          this.iter = sink.canvasesAtTimestamps(this.info.times.map((t) => first + t));
          return;
        }
      } catch {
        /* element fallback */
      }
    }
    const el = document.createElement('video');
    el.crossOrigin = 'anonymous';
    el.muted = true;
    el.preload = 'auto';
    el.src = api.fileUrl(m.path!);
    await new Promise<void>((res, rej) => {
      el.onloadeddata = () => res();
      el.onerror = () => rej(new Error(`Can't decode ${m.name}`));
    });
    this.el = el;
  }

  /** Frame for output frame `k` (must be called in ascending order of k). */
  async frameFor(k: number): Promise<boolean> {
    if (!this.iter && !this.el) await this.init();
    const idx = this.info.frames.indexOf(k, this.pos);
    if (idx < 0) return !!this.current;
    if (this.iter) {
      while (this.pos <= idx) {
        const r = await this.iter.next();
        this.pos++;
        if (r.done) break;
        if (r.value) this.current = r.value.canvas as TexImageSource;
      }
    } else if (this.el) {
      this.pos = idx + 1;
      const t = this.info.times[idx];
      const el = this.el;
      if (Math.abs(el.currentTime - t) > 1e-4) {
        await new Promise<void>((res) => {
          el.onseeked = () => res();
          el.currentTime = t;
        });
      }
      this.current = el;
    }
    if (this.current) this.tex.upload(this.current);
    return !!this.current;
  }

  get done() {
    return this.pos >= this.info.frames.length;
  }

  close() {
    void this.iter?.return();
    this.iter = null;
    if (this.el) {
      this.el.removeAttribute('src');
      this.el.load();
      this.el = null;
    }
    this.tex.dispose();
  }
}

export async function exportSequence(project: Project, o: ExportOptions, onProgress: (p: ExportProgress) => void, isCancelled: () => boolean): Promise<void> {
  const seq = project.seq;
  const media = new Map(project.media.map((m) => [m.id, m]));
  const lookup = (id: string) => media.get(id);
  const seqFps = exactFps(seq.fps);
  const outFps = exactFps(o.fps);
  const duration = (o.end - o.start) / seqFps;
  const total = Math.max(1, Math.round(duration * outFps));
  const frameAt = (k: number) => o.start + Math.floor((k / outFps) * seqFps + 1e-6);

  // Which clips need which source frames (and which stills are used).
  const needs = new Map<string, ClipFrames>();
  const usedImages = new Set<MediaItem>();
  for (let k = 0; k < total; k++) {
    const plan = planFrame(seq, lookup, frameAt(k));
    for (const tp of plan) {
      const it = tp.item;
      const layers: LayerEval[] = it.kind === 'transition' ? ([it.a, it.b].filter(Boolean) as LayerEval[]) : [it.layer];
      for (const l of layers) {
        if (l.media.kind === 'image' && l.media.path) usedImages.add(l.media);
        if (l.media.kind !== 'video' || !l.media.path) continue;
        let n = needs.get(l.clip.id);
        if (!n) needs.set(l.clip.id, (n = { media: l.media, frames: [], times: [] }));
        n.frames.push(k);
        n.times.push(l.srcTime + 0.001);
      }
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const comp = new Compositor(canvas, { preserve: true });
  const inputs = new Map<string, Promise<Input>>();
  const getInput = (path: string) => {
    let p = inputs.get(path);
    if (!p) inputs.set(path, (p = openInput(path)));
    return p;
  };
  const readers = new Map<string, FrameReader>();
  const images = new Map<string, ImageBitmap>();
  let file: Awaited<ReturnType<typeof api.openWriteStream>> | null = null;
  let output: Output | null = null;
  let started = false;
  const SR = 48000;
  try {
    // Only stills that are actually on screen in the range; an unused or unreadable one mustn't fail the export.
    for (const m of usedImages) {
      try {
        images.set(m.path!, await loadImage(m.path!));
      } catch (e) {
        console.warn('export: image unavailable', m.name, e);
      }
    }
    // Stream straight to disk in 16 MiB chunks so long exports never sit in memory.
    const stream = (file = await api.openWriteStream(o.path));
    const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => stream.write(chunk.data, chunk.position) });
    output = new Output({
      format: o.container === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(writable, { chunked: true }),
    });
    const vSource = new CanvasSource(canvas, {
      codec: o.videoCodec,
      ...(typeof o.quality === 'number' ? { bitrate: o.quality } : { quality: o.quality }),
      keyFrameInterval: 2,
      sizeChangeBehavior: 'contain',
    });
    output.addVideoTrack(vSource, { frameRate: o.fps });
    const aSource = o.audioCodec ? new AudioBufferSource({ codec: o.audioCodec, bitrate: o.audioBitrate }) : null;
    if (aSource) output.addAudioTrack(aSource);
    const t0 = performance.now();
    await output.start();
    started = true;
    const audioSamples = Math.round(duration * SR);
    const CHUNK = SR * 4;
    let audioDone = 0;
    const pumpAudio = async (untilSec: number) => {
      if (!aSource) return;
      while (audioDone < audioSamples && audioDone / SR < untilSec) {
        const n = Math.min(CHUNK, audioSamples - audioDone);
        const startFrame = o.start + (audioDone / SR) * seqFps;
        const buf = await renderAudioRange(seq, lookup, startFrame, n, SR);
        await aSource.add(buf);
        audioDone += n;
      }
    };
    const maxDim = Math.max(o.width, o.height) * 2;
    for (let k = 0; k < total; k++) {
      if (isCancelled()) throw new DOMException('Export cancelled', 'AbortError');
      const f = frameAt(k);
      const plan = planFrame(seq, lookup, f);
      // Fetch source frames.
      const ready = new Set<string>();
      for (const tp of plan) {
        const it = tp.item;
        const layers: LayerEval[] = it.kind === 'transition' ? ([it.a, it.b].filter(Boolean) as LayerEval[]) : [it.layer];
        for (const l of layers) {
          const info = needs.get(l.clip.id);
          if (!info) continue;
          let r = readers.get(l.clip.id);
          if (!r) readers.set(l.clip.id, (r = new FrameReader(info, getInput, comp, maxDim)));
          if (await r.frameFor(k)) ready.add(l.clip.id);
        }
      }
      const source = (l: LayerEval): LayerSource | null => {
        const m = l.media;
        if (m.kind === 'image' && m.path) {
          const b = images.get(m.path);
          return b ? { kind: 'tex', tex: comp.imageTexture(m.path, b), w: m.width || b.width, h: m.height || b.height } : null;
        }
        if (m.kind === 'video') {
          const r = readers.get(l.clip.id);
          if (!r || !ready.has(l.clip.id)) return null;
          return { kind: 'tex', tex: r.tex, w: m.width || r.tex.width, h: m.height || r.tex.height };
        }
        return null;
      };
      const res = comp.render({ plan, seqW: seq.width, seqH: seq.height, scale: o.width / seq.width, bg: seq.bg, source });
      comp.blit(res);
      await vSource.add(k / outFps, 1 / outFps);
      // Close finished readers to free decoders.
      for (const [id, r] of readers)
        if (r.done) {
          r.close();
          readers.delete(id);
          needs.delete(id);
        }
      await pumpAudio((k + 1) / outFps + 1);
      if (k % 4 === 0) {
        onProgress({ frame: k + 1, total, elapsed: (performance.now() - t0) / 1000 });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await pumpAudio(Infinity);
    onProgress({ frame: total, total, elapsed: (performance.now() - t0) / 1000 });
    await output.finalize();
    await stream.close();
  } catch (e) {
    if (started) await output?.cancel().catch(() => {});
    // Discard the partial file.
    await file?.close(true).catch(() => {});
    throw e;
  } finally {
    for (const r of readers.values()) r.close();
    for (const p of inputs.values()) p.then((i) => i.dispose()).catch(() => {});
    comp.dispose();
  }
}

