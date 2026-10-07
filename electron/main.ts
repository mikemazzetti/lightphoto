import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, MenuItemConstructorOptions, nativeTheme } from 'electron';
import { createReadStream, promises as fsp, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';

const isMac = process.platform === 'darwin';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
/** LP_SMOKE=<file>: load the UI hidden, run renderer self-checks (optionally fetching <file> via lp://), print JSON, quit. */
const SMOKE = process.env.LP_SMOKE;

// Performance: keep the GPU path on even on blocklisted drivers, rasterize on GPU,
// and give V8 room for multi-hundred-megapixel documents.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'lp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

export const EXT = {
  image: ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'psd', 'jxl', 'ico'],
  raw: ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq', 'rwl', 'erf', 'kdc', 'mrw', 'mos', 'mef'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'aif', 'aiff'],
};
type Kind = keyof typeof EXT;
const extKind = new Map<string, Kind>();
for (const k of Object.keys(EXT) as Kind[]) for (const e of EXT[k]) extKind.set(e, k);

const MIME: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  woff2: 'font/woff2', ttf: 'font/ttf',
};
const mimeOf = (p: string) => MIME[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream';

/** Serves a local file, honouring HTTP Range so <video> can seek. */
// Production CSP for the app bundle. 'wasm-unsafe-eval' is required by the RAW decoder; lp: serves local media.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' lp: blob: data:",
  "media-src 'self' lp: blob: data:",
  "connect-src 'self' lp: blob: data:",
  "font-src 'self' data:",
].join('; ');

async function serveFile(filePath: string, req: Request, extra: Record<string, string> = {}): Promise<Response> {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers: Record<string, string> = {
    'Content-Type': mimeOf(filePath),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // Cross-origin isolation (SharedArrayBuffer for the threaded RAW decoder).
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-cache',
    ...extra,
  };
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

const userDir = (...p: string[]) => path.join(app.getPath('userData'), ...p);

async function atomicWrite(file: string, data: string | Uint8Array) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function walk(dir: string, recursive: boolean, kinds: Set<Kind>, out: any[], depth = 0) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith('.')) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < 32) await walk(full, recursive, kinds, out, depth + 1);
        return;
      }
      const ext = path.extname(e.name).slice(1).toLowerCase();
      const kind = extKind.get(ext);
      if (!kind || !kinds.has(kind)) return;
      try {
        const st = await fsp.stat(full);
        out.push({ path: full, name: e.name, ext, kind, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* unreadable */
      }
    }),
  );
}

let win: BrowserWindow | null = null;
let dirty = false;

function send(action: string, payload?: unknown) {
  win?.webContents.send('menu', action, payload);
}

