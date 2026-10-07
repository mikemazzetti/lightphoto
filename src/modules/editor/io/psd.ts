import { readPsd, writePsdUint8Array } from 'ag-psd';
import type { AdjustmentLayer, BlendMode as PsdBlend, Layer as PsdLayer, Psd } from 'ag-psd';
import { BLEND_MODES, BlendMode } from '@/core/gl/glsl';
import { baseLayer, Doc, rasterLayer } from '../model/doc';
import { Surface } from '../model/surface';
import type { AdjustParams, Layer, LevelsChannel, RGBA } from '../model/types';
import { ADJUST_NAMES, defaultAdjust, levelsIdentity } from '../render/adjustments';
import { textBox } from '../model/rasterize';

// ---------------------------------------------------------------------------------------------
// Blend modes

const toPsdBlend = (m: BlendMode): PsdBlend => m.replace(/-/g, ' ') as PsdBlend;
function fromPsdBlend(m: PsdBlend | undefined): BlendMode {
  if (!m || m === 'pass through') return 'normal';
  const k = m.replace(/ /g, '-') as BlendMode;
  if (m === 'subtraction') return 'subtract';
  return (BLEND_MODES as readonly string[]).includes(k) ? k : 'normal';
}

// ---------------------------------------------------------------------------------------------
// Pixels

function toImageData(px: { data: ArrayLike<number>; width: number; height: number }): ImageData {
  const n = px.width * px.height * 4;
  const d = px.data as any;
  let out: Uint8ClampedArray;
  if (d instanceof Uint8ClampedArray) out = d.length === n ? d : new Uint8ClampedArray(d.buffer, d.byteOffset, n);
  else if (d instanceof Uint8Array) out = new Uint8ClampedArray(d.buffer, d.byteOffset, n);
  else if (d instanceof Uint16Array) {
    out = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) out[i] = d[i] >> 8;
  } else if (d instanceof Float32Array) {
    out = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) out[i] = Math.round(Math.min(1, Math.max(0, i % 4 === 3 ? d[i] : Math.pow(Math.max(0, d[i]), 1 / 2.2))) * 255);
  } else out = Uint8ClampedArray.from(d as ArrayLike<number>);
  return new ImageData(out as Uint8ClampedArray<ArrayBuffer>, px.width, px.height);
}

const rgb = (c: any): RGBA => {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  if ('fr' in c) return { r: c.fr * 255, g: c.fg * 255, b: c.fb * 255, a: 1 };
  if ('r' in c) return { r: c.r, g: c.g, b: c.b, a: 1 };
  if ('k' in c && !('c' in c)) return { r: 255 - c.k * 2.55, g: 255 - c.k * 2.55, b: 255 - c.k * 2.55, a: 1 };
  return { r: 0, g: 0, b: 0, a: 1 };
};

// ---------------------------------------------------------------------------------------------
// Adjustments (both directions)

function levelsIn(c: any): LevelsChannel {
  if (!c) return levelsIdentity();
  return { inBlack: c.shadowInput ?? 0, inWhite: c.highlightInput ?? 255, gamma: c.midtoneInput ?? 1, outBlack: c.shadowOutput ?? 0, outWhite: c.highlightOutput ?? 255 };
}
const levelsOut = (c: LevelsChannel) => ({ shadowInput: c.inBlack, highlightInput: c.inWhite, shadowOutput: c.outBlack, highlightOutput: c.outWhite, midtoneInput: c.gamma });

function curveIn(c: { input: number; output: number }[] | undefined): [number, number][] {
  if (!c || c.length < 2)
    return [
      [0, 0],
      [1, 1],
    ];
  return c.map((p) => [p.input / 255, p.output / 255] as [number, number]);
}
const curveOut = (c: [number, number][]) => c.map(([x, y]) => ({ input: Math.round(x * 255), output: Math.round(y * 255) }));

