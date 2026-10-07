import { useEffect, useState } from 'react';
import { AudioCodec, canEncodeAudio, canEncodeVideo, QUALITY_HIGH, QUALITY_LOW, QUALITY_MEDIUM, QUALITY_VERY_HIGH, VideoCodec } from 'mediabunny';
import { api, basename } from '@/platform/api';
import { errorToast, openDialog, startTask, toast } from '@/state/app';
import { Button, Checkbox, NumberField, Select } from '@/ui/controls';
import { Modal } from '@/ui/overlays';
import { sequenceEnd } from '../model/ops';
import { exactFps, formatDuration, FPS_OPTIONS, timecode } from '../model/time';
import { exportSequence } from '../engine/exporter';
import { getProject, getSeq, getState } from '../state/store';
import { transport } from '../state/transport';

interface Format {
  id: string;
  label: string;
  container: 'mp4' | 'webm';
  video: VideoCodec;
  audio: AudioCodec[];
}

const FORMATS: Format[] = [
  { id: 'h264', label: 'MP4 — H.264 (most compatible)', container: 'mp4', video: 'avc', audio: ['aac', 'opus'] },
  { id: 'hevc', label: 'MP4 — HEVC / H.265', container: 'mp4', video: 'hevc', audio: ['aac', 'opus'] },
  { id: 'av1mp4', label: 'MP4 — AV1', container: 'mp4', video: 'av1', audio: ['aac', 'opus'] },
  { id: 'vp9', label: 'WebM — VP9 + Opus', container: 'webm', video: 'vp9', audio: ['opus'] },
  { id: 'av1webm', label: 'WebM — AV1 + Opus', container: 'webm', video: 'av1', audio: ['opus'] },
];

const QUALITIES = [
  { value: 'veryhigh', label: 'Very High', q: QUALITY_VERY_HIGH },
  { value: 'high', label: 'High', q: QUALITY_HIGH },
  { value: 'medium', label: 'Medium', q: QUALITY_MEDIUM },
  { value: 'low', label: 'Low', q: QUALITY_LOW },
  { value: 'custom', label: 'Target Bitrate…', q: null },
] as const;

let lastSettings: { format: string; scale: number; quality: string; mbps: number; audio: boolean; abr: number } | null = null;

export function openExportDialog() {
  const seq = getSeq();
  if (!seq.clips.length) return toast('The sequence is empty — add clips before exporting.', 'info');
  if (transport.playing) transport.pause();
  return openDialog((close) => <ExportDialog close={() => close()} />);
}

