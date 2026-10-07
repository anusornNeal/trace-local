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
  const [builder, nsis, firewall, runtimeFirewall] = await Promise.all([
    read('electron-builder.yml'),
    read('scripts/installer/windows-firewall.nsh'),
    read('scripts/installer/windows-firewall.ps1'),
    read('src/platform/windows-firewall.ts'),
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
  assert.match(firewall, /Get-ConflictingInboundBlockRules/);
  assert.match(firewall, /\$hasConflictingBlockRule/);
  assert.match(firewall, /Disable-ConflictingInboundBlockRules/);
  assert.match(firewall, /PolicyStore = 'PersistentStore'/);
  assert.match(firewall, /tracelocal-firewall\.log/);
  assert.doesNotMatch(firewall, /PairingPort/);
  assert.doesNotMatch(firewall, /Profile = 'Any'/);

  assert.match(runtimeFirewall, /Buffer\.from\(childCommand, 'utf16le'\)/);
  assert.match(runtimeFirewall, /-EncodedCommand/);
  assert.doesNotMatch(runtimeFirewall, /scriptArgs\(options, 'install'\)\.map\(psLiteral\)/);
});

test('traffic inspector keeps detail, Map Local context menu, and live client count wired', async () => {
  const [ui, styles, proxy] = await Promise.all([
    read('src/ui/app.js'),
    read('src/ui/styles.css'),
    read('src/proxy/intercept-proxy.ts'),
  ]);

  assert.match(ui, /sessionList\.addEventListener\('click'/);
  assert.match(ui, /sessionList\.addEventListener\('contextmenu'/);
  assert.match(ui, /openTrafficContextMenu/);
  assert.match(ui, /contextMapLocal/);
  assert.match(ui, /detailPane.*classList\.toggle\('open'/);
  assert.match(ui, /setInterval\(\(\) => \{ void updateMobileStatus\(\); \}, 3000\)/);
  assert.match(styles, /\.detail-pane\.open \{ display: block; \}/);
  assert.match(proxy, /trackActiveClient\(request\.remoteIpAddress\)/);
});

test('traffic detail pane starts at the top and scrolls its own content', async () => {
  const [ui, styles] = await Promise.all([
    read('src/ui/app.js'),
    read('src/ui/styles.css'),
  ]);

  assert.match(styles, /\.detail-pane \{[\s\S]*display: flex;[\s\S]*justify-content: flex-start;/);
  assert.match(styles, /#detailContent \{[\s\S]*height: 100%;[\s\S]*overflow: auto;/);
  assert.match(styles, /#detailContent\[hidden\] \{ display: none !important; \}/);
  assert.match(styles, /pre\.json-body/);
  assert.match(ui, /detailContent'\)\.scrollTop = 0/);
  assert.match(ui, /JSON\.stringify\(JSON\.parse\(body\), null, 2\)/);
});


test('Traffic P0 inspector exposes resizers, sorting, structured detail, and context actions', async () => {
  const [html, ui, styles] = await Promise.all([
    read('src/ui/index.html'),
    read('src/ui/app.js'),
    read('src/ui/styles.css'),
  ]);

  assert.match(html, /data-pane-resizer="domains"/);
  assert.match(html, /data-pane-resizer="detail"/);
  assert.match(html, /data-sort="durationMs"/);
  assert.match(html, /data-sort="statusCode"/);
  assert.match(html, /contextCopyCurl/);
  assert.match(html, /contextClearHost/);
  assert.match(ui, /tracelocal\.inspector\.layout/);
  assert.match(ui, /headersTable/);
  assert.match(ui, /jsonTree/);
  assert.match(ui, /\/api\/sessions\?host=/);
  assert.match(styles, /\.column-resizer/);
  assert.match(styles, /\.headers-table/);
  assert.match(styles, /\.json-tree/);
  assert.match(styles, /resize: vertical/);
});


test('Map Local edits captured responses inline with path-only host-scoped matching', async () => {
  const [html, ui] = await Promise.all([
    read('src/ui/index.html'),
    read('src/ui/app.js'),
  ]);

  assert.match(html, /id="ruleHost" type="hidden"/);
  assert.match(html, /Edit the mapped response directly here/);
  assert.doesNotMatch(html, /id="browseFile"/);
  assert.doesNotMatch(html, /id="loadRuleFile"/);
  assert.doesNotMatch(html, /id="saveRuleFile"/);
  assert.match(ui, /ruleTarget'\)\.value = 'path'/);
  assert.match(ui, /ruleHost'\)\.value = summary\.host/);
  assert.match(ui, /rulePattern'\)\.value = summary\.path/);
  assert.match(ui, /responseBody: \$\('#ruleFileContent'\)\.value/);
  assert.match(ui, /host: \$\('#ruleHost'\)\.value/);
});

test('domain sidebar supports persistent favorites pinned above other domains', async () => {
  const [ui, styles] = await Promise.all([
    read('src/ui/app.js'),
    read('src/ui/styles.css'),
  ]);

  assert.match(ui, /favoriteDomains: new Set\(\)/);
  assert.match(ui, /saved\.favoriteDomains/);
  assert.match(ui, /favoriteDomains: \[\.\.\.state\.favoriteDomains\]/);
  assert.match(ui, /data-favorite-domain/);
  assert.match(ui, /bf - af \|\| a\[0\]\.localeCompare\(b\[0\]\)/);
  assert.match(styles, /\.domain-favorite\.on/);
  assert.match(styles, /\.domain-row-shell\.favorite/);
});