function adjustFromPsd(a: AdjustmentLayer): AdjustParams | null {
  const x = a as any;
  switch (a.type) {
    case 'brightness/contrast':
      return { type: 'brightness', brightness: x.brightness ?? 0, contrast: x.contrast ?? 0, legacy: !!x.useLegacy };
    case 'levels':
      return { type: 'levels', rgb: levelsIn(x.rgb), r: levelsIn(x.red), g: levelsIn(x.green), b: levelsIn(x.blue) };
    case 'curves':
      return { type: 'curves', rgb: curveIn(x.rgb), r: curveIn(x.red), g: curveIn(x.green), b: curveIn(x.blue) };
    case 'exposure':
      return { type: 'exposure', exposure: x.exposure ?? 0, offset: x.offset ?? 0, gamma: x.gamma ?? 1 };
    case 'vibrance':
      return { type: 'vibrance', vibrance: x.vibrance ?? 0, saturation: x.saturation ?? 0 };
    case 'hue/saturation':
      return { type: 'hueSat', hue: x.master?.hue ?? 0, saturation: x.master?.saturation ?? 0, lightness: x.master?.lightness ?? 0, colorize: false };
    case 'color balance': {
      const v = (c: any): [number, number, number] => [c?.cyanRed ?? 0, c?.magentaGreen ?? 0, c?.yellowBlue ?? 0];
      return { type: 'colorBalance', shadows: v(x.shadows), midtones: v(x.midtones), highlights: v(x.highlights), preserveLum: x.preserveLuminosity ?? true };
    }
    case 'black & white':
      return {
        type: 'bw',
        reds: x.reds ?? 40,
        yellows: x.yellows ?? 60,
        greens: x.greens ?? 40,
        cyans: x.cyans ?? 60,
        blues: x.blues ?? 20,
        magentas: x.magentas ?? 80,
        tint: !!x.useTint,
        tintColor: rgb(x.tintColor ?? { r: 225, g: 211, b: 179 }),
      };
    case 'photo filter':
      return { type: 'photoFilter', color: rgb(x.color ?? { r: 236, g: 138, b: 0 }), density: x.density ?? 25, preserveLum: x.preserveLuminosity ?? true };
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: x.levels ?? 4 };
    case 'threshold':
      return { type: 'threshold', level: x.level ?? 128 };
    case 'gradient map': {
      const stops = (x.colorStops ?? []).map((s: any) => ({ pos: s.location ?? 0, color: rgb(s.color) }));
      return { type: 'gradientMap', stops: stops.length >= 2 ? stops : (defaultAdjust('gradientMap') as any).stops, reverse: !!x.reverse };
    }
    default:
      return null;
  }
}

function adjustToPsd(p: AdjustParams): AdjustmentLayer | null {
  const c3 = (c: RGBA) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
  switch (p.type) {
    case 'brightness':
      return { type: 'brightness/contrast', brightness: Math.round(p.brightness), contrast: Math.round(p.contrast), useLegacy: p.legacy, meanValue: 127, labColorOnly: false };
    case 'levels':
      return { type: 'levels', rgb: levelsOut(p.rgb), red: levelsOut(p.r), green: levelsOut(p.g), blue: levelsOut(p.b) };
    case 'curves':
      return { type: 'curves', rgb: curveOut(p.rgb), red: curveOut(p.r), green: curveOut(p.g), blue: curveOut(p.b) };
    case 'exposure':
      return { type: 'exposure', exposure: p.exposure, offset: p.offset, gamma: p.gamma };
    case 'vibrance':
      return { type: 'vibrance', vibrance: Math.round(p.vibrance), saturation: Math.round(p.saturation) };
    case 'hueSat':
      if (p.colorize) return null;
      return { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: Math.round(p.hue), saturation: Math.round(p.saturation), lightness: Math.round(p.lightness) } };
    case 'colorBalance': {
      const v = (a: [number, number, number]) => ({ cyanRed: Math.round(a[0]), magentaGreen: Math.round(a[1]), yellowBlue: Math.round(a[2]) });
      return { type: 'color balance', shadows: v(p.shadows), midtones: v(p.midtones), highlights: v(p.highlights), preserveLuminosity: p.preserveLum };
    }
    case 'bw':
      return { type: 'black & white', reds: p.reds, yellows: p.yellows, greens: p.greens, cyans: p.cyans, blues: p.blues, magentas: p.magentas, useTint: p.tint, tintColor: c3(p.tintColor) };
    case 'photoFilter':
      return { type: 'photo filter', color: c3(p.color), density: Math.round(p.density), preserveLuminosity: p.preserveLum };
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: Math.round(p.levels) };
    case 'threshold':
      return { type: 'threshold', level: Math.round(p.level) };
    case 'gradientMap':
      return {
        type: 'gradient map',
        gradientType: 'solid',
        name: 'Custom',
        reverse: p.reverse,
        dither: false,
        colorStops: p.stops.map((s) => ({ location: s.pos, midpoint: 0.5, color: c3(s.color) })),
        opacityStops: [
          { location: 0, midpoint: 0.5, opacity: 1 },
          { location: 1, midpoint: 0.5, opacity: 1 },
        ],
      } as AdjustmentLayer;
  }
}