function buildMenu() {
  const item = (label: string, action: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(action),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        item('New Document…', 'file:new', 'CmdOrCtrl+N'),
        item('Open…', 'file:open', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('Import Photos…', 'library:importFiles', 'CmdOrCtrl+Shift+I'),
        item('Import Folder…', 'library:importFolder'),
        item('Import Media to Video Project…', 'video:import'),
        { type: 'separator' },
        item('Save', 'file:save', 'CmdOrCtrl+S'),
        item('Save As…', 'file:saveAs', 'CmdOrCtrl+Shift+S'),
        item('Export…', 'file:export', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'edit:undo', 'CmdOrCtrl+Z'),
        item('Redo', 'edit:redo', isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
        { type: 'separator' },
        // Native roles keep copy/paste working inside text fields and fire DOM clipboard events elsewhere.
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        item('Select All', 'edit:selectAll', 'CmdOrCtrl+A'),
        item('Deselect', 'edit:deselect', 'CmdOrCtrl+D'),
        { type: 'separator' },
        item('Preferences…', 'app:preferences', 'CmdOrCtrl+,'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Zoom In', 'view:zoomIn', 'CmdOrCtrl+='),
        item('Zoom Out', 'view:zoomOut', 'CmdOrCtrl+-'),
        item('Fit on Screen', 'view:fit', 'CmdOrCtrl+0'),
        item('Actual Pixels', 'view:actual', 'CmdOrCtrl+1'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Reload would discard unsaved work, so it's a dev-only command.
        ...(DEV_URL ? [{ role: 'reload' as const, accelerator: 'CmdOrCtrl+Alt+R' }] : []),
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        item('Library', 'module:library', 'CmdOrCtrl+Alt+1'),
        item('Develop', 'module:develop', 'CmdOrCtrl+Alt+2'),
        item('Edit', 'module:editor', 'CmdOrCtrl+Alt+3'),
        item('Video', 'module:video', 'CmdOrCtrl+Alt+4'),
        { type: 'separator' },
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' as const }, { role: 'front' as const }] : []),
      ],
    },
    {
      role: 'help',
      submenu: [item('Keyboard Shortcuts', 'app:shortcuts', 'CmdOrCtrl+/')],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#161616',
    show: false,
    title: 'LightPhoto Studio',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: '#1b1b1b', symbolColor: '#d0d0d0', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (SMOKE) runSmokeTest(win);
  else win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    if (!dirty || !win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit Anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Unsaved documents and video projects will be lost.',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://bundle/index.html');
}

function runSmokeTest(w: BrowserWindow) {
  w.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') console.log('[renderer]', e.message);
  });
  w.webContents.once('did-finish-load', async () => {
    const probe = SMOKE && SMOKE !== '1' ? JSON.stringify(SMOKE) : 'null';
    try {
      const r = await w.webContents.executeJavaScript(`(async () => {
        const out = { native: !!window.lpNative, crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
          webgl2: !!document.createElement('canvas').getContext('webgl2'), webcodecs: typeof VideoEncoder === 'function' };
        const p = ${probe};
        if (p) {
          const res = await fetch('lp://file/' + encodeURIComponent(p), { headers: { Range: 'bytes=0-15' } });
          out.lpStatus = res.status; out.lpBytes = (await res.arrayBuffer()).byteLength; out.lpRange = res.headers.get('content-range');
        }
        await new Promise((r) => setTimeout(r, 1500));
        out.rootRendered = document.getElementById('root').children.length > 0;
        out.title = document.title;
        return out;
      })()`);
      console.log('SMOKE ' + JSON.stringify(r));
      // LP_SHOT=<png path>: also save a capture of the rendered window.
      if (process.env.LP_SHOT) {
        const img = await w.webContents.capturePage();
        await fsp.writeFile(process.env.LP_SHOT, img.toPNG());
      }
    } catch (e) {
      console.log('SMOKE-ERROR ' + String(e));
    }
    app.exit(0);
  });
}

function registerIpc() {
  ipcMain.handle('dialog:openFiles', async (_e, opts: { title?: string; filters?: Electron.FileFilter[]; multi?: boolean; directory?: boolean }) => {
    const props: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [opts?.directory ? 'openDirectory' : 'openFile'];
    if (opts?.multi) props.push('multiSelections');
    const r = await dialog.showOpenDialog(win!, { title: opts?.title, filters: opts?.filters, properties: props });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:save', async (_e, opts: { title?: string; defaultPath?: string; filters?: Electron.FileFilter[] }) => {
    const r = await dialog.showSaveDialog(win!, { title: opts?.title, defaultPath: opts?.defaultPath, filters: opts?.filters });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('fs:list', async (_e, dir: string, recursive: boolean, kinds: Kind[]) => {
    const out: any[] = [];
    await walk(dir, recursive, new Set(kinds), out);
    out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    return out;
  });
  ipcMain.handle('fs:stat', async (_e, p: string) => {
    try {
      const st = await fsp.stat(p);
      const ext = path.extname(p).slice(1).toLowerCase();
      return { path: p, name: path.basename(p), ext, kind: extKind.get(ext) ?? null, size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
    } catch {
      return null;
    }
  });
  ipcMain.handle('fs:read', async (_e, p: string) => {
    const buf = await fsp.readFile(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  ipcMain.handle('fs:write', async (_e, p: string, data: ArrayBuffer | Uint8Array | string) => {
    const payload = typeof data === 'string' ? data : data instanceof Uint8Array ? data : new Uint8Array(data);
    await atomicWrite(p, payload);
  });
  // Streaming / positioned writes (large video exports without holding the file in memory).
  const writeHandles = new Map<number, import('node:fs/promises').FileHandle>();
  const writtenPaths = new Map<number, string>();
  let writeSeq = 1;
  ipcMain.handle('fs:openWrite', async (_e, p: string) => {
    const h = await fsp.open(p, 'w');
    writeHandles.set(writeSeq, h);
    writtenPaths.set(writeSeq, p);
    return writeSeq++;
  });
  ipcMain.handle('fs:writeAt', async (_e, id: number, data: Uint8Array, pos: number) => {
    const h = writeHandles.get(id);
    if (!h) throw new Error('File handle is closed');
    await h.write(data, 0, data.byteLength, pos);
  });
  // Only files opened by fs:openWrite in this session can be discarded (cancelled exports).
  ipcMain.handle('fs:closeWrite', async (_e, id: number, discard?: boolean) => {
    await writeHandles.get(id)?.close();
    writeHandles.delete(id);
    const p = writtenPaths.get(id);
    writtenPaths.delete(id);
    if (discard && p) await fsp.rm(p, { force: true });
  });
  ipcMain.handle('store:get', async (_e, key: string) => {
    try {
      return JSON.parse(await fsp.readFile(userDir('store', `${key}.json`), 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('store:set', async (_e, key: string, value: unknown) => {
    await atomicWrite(userDir('store', `${key}.json`), JSON.stringify(value));
  });
  const thumbPath = (key: string) => userDir('thumbs', createHash('sha1').update(key).digest('hex') + '.jpg');
  ipcMain.handle('thumb:get', async (_e, key: string) => {
    try {
      const buf = await fsp.readFile(thumbPath(key));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      return null;
    }
  });
  ipcMain.handle('thumb:put', async (_e, key: string, data: ArrayBuffer) => {
    await atomicWrite(thumbPath(key), new Uint8Array(data));
  });
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('app:paths', () => ({
    home: os.homedir(),
    pictures: app.getPath('pictures'),
    videos: app.getPath('videos'),
    documents: app.getPath('documents'),
    desktop: app.getPath('desktop'),
    temp: app.getPath('temp'),
  }));
  ipcMain.handle('app:setDirty', (_e, d: boolean) => {
    dirty = !!d;
    win?.setDocumentEdited?.(dirty);
  });
  ipcMain.handle('app:setTitle', (_e, t: string) => win?.setTitle(t));
  // macOS can decode HEIC natively through `sips`; elsewhere the renderer falls back to an error.
  ipcMain.handle('image:convertToJpeg', async (_e, p: string) => {
    if (!isMac) return null;
    const out = path.join(app.getPath('temp'), `lp-${createHash('sha1').update(p).digest('hex')}.jpg`);
    await new Promise<void>((resolve, reject) =>
      execFile('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', p, '--out', out], (err) => (err ? reject(err) : resolve())),
    );
    return out;
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  const distDir = path.join(__dirname, '..', 'dist');
  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.normalize(path.join(distDir, rel));
    if (!full.startsWith(distDir)) return new Response('Forbidden', { status: 403 });
    return serveFile(full, req, full.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {});
  });
  // lp://file/<encodeURIComponent(absolutePath)>
  protocol.handle('lp', async (req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    return serveFile(p, req);
  });
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
