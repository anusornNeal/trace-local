import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('traceLocalDesktop', Object.freeze({
  chooseFile: (): Promise<string | null> =>
    ipcRenderer.invoke('tracelocal:choose-file') as Promise<string | null>,
}));