// ---------------------------------------------------------------------------------------------
// Read

/** "TimesNewRomanPS-BoldMT" → "Times New Roman" (PostScript name → CSS family, best effort). */
function psFontFamily(ps: string | undefined): string {
  if (!ps) return 'Helvetica';
  const base = ps.replace(/-.*$/, '').replace(/(PSMT|PS|MT)$/, '');
  return base.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Helvetica';
}

export function readPsdDoc(buf: ArrayBuffer, name: string, path?: string): Doc {
  const psd = readPsd(buf, { useImageData: true, skipThumbnail: true });
  const doc = new Doc(name, psd.width, psd.height);
  doc.path = path;
  const out: Layer[] = [];
  const walk = (children: PsdLayer[] | undefined, hidden: boolean, opacity: number) => {
    for (const pl of children ?? []) {
      if (pl.children) {
        walk(pl.children, hidden || !!pl.hidden, opacity * (pl.opacity ?? 1));
        continue;
      }
      const l = convertLayer(pl, doc);
      if (!l) continue;
      l.visible = l.visible && !hidden;
      l.opacity *= opacity;
      out.push(l);
    }
  };
  walk(psd.children, false, 1);
  if (!out.length && psd.imageData) out.push(rasterLayer('Background', Surface.fromImageData(toImageData(psd.imageData))));
  if (!out.length) out.push(rasterLayer('Background', Surface.filled(psd.width, psd.height, '#fff')));
  doc.layers = out;
  doc.activeLayerId = out[out.length - 1].id;
  doc.resetHistory('Open');
  return doc;
}

