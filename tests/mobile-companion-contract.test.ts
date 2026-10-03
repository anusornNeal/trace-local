import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

test('mobile companions share the release-candidate lifecycle contract', () => {
  const server = read('src/daemon/server.ts');
  const deviceStore = read('src/devices/device-session-store.ts');
  const desktopHtml = read('src/ui/index.html');
  const desktopJs = read('src/ui/app.js');
  const androidMain = read('apps/android-companion/app/src/main/java/com/tracelocal/companion/MainActivity.java');
  const androidVpn = read('apps/android-companion/app/src/main/java/com/tracelocal/companion/TraceVpnService.java');
  const androidClient = read('apps/android-companion/app/src/main/java/com/tracelocal/companion/PairingClient.java');
  const iosStore = read('apps/ios-companion/TraceLocal/Core/CompanionStore.swift');
  const iosTunnel = read('apps/ios-companion/TraceLocalExtension/PacketTunnelProvider.swift');
  const iosClient = read('apps/ios-companion/TraceLocal/Core/PairingClient.swift');
  const readme = read('README.md');

  const labels = [
    'Ready to pair',
    'Certificate required',
    'Ready to connect',
    'Connecting',
    'Connected',
    'Disconnecting',
    'Needs attention',
  ];

  for (const label of labels) {
    assert.equal(androidMain.includes(label), true, 'Android missing lifecycle label: ' + label);
    assert.equal(iosStore.includes(label), true, 'iOS missing lifecycle label: ' + label);
  }

  for (const source of [androidClient, iosClient]) assert.equal(source.includes('/device/session'), true);
  assert.equal(androidClient.includes('/heartbeat'), true);
  assert.equal(androidClient.includes('/disconnected'), true);
  assert.equal(androidVpn.includes('client.heartbeat('), true);
  assert.equal(androidVpn.includes('client.acknowledgeDisconnected('), true);
  assert.equal(iosTunnel.includes('/heartbeat'), true);
  assert.equal(iosTunnel.includes('/disconnected'), true);

  assert.equal(deviceStore.includes('DEFAULT_DEVICE_HEARTBEAT_MS = 3_000'), true);
  assert.equal(deviceStore.includes('DEFAULT_DEVICE_STALE_MS = 15_000'), true);
  assert.equal(server.includes('waitForDeviceDisconnects'), true);

  assert.equal(desktopHtml.includes('Mobile companions'), true);
  assert.equal(desktopHtml.includes('Advanced manual CA setup'), true);
  assert.equal(desktopJs.includes('stateLabel = (value)'), true);
  assert.equal(desktopJs.includes('mobileCaLink'), true);
  assert.equal(desktopHtml.includes('qrCanvas'), false);
  assert.equal(desktopJs.includes('generateQrCode('), false);
  assert.equal(desktopJs.includes('generateQrSvg('), false);
  assert.equal(desktopJs.includes('encodeQrData('), false);

  assert.equal(readme.includes('## Mobile companions'), true);
  assert.equal(readme.includes('Returning devices'), true);
  assert.equal(readme.includes('does not require editing Wi-Fi proxy settings'), true);
  assert.equal(readme.includes('not considered physically validated'), true);
  assert.equal(/adb\s+(shell|reverse)/i.test(readme), false);
});
