import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { TraceLocalDaemon } from './daemon/server';

let mainWindow: BrowserWindow | null = null;
let daemon: TraceLocalDaemon | null = null;
let shuttingDown = false;
let readinessEmitted = false;

const e2eMode = process.env.TRACELOCAL_E2E === '1';
const electronUserDataDir = process.env.TRACELOCAL_ELECTRON_USER_DATA_DIR?.trim();
if (electronUserDataDir) {
  app.setPath('userData', path.resolve(electronUserDataDir));
}

function portFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

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
  const dataDir = process.env.TRACELOCAL_DATA_DIR?.trim();
  const candidate = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: portFromEnv('TRACELOCAL_CONTROL_PORT') ?? 0,
    proxyPort,
    dataDir: dataDir ? path.resolve(dataDir) : undefined,
    allowRemote: true,
  });
  await candidate.start();
  return candidate;
}

async function createMainWindow(): Promise<void> {
  if (!daemon) {
    const configuredProxyPort = portFromEnv('TRACELOCAL_PROXY_PORT');
    const preferredProxyPort = configuredProxyPort ?? 8888;

    try {
      daemon = await startDesktopDaemon(preferredProxyPort);
    } catch (error) {
      if (isAddressInUse(error)) {
        throw new Error(`Proxy port ${preferredProxyPort} is already in use. Close the conflicting app or set TRACELOCAL_PROXY_PORT to another stable port.`);
      }
      throw error;
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

  mainWindow.once('ready-to-show', () => {
    if (!e2eMode) mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(
    `http://127.0.0.1:${daemon.status.controlPort}/`,
  );

  if (e2eMode && !readinessEmitted) {
    readinessEmitted = true;
    console.log(`TRACELOCAL_E2E_READY ${JSON.stringify(daemon.status)}`);
  }
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

if (e2eMode) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (chunk.includes('quit')) app.quit();
  });
}

app.whenReady().then(() => {
  void createMainWindow().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to start Trace Local desktop:', error);
    if (!e2eMode) {
      dialog.showErrorBox(
        'Trace Local could not start',
        `${message}\n\nCheck the data directory permissions and whether configured ports are available.`,
      );
    }
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
