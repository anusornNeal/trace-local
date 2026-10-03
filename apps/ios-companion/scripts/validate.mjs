import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const base = path.join(root, 'apps', 'ios-companion');

const required = [
  'TraceLocal.xcodeproj/project.pbxproj',
  'TraceLocal.xcodeproj/xcshareddata/xcschemes/TraceLocal.xcscheme',
  'TraceLocal/TraceLocalApp.swift',
  'TraceLocal/ContentView.swift',
  'TraceLocal/Core/PairingContract.swift',
  'TraceLocal/Core/PairingClient.swift',
  'TraceLocal/Core/DeviceIdentity.swift',
  'TraceLocal/Core/TunnelController.swift',
  'TraceLocal/Core/CompanionStore.swift',
  'TraceLocal/Scanner/ScannerView.swift',
  'TraceLocal/Info.plist',
  'TraceLocal/TraceLocal.entitlements',
  'TraceLocalExtension/PacketTunnelProvider.swift',
  'TraceLocalExtension/Info.plist',
  'TraceLocalExtension/TraceLocalExtension.entitlements',
  'TraceLocalTests/PairingContractTests.swift',
];

for (const relative of required) {
  await access(path.join(base, relative));
}

const pbx = await readFile(path.join(base, 'TraceLocal.xcodeproj/project.pbxproj'), 'utf8');
for (const token of [
  'TraceLocal.app',
  'TraceLocalExtension.appex',
  'TraceLocalTests.xctest',
  'Embed App Extensions',
  'PacketTunnelProvider.swift',
  'PairingContractTests.swift',
  'com.tracelocal.companion.PacketTunnel',
]) {
  if (!pbx.includes(token)) throw new Error('Xcode project is missing: ' + token);
}

const appInfo = await readFile(path.join(base, 'TraceLocal/Info.plist'), 'utf8');
if (!appInfo.includes('NSCameraUsageDescription') || !appInfo.includes('<string>tracelocal</string>')) {
  throw new Error('App Info.plist is missing QR/deep-link configuration');
}

for (const relative of [
  'TraceLocal/TraceLocal.entitlements',
  'TraceLocalExtension/TraceLocalExtension.entitlements',
]) {
  const text = await readFile(path.join(base, relative), 'utf8');
  if (!text.includes('packet-tunnel-provider')) throw new Error(relative + ' is missing Network Extension entitlement');
}

const extensionSource = await readFile(path.join(base, 'TraceLocalExtension/PacketTunnelProvider.swift'), 'utf8');
for (const token of [
  'NEProxySettings()',
  'httpEnabled = true',
  'httpsEnabled = true',
  'includedRoutes = []',
  '/heartbeat',
  '/disconnected',
  'cancelTunnelWithError',
]) {
  if (!extensionSource.includes(token)) throw new Error('Packet tunnel provider is missing: ' + token);
}
if (extensionSource.includes('NEIPv4Route.default()')) {
  throw new Error('Packet tunnel must not install a default route without a raw packet forwarder');
}

const pairing = await readFile(path.join(base, 'TraceLocal/Core/PairingContract.swift'), 'utf8');
for (const field of ['pairingId', 'proxyAddress', 'caFingerprint256', 'apiBaseUrl', 'caDownloadUrl', 'expiresAt']) {
  if (!pairing.includes('let ' + field + ':')) throw new Error('Pairing contract is missing ' + field);
}

const client = await readFile(path.join(base, 'TraceLocal/Core/PairingClient.swift'), 'utf8');
if (!client.includes('/device/session') || !client.includes('connectionProxyDictionary = [:]')) {
  throw new Error('Pairing client does not use the canonical direct device-session API');
}

console.log(JSON.stringify({
  ok: true,
  requiredFiles: required.length,
  targets: ['TraceLocal', 'TraceLocalExtension', 'TraceLocalTests'],
  routingMode: 'safe-http-proxy-no-default-route',
}, null, 2));
