/**
 * Platform layer. In Electron it talks to the main process through the preload bridge;
 * in a plain browser (handy for UI work at http://localhost:5173) it falls back to
 * <input type=file>, object URLs, downloads and localStorage.
 *
 * Files are always identified by a string `path`. Use `fileUrl(path)` to get a URL that
 * <img>/<video>/fetch can load. ALWAYS set `crossOrigin = 'anonymous'` on media elements
 * loaded from these URLs, otherwise WebGL uploads will throw a security error.
 */

export type MediaKind = 'image' | 'raw' | 'video' | 'audio';

export interface FileEntry {
  path: string;
  name: string;
  ext: string;
  kind: MediaKind | null;
  size: number;
  mtime: number;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const EXTENSIONS: Record<MediaKind, string[]> = {
  image: ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'psd', 'jxl', 'ico'],
  raw: ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq', 'rwl', 'erf', 'kdc', 'mrw', 'mos', 'mef'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'aif', 'aiff'],
};

const EXT_KIND = new Map<string, MediaKind>();
for (const k of Object.keys(EXTENSIONS) as MediaKind[]) for (const e of EXTENSIONS[k]) EXT_KIND.set(e, k);

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const extname = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};
export const stem = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
};
export const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
};
export const kindOf = (p: string): MediaKind | null => EXT_KIND.get(extname(p)) ?? null;