function ExportDialog({ close }: { close: () => void }) {
  const seq = getSeq();
  const [format, setFormat] = useState(lastSettings?.format ?? 'h264');
  const [scale, setScale] = useState(lastSettings?.scale ?? 1);
  const [fps, setFps] = useState(seq.fps);
  const [quality, setQuality] = useState<string>(lastSettings?.quality ?? 'high');
  const [mbps, setMbps] = useState(lastSettings?.mbps ?? 16);
  const [audio, setAudio] = useState(lastSettings?.audio ?? true);
  const [abr, setAbr] = useState(lastSettings?.abr ?? 192);
  const hasRange = seq.inPoint !== null || seq.outPoint !== null;
  const [range, setRange] = useState<'all' | 'inout'>(hasRange ? 'inout' : 'all');
  const [support, setSupport] = useState<Record<string, boolean | undefined>>({});
  const [audioCodec, setAudioCodec] = useState<Record<string, AudioCodec | null>>({});
  const w = Math.max(16, Math.round((seq.width * scale) / 2) * 2);
  const h = Math.max(16, Math.round((seq.height * scale) / 2) * 2);
  const end = sequenceEnd(seq);
  const r0 = range === 'inout' ? seq.inPoint ?? 0 : 0;
  const r1 = range === 'inout' ? seq.outPoint ?? end : end;
  const secs = Math.max(0, r1 - r0) / exactFps(seq.fps);
  const fmt = FORMATS.find((f) => f.id === format)!;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: Record<string, boolean> = {};
      const ac: Record<string, AudioCodec | null> = {};
      for (const f of FORMATS) {
        try {
          out[f.id] = await canEncodeVideo(f.video, { width: w, height: h });
        } catch {
          out[f.id] = false;
        }
        ac[f.id] = null;
        for (const a of f.audio) {
          try {
            if (await canEncodeAudio(a, { numberOfChannels: 2, sampleRate: 48000, bitrate: abr * 1000 })) {
              ac[f.id] = a;
              break;
            }
          } catch {
            /* next */
          }
        }
      }
      if (alive) {
        setSupport(out);
        setAudioCodec(ac);
      }
    })();
    return () => {
      alive = false;
    };
  }, [w, h, abr]);

  const ok = support[format];
  const est = quality === 'custom' ? ((mbps * 1e6 + (audio ? abr * 1000 : 0)) * secs) / 8 / 1e6 : null;

  const start = async () => {
    lastSettings = { format, scale, quality, mbps, audio, abr };
    const ext = fmt.container;
    const path = await api.saveDialog({ title: 'Export Video', defaultPath: `${seq.name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return;
    close();
    const q = QUALITIES.find((x) => x.value === quality)!;
    let cancelled = false;
    const task = startTask(`Exporting ${basename(path)}…`, () => {
      cancelled = true;
    });
    try {
      await exportSequence(
        getProject(),
        {
          path,
          container: fmt.container,
          videoCodec: fmt.video,
          audioCodec: audio ? audioCodec[format] ?? null : null,
          width: w,
          height: h,
          fps,
          quality: q.q ?? Math.round(mbps * 1e6),
          audioBitrate: abr * 1000,
          start: r0,
          end: r1,
        },
        (p) => {
          const frac = p.frame / p.total;
          const eta = frac > 0.02 ? (p.elapsed / frac) * (1 - frac) : NaN;
          task.update(frac, `Exporting ${Math.round(frac * 100)}%${Number.isFinite(eta) ? ` — ${formatDuration(Math.max(1, eta)) || '0:01'} left` : ''}`);
        },
        () => cancelled,
      );
      toast(`Exported ${basename(path)}`, 'success');
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || cancelled) toast('Export cancelled', 'info');
      else errorToast(e, 'Export failed');
    } finally {
      task.done();
    }
  };

  return (
    <Modal
      title="Export Media"
      onClose={close}
      width={500}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 11 }}>
            {timecode(r1 - r0, seq.fps)} · {w}×{h} · {fps} fps{est !== null ? ` · ≈${est.toFixed(est < 10 ? 1 : 0)} MB` : ''}
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={ok === false || r1 <= r0} onClick={() => void start()}>
            Export…
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Format</label>
        <Select value={format} options={FORMATS.map((f) => ({ value: f.id, label: f.label + (support[f.id] === false ? ' (unavailable)' : ''), disabled: support[f.id] === false }))} onChange={setFormat} />
      </div>
      {ok === false && <div style={{ color: 'var(--warn)', fontSize: 11 }}>This encoder isn't available on this system at {w}×{h}.</div>}
      <div className="field">
        <label>Resolution</label>
        <div className="row">
          <Select
            value={scale}
            options={[
              { value: 1, label: `Sequence (${seq.width}×${seq.height})` },
              { value: 0.75, label: '75%' },
              { value: 2 / 3, label: '67%' },
              { value: 0.5, label: '50%' },
              { value: 1 / 3, label: '33%' },
              { value: 0.25, label: '25%' },
              ...(seq.height < 2160 && seq.width <= 1920 ? [{ value: 2, label: '200% (upscale)' }] : []),
            ]}
            onChange={setScale}
          />
          <span className="faint mono">
            {w}×{h}
          </span>
        </div>
      </div>
      <div className="field">
        <label>Frame Rate</label>
        <Select value={fps} options={FPS_OPTIONS.map((f) => ({ value: f, label: `${f} fps${f === seq.fps ? ' (sequence)' : ''}` }))} onChange={setFps} />
      </div>
      <div className="field">
        <label>Quality</label>
        <div className="row">
          <Select value={quality} options={QUALITIES.map((q) => ({ value: q.value, label: q.label }))} onChange={setQuality} />
          {quality === 'custom' && <NumberField value={mbps} onChange={setMbps} min={0.5} max={400} step={0.5} precision={1} suffix=" Mbps" width={86} />}
        </div>
      </div>
      <div className="field">
        <label>Audio</label>
        <div className="row">
          <Checkbox checked={audio} onChange={setAudio}>
            {audioCodec[format] ? audioCodec[format]!.toUpperCase() : 'Unavailable'}
          </Checkbox>
          {audio && (
            <Select
              value={abr}
              options={[96, 128, 192, 256, 320].map((b) => ({ value: b, label: `${b} kbps` }))}
              onChange={setAbr}
            />
          )}
        </div>
      </div>
      <div className="field">
        <label>Range</label>
        <Select
          value={range}
          options={[
            { value: 'all', label: `Entire Sequence (${timecode(end, seq.fps)})` },
            { value: 'inout', label: hasRange ? `Sequence In/Out (${timecode(r1 - r0, seq.fps)})` : 'Sequence In/Out (not set)', disabled: !hasRange },
          ]}
          onChange={setRange}
        />
      </div>
      <div className="faint" style={{ fontSize: 10.5 }}>
        Rendering is frame-accurate and uses hardware encoding when available. You can keep editing; the export uses the sequence as it is now ({getState().project.seq.clips.length} clips).
      </div>
    </Modal>
  );
}
