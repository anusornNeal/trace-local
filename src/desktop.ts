import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TraceLocalDaemon } from './daemon/server';
import { ensureWindowsFirewallReady } from './platform/windows-firewall';

let mainWindow: BrowserWindow | null = null;
let daemon: TraceLocalDaemon | null = null;
let shuttingDown = false;
let readinessEmitted = false;
let lastSelectedMapFile: string | null = null;
const MAX_MAP_LOCAL_EDITOR_BYTES = 1024 * 1024;

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

async function startDesktopDaemon(
  proxyPort: number,
  mobileCaPort: number,
  startupWarnings: string[] = [],
): Promise<TraceLocalDaemon> {
  const dataDir = process.env.TRACELOCAL_DATA_DIR?.trim();
  const candidate = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: portFromEnv('TRACELOCAL_CONTROL_PORT') ?? 0,
    proxyPort,
    mobileCaPort,
    dataDir: dataDir ? path.resolve(dataDir) : undefined,
    allowRemote: true,
    startupWarnings,
  });
  await candidate.start();
  return candidate;
}

async function createMainWindow(): Promise<void> {
  if (!daemon) {
    const configuredProxyPort = portFromEnv('TRACELOCAL_PROXY_PORT');
    const preferredProxyPort = configuredProxyPort ?? 8888;
    const configuredMobileCaPort = portFromEnv('TRACELOCAL_MOBILE_PORT');
    const preferredMobileCaPort = configuredMobileCaPort ?? 8889;
    const firewallScriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'installer', 'windows-firewall.ps1')
      : path.resolve(__dirname, '..', 'scripts', 'installer', 'windows-firewall.ps1');
    const firewall = await ensureWindowsFirewallReady({
      programPath: process.execPath,
      scriptPath: firewallScriptPath,
      proxyPort: preferredProxyPort,
      caPort: preferredMobileCaPort,
      skip:
        e2eMode ||
        process.env.TRACELOCAL_SKIP_FIREWALL === '1' ||
        preferredProxyPort === 0 ||
        preferredMobileCaPort === 0,
    });
    const startupWarnings = firewall.warning ? [firewall.warning] : [];

    try {
      daemon = await startDesktopDaemon(preferredProxyPort, preferredMobileCaPort, startupWarnings);
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
    autoHideMenuBar: true,
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

  mainWindow.setMenuBarVisibility(false);

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

  const selected = result.canceled ? null : result.filePaths[0] ?? null;
  lastSelectedMapFile = selected ? path.resolve(selected) : null;
  return selected;
});

function canAccessMapLocalFile(filePath: string): boolean {
  if (!daemon) return false;
  const resolved = path.resolve(filePath);
  if (lastSelectedMapFile === resolved) return true;
  return daemon.rules.list().some((rule) => rule.filePath && path.resolve(rule.filePath) === resolved);
}

ipcMain.handle('tracelocal:read-text-file', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !canAccessMapLocalFile(filePath)) {
    throw new Error('File is not selected by a Map Local rule');
  }
  const resolved = path.resolve(filePath);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > MAX_MAP_LOCAL_EDITOR_BYTES) {
    throw new Error('Map Local file must be a text file smaller than 1 MiB');
  }
  return readFile(resolved, 'utf8');
});

ipcMain.handle('tracelocal:write-text-file', async (_event, filePath: unknown, content: unknown) => {
  if (typeof filePath !== 'string' || typeof content !== 'string' || !canAccessMapLocalFile(filePath)) {
    throw new Error('File is not selected by a Map Local rule');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_MAP_LOCAL_EDITOR_BYTES) {
    throw new Error('Map Local response exceeds 1 MiB');
  }
  await writeFile(path.resolve(filePath), content, 'utf8');
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
  if (shuttingDown) { event.preventDefault(); return; }
  if (!daemon) return;

  event.preventDefault();
  shuttingDown = true;
  const activeDaemon = daemon;
  daemon = null;

  void activeDaemon
    .stop()
    .catch((error) => console.error('Failed to stop Trace Local daemon:', error))
    .finally(() => { shuttingDown = false; app.quit(); });
});