function convertLayer(pl: PsdLayer, doc: Doc): Layer | null {
  let l: Layer;
  const name = pl.name ?? 'Layer';
  const adj = pl.adjustment ? adjustFromPsd(pl.adjustment) : null;
  const left = pl.left ?? 0;
  const top = pl.top ?? 0;
  if (adj) {
    l = baseLayer('adjustment', name || ADJUST_NAMES[adj.type]);
    l.adjust = adj;
  } else if (pl.vectorFill && (pl.vectorFill as any).type === 'color' && !pl.vectorMask) {
    l = baseLayer('fill', name);
    l.fillColor = rgb((pl.vectorFill as any).color);
  } else if (pl.imageData && pl.imageData.width > 0 && pl.imageData.height > 0) {
    l = rasterLayer(name, Surface.fromImageData(toImageData(pl.imageData)), left, top);
    if (pl.text?.text) {
      // Keep Photoshop's rendering, but make the text editable.
      const st = pl.text.style ?? {};
      const t = pl.text.transform ?? [1, 0, 0, 1, left, top];
      const scale = Math.hypot(t[0], t[1]) || 1;
      const size = (st.fontSize ?? 24) * scale;
      const just = pl.text.paragraphStyle?.justification;
      l.kind = 'text';
      l.text = {
        text: pl.text.text.replace(/\r/g, '\n'),
        font: psFontFamily(st.font?.name),
        size,
        weight: st.fauxBold || /bold/i.test(st.font?.name ?? '') ? 700 : 400,
        italic: !!st.fauxItalic || /italic|oblique/i.test(st.font?.name ?? ''),
        color: rgb(st.fillColor),
        align: just === 'center' ? 'center' : just === 'right' ? 'right' : 'left',
        lineHeight: st.autoLeading === false && st.leading ? st.leading / (st.fontSize ?? 24) : 1.2,
        tracking: ((st.tracking ?? 0) / 1000) * size,
        x: left,
        y: top,
      };
    }
  } else {
    // empty pixel layer
    l = rasterLayer(name, new Surface(1, 1), 0, 0);
  }
  l.visible = !pl.hidden;
  l.opacity = pl.opacity ?? 1;
  l.fillOpacity = pl.fillOpacity ?? 1;
  l.blendMode = fromPsdBlend(pl.blendMode);
  l.clip = !!pl.clipping;
  if (pl.protected) {
    l.lockTransparency = !!pl.protected.transparency;
    l.lockPixels = !!pl.protected.composite;
    l.lockPosition = !!pl.protected.position;
  }
  const m = pl.mask;
  if (m && m.imageData && m.imageData.width > 0 && m.imageData.height > 0) {
    l.mask = {
      surf: Surface.fromImageData(toImageData(m.imageData)),
      x: m.left ?? 0,
      y: m.top ?? 0,
      defaultColor: (m.defaultColor ?? 0) >= 128 ? 255 : 0,
      enabled: !m.disabled,
      linked: !m.positionRelativeToLayer,
      density: m.userMaskDensity ?? 1,
      feather: m.userMaskFeather ?? 0,
    };
  } else if (m && (l.kind === 'adjustment' || l.kind === 'fill')) {
    l.mask = { surf: Surface.filled(doc.width, doc.height, (m.defaultColor ?? 255) >= 128 ? '#fff' : '#000'), x: 0, y: 0, defaultColor: (m.defaultColor ?? 255) >= 128 ? 255 : 0, enabled: !m.disabled, linked: true, density: 1, feather: 0 };
  }
  const fx = pl.effects;
  if (fx && !fx.disabled) {
    const ds = fx.dropShadow?.[0];
    const og = fx.outerGlow;
    const sk = fx.stroke?.[0];
    const style: Layer['style'] = {};
    if (ds) style.dropShadow = { enabled: ds.enabled !== false, color: rgb(ds.color), opacity: ds.opacity ?? 0.75, angle: ds.angle ?? 120, distance: ds.distance?.value ?? 5, size: ds.size?.value ?? 5, spread: (ds.choke?.value ?? 0) };
    if (og) style.outerGlow = { enabled: og.enabled !== false, color: rgb(og.color), opacity: og.opacity ?? 0.75, size: og.size?.value ?? 5, spread: og.choke?.value ?? 0 };
    if (sk) style.stroke = { enabled: sk.enabled !== false, color: rgb(sk.color), opacity: sk.opacity ?? 1, size: sk.size?.value ?? 3, position: sk.position ?? 'outside' };
    if (style.dropShadow || style.outerGlow || style.stroke) l.style = style;
  }
  return l;
}

// ---------------------------------------------------------------------------------------------
// Write

function imageDataOf(s: Surface): ImageData {
  return s.ctx.getImageData(0, 0, s.width, s.height);
}

