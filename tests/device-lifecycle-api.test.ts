import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceLocalDaemon } from '../src/daemon/server';

describe('paired device lifecycle API', () => {
  let daemon: TraceLocalDaemon;
  let controlPort = 0;

  before(async () => {
    daemon = new TraceLocalDaemon({
      controlHost: '127.0.0.1',
      controlPort: 0,
      proxyPort: 0,
      allowRemote: true,
      dataDir: join(tmpdir(), 'tracelocal-device-' + randomUUID()),
    });
    controlPort = (await daemon.start()).controlPort;
  });

  after(async () => daemon.stop());

  it('pairs, heartbeats, requests disconnect, and acknowledges cleanup', async () => {
    const pairingResponse = await fetch('http://127.0.0.1:' + controlPort + '/api/pairing/token', { method: 'POST' });
    assert.equal(pairingResponse.status, 201);
    const pairingSetup = await pairingResponse.json() as any;

    const pairingPayloadResponse = await fetch(pairingSetup.url);
    assert.equal(pairingPayloadResponse.status, 200);
    const pairingPayload = await pairingPayloadResponse.json() as any;
    const mobileOrigin = new URL(pairingSetup.url).origin;

    const connectResponse = await fetch(mobileOrigin + '/device/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingId: pairingPayload.pairingId,
        deviceId: 'test-device',
        name: 'Test Phone',
        platform: 'android',
      }),
    });
    assert.equal(connectResponse.status, 201);
    const connected = await connectResponse.json() as any;
    const sessionId = connected.session.sessionId;
    assert.equal(connected.restoreRoutingOnDisconnect, true);

    const replayConnect = await fetch(mobileOrigin + '/device/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingId: pairingPayload.pairingId,
        deviceId: 'second-device',
        name: 'Second Phone',
        platform: 'android',
      }),
    });
    assert.equal(replayConnect.status, 401);

    const listResponse = await fetch('http://127.0.0.1:' + controlPort + '/api/devices');
    const list = await listResponse.json() as any;
    assert.equal(list.devices.length, 1);

    const disconnectResponse = await fetch('http://127.0.0.1:' + controlPort + '/api/devices/' + encodeURIComponent(sessionId), { method: 'DELETE' });
    assert.equal(disconnectResponse.status, 200);

    const heartbeatResponse = await fetch(mobileOrigin + '/device/session/' + encodeURIComponent(sessionId) + '/heartbeat', { method: 'POST' });
    const heartbeat = await heartbeatResponse.json() as any;
    assert.equal(heartbeat.disconnectRequested, true);
    assert.equal(heartbeat.restoreRouting, true);

    const ackResponse = await fetch(mobileOrigin + '/device/session/' + encodeURIComponent(sessionId) + '/disconnected', { method: 'POST' });
    assert.equal(ackResponse.status, 200);

    const missingHeartbeat = await fetch(mobileOrigin + '/device/session/' + encodeURIComponent(sessionId) + '/heartbeat', { method: 'POST' });
    assert.equal(missingHeartbeat.status, 404);
    const missing = await missingHeartbeat.json() as any;
    assert.equal(missing.restoreRouting, true);
  });
});


it('graceful daemon stop gives connected devices a bounded disconnect window', async () => {
  const shutdownDaemon = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
    allowRemote: true,
    dataDir: join(tmpdir(), 'tracelocal-shutdown-' + randomUUID()),
  });
  const shutdownControlPort = (await shutdownDaemon.start()).controlPort;

  const pairingResponse = await fetch('http://127.0.0.1:' + shutdownControlPort + '/api/pairing/token', { method: 'POST' });
  const pairingSetup = await pairingResponse.json() as any;
  const pairingPayload = await fetch(pairingSetup.url).then((response) => response.json()) as any;
  const mobileOrigin = new URL(pairingSetup.url).origin;

  const connected = await fetch(mobileOrigin + '/device/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingId: pairingPayload.pairingId,
      deviceId: 'shutdown-device',
      name: 'Shutdown Phone',
      platform: 'android',
    }),
  }).then((response) => response.json()) as any;

  assert.equal(connected.heartbeatIntervalMs, 3_000);
  assert.equal(connected.staleAfterMs, 15_000);
  const sessionId = connected.session.sessionId;

  const observeDisconnect = (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const heartbeatResponse = await fetch(
        mobileOrigin + '/device/session/' + encodeURIComponent(sessionId) + '/heartbeat',
        { method: 'POST' },
      );
      const heartbeat = await heartbeatResponse.json() as any;
      if (heartbeat.disconnectRequested) {
        await fetch(
          mobileOrigin + '/device/session/' + encodeURIComponent(sessionId) + '/disconnected',
          { method: 'POST' },
        );
        return true;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return false;
  })();

  const startedAt = Date.now();
  await shutdownDaemon.stop();
  assert.equal(await observeDisconnect, true);
  assert.ok(Date.now() - startedAt < 4_500);
});
