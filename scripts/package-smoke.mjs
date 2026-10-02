import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const releaseDir = path.resolve('release');
const candidates = process.platform === 'win32'
  ? [path.join(releaseDir, 'win-unpacked')]
  : process.platform === 'darwin'
    ? [path.join(releaseDir, 'mac'), path.join(releaseDir, 'mac-arm64')]
    : [path.join(releaseDir, 'linux-unpacked')];

const unpacked = candidates.find(existsSync);
assert.ok(unpacked, `No unpacked package found under ${releaseDir}`);

let executable;
let resources;
if (process.platform === 'win32') {
  executable = path.join(unpacked, 'Trace Local.exe');
  resources = path.join(unpacked, 'resources');
} else if (process.platform === 'darwin') {
  const app = path.join(unpacked, 'Trace Local.app');
  executable = path.join(app, 'Contents', 'MacOS', 'Trace Local');
  resources = path.join(app, 'Contents', 'Resources');
} else {
  executable = path.join(unpacked, 'tracelocal');
  resources = path.join(unpacked, 'resources');
}

const asar = path.join(resources, 'app.asar');
assert.ok(existsSync(executable), `Missing packaged executable: ${executable}`);
assert.ok(existsSync(asar), `Missing packaged app.asar: ${asar}`);
assert.ok(statSync(asar).size > 10_000, 'Packaged app.asar is unexpectedly small');

console.log(JSON.stringify({
  ok: true,
  platform: process.platform,
  unpacked,
  executable,
  appAsarBytes: statSync(asar).size,
}, null, 2));
