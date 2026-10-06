import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => readFile(path.join(root, relative), 'utf8');

const [server, desktopHtml, desktopJs, desktop, firewall, readme] = await Promise.all([
  read('src/daemon/server.ts'),
  read('src/ui/index.html'),
  read('src/ui/app.js'),
  read('src/desktop.ts'),
  read('scripts/installer/windows-firewall.ps1'),
  read('README.md'),
]);

function requireText(source, value, label) {
  if (!source.includes(value)) throw new Error(label + ' is missing: ' + value);
}

function forbidText(source, value, label) {
  if (source.includes(value)) throw new Error(label + ' still contains legacy companion flow: ' + value);
}

requireText(desktopHtml, 'Mobile setup', 'Desktop mobile UI');
requireText(desktopHtml, 'No mobile app is required', 'Desktop mobile UI');
requireText(desktopHtml, 'Show CA download QR', 'Desktop mobile UI');
requireText(desktopJs, "/api/ca/mobile-token", 'CA QR action');
requireText(desktopJs, 'mobileQrSvg', 'CA QR rendering');
requireText(server, 'QRCode.toString(tokenUrl', 'Server CA QR');
requireText(desktop, 'preferredMobileCaPort = configuredMobileCaPort ?? 8889', 'Stable CA download port');
requireText(firewall, 'TraceLocal CA Download (Private)', 'Firewall CA rule');
requireText(readme, '## Mobile setup (no mobile app)', 'README mobile flow');

for (const [label, source] of [
  ['server', server],
  ['desktop HTML', desktopHtml],
  ['desktop JS', desktopJs],
  ['README', readme],
]) {
  for (const forbidden of ['tracelocal://pair', '/api/pairing/token', '/device/session', 'Pair mobile device', 'Mobile companions']) {
    forbidText(source, forbidden, label);
  }
}

for (const relative of ['apps/android-companion', 'apps/ios-companion', 'src/pairing', 'src/devices']) {
  if (existsSync(path.join(root, relative))) throw new Error('Legacy companion path still exists: ' + relative);
}

console.log(JSON.stringify({
  ok: true,
  mobileFlow: {
    mobileAppRequired: false,
    proxyConfiguration: 'manual',
    caInstall: 'manual',
    caDownloadQr: true,
    proxyPort: 8888,
    caDownloadPort: 8889,
  },
  physicalValidationStillRequired: [
    'Android manual Wi-Fi proxy + CA install/trust + HTTPS capture',
    'iPhone manual Wi-Fi proxy + CA install/full trust + HTTPS capture',
    'clean Windows install firewall access from a phone on the same LAN',
    'Wi-Fi/LAN/IP change behavior',
  ],
}, null, 2));
