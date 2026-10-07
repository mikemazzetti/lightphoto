import { api, basename, dirname } from '@/platform/api';
import { formatShutter, type PhotoMeta } from '@/core/image/decode';
import type { LibraryFilter, Photo } from '@/state/catalog';

/** dataTransfer type for photos dragged out of the grid (onto collections). */
export const DRAG_MIME = 'application/x-lightphoto-photos';

export const revealLabel = api.isMac ? 'Show in Finder' : 'Show in Explorer';

const nf = new Intl.NumberFormat();
export const fmtInt = (n: number) => nf.format(n);
export const plural = (n: number, word: string, pluralWord = word + 's') => `${nf.format(n)} ${n === 1 ? word : pluralWord}`;

export function formatBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDate(ms: number | undefined, time = true): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, time ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** YYYY-MM-DD in local time (for export filename templates). */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Pixel dimensions as displayed (EXIF orientation 5–8 swaps width/height). */
export function orientedDims(meta?: PhotoMeta): [number, number] | null {
  if (!meta?.width || !meta?.height) return null;
  return (meta.orientation ?? 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
}

export function cameraName(meta?: PhotoMeta): string {
  if (!meta) return '';
  const make = (meta.make ?? '').trim();
  const model = (meta.model ?? '').trim();
  if (!model) return make;
  if (!make) return model;
  const firstWord = make.split(/\s+/)[0].toLowerCase();
  return model.toLowerCase().startsWith(firstWord) ? model : `${make} ${model}`;
}

export const fmtAperture = (f?: number) => (f ? `ƒ/${+f.toFixed(1)}` : '');
export const fmtFocal = (f?: number) => (f ? `${Math.round(f)} mm` : '');
export const fmtIso = (iso?: number) => (iso ? `ISO ${iso}` : '');

/** Lightroom-style exposure summary: ISO · focal · aperture · shutter. */
export function exposureParts(meta?: PhotoMeta): string[] {
  if (!meta) return [];
  return [fmtIso(meta.iso), fmtFocal(meta.focalLength), fmtAperture(meta.fNumber), formatShutter(meta.exposureTime)].filter(Boolean);
}

export function joinPath(dir: string, name: string): string {
  const sep = api.platform === 'win32' ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

export function sanitizeFileName(s: string): string {
  // eslint-disable-next-line no-control-regex
  const out = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return out || 'untitled';
}

export function folderName(path: string): string {
  return basename(path) || path;
}

export function parentPath(path: string): string {
  const d = dirname(path);
  return d === path ? '' : d;
}

export const captureTime = (p: Photo) => p.meta?.dateTaken ?? p.mtime;

export function sourceTitle(filter: LibraryFilter, collections: { id: string; name: string }[]): string {
  const src = filter.source;
  if (src.type === 'all') return 'All Photographs';
  if (src.type === 'recent') return 'Previous Import';
  if (src.type === 'folder') return folderName(src.path);
  return collections.find((c) => c.id === src.id)?.name ?? 'Collection';
}

/** True when any attribute/text filter (anything but the source) is active. */
export function hasAttributeFilters(f: LibraryFilter): boolean {
  return !!f.text.trim() || f.minRating > 0 || f.ratingOp !== '>=' || f.flag !== 'all' || f.label !== 'any' || f.kind !== 'all' || f.edited !== 'all';
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
