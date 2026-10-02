import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TraceLocalDaemon } from '../src/daemon/server';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('Mobile CA endpoints', () => {
  let daemon: TraceLocalDaemon;
  let controlPort: number;

  before(async () => {
    const dataDir = join(tmpdir(), `tracelocal-test-mobile-${randomUUID()}`);
    daemon = new TraceLocalDaemon({
      controlHost: '127.0.0.1',
      controlPort: 0,
      proxyPort: 0,
      dataDir,
    });
    const status = await daemon.start();
    controlPort = status.controlPort;
  });

  after(async () => {
    await daemon.stop();
  });

  it('creates mobile token', async () => {
    const response = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });

    assert.equal(response.status, 201);
    const data = await response.json();
    assert.ok(data.token);
    assert.ok(data.url);
    assert.ok(data.expiresAt);
    assert.ok(data.ttlSeconds > 0);
    assert.ok(data.proxyAddress);
    assert.ok(Array.isArray(data.lanAddresses));
  });

  it('serves CA cert with valid token', async () => {
    const tokenResponse = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    const { token } = await tokenResponse.json();

    const certResponse = await fetch(`http://127.0.0.1:${controlPort}/ca/${token}`);
    assert.equal(certResponse.status, 200);
    assert.equal(certResponse.headers.get('content-type'), 'application/x-pem-file; charset=utf-8');
    assert.equal(certResponse.headers.get('content-disposition'), 'attachment; filename="tracelocal.crt"');

    const cert = await certResponse.text();
    assert.ok(cert.includes('BEGIN CERTIFICATE'));
    assert.ok(cert.includes('END CERTIFICATE'));
  });

  it('rejects invalid token', async () => {
    const response = await fetch(`http://127.0.0.1:${controlPort}/ca/invalid-token-12345`);
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.ok(text.includes('Invalid or expired'));
  });

  it('returns mobile status', async () => {
    const response = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-status`);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.ok(typeof data.activeClients === 'number');
    assert.ok(data.activeClients >= 0);
    assert.ok(Array.isArray(data.lanAddresses));
  });

  it('tracks client connections', async () => {
    const tokenResponse = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    const { token } = await tokenResponse.json();

    const beforeStatus = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-status`);
    const beforeData = await beforeStatus.json();
    const beforeCount = beforeData.activeClients;

    await fetch(`http://127.0.0.1:${controlPort}/ca/${token}`);

    const afterStatus = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-status`);
    const afterData = await afterStatus.json();
    const afterCount = afterData.activeClients;

    assert.ok(afterCount >= beforeCount);
  });

  it('rejects expired token', async () => {
    const tokenResponse = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    const { token } = await tokenResponse.json();

    // Manually expire the token
    const tokenServer = daemon.caTokenServer;
    const tokenObj = (tokenServer as any).tokens.get(token);
    assert.ok(tokenObj);
    tokenObj.expiresAt = Date.now() - 1000;

    const certResponse = await fetch(`http://127.0.0.1:${controlPort}/ca/${token}`);
    assert.equal(certResponse.status, 404);
  });

  it('creates unique tokens on multiple requests', async () => {
    const response1 = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    const data1 = await response1.json();

    const response2 = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    const data2 = await response2.json();

    assert.notEqual(data1.token, data2.token);
    assert.notEqual(data1.url, data2.url);
  });

  it('includes LAN addresses in token response', async () => {
    const response = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    const data = await response.json();

    assert.ok(Array.isArray(data.lanAddresses));
    for (const addr of data.lanAddresses) {
      assert.ok(addr.address);
      assert.ok(addr.family === 'IPv4' || addr.family === 'IPv6');
      assert.ok(addr.interface);
    }
  });

  it('sets cache-control header on CA cert response', async () => {
    const tokenResponse = await fetch(`http://127.0.0.1:${controlPort}/api/ca/mobile-token`, {
      method: 'POST',
    });
    const { token } = await tokenResponse.json();

    const certResponse = await fetch(`http://127.0.0.1:${controlPort}/ca/${token}`);
    assert.equal(certResponse.headers.get('cache-control'), 'no-store');
  });
});
