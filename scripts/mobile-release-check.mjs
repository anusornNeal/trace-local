import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => readFile(path.join(root, relative), 'utf8');

const [
  server,
  deviceStore,
  desktopHtml,
  desktopJs,
  androidMain,
  androidVpn,
  androidClient,
  iosStore,
  iosTunnel,
  iosClient,
  readme,
] = await Promise.all([
  read('src/daemon/server.ts'),
  read('src/devices/device-session-store.ts'),
  read('src/ui/index.html'),
  read('src/ui/app.js'),
  read('apps/android-companion/app/src/main/java/com/tracelocal/companion/MainActivity.java'),
  read('apps/android-companion/app/src/main/java/com/tracelocal/companion/TraceVpnService.java'),
  read('apps/android-companion/app/src/main/java/com/tracelocal/companion/PairingClient.java'),
  read('apps/ios-companion/TraceLocal/Core/CompanionStore.swift'),
  read('apps/ios-companion/TraceLocalExtension/PacketTunnelProvider.swift'),
  read('apps/ios-companion/TraceLocal/Core/PairingClient.swift'),
  read('README.md'),
]);

function requireText(source, value, label) {
  if (!source.includes(value)) {
    throw new Error(label + ' is missing required contract text: ' + value);
  }
}

const lifecycleLabels = [
  'Ready to pair',
  'Certificate required',
  'Ready to connect',
  'Connecting',
  'Connected',
  'Disconnecting',
  'Needs attention',
];

for (const label of lifecycleLabels) {
  requireText(androidMain, label, 'Android lifecycle');
  requireText(iosStore, label, 'iOS lifecycle');
}

for (const source of [androidClient, iosClient]) {
  requireText(source, '/device/session', 'Mobile pairing client');
}
requireText(androidClient, '/heartbeat', 'Android heartbeat API');
requireText(androidClient, '/disconnected', 'Android disconnect acknowledgement API');
requireText(androidVpn, 'client.heartbeat(', 'Android VPN heartbeat lifecycle');
requireText(androidVpn, 'client.acknowledgeDisconnected(', 'Android VPN disconnect lifecycle');
requireText(iosTunnel, '/heartbeat', 'iOS heartbeat API');
requireText(iosTunnel, '/disconnected', 'iOS disconnect acknowledgement API');

requireText(deviceStore, 'DEFAULT_DEVICE_HEARTBEAT_MS = 3_000', 'Device lifecycle');
requireText(deviceStore, 'DEFAULT_DEVICE_STALE_MS = 15_000', 'Device lifecycle');
requireText(server, 'waitForDeviceDisconnects', 'Graceful desktop shutdown');

requireText(desktopHtml, 'Mobile companions', 'Desktop mobile UI');
requireText(desktopHtml, 'Advanced manual CA setup', 'Desktop advanced fallback');
requireText(desktopJs, "stateLabel = (value)", 'Desktop device state rendering');
requireText(desktopJs, "$('#mobileCaLink').textContent = tokenData.url", 'Manual CA link rendering');

for (const forbidden of ['qrCanvas', 'generateQrCode(', 'generateQrSvg(', 'encodeQrData(']) {
  if (desktopHtml.includes(forbidden) || desktopJs.includes(forbidden)) {
    throw new Error('Legacy fake QR implementation still present: ' + forbidden);
  }
}

requireText(readme, '## Mobile companions', 'README');
requireText(readme, 'Returning devices', 'README returning flow');
requireText(readme, 'does not require editing Wi-Fi proxy settings', 'README normal mobile flow');
requireText(readme, 'not considered physically validated', 'README physical validation boundary');

if (/adb\s+(shell|reverse)/i.test(readme)) {
  throw new Error('README normal product documentation must not depend on ADB commands');
}

const report = {
  ok: true,
  lifecycleLabels,
  serverPolicy: {
    heartbeatMs: 3000,
    staleAfterMs: 15000,
    gracefulDesktopDisconnect: true,
  },
  desktop: {
    serverGeneratedPairingQrOnly: true,
    legacyManualCaFallback: 'short-lived-link',
  },
  automation: {
    androidSourceContract: 'checked',
    iosSourceContract: 'checked',
    desktopSourceContract: 'checked',
  },
  physicalValidationStillRequired: [
    'Android first-use CA + VPN + HTTPS capture',
    'Android returning QR reconnect and Wi-Fi/LAN change',
    'iOS Xcode compile/signing + Network Extension entitlement',
    'iPhone first-use CA full-trust + VPN + HTTPS capture',
    'iPhone returning QR reconnect and desktop-loss cleanup',
    'sleep/wake and LAN/IP-change matrix on both platforms',
  ],
};

console.log(JSON.stringify(report, null, 2));