/** Serialises the document as a layered PSD (opens in Photoshop with layers intact). */
export function writePsdDoc(doc: Doc, composite: OffscreenCanvas): Uint8Array {
  const children: PsdLayer[] = [];
  for (const l of doc.layers) {
    const pl: PsdLayer = {
      name: l.name,
      hidden: !l.visible,
      opacity: l.opacity,
      blendMode: toPsdBlend(l.blendMode),
      clipping: l.clip,
      fillOpacity: l.fillOpacity,
    };
    if (l.lockTransparency || l.lockPixels || l.lockPosition || l.lockAll) pl.protected = { transparency: l.lockTransparency || l.lockAll, composite: l.lockPixels || l.lockAll, position: l.lockPosition || l.lockAll };
    if (l.kind === 'adjustment' && l.adjust) {
      const a = adjustToPsd(l.adjust);
      if (a) pl.adjustment = a;
      else {
        // Not representable: skip (Photoshop has no equivalent).
        continue;
      }
    } else if (l.kind === 'fill' && l.fillColor) {
      const c = l.fillColor;
      pl.vectorFill = { type: 'color', color: { r: c.r, g: c.g, b: c.b } };
      const s = Surface.filled(doc.width, doc.height, `rgb(${c.r},${c.g},${c.b})`);
      pl.left = 0;
      pl.top = 0;
      pl.imageData = imageDataOf(s);
    } else if (l.surf) {
      pl.left = l.x;
      pl.top = l.y;
      pl.imageData = imageDataOf(l.surf);
      if (l.kind === 'text' && l.text && !l.xform) {
        const t = l.text;
        const box = textBox(t);
        pl.text = {
          text: t.text.replace(/\n/g, '\r'),
          transform: [1, 0, 0, 1, box.x, box.y + t.size * 0.9],
          style: { font: { name: t.font.replace(/\s+/g, '') + (t.weight >= 600 ? '-Bold' : '') }, fontSize: t.size, fillColor: { r: t.color.r, g: t.color.g, b: t.color.b }, tracking: Math.round((t.tracking / t.size) * 1000), fauxItalic: t.italic },
          paragraphStyle: { justification: t.align },
        };
      }
    }
    if (l.mask) {
      const m = l.mask;
      pl.mask = {
        left: m.x,
        top: m.y,
        right: m.x + m.surf.width,
        bottom: m.y + m.surf.height,
        defaultColor: m.defaultColor,
        disabled: !m.enabled,
        imageData: imageDataOf(m.surf),
        userMaskDensity: m.density,
        userMaskFeather: m.feather,
      };
    }
    if (l.style) {
      const s = l.style;
      const px = (v: number) => ({ units: 'Pixels' as const, value: v });
      const c3 = (c: RGBA) => ({ r: c.r, g: c.g, b: c.b });
      pl.effects = {};
      if (s.dropShadow) pl.effects.dropShadow = [{ enabled: s.dropShadow.enabled, color: c3(s.dropShadow.color), opacity: s.dropShadow.opacity, angle: s.dropShadow.angle, distance: px(s.dropShadow.distance), size: px(s.dropShadow.size), choke: px(s.dropShadow.spread), blendMode: 'multiply', useGlobalLight: false }];
      if (s.outerGlow) pl.effects.outerGlow = { enabled: s.outerGlow.enabled, color: c3(s.outerGlow.color), opacity: s.outerGlow.opacity, size: px(s.outerGlow.size), choke: px(s.outerGlow.spread), blendMode: 'screen' };
      if (s.stroke) pl.effects.stroke = [{ enabled: s.stroke.enabled, color: c3(s.stroke.color), opacity: s.stroke.opacity, size: px(s.stroke.size), position: s.stroke.position, fillType: 'color', blendMode: 'normal' }];
    }
    children.push(pl);
  }
  const cctx = composite.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    channels: 4,
    bitsPerChannel: 8,
    colorMode: 3,
    children,
    imageData: cctx.getImageData(0, 0, composite.width, composite.height),
  };
  try {
    return writePsdUint8Array(psd, { invalidateTextLayers: true, noBackground: true, generateThumbnail: false, trimImageData: true });
  } catch (e) {
    // Retry without editable text / adjustments (rasterised everything).
    console.warn('PSD write with editable layers failed, retrying raster-only', e);
    for (const c of children) {
      delete c.text;
      if (c.adjustment) c.hidden = true;
    }
    return writePsdUint8Array(psd, { noBackground: true, generateThumbnail: false });
  }
}
