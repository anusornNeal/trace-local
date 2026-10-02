import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { TraceLocalDaemon } from './daemon/server';

let mainWindow: BrowserWindow | null = null;
let daemon: TraceLocalDaemon | null = null;
let shuttingDown = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isAddressInUse(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const withCode = error as Error & { code?: string; cause?: unknown };
  return (
    withCode.code === 'EADDRINUSE' ||
    /EADDRINUSE|address already in use/i.test(error.message) ||
    isAddressInUse(withCode.cause)
  );
}

async function startDesktopDaemon(proxyPort: number): Promise<TraceLocalDaemon> {
  const candidate = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort,
  });
  await candidate.start();
  return candidate;
}

async function createMainWindow(): Promise<void> {
  if (!daemon) {
    try {
      daemon = await startDesktopDaemon(8888);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      console.warn('Proxy port 8888 is already in use; falling back to a free port.');
      daemon = await startDesktopDaemon(0);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0f14',
    title: 'Trace Local',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(
    `http://127.0.0.1:${daemon.status.controlPort}/`,
  );
}

ipcMain.handle('tracelocal:choose-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Map Local response file',
    properties: ['openFile'],
  });

  return result.canceled ? null : result.filePaths[0] ?? null;
});

app.on('second-instance', () => {
  focusMainWindow();
});

app.whenReady().then(() => {
  void createMainWindow().catch((error) => {
    console.error('Failed to start Trace Local desktop:', error);
    app.quit();
  });

  app.on('activate', () => {
    void createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (shuttingDown || !daemon) return;

  event.preventDefault();
  shuttingDown = true;
  const activeDaemon = daemon;
  daemon = null;

  void activeDaemon
    .stop()
    .catch((error) => console.error('Failed to stop Trace Local daemon:', error))
    .finally(() => app.quit());
});
