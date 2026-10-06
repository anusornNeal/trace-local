import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TraceLocalDaemon } from '../src/daemon/server';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('Mobile CA download endpoints', () => {
  let daemon: TraceLocalDaemon;
  let controlPort: number;

  before(async () => {
    const dataDir = join(tmpdir(), `tracelocal-test-mobile-${randomUUID()}`);
    daemon = new TraceLocalDaemon({
      controlHost: '127.0.0.1',
      controlPort: 0,
      proxyPort: 0,
      mobileCaPort: 0,
      dataDir,
    });
    const status = await daemon.start();
    controlPort = status.controlPort;
  });

  after(async () => {
    await daemon.stop();
  });

  async function createDownload() {
    const response = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<any>;
  }

  it('creates a short-lived CA URL and real QR SVG', async () => {
    const data = await createDownload();
    assert.ok(data.token);
    assert.match(data.url, /^http:\/\//);
    assert.match(data.qrSvg, /<svg[\s>]/);
    assert.ok(data.expiresAt);
    assert.ok(data.ttlSeconds > 0);
    assert.ok(data.proxyAddress);
    assert.ok(Array.isArray(data.lanAddresses));
  });

  it('serves the CA certificate from the QR URL', async () => {
    const data = await createDownload();
    const response = await fetch(data.url);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-pem-file; charset=utf-8');
    assert.match(response.headers.get('content-disposition') || '', /tracelocal.*\.crt/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const cert = await response.text();
    assert.match(cert, /BEGIN CERTIFICATE/);
    assert.match(cert, /END CERTIFICATE/);
  });

  it('rejects invalid or expired CA download tokens', async () => {
    const data = await createDownload();
    const origin = new URL(data.url).origin;

    const invalid = await fetch(origin + '/ca/invalid-token-12345');
    assert.equal(invalid.status, 404);

    const tokenObj = (daemon.caTokenServer as any).tokens.get(data.token);
    assert.ok(tokenObj);
    tokenObj.expiresAt = Date.now() - 1;

    const expired = await fetch(data.url);
    assert.equal(expired.status, 404);
  });

  it('returns manual mobile setup status from active proxy clients', async () => {
    const response = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-status`);
    assert.equal(response.status, 200);

    const data = await response.json() as any;
    assert.equal(typeof data.activeClients, 'number');
    assert.ok(data.activeClients >= 0);
    assert.ok(data.proxyAddress);
    assert.ok(Array.isArray(data.lanAddresses));
    assert.equal('devices' in data, false);
  });

  it('creates unique QR URLs', async () => {
    const first = await createDownload();
    const second = await createDownload();

    assert.notEqual(first.token, second.token);
    assert.notEqual(first.url, second.url);
    assert.notEqual(first.qrSvg, second.qrSvg);
  });

  it('includes LAN interface metadata in the QR response', async () => {
    const data = await createDownload();
    assert.ok(Array.isArray(data.lanAddresses));
    for (const addr of data.lanAddresses) {
      assert.ok(addr.address);
      assert.ok(addr.family === 'IPv4' || addr.family === 'IPv6');
      assert.ok(addr.interface);
    }
  });
});
