import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('traceLocalDesktop', Object.freeze({
  chooseFile: (): Promise<string | null> =>
    ipcRenderer.invoke('tracelocal:choose-file') as Promise<string | null>,
  readTextFile: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('tracelocal:read-text-file', filePath) as Promise<string>,
  writeTextFile: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('tracelocal:write-text-file', filePath, content) as Promise<void>,
}));
