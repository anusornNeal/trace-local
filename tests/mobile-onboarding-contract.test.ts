import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

test('mobile onboarding is manual proxy plus CA download QR with no companion app', async () => {
  const [desktop, server, html, ui] = await Promise.all([
    read('src/desktop.ts'),
    read('src/daemon/server.ts'),
    read('src/ui/index.html'),
    read('src/ui/app.js'),
  ]);

  assert.match(desktop, /preferredMobileCaPort = configuredMobileCaPort \?\? 8889/);
  assert.match(server, /server\.listen\(requestedPort, '0\.0\.0\.0'/);
  assert.match(server, /QRCode\.toString\(tokenUrl/);
  assert.match(server, /url: tokenUrl/);
  assert.match(server, /qrSvg/);

  assert.match(html, /Mobile setup/);
  assert.match(html, /No mobile app is required/);
  assert.match(html, /Proxy LAN address/);
  assert.match(html, /Show CA download QR/);
  assert.match(ui, /\/api\/ca\/mobile-token/);
  assert.match(ui, /mobileQrSvg/);

  for (const source of [server, html, ui]) {
    assert.doesNotMatch(source, /tracelocal:\/\/pair/);
    assert.doesNotMatch(source, /\/api\/pairing\/token/);
    assert.doesNotMatch(source, /\/device\/session/);
    assert.doesNotMatch(source, /Pair mobile device/);
  }

  assert.equal(existsSync(path.join(root, 'apps', 'android-companion')), false);
  assert.equal(existsSync(path.join(root, 'apps', 'ios-companion')), false);
  assert.equal(existsSync(path.join(root, 'src', 'pairing')), false);
  assert.equal(existsSync(path.join(root, 'src', 'devices')), false);
});

test('Windows installer opens only proxy and CA download ports to the local subnet', async () => {
  const [builder, nsis, firewall] = await Promise.all([
    read('electron-builder.yml'),
    read('scripts/installer/windows-firewall.nsh'),
    read('scripts/installer/windows-firewall.ps1'),
  ]);

  assert.match(builder, /perMachine: true/);
  assert.match(builder, /include: scripts\/installer\/windows-firewall\.nsh/);
  assert.match(builder, /from: scripts\/installer\/windows-firewall\.ps1/);

  assert.match(nsis, /-ProxyPort 8888/);
  assert.match(nsis, /-CaPort 8889/);
  assert.doesNotMatch(nsis, /PairingPort/);

  assert.match(firewall, /TraceLocal Proxy \(Private\)/);
  assert.match(firewall, /TraceLocal CA Download \(Private\)/);
  assert.match(firewall, /Profile = 'Private, Public'/);
  assert.match(firewall, /RemoteAddress = 'LocalSubnet'/);
  assert.match(firewall, /LocalPort = \$ProxyPort/);
  assert.match(firewall, /LocalPort = \$CaPort/);
  assert.doesNotMatch(firewall, /PairingPort/);
  assert.doesNotMatch(firewall, /Profile = 'Any'/);
});
