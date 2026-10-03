import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceLocalDaemon } from '../src/daemon/server';

describe('secure pairing endpoint', () => {
  let daemon: TraceLocalDaemon;
  let controlPort = 0;

  before(async () => {
    daemon = new TraceLocalDaemon({
      controlHost: '127.0.0.1',
      controlPort: 0,
      proxyPort: 0,
      allowRemote: true,
      dataDir: join(tmpdir(), 'tracelocal-pairing-' + randomUUID()),
    });
    controlPort = (await daemon.start()).controlPort;
  });

  after(async () => {
    await daemon.stop();
  });

  async function createPairing() {
    const response = await fetch('http://127.0.0.1:' + controlPort + '/api/pairing/token', { method: 'POST' });
    assert.equal(response.status, 201);
    return response.json() as Promise<any>;
  }

  it('creates a versioned short-lived pairing reference with a real QR SVG', async () => {
    const pairing = await createPairing();
    assert.equal(pairing.protocolVersion, 1);
    assert.ok(pairing.ttlSeconds > 0 && pairing.ttlSeconds <= 120);
    assert.match(pairing.desktopId, /^trace-local-[a-f0-9]{16}$/);
    assert.match(pairing.proxyAddress, /:\d+$/);
    assert.ok(pairing.caFingerprint256);
    assert.match(pairing.qrSvg, /<svg[\s>]/);
    assert.match(pairing.qrSvg, /<path /);

    const url = new URL(pairing.url);
    assert.match(url.pathname, /^\/pair\/[A-Za-z0-9_-]{40,}$/);
    assert.equal(url.searchParams.get('v'), '1');
    assert.equal([...url.searchParams.keys()].length, 1);
    assert.equal(pairing.url.includes(pairing.caFingerprint256), false);
    assert.equal(pairing.url.includes('PRIVATE KEY'), false);
    assert.equal(pairing.qrSvg.includes('PRIVATE KEY'), false);
  });

  it('rejects wrong protocol without consuming the token, then consumes it once', async () => {
    const pairing = await createPairing();
    const wrong = new URL(pairing.url);
    wrong.searchParams.set('v', '999');

    const wrongResponse = await fetch(wrong);
    assert.equal(wrongResponse.status, 400);

    const accepted = await fetch(pairing.url);
    assert.equal(accepted.status, 200);
    const payload = await accepted.json() as any;
    assert.equal(payload.protocolVersion, 1);
    assert.ok(payload.pairingId);
    assert.equal(payload.desktopId, pairing.desktopId);
    assert.equal(payload.proxyAddress, pairing.proxyAddress);
    assert.equal(payload.caFingerprint256, pairing.caFingerprint256);
    assert.equal(payload.apiBaseUrl, new URL(pairing.url).origin);
    assert.match(payload.caDownloadUrl, /^http:\/\//);
    assert.ok(payload.expiresAt > pairing.expiresAt);
    const caResponse = await fetch(payload.caDownloadUrl);
    assert.equal(caResponse.status, 200);
    assert.match(await caResponse.text(), /BEGIN CERTIFICATE/);
    assert.equal('privateKey' in payload, false);
    assert.equal(JSON.stringify(payload).includes('PRIVATE KEY'), false);

    const replay = await fetch(pairing.url);
    assert.equal(replay.status, 410);
    const replayPayload = await replay.json() as any;
    assert.equal(replayPayload.error, 'pairing_token_expired_or_used');
  });
});
