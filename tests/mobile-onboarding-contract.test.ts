import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

test('desktop mobile onboarding uses stable pairing port and companion deep link', async () => {
  const [desktop, server, ui, android] = await Promise.all([
    read('src/desktop.ts'),
    read('src/daemon/server.ts'),
    read('src/ui/app.js'),
    read('apps/android-companion/app/src/main/java/com/tracelocal/companion/MainActivity.java'),
  ]);

  assert.match(desktop, /preferredMobilePort = configuredMobilePort \?\? 8889/);
  assert.match(server, /server\.listen\(requestedPort, '0\.0\.0\.0'/);
  assert.match(server, /tracelocal:\/\/pair\?url=/);
  assert.match(ui, /pairingToken\.deepLink \|\| state\.pairingToken\.url/);
  assert.match(android, /unwrapPairingUrl/);
  assert.match(android, /"tracelocal"\.equalsIgnoreCase\(candidate\.getScheme\(\)\)/);
});

test('Windows installer owns least-privilege TraceLocal firewall rules', async () => {
  const [builder, nsis, firewall] = await Promise.all([
    read('electron-builder.yml'),
    read('scripts/installer/windows-firewall.nsh'),
    read('scripts/installer/windows-firewall.ps1'),
  ]);

  assert.match(builder, /perMachine: true/);
  assert.match(builder, /include: scripts\/installer\/windows-firewall\.nsh/);
  assert.match(builder, /from: scripts\/installer\/windows-firewall\.ps1/);

  assert.match(nsis, /!macro customInstall/);
  assert.match(nsis, /!macro customUnInstall/);
  assert.match(nsis, /-Action install/);
  assert.match(nsis, /-Action uninstall/);

  assert.match(firewall, /Profile = 'Private'/);
  assert.match(firewall, /RemoteAddress = 'LocalSubnet'/);
  assert.match(firewall, /LocalPort = \$ProxyPort/);
  assert.match(firewall, /LocalPort = \$PairingPort/);
  assert.match(firewall, /Remove-ConflictingInboundBlockRules/);
  assert.doesNotMatch(firewall, /Profile = 'Any'/);
});
