import { createGL, GL } from '@/core/gl/gl';
import { autoTone, DevelopEngine, EngineSource, whiteBalanceFrom } from '@/core/develop/engine';
import { defaultSettings, DevelopSettings } from '@/core/develop/settings';
import { apply, invert, Mat3, orientedSize, outputToSource } from '@/core/develop/geometry';
import { decodeImage, decodeRawPreview, formatShutter, isRawPath, loadThumbnail } from '@/core/image/decode';
import { debounce } from '@/core/util/async';
import { Photo, settingsHash, useCatalog } from '@/state/catalog';
import { regenerateEditedThumbnail, storeEditedThumbnail } from '../shared/editedThumb';
import { histogramOf, PreviewReader } from './gpu';
import { commit, DevelopState, editCommit, flushSave, LoadStatus, useDevelop, ZoomMode } from './store';
import * as cropTool from './cropTool';
import * as maskTool from './maskTool';

/** Pointer position in CSS px inside the (half-)viewport. `half` = 1 for the right pane in side-by-side. */
export interface VPos {
  cx: number;
  cy: number;
  half: 0 | 1;
}

export interface NavRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 14;
const SBS_GAP = 6;
const BG: [number, number, number] = [0.085, 0.085, 0.09];
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

/** Panels with an on/off switch → the settings keys they neutralise while switched off. */
export const PANEL_KEYS: Record<string, (keyof DevelopSettings)[]> = {
  curve: ['curve'],
  mixer: ['hsl', 'bwMix'],
  grading: ['grading'],
  detail: ['sharpening', 'noise'],
  lens: ['lens'],
  effects: ['vignette', 'grain'],
};

// ---------------------------------------------------------------------------------------------
// Navigator bus — lets the left-panel navigator draw without React re-renders.

type NavListener = { image?: (img: ImageData) => void; rect?: (r: NavRect | null) => void };
export const navBus = {
  listeners: new Set<NavListener>(),
  image: null as ImageData | null,
  rect: null as NavRect | null,
  setImage(img: ImageData | null) {
    this.image = img;
    if (img) for (const l of this.listeners) l.image?.(img);
  },
  setRect(r: NavRect | null) {
    const o = this.rect;
    if (o && r && Math.abs(o.x - r.x) < 1e-5 && Math.abs(o.y - r.y) < 1e-5 && Math.abs(o.w - r.w) < 1e-5 && Math.abs(o.h - r.h) < 1e-5) return;
    this.rect = r;
    for (const l of this.listeners) l.rect?.(r);
  },
  subscribe(l: NavListener) {
    this.listeners.add(l);
    if (this.image) l.image?.(this.image);
    l.rect?.(this.rect);
    return () => void this.listeners.delete(l);
  },
};

let current: ViewerController | null = null;
export const getController = () => current;

const setStatus = (patch: Partial<LoadStatus>) => useDevelop.setState((s) => ({ status: { ...s.status, ...patch } }));

function onlyChanged(a: DevelopSettings, b: DevelopSettings, key: keyof DevelopSettings) {
  for (const k of Object.keys(b) as (keyof DevelopSettings)[]) if (k !== key && a[k] !== b[k]) return false;
  return true;
}

export { CURSORS } from './cursors';

/**
 * Owns the Develop viewer: the WebGL canvas + DevelopEngine, the 2D overlay canvas, the view
 * transform (zoom / pan), photo loading (thumbnail → embedded RAW preview → full decode) and all
 * pointer interaction (pan, click-zoom, WB picker, crop & mask tools). Everything here runs
 * imperatively on requestAnimationFrame — React never re-renders per frame.
 */
export class ViewerController {
  readonly gl: GL;
  readonly engine: DevelopEngine;
  private readonly octx: CanvasRenderingContext2D;
  private readonly reader: PreviewReader;
  private readonly ro: ResizeObserver;
  private readonly unsubs: (() => void)[] = [];
  private disposed = false;

  /** Container size (CSS px) and device pixel ratio. */
  vw = 1;
  vh = 1;
  dpr = 1;
  /** CSS px offset of the displayed image's top-left in the (half-)viewport, CSS px per full-res px. */
  view = { x: 0, y: 0, scale: 1 };
  /** Full-resolution size of what is displayed (output frame; the whole oriented frame in crop mode). */
  dispW = 0;
  dispH = 0;
  private lastVp: [number, number] = [0, 0];
  private sourceRatio: number | null = null;
  private refit = false;

  photoId: string | null = null;
  stage: 'none' | 'thumb' | 'preview' | 'full' = 'none';
  private failed = false;
  private loadStart = 0;
  private fullSource: EngineSource | null = null;
  private fullWaiters: ((s: EngineSource | null) => void)[] = [];
  private token = 0;

  private raf = 0;
  private needImage = false;
  private needPresent = false;
  private needOverlay = false;
  private interactiveUntil = 0;
  /** Overlay auto-hidden after adjusting the selected mask's sliders. */
  private overlaySuppressed = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private rendered = { w: 0, h: 0, overlay: null as string | null };
  private statsAt = 0;
  private statsPending = false;
  private renderCache: { key: unknown[]; value: DevelopSettings } | null = null;

  hover: VPos | null = null;
  spaceHeld = false;
  /** Alt/Option held (brush erase preview). */
  altHeld = false;
  /** Name of the drag in progress (tools use it to show grids etc.). */
  dragging: string | null = null;
  /** Transient centred HUD text drawn on the overlay (e.g. straighten angle). */
  hud: string | null = null;
  /** Straighten ruler line while dragging (CSS px). */
  ruler: [VPos, VPos] | null = null;
  private cursor = '';
  private thumbDebounced = debounce(() => void this.updateThumbnail(), 900);