export const FILTERS = {
  photos: { name: 'Photos', extensions: [...EXTENSIONS.image, ...EXTENSIONS.raw] },
  images: { name: 'Images', extensions: EXTENSIONS.image },
  raw: { name: 'Camera RAW', extensions: EXTENSIONS.raw },
  video: { name: 'Video', extensions: EXTENSIONS.video },
  audio: { name: 'Audio', extensions: EXTENSIONS.audio },
  media: { name: 'All Media', extensions: [...EXTENSIONS.video, ...EXTENSIONS.audio, ...EXTENSIONS.image, ...EXTENSIONS.raw] },
  psd: { name: 'Photoshop Document', extensions: ['psd'] },
  project: { name: 'LightPhoto Project', extensions: ['lpp'] },
  videoProject: { name: 'LightPhoto Video Project', extensions: ['lpv'] },
  jpeg: { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  png: { name: 'PNG', extensions: ['png'] },
  webp: { name: 'WebP', extensions: ['webp'] },
  mp4: { name: 'MP4 Video', extensions: ['mp4'] },
  webm: { name: 'WebM Video', extensions: ['webm'] },
} satisfies Record<string, FileFilter>;

interface Native {
  isElectron: true;
  platform: string;
  openFiles(opts: { title?: string; filters?: FileFilter[]; multi?: boolean; directory?: boolean }): Promise<string[]>;
  saveDialog(opts: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  list(dir: string, recursive: boolean, kinds: MediaKind[]): Promise<FileEntry[]>;
  stat(p: string): Promise<(FileEntry & { isDir: boolean }) | null>;
  readFile(p: string): Promise<ArrayBuffer>;
  writeFile(p: string, data: ArrayBuffer | Uint8Array | string): Promise<void>;
  openWrite(p: string): Promise<number>;
  writeAt(id: number, data: Uint8Array, pos: number): Promise<void>;
  closeWrite(id: number, discard?: boolean): Promise<void>;
  storeGet(key: string): Promise<any>;
  storeSet(key: string, value: unknown): Promise<void>;
  thumbGet(key: string): Promise<ArrayBuffer | null>;
  thumbPut(key: string, data: ArrayBuffer): Promise<void>;
  reveal(p: string): Promise<void>;
  paths(): Promise<Record<string, string>>;
  setDirty(d: boolean): Promise<void>;
  setTitle(t: string): Promise<void>;
  convertToJpeg(p: string): Promise<string | null>;
  pathForFile(f: File): string;
  onMenu(cb: (action: string, payload?: unknown) => void): () => void;
}

const native: Native | undefined = (globalThis as any).lpNative;

// ---------------------------------------------------------------------------------------------
// Browser fallback state
const memFiles = new Map<string, File>();
const memUrls = new Map<string, string>();
const memThumbs = new Map<string, ArrayBuffer>();
let memSeq = 0;

function registerMemFile(f: File, dir = 'files'): string {
  const rel: string = (f as any).webkitRelativePath || f.name;
  let p = `mem://${dir}/${rel}`;
  for (let n = 2; memFiles.has(p) && memFiles.get(p) !== f; n++) p = `mem://${dir}/${rel.replace(/(\.[^./]+)?$/, ` (${n})$1`)}`;
  memFiles.set(p, f);
  return p;
}

function pickWithInput(accept: string, multi: boolean, directory: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multi;
    if (directory) (input as any).webkitdirectory = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

function entryFor(p: string, size = 0, mtime = Date.now()): FileEntry {
  return { path: p, name: basename(p), ext: extname(p), kind: kindOf(p), size, mtime };
}

// ---------------------------------------------------------------------------------------------

export const api = {
  isElectron: !!native,
  platform: native?.platform ?? (navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32'),
  get isMac() {
    return this.platform === 'darwin';
  },

  /** Returns selected absolute paths (empty when cancelled). */
  async openFiles(opts: { title?: string; filters?: FileFilter[]; multi?: boolean } = {}): Promise<string[]> {
    if (native) return native.openFiles(opts);
    const accept = (opts.filters ?? []).flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
    const files = await pickWithInput(accept, !!opts.multi, false);
    return files.map((f) => registerMemFile(f));
  },

  /** Returns a directory path, or null. In the browser, the whole folder's files are registered. */
  async openFolder(title?: string): Promise<string | null> {
    if (native) return (await native.openFiles({ title, directory: true }))[0] ?? null;
    const files = await pickWithInput('', true, true);
    if (!files.length) return null;
    const dir = `folder${memSeq++}`;
    for (const f of files) registerMemFile(f, dir);
    return `mem://${dir}`;
  },

  async list(dir: string, recursive = true, kinds: MediaKind[] = ['image', 'raw']): Promise<FileEntry[]> {
    if (native) return native.list(dir, recursive, kinds);
    const out: FileEntry[] = [];
    for (const [p, f] of memFiles) {
      if (!p.startsWith(dir + '/')) continue;
      const e = entryFor(p, f.size, f.lastModified);
      if (e.kind && kinds.includes(e.kind)) out.push(e);
    }
    return out;
  },

  async stat(p: string): Promise<(FileEntry & { isDir?: boolean }) | null> {
    if (native) return native.stat(p);
    const f = memFiles.get(p);
    return f ? entryFor(p, f.size, f.lastModified) : null;
  },

  /** Save dialog. Returns the chosen path or null. */
  async saveDialog(opts: { title?: string; defaultPath?: string; filters?: FileFilter[] } = {}): Promise<string | null> {
    if (native) return native.saveDialog(opts);
    const name = prompt('Save as', basename(opts.defaultPath ?? 'untitled'));
    return name ? `download://${name}` : null;
  },

  fileUrl(p: string): string {
    if (native) return `lp://file/${encodeURIComponent(p)}`;
    if (p.startsWith('blob:') || p.startsWith('data:') || p.startsWith('http')) return p;
    let u = memUrls.get(p);
    if (!u) {
      const f = memFiles.get(p);
      if (!f) return p;
      u = URL.createObjectURL(f);
      memUrls.set(p, u);
    }
    return u;
  },

  async readFile(p: string): Promise<ArrayBuffer> {
    if (native) return native.readFile(p);
    const f = memFiles.get(p);
    if (f) return f.arrayBuffer();
    return (await fetch(p)).arrayBuffer();
  },

  /** Reads a file as a Blob (typed by extension) — convenient for createImageBitmap. */
  async readBlob(p: string): Promise<Blob> {
    if (!native) {
      const f = memFiles.get(p);
      if (f) return f;
    }
    const res = await fetch(api.fileUrl(p));
    return res.blob();
  },

  async writeFile(p: string, data: ArrayBuffer | Uint8Array | string | Blob): Promise<void> {
    if (data instanceof Blob) data = await data.arrayBuffer();
    if (native) return native.writeFile(p, data);
    const blob = new Blob([data as BlobPart]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = basename(p.replace('download://', ''));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },

  /**
   * Opens a file for positioned/streaming writes (e.g. a mediabunny StreamTarget). In the browser
   * fallback chunks are assembled in memory and downloaded on close.
   */
  async openWriteStream(p: string): Promise<{ write(data: Uint8Array, position: number): Promise<void>; close(discard?: boolean): Promise<void> }> {
    if (native) {
      const id = await native.openWrite(p);
      return { write: (d, pos) => native.writeAt(id, d, pos), close: (discard) => native.closeWrite(id, discard) };
    }
    const chunks: { d: Uint8Array; pos: number }[] = [];
    return {
      write: async (d, pos) => void chunks.push({ d: d.slice(), pos }),
      close: async (discard) => {
        if (discard) return;
        const size = chunks.reduce((m, c) => Math.max(m, c.pos + c.d.byteLength), 0);
        const out = new Uint8Array(size);
        for (const c of chunks) out.set(c.d, c.pos);
        await api.writeFile(p, out);
      },
    };
  },

  /** Small JSON key/value store persisted in the user data folder. */
  async storeGet<T = unknown>(key: string): Promise<T | null> {
    if (native) return native.storeGet(key);
    try {
      const s = localStorage.getItem('lp:' + key);
      return s ? (JSON.parse(s) as T) : null;
    } catch {
      return null;
    }
  },
  async storeSet(key: string, value: unknown): Promise<void> {
    if (native) return native.storeSet(key, value);
    try {
      localStorage.setItem('lp:' + key, JSON.stringify(value));
    } catch {
      /* quota */
    }
  },

  /** Persistent JPEG thumbnail cache keyed by an arbitrary string. */
  async thumbGet(key: string): Promise<ArrayBuffer | null> {
    if (native) return native.thumbGet(key);
    return memThumbs.get(key) ?? null;
  },
  async thumbPut(key: string, data: ArrayBuffer): Promise<void> {
    if (native) return native.thumbPut(key, data);
    memThumbs.set(key, data);
  },

  reveal(p: string) {
    native?.reveal(p);
  },
  async paths(): Promise<Record<string, string>> {
    return native ? native.paths() : { home: '', pictures: '', videos: '', documents: '', desktop: '', temp: '' };
  },
  setDirty(d: boolean) {
    native?.setDirty(d);
  },
  setTitle(t: string) {
    if (native) native.setTitle(t);
    else document.title = t;
  },
  async convertToJpeg(p: string): Promise<string | null> {
    return native ? native.convertToJpeg(p) : null;
  },
  /** Absolute path of a File from drag & drop / <input>. */
  pathForFile(f: File): string {
    if (native) {
      try {
        const p = native.pathForFile(f);
        if (p) return p;
      } catch {
        /* not a disk file */
      }
    }
    return registerMemFile(f);
  },
  onMenu(cb: (action: string, payload?: unknown) => void): () => void {
    return native ? native.onMenu(cb) : () => {};
  },
};

export type Api = typeof api;
