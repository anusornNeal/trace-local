import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceLocalDaemon } from '../src/daemon/server';

const execFileAsync = promisify(execFile);

describe('device CLI', () => {
  let daemon: TraceLocalDaemon;
  let controlUrl = '';
  let mobileOrigin = '';
  let pairingId = '';

  before(async () => {
    daemon = new TraceLocalDaemon({
      controlHost: '127.0.0.1',
      controlPort: 0,
      proxyPort: 0,
      allowRemote: true,
      dataDir: join(tmpdir(), 'tracelocal-cli-device-' + randomUUID()),
    });
    const status = await daemon.start();
    controlUrl = 'http://127.0.0.1:' + status.controlPort;

    const setupResponse = await fetch(controlUrl + '/api/pairing/token', { method: 'POST' });
    assert.equal(setupResponse.status, 201);
    const setup = await setupResponse.json() as any;
    mobileOrigin = new URL(setup.url).origin;

    const pairingResponse = await fetch(setup.url);
    assert.equal(pairingResponse.status, 200);
    const pairing = await pairingResponse.json() as any;
    pairingId = pairing.pairingId;
  });

  after(async () => daemon.stop());

  async function runCli(args: string[]) {
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cli = join(process.cwd(), 'src', 'cli.ts');
    return execFileAsync(process.execPath, [tsxCli, cli, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
    });
  }

  async function connect(deviceId: string, name: string): Promise<string> {
    const response = await fetch(mobileOrigin + '/device/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId, deviceId, name, platform: 'android' }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as any;
    return body.session.sessionId;
  }

  it('lists connected devices as compact JSON', async () => {
    const sessionId = await connect('cli-device-1', 'CLI Phone');
    const { stdout, stderr } = await runCli([
      'devices',
      'list',
      '--control-url',
      controlUrl,
      '--json',
    ]);
    assert.equal(stderr, '');

    const result = JSON.parse(stdout);
    assert.equal(result.devices.length, 1);
    assert.equal(result.devices[0].sessionId, sessionId);
    assert.equal(result.devices[0].name, 'CLI Phone');
  });

  it('disconnects one device and rejects ambiguous input', async () => {
    const list = await fetch(controlUrl + '/api/devices').then((response) => response.json()) as any;
    const sessionId = list.devices[0].sessionId;

    const { stdout } = await runCli([
      'devices',
      'disconnect',
      sessionId,
      '--control-url',
      controlUrl,
      '--json',
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.requested, true);
    assert.equal(result.session.sessionId, sessionId);

    await assert.rejects(
      runCli(['devices', 'disconnect', '--control-url', controlUrl]),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Specify exactly one device session id or --all/);
        return true;
      },
    );
  });
});