  constructor(
    readonly container: HTMLDivElement,
    readonly canvas: HTMLCanvasElement,
    readonly overlay: HTMLCanvasElement,
  ) {
    this.gl = createGL(canvas);
    try {
      this.engine = new DevelopEngine(this.gl);
    } catch (e) {
      // Don't leak the context when the pipeline can't be built (e.g. shader compile failure).
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw e;
    }
    this.reader = new PreviewReader(this.gl);
    this.octx = overlay.getContext('2d')!;
    current = this;

    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(container);
    this.onResize();

    container.addEventListener('pointerdown', this.onPointerDown);
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerleave', this.onPointerLeave);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.unsubs.push(useDevelop.subscribe((s, p) => this.onState(s, p)));
    this.schedule();
  }

  // ===========================================================================================
  // Lifecycle

  dispose() {
    if (this.disposed) return;
    this.leavePhoto();
    this.disposed = true;
    // Invalidate in-flight loads: they must not touch the disposed engine or overwrite the status
    // of a controller created after a quick module switch.
    this.token++;
    this.abortDrags();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settleTimer);
    this.thumbDebounced.cancel();
    this.unsubs.forEach((u) => u());
    this.ro.disconnect();
    const c = this.container;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.flushWaiters(null);
    this.releaseFull();
    try {
      this.reader.dispose();
      this.engine.dispose();
    } catch {
      /* context may be lost */
    }
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    navBus.setRect(null);
    if (current === this) current = null;
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    setStatus({ loading: false, error: 'The GPU context was lost. Switch modules and back to reload the viewer.' });
  };

  // ===========================================================================================
  // Photo loading

  /** Loads `photo` (no-op when it's already the loaded photo). */
  load(photo: Photo) {
    if (this.disposed) return;
    if (this.photoId === photo.id && this.stage !== 'none' && !this.failed) return;
    this.leavePhoto();
    const token = ++this.token;
    this.photoId = photo.id;
    this.stage = 'none';
    this.loadStart = performance.now();
    this.failed = false;
    this.flushWaiters(null);
    this.releaseFull();
    this.renderCache = null;
    if (useDevelop.getState().zoomMode === 'custom') this.refit = true;
    setStatus({ loading: true, label: 'Loading…', error: null, full: false });
    this.needImage = true;
    this.schedule();

    const raw = photo.kind === 'raw' || isRawPath(photo.path);
    const entry = { path: photo.path, mtime: photo.mtime, size: photo.size };
    // Instant placeholder: the filmstrip's cached thumbnail (shared bitmap — never close it).
    const orientation = photo.meta?.orientation;
    loadThumbnail(entry, 256).then(
      async (bmp) => {
        if (token !== this.token || this.stage !== 'none') return;
        const rot = raw ? await orientPreview(bmp, orientation) : null;
        if (token !== this.token || this.stage !== 'none') return rot?.close();
        this.useSource(rot ?? bmp, 'thumb');
        rot?.close();
      },
      () => {},
    );
    void (async () => {
      try {
        if (raw) {
          setStatus({ label: 'Loading preview…' });
          const prev = await decodeRawPreview(photo.path).catch(() => null);
          if (token !== this.token) {
            prev?.close();
            return;
          }
          if (prev) {
            const rot = await orientPreview(prev, orientation);
            if (token === this.token) this.useSource(rot ?? prev, 'preview');
            prev.close();
            rot?.close();
            if (token !== this.token) return;
          }
          setStatus({ label: 'Decoding RAW…' });
        }
        const dec = await decodeImage(photo.path);
        if (token !== this.token || this.disposed) {
          if (dec.source instanceof ImageBitmap) dec.source.close();
          return;
        }
        if (!this.useSource(dec.source, 'full')) {
          // e.g. larger than the GPU texture limit: keep the error useSource() reported visible
          // (don't clear it below and pretend the full-quality image is loaded).
          if (dec.source instanceof ImageBitmap) dec.source.close();
          this.flushWaiters(null);
          return;
        }
        this.failed = false;
        this.fullSource = dec.source;
        this.flushWaiters(dec.source);
        setStatus({ loading: false, label: '', error: null, full: true });
        // Thumbnail may be stale if the photo was edited elsewhere (e.g. pasted in Library).
        this.thumbDebounced();
      } catch (e) {
        if (token !== this.token || this.disposed) return;
        this.failed = true;
        this.flushWaiters(null);
        console.error(e);
        setStatus({ loading: false, label: '', error: e instanceof Error ? e.message : String(e), full: false });
      }
    })();
  }

  private useSource(src: EngineSource, stage: 'thumb' | 'preview' | 'full'): boolean {
    const oldW = this.stage !== 'none' && this.engine.hasSource ? this.engine.sourceWidth : 0;
    try {
      this.engine.setSource(src);
    } catch (e) {
      this.failed = true;
      setStatus({ loading: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
    if (oldW) this.sourceRatio = oldW / Math.max(1, this.engine.sourceWidth);
    this.stage = stage;
    this.renderCache = null;
    this.needImage = true;
    this.schedule();
    return true;
  }

  private flushWaiters(s: EngineSource | null) {
    const w = this.fullWaiters;
    this.fullWaiters = [];
    w.forEach((r) => r(s));
  }

  private releaseFull() {
    if (this.fullSource instanceof ImageBitmap) this.fullSource.close();
    this.fullSource = null;
  }

  /** Resolves with the full-quality decoded source of the loaded photo (null if it failed / photo changed). */
  whenFull(): Promise<EngineSource | null> {
    if (this.fullSource) return Promise.resolve(this.fullSource);
    // Disposed: dispose() already flushed the waiters — a new one would never resolve.
    if (this.disposed || this.failed || !this.photoId) return Promise.resolve(null);
    return new Promise((r) => this.fullWaiters.push(r));
  }

  /** Saves the photo being left and refreshes its edited thumbnail if stale. */
  private leavePhoto() {
    const id = this.photoId;
    if (!id) return;
    this.thumbDebounced.cancel();
    flushSave();
    const photo = useCatalog.getState().photos[id];
    if (!photo) return;
    const want = photo.settings ? settingsHash(photo.settings) : '';
    if ((photo.thumbVariant ?? '') === want) return;
    if (this.stage === 'full') void storeEditedThumbnail(photo, this.engine).catch(() => {});
    else void regenerateEditedThumbnail(id).catch(() => {});
    this.needImage = true;
  }

  /** Re-renders the edited Library thumbnail (debounced after edits settle). */
  async updateThumbnail() {
    const id = this.photoId;
    if (!id || this.stage !== 'full' || this.disposed) return;
    flushSave();
    const photo = useCatalog.getState().photos[id];
    if (!photo) return;
    const want = photo.settings ? settingsHash(photo.settings) : '';
    if ((photo.thumbVariant ?? '') === want) return;
    const p = storeEditedThumbnail(photo, this.engine);
    // The thumbnail render reused the engine's targets: our result is stale now.
    this.needImage = true;
    this.schedule();
    await p.catch(() => {});
  }

  // ===========================================================================================
  // Store → viewer

  private onState(s: DevelopState, p: DevelopState) {
    let image = false;
    let present = false;
    let overlay = false;
    const now = performance.now();
    // A photo switch mid-drag (←/→ while dragging a crop handle or painting) ends the drag.
    if (s.photoId !== p.photoId) this.abortDrags();
    if (s.settings !== p.settings || s.preview !== p.preview) {
      overlay = true;
      const cropOnly = s.tool === 'crop' && p.tool === 'crop' && s.preview === p.preview && !!p.settings && !!s.settings && onlyChanged(p.settings, s.settings, 'crop');
      if (!cropOnly) {
        image = true;
        this.interactiveUntil = now + 160;
        // Auto-toggle overlay (Lightroom): adjusting the selected mask's sliders hides the red overlay
        // so the effect is visible; editing its shape, reselecting or toggling O shows it again.
        if (s.tool === 'mask' && s.selectedMask && s.settings && p.settings && s.settings !== p.settings && !s.preview) {
          const a = p.settings.locals.find((l) => l.id === s.selectedMask);
          const b = s.settings.locals.find((l) => l.id === s.selectedMask);
          if (a && b && a !== b) this.overlaySuppressed = a.linear === b.linear && a.radial === b.radial && a.strokes === b.strokes;
        }
      }
      if (s.settings !== p.settings) this.thumbDebounced();
    }
    if (s.disabledPanels !== p.disabledPanels) image = true;
    if (s.tool !== p.tool) {
      image = overlay = true;
      if (s.tool === 'crop' || p.tool === 'crop') this.refit = true;
    }
    if (s.compare !== p.compare || s.showBefore !== p.showBefore) image = overlay = true;
    if (s.maskOverlay !== p.maskOverlay || s.selectedMask !== p.selectedMask || s.tool !== p.tool) this.overlaySuppressed = false;
    if (s.maskOverlay !== p.maskOverlay || s.selectedMask !== p.selectedMask || s.hoverMask !== p.hoverMask) {
      overlay = true;
      if (s.tool === 'mask') image = true;
    }
    if (s.clipping !== p.clipping || s.splitPos !== p.splitPos) present = overlay = true;
    if (s.info !== p.info || s.creating !== p.creating || s.brush !== p.brush || s.straighten !== p.straighten || s.status !== p.status) overlay = true;
    if (s.hideLeft !== p.hideLeft || s.hideRight !== p.hideRight) this.onResize();
    if (image) {
      this.needImage = true;
      this.touchSettle(180);
    }
    if (present) this.needPresent = true;
    if (overlay) this.needOverlay = true;
    if (image || present || overlay) this.schedule();
  }

  // ===========================================================================================
  // Render loop

  schedule() {
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.frame);
  }
  requestOverlay() {
    this.needOverlay = true;
    this.schedule();
  }
  requestPresent() {
    this.needPresent = this.needOverlay = true;
    this.schedule();
  }
  /** Forces a re-render (e.g. after something else used the engine). */
  invalidate() {
    this.needImage = true;
    this.schedule();
  }

  private touchSettle(ms: number) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settle(), ms);
  }

  private settle() {
    if (this.disposed || !this.engine.hasSource || this.stage === 'none') return;
    const st = useDevelop.getState();
    const [tw, th] = this.renderSize(false);
    if (tw !== this.rendered.w || th !== this.rendered.h || this.overlayMaskId(st) !== this.rendered.overlay) {
      this.needImage = true;
      this.schedule();
    } else if (this.statsPending && !this.rendered.overlay) this.stats(false);
  }

  /** Effective settings to render: preview/hover, disabled panels neutralised, full frame while cropping. */
  renderSettings(st: DevelopState = useDevelop.getState()): DevelopSettings {
    const key = [st.settings, st.preview, st.disabledPanels, st.tool === 'crop'];
    if (this.renderCache && this.renderCache.key.every((k, i) => k === key[i])) return this.renderCache.value;
    let s = (st.preview ?? st.settings)!;
    const off = Object.keys(st.disabledPanels).filter((k) => st.disabledPanels[k] && PANEL_KEYS[k]);
    if (off.length) {
      const d = defaultSettings() as any;
      const o: any = { ...s };
      for (const k of off) for (const f of PANEL_KEYS[k]) o[f] = d[f];
      s = o;
    }
    if (st.tool === 'crop') s = { ...s, crop: FULL_CROP };
    this.renderCache = { key, value: s };
    return s;
  }

  private effCompare(st: DevelopState) {
    return st.tool === 'crop' || st.tool === 'mask' ? 'off' : st.compare;
  }
  private showsBefore(st: DevelopState) {
    return st.showBefore && st.tool !== 'crop' && st.tool !== 'mask';
  }

  private overlayMaskId(st: DevelopState): string | null {
    if (st.tool !== 'mask' || st.preview) return null;
    if (st.hoverMask && st.settings?.locals.some((l) => l.id === st.hoverMask && l.enabled)) return st.hoverMask;
    if (!st.maskOverlay || !st.selectedMask || this.overlaySuppressed) return null;
    return st.selectedMask;
  }

  /** Render resolution for the current zoom: display resolution (≤ full res), capped while interacting. */
  private renderSize(interactive: boolean): [number, number] {
    const fw = this.dispW;
    const fh = this.dispH;
    if (!fw || !fh) return [1, 1];
    const k = Math.min(1, this.view.scale * this.dpr);
    let w = fw * k;
    let h = fh * k;
    if (interactive) {
      const cap = Math.max(this.canvas.width * this.canvas.height, 640 * 480);
      if (w * h > cap) {
        const f = Math.sqrt(cap / (w * h));
        w *= f;
        h *= f;
      }
    }
    return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  }

  private frame = () => {
    this.raf = 0;
    if (this.disposed) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if ((window.devicePixelRatio || 1) !== this.dpr) return this.onResize(); // moved to another display (re-enters frame)
    const st = useDevelop.getState();
    const vp = this.vpSize();
    if (vp[0] !== this.lastVp[0] || vp[1] !== this.lastVp[1]) {
      this.lastVp = vp;
      if (this.dispW) this.reapplyZoom();
      this.needPresent = this.needOverlay = true;
    }
    if (!this.engine.hasSource || this.stage === 'none' || !st.settings) {
      // Switching photos: keep the previous frame up briefly so the placeholder can arrive without a flash.
      const wait = this.loadStart + 220 - performance.now();
      if (this.engine.hasSource && st.settings && wait > 0) {
        setTimeout(() => this.schedule(), wait + 5);
        return;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(BG[0], BG[1], BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawOverlay(st);
      this.needImage = this.needPresent = this.needOverlay = false;
      navBus.setRect(null);
      return;
    }
    const s = this.renderSettings(st);
    const [fw, fh] = this.engine.fullSize(s);
    if (fw !== this.dispW || fh !== this.dispH || this.refit) {
      this.onDisplaySize(fw, fh);
      this.needImage = true;
    }
    if (this.needImage) {
      const interactive = performance.now() < this.interactiveUntil;
      const [rw, rh] = this.renderSize(interactive);
      const ovl = this.overlayMaskId(st);
      try {
        this.engine.render(s, rw, rh, { maskOverlay: ovl });
        if (this.effCompare(st) !== 'off' || this.showsBefore(st)) this.engine.render(s, rw, rh, { neutral: true });
      } catch (e) {
        console.error(e);
        setStatus({ error: e instanceof Error ? e.message : String(e) });
        this.needImage = false;
        return;
      }
      this.rendered = { w: rw, h: rh, overlay: ovl };
      this.needImage = false;
      this.needPresent = true;
      if (interactive) this.touchSettle(180);
      if (!ovl) this.stats(interactive);
    }
    if (this.needPresent) {
      this.present(st);
      this.needPresent = false;
      this.updateNavRect();
    }
    if (this.needOverlay) {
      this.drawOverlay(st);
      this.needOverlay = false;
    }
  };

  /** Histogram + navigator image from a box-filtered ≤256px readback (throttled while dragging). */
  private stats(interactive: boolean) {
    const now = performance.now();
    if (interactive && now - this.statsAt < 120) {
      this.statsPending = true;
      return;
    }
    this.statsAt = now;
    this.statsPending = false;
    const res = this.engine.lastResult;
    if (!res) return;
    try {
      const img = this.reader.read(res, 256);
      useDevelop.setState({ histogram: histogramOf(img) });
      navBus.setImage(img);
    } catch {
      /* ignore */
    }
  }

  private present(st: DevelopState) {
    const gl = this.gl;
    const res = this.engine.lastResult;
    if (!res) return;
    const neutral = this.engine.lastNeutral;
    const dpr = this.dpr;
    const v = this.view;
    const cmp = this.effCompare(st);
    const opts = { imgW: this.dispW, imgH: this.dispH, background: BG, clipping: st.clipping, nearest: v.scale * dpr >= 2.5 };
    const tv = { x: v.x * dpr, y: v.y * dpr, scale: v.scale * dpr };
    if (cmp === 'sbs' && neutral) {
      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;
      const [hw] = this.vpSize();
      const left = Math.round(hw * dpr);
      const off = Math.round((hw + SBS_GAP) * dpr);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.05, 0.05, 0.055, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, left, H);
      this.engine.present(neutral, tv, opts);
      gl.scissor(off, 0, Math.max(0, W - off), H);
      this.engine.present(res, { ...tv, x: tv.x + off }, opts);
      gl.disable(gl.SCISSOR_TEST);
    } else if (this.showsBefore(st) && neutral) {
      this.engine.present(neutral, tv, opts);
    } else if (cmp === 'split' && neutral) {
      this.engine.present(res, tv, { ...opts, split: st.splitPos, before: neutral });
    } else {
      this.engine.present(res, tv, opts);
    }
  }

  // ===========================================================================================
  // View / zoom

  private onResize() {
    const r = this.container.getBoundingClientRect();
    this.vw = Math.max(1, r.width);
    this.vh = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.vw * this.dpr));
    const h = Math.max(1, Math.round(this.vh * this.dpr));
    for (const c of [this.canvas, this.overlay]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    this.needPresent = this.needOverlay = true;
    // Resizing cleared the drawing buffer: redraw now (ResizeObserver runs before paint) to avoid a blank frame.
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.engine && !this.disposed) this.frame();
  }

  /** Logical viewport size (one pane in side-by-side). */
  vpSize(): [number, number] {
    const sbs = this.effCompare(useDevelop.getState()) === 'sbs';
    return sbs ? [Math.max(1, (this.vw - SBS_GAP) / 2), this.vh] : [this.vw, this.vh];
  }

  private onDisplaySize(fw: number, fh: number) {
    const prevW = this.dispW;
    const prevH = this.dispH;
    this.dispW = fw;
    this.dispH = fh;
    const [w, h] = this.vpSize();
    const fresh = !prevW || this.refit;
    this.refit = false;
    const ratio = this.sourceRatio ?? 1;
    this.sourceRatio = null;
    let mode = useDevelop.getState().zoomMode;
    if (fresh && mode === 'custom') mode = 'fit';
    if (mode === 'fit' || mode === 'fill') {
      this.applyZoomMode(mode);
      return;
    }
    // 100% / custom: keep the zoom (rescaled when a higher-resolution source arrived) and the
    // image point at the viewport centre; a new image starts centred.
    const scale = mode === '100' ? 1 / this.dpr : this.view.scale * ratio;
    const v = this.view;
    const u = fresh ? 0.5 : (w / 2 - v.x) / (prevW * v.scale);
    const t = fresh ? 0.5 : (h / 2 - v.y) / (prevH * v.scale);
    this.setView({ scale, x: w / 2 - u * fw * scale, y: h / 2 - t * fh * scale }, mode);
    this.touchSettle(220);
  }

  private reapplyZoom() {
    const mode = useDevelop.getState().zoomMode;
    if (mode === 'custom') this.setView(this.view, 'custom');
    else this.applyZoomMode(mode);
  }

  fitScale(mode: 'fit' | 'fill' = 'fit') {
    const [w, h] = this.vpSize();
    if (!this.dispW) return 1;
    return mode === 'fit' ? Math.max(1e-4, Math.min((w - PAD * 2) / this.dispW, (h - PAD * 2) / this.dispH)) : Math.max(w / this.dispW, h / this.dispH);
  }

  applyZoomMode(mode: ZoomMode, anchor?: VPos) {
    if (!this.dispW) {
      useDevelop.setState({ zoomMode: mode });
      return;
    }
    const scale = mode === 'fit' ? this.fitScale('fit') : mode === 'fill' ? this.fitScale('fill') : mode === '100' ? 1 / this.dpr : this.view.scale;
    this.zoomTo(scale, anchor, mode);
  }

  /** Zooms to `scale` (CSS px per image px) keeping the image point under `anchor` (default: centre) fixed. */
  zoomTo(scale: number, anchor?: VPos, mode: ZoomMode = 'custom') {
    const [w, h] = this.vpSize();
    scale = Math.min(32 / this.dpr, Math.max(Math.min(this.fitScale('fit'), 1 / this.dpr) * 0.5, scale));
    const v = this.view;
    let x: number;
    let y: number;
    if (mode === 'fit' || mode === 'fill') {
      x = (w - this.dispW * scale) / 2;
      y = (h - this.dispH * scale) / 2;
      if (anchor && mode === 'fill') {
        const ix = (anchor.cx - v.x) / v.scale;
        const iy = (anchor.cy - v.y) / v.scale;
        x = anchor.cx - ix * scale;
        y = anchor.cy - iy * scale;
      }
    } else {
      const ax = anchor?.cx ?? w / 2;
      const ay = anchor?.cy ?? h / 2;
      const ix = (ax - v.x) / v.scale;
      const iy = (ay - v.y) / v.scale;
      x = ax - ix * scale;
      y = ay - iy * scale;
    }
    this.setView({ x, y, scale }, mode);
    this.touchSettle(220);
  }

  zoomStep(dir: 1 | -1, anchor?: VPos) {
    const STEPS = [0.0625, 0.125, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 11, 16];
    const cur = this.view.scale * this.dpr;
    const fit = this.fitScale('fit') * this.dpr;
    const all = [...STEPS, fit].sort((a, b) => a - b);
    const next = dir > 0 ? all.find((z) => z > cur * 1.01) ?? cur * 1.5 : [...all].reverse().find((z) => z < cur / 1.01) ?? cur / 1.5;
    if (Math.abs(next - fit) < 1e-6) this.applyZoomMode('fit');
    else this.zoomTo(next / this.dpr, anchor, Math.abs(next - 1) < 1e-6 ? '100' : 'custom');
  }

  setView(v: { x: number; y: number; scale: number }, mode: ZoomMode) {
    const [w, h] = this.vpSize();
    const iw = this.dispW * v.scale;
    const ih = this.dispH * v.scale;
    const x = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, v.x));
    const y = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, v.y));
    this.view = { x, y, scale: v.scale };
    const zoomPct = Math.round(v.scale * this.dpr * 1000) / 10;
    const st = useDevelop.getState();
    if (st.zoomMode !== mode || st.zoomPct !== zoomPct) useDevelop.setState({ zoomMode: mode, zoomPct });
    this.needPresent = this.needOverlay = true;
    this.schedule();
  }

  panBy(dx: number, dy: number) {
    this.setView({ ...this.view, x: this.view.x + dx, y: this.view.y + dy }, useDevelop.getState().zoomMode);
  }

  /** Centres the view on normalised output coords (navigator). */
  panToNormalized(u: number, v: number) {
    const [w, h] = this.vpSize();
    const s = this.view.scale;
    this.setView({ scale: s, x: w / 2 - u * this.dispW * s, y: h / 2 - v * this.dispH * s }, useDevelop.getState().zoomMode);
  }

  /** Z / click-zoom: fit ↔ 100% at the cursor. */
  toggleZoom(anchor?: VPos) {
    if (useDevelop.getState().zoomMode !== 'fit') this.applyZoomMode('fit');
    else this.applyZoomMode('100', anchor ?? this.hover ?? undefined);
  }

  private updateNavRect() {
    if (!this.dispW) return navBus.setRect(null);
    const [w, h] = this.vpSize();
    const v = this.view;
    const iw = this.dispW * v.scale;
    const ih = this.dispH * v.scale;
    const x0 = Math.max(0, -v.x / iw);
    const y0 = Math.max(0, -v.y / ih);
    const x1 = Math.min(1, (w - v.x) / iw);
    const y1 = Math.min(1, (h - v.y) / ih);
    navBus.setRect({ x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) });
  }

  // ===========================================================================================
  // Coordinates

  /** CSS (viewport) → normalised displayed-output coords. */
  toOut(cx: number, cy: number): [number, number] {
    const v = this.view;
    return [(cx - v.x) / (this.dispW * v.scale), (cy - v.y) / (this.dispH * v.scale)];
  }
  /** Normalised displayed-output coords → CSS (viewport). */
  fromOut(u: number, v: number): [number, number] {
    const w = this.view;
    return [w.x + u * this.dispW * w.scale, w.y + v * this.dispH * w.scale];
  }

  private geomCache: { s: DevelopSettings; w: number; h: number; o2s: Mat3; s2o: Mat3 } | null = null;
  private geom() {
    const s = this.renderSettings();
    const w = this.engine.sourceWidth;
    const h = this.engine.sourceHeight;
    const g = this.geomCache;
    if (g && g.s === s && g.w === w && g.h === h) return g;
    const o2s = outputToSource(w, h, s);
    this.geomCache = { s, w, h, o2s, s2o: invert(o2s) };
    return this.geomCache;
  }
  /** Displayed-output normalised → source normalised. */
  outToSrc(u: number, v: number): [number, number] {
    return apply(this.geom().o2s, u, v);
  }
  /** Source normalised → displayed-output normalised. */
  srcToOut(x: number, y: number): [number, number] {
    return apply(this.geom().s2o, x, y);
  }
  get srcW() {
    return this.engine.sourceWidth;
  }
  get srcH() {
    return this.engine.sourceHeight;
  }
  /** Full-res oriented (un-cropped) size for `s` — the crop tool's frame. */
  orientedSize(s: DevelopSettings): [number, number] {
    return orientedSize(this.engine.sourceWidth, this.engine.sourceHeight, s.orientation);
  }

  pos(e: { clientX: number; clientY: number }): VPos {
    const r = this.container.getBoundingClientRect();
    let cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    let half: 0 | 1 = 0;
    if (this.effCompare(useDevelop.getState()) === 'sbs') {
      const [hw] = this.vpSize();
      if (cx > hw + SBS_GAP / 2) {
        cx -= hw + SBS_GAP;
        half = 1;
      }
    }
    return { cx, cy, half };
  }

  setCursor(c: string) {
    if (c === this.cursor) return;
    this.cursor = c;
    this.container.style.cursor = c;
  }

  setSpace(held: boolean) {
    this.spaceHeld = held;
    this.setCursor(held ? 'grab' : 'default');
  }

  /** Abort handles of the drags in progress (see drag()). */
  private drags = new Set<() => void>();

  /** Ends the drags in progress without running their move/up handlers (photo switched, disposed). */
  abortDrags() {
    for (const abort of [...this.drags]) abort();
  }

  /** Pointer-capture drag helper. */
  drag(e: PointerEvent, move: (ev: PointerEvent) => void, up?: (ev: PointerEvent) => void, name = 'drag') {
    const el = this.container;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.dragging = name;
    const detach = () => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      this.drags.delete(abort);
    };
    const mv = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) move(ev);
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      detach();
      this.dragging = null;
      up?.(ev);
      this.requestOverlay();
    };
    // Tool drags compute their edits from the photo they started on (crop frame, mask ids, start
    // geometry): after a photo switch they must not keep writing into the new photo's settings.
    const abort = () => {
      detach();
      this.dragging = null;
      this.hud = null;
      this.ruler = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      this.requestOverlay();
    };
    this.drags.add(abort);
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }

  beginPan(e: PointerEvent) {
    let lx = e.clientX;
    let ly = e.clientY;
    this.setCursor('grabbing');
    this.drag(
      e,
      (ev) => {
        this.panBy(ev.clientX - lx, ev.clientY - ly);
        lx = ev.clientX;
        ly = ev.clientY;
      },
      () => this.setCursor(this.spaceHeld ? 'grab' : 'default'),
      'pan',
    );
  }

  /** Click (no drag) toggles fit/100% at the point; drag pans. */
  private clickZoomOrPan(e: PointerEvent, p: VPos, allowZoom: boolean) {
    const sx = e.clientX;
    const sy = e.clientY;
    let lx = sx;
    let ly = sy;
    let moved = false;
    this.drag(
      e,
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) {
          moved = true;
          this.setCursor('grabbing');
        }
        if (moved) this.panBy(ev.clientX - lx, ev.clientY - ly);
        lx = ev.clientX;
        ly = ev.clientY;
      },
      () => {
        this.setCursor('default');
        if (!moved && allowZoom) this.toggleZoom(p);
      },
      'pan',
    );
  }

  // ===========================================================================================
  // Pointer / wheel

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.dispW) return;
    const p = this.pos(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const k = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0025));
      this.zoomTo(this.view.scale * k, p, 'custom');
    } else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.panBy(-dx, -dy);
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (!this.engine.hasSource || this.stage === 'none') return;
    const st = useDevelop.getState();
    if (!st.settings) return;
    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault();
      this.beginPan(e);
      return;
    }
    if (e.button !== 0) return;
    const p = this.pos(e);
    if (this.effCompare(st) === 'split' && this.nearSplit(p, st)) {
      this.drag(
        e,
        (ev) => {
          const q = this.pos(ev);
          const [u] = this.toOut(q.cx, q.cy);
          useDevelop.setState({ splitPos: Math.min(1, Math.max(0, u)) });
        },
        undefined,
        'split',
      );
      return;
    }
    if (st.tool === 'wb') {
      this.pickWhiteBalance(p);
      return;
    }
    if (st.tool === 'crop') {
      cropTool.pointerDown(this, e, p, st);
      return;
    }
    if (st.tool === 'mask' && !st.preview) {
      if (maskTool.pointerDown(this, e, p, st)) return;
      this.clickZoomOrPan(e, p, false);
      return;
    }
    this.clickZoomOrPan(e, p, true);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.dragging) return;
    const p = this.pos(e);
    this.hover = p;
    this.altHeld = e.altKey;
    const st = useDevelop.getState();
    let cursor = 'default';
    if (this.spaceHeld) cursor = 'grab';
    else if (!this.engine.hasSource || this.stage === 'none') cursor = 'default';
    else if (this.effCompare(st) === 'split' && this.nearSplit(p, st)) cursor = 'ew-resize';
    else if (st.tool === 'wb') cursor = 'crosshair';
    else if (st.tool === 'crop') cursor = cropTool.hoverCursor(this, p, st);
    else if (st.tool === 'mask' && !st.preview) cursor = maskTool.hoverCursor(this, p, st) ?? (this.canPan() ? 'grab' : 'default');
    else cursor = st.zoomMode === 'fit' ? 'zoom-in' : this.canPan() ? 'grab' : 'zoom-out';
    this.setCursor(cursor);
    if (st.tool === 'mask' || st.tool === 'wb' || st.tool === 'crop') this.requestOverlay();
  };

  private onPointerLeave = () => {
    this.hover = null;
    this.requestOverlay();
  };

  private canPan() {
    const [w, h] = this.vpSize();
    return this.dispW * this.view.scale > w + 1 || this.dispH * this.view.scale > h + 1;
  }

  private nearSplit(p: VPos, st: DevelopState) {
    const [x] = this.fromOut(st.splitPos, 0);
    const [, y0] = this.fromOut(0, 0);
    const [, y1] = this.fromOut(0, 1);
    return Math.abs(p.cx - x) < 7 && p.cy >= y0 - 4 && p.cy <= y1 + 4;
  }

  // ===========================================================================================
  // Tools & engine helpers

  /** White-balance eyedropper: neutralises the clicked area (7×7 average of the unadjusted image). */
  pickWhiteBalance(p: VPos) {
    const [u, v] = this.toOut(p.cx, p.cy);
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    const wb = whiteBalanceFrom(this.engine.sampleBase(u, v, 3));
    editCommit((s) => ({ ...s, ...wb }), 'White Balance: Custom');
    useDevelop.setState({ tool: 'none' });
  }

  /** Lightroom-style Auto tone from a neutral render's histogram. */
  computeAutoTone(): Partial<DevelopSettings> | null {
    const s = useDevelop.getState().settings;
    if (!s || !this.engine.hasSource || this.stage === 'none') return null;
    const [w, h] = this.engine.fitSize(s, 768, 768);
    this.engine.render(s, w, h, { neutral: true });
    const hist = this.engine.histogram(this.engine.lastNeutral);
    this.invalidate();
    return autoTone(hist);
  }

  /** Gray-world auto white balance. */
  computeAutoWB(): { temperature: number; tint: number } | null {
    const s = useDevelop.getState().settings;
    if (!s || !this.engine.hasSource || this.stage === 'none') return null;
    const [w, h] = this.engine.fitSize(s, 768, 768);
    this.engine.render(s, w, h, { neutral: true });
    const avg = this.engine.averageBase();
    this.invalidate();
    return whiteBalanceFrom(avg);
  }

  /** Reads the rendered pixel (0..255 RGB) under a viewport point, or null outside the image. */
  sampleResult(p: VPos): [number, number, number] | null {
    const res = this.engine.lastResult;
    if (!res) return null;
    const [u, v] = this.toOut(p.cx, p.cy);
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
    const x = Math.min(res.width - 1, Math.floor(u * res.width));
    const y = Math.min(res.height - 1, Math.floor(v * res.height));
    const d = res.read(x, y, 1, 1);
    return [d[0], d[1], d[2]];
  }

  // ===========================================================================================
  // Overlay (2D canvas, CSS px coordinates)

  private drawOverlay(st: DevelopState) {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.engine.hasSource || this.stage === 'none' || !st.settings || !this.dispW) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const cmp = this.effCompare(st);
    if (st.tool === 'crop') cropTool.draw(this, ctx, st);
    else if (st.tool === 'mask' && !st.preview) maskTool.draw(this, ctx, st);

    const [x0, y0] = this.fromOut(0, 0);
    const [x1] = this.fromOut(1, 1);
    if (cmp === 'split') {
      const [sx] = this.fromOut(st.splitPos, 0);
      const [, y1] = this.fromOut(0, 1);
      const yc = Math.min(Math.max((y0 + y1) / 2, 20), this.vh - 20);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(sx, yc, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.moveTo(sx - 2, yc - 4);
      ctx.lineTo(sx - 6, yc);
      ctx.lineTo(sx - 2, yc + 4);
      ctx.moveTo(sx + 2, yc - 4);
      ctx.lineTo(sx + 6, yc);
      ctx.lineTo(sx + 2, yc + 4);
      ctx.fill();
      label(ctx, 'Before', Math.max(x0, 0) + 10, Math.max(y0, 0) + 10, 'left');
      label(ctx, 'After', Math.min(x1, this.vpSize()[0]) - 10, Math.max(y0, 0) + 10, 'right');
    } else if (cmp === 'sbs') {
      const [hw] = this.vpSize();
      label(ctx, 'Before', 10, 10, 'left');
      label(ctx, 'After', hw + SBS_GAP + 10, 10, 'left');
    } else if (this.showsBefore(st)) {
      label(ctx, 'Before', Math.max(x0, 0) + 10, Math.max(y0, 0) + 10, 'left');
    }
    if (st.preview && st.previewLabel) label(ctx, `Preview · ${st.previewLabel}`, Math.max(x0, 0) + 10, Math.max(y0, 0) + 10, 'left');

    if (st.tool === 'wb' && this.hover) {
      const p = this.hover;
      const rgb = this.sampleResult(p);
      if (rgb) {
        const txt = `R ${((rgb[0] / 255) * 100).toFixed(1)}   G ${((rgb[1] / 255) * 100).toFixed(1)}   B ${((rgb[2] / 255) * 100).toFixed(1)} %`;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.rect(p.cx - 6, p.cy - 6, 12, 12);
        ctx.stroke();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
        label(ctx, txt, p.cx + 14, p.cy + 12, 'left');
      }
    }
    if (st.info) this.drawInfo(ctx, st);
    if (this.hud) {
      const [w, h] = this.vpSize();
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      label(ctx, this.hud, w / 2, h / 2 - 10, 'center');
    }
  }

  private drawInfo(ctx: CanvasRenderingContext2D, st: DevelopState) {
    const photo = st.photoId ? useCatalog.getState().photos[st.photoId] : undefined;
    if (!photo) return;
    const m = photo.meta ?? {};
    const lines = [
      photo.name,
      [m.make, m.model].filter(Boolean).join(' '),
      [m.iso ? `ISO ${m.iso}` : '', m.focalLength ? `${Math.round(m.focalLength)} mm` : '', m.fNumber ? `f/${m.fNumber}` : '', formatShutter(m.exposureTime)].filter(Boolean).join('   '),
      `${this.engine.sourceWidth} × ${this.engine.sourceHeight}${this.stage !== 'full' ? ' (preview)' : ''} · ${Math.round(this.view.scale * this.dpr * 100)}%`,
    ].filter(Boolean);
    ctx.save();
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    lines.forEach((t, i) => {
      if (i === 1) ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(t, 13, 13 + i * 16);
      ctx.fillStyle = i === 0 ? '#fff' : 'rgba(235,235,240,0.85)';
      ctx.fillText(t, 12, 12 + i * 16);
    });
    ctx.restore();
  }
}

/**
 * Camera-embedded RAW previews are usually stored in sensor orientation while LibRaw's full decode
 * is rotated by the EXIF orientation — rotate the preview so the swap to the full decode is seamless.
 */
async function orientPreview(bmp: ImageBitmap, orientation?: number): Promise<ImageBitmap | null> {
  if ((orientation !== 6 && orientation !== 8) || bmp.height >= bmp.width) return null;
  try {
    const c = new OffscreenCanvas(bmp.height, bmp.width);
    const ctx = c.getContext('2d')!;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(orientation === 6 ? Math.PI / 2 : -Math.PI / 2);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    return c.transferToImageBitmap();
  } catch {
    return null;
  }
}

/** Small pill label for the overlay. */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: 'left' | 'right' | 'center') {
  ctx.save();
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 14;
  const h = 20;
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  ctx.fillStyle = 'rgba(16,16,18,0.78)';
  ctx.beginPath();
  ctx.roundRect(left, y, w, h, 5);
  ctx.fill();
  ctx.fillStyle = 'rgba(240,240,244,0.95)';
  ctx.fillText(text, left + 7, y + h / 2 + 0.5);
  ctx.restore();
}

/** Commits helper shared by tools. */
export { commit };
