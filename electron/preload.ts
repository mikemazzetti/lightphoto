import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  isElectron: true,
  platform: process.platform,
  openFiles: (opts: unknown) => ipcRenderer.invoke('dialog:openFiles', opts),
  saveDialog: (opts: unknown) => ipcRenderer.invoke('dialog:save', opts),
  list: (dir: string, recursive: boolean, kinds: string[]) => ipcRenderer.invoke('fs:list', dir, recursive, kinds),
  stat: (p: string) => ipcRenderer.invoke('fs:stat', p),
  readFile: (p: string) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p: string, data: ArrayBuffer | Uint8Array | string) => ipcRenderer.invoke('fs:write', p, data),
  openWrite: (p: string) => ipcRenderer.invoke('fs:openWrite', p),
  writeAt: (id: number, data: Uint8Array, pos: number) => ipcRenderer.invoke('fs:writeAt', id, data, pos),
  closeWrite: (id: number, discard?: boolean) => ipcRenderer.invoke('fs:closeWrite', id, discard),
  storeGet: (key: string) => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
  thumbGet: (key: string) => ipcRenderer.invoke('thumb:get', key),
  thumbPut: (key: string, data: ArrayBuffer) => ipcRenderer.invoke('thumb:put', key, data),
  reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  paths: () => ipcRenderer.invoke('app:paths'),
  setDirty: (d: boolean) => ipcRenderer.invoke('app:setDirty', d),
  setTitle: (t: string) => ipcRenderer.invoke('app:setTitle', t),
  convertToJpeg: (p: string) => ipcRenderer.invoke('image:convertToJpeg', p),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  onMenu: (cb: (action: string, payload?: unknown) => void) => {
    const h = (_e: unknown, action: string, payload?: unknown) => cb(action, payload);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
};

contextBridge.exposeInMainWorld('lpNative', api);
