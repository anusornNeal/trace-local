import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceSessionStore } from '../src/devices/device-session-store';

test('pairing authorization is single-use and creates a device session', () => {
  let now = 1000;
  const store = new DeviceSessionStore(45_000, () => now);
  store.authorizePairing('pair-1', now + 5000);
  const session = store.connect('pair-1', { deviceId: 'phone-1', name: 'Pixel', platform: 'android' });
  assert.ok(session);
  assert.equal(store.connect('pair-1', { deviceId: 'phone-2', name: 'Other', platform: 'android' }), null);
  assert.equal(store.size, 1);
});

test('disconnect survives heartbeat until companion acknowledges and requests routing restore', () => {
  let now = 1000;
  const store = new DeviceSessionStore(45_000, () => now);
  store.authorizePairing('pair-1', now + 5000);
  const session = store.connect('pair-1', { deviceId: 'phone-1', name: 'Pixel', platform: 'android' })!;
  store.requestDisconnect(session.sessionId);
  now += 1000;
  const heartbeat = store.heartbeat(session.sessionId)!;
  assert.equal(heartbeat.disconnectRequested, true);
  assert.equal(heartbeat.restoreRouting, true);
  assert.equal(heartbeat.session.state, 'disconnecting');
  assert.equal(store.acknowledgeDisconnected(session.sessionId), true);
  assert.equal(store.size, 0);
});

test('stale heartbeat sessions expire', () => {
  let now = 1000;
  const store = new DeviceSessionStore(30_000, () => now);
  store.authorizePairing('pair-1', now + 5000);
  const session = store.connect('pair-1', { deviceId: 'phone-1', name: 'Pixel', platform: 'android' })!;
  now += 30_000;
  assert.deepEqual(store.prune(), [session.sessionId]);
  assert.equal(store.heartbeat(session.sessionId), null);
});

test('disconnect all marks every live session', () => {
  let now = 1000;
  const store = new DeviceSessionStore(45_000, () => now);
  for (const id of ['1','2']) {
    store.authorizePairing('pair-'+id, now + 5000);
    store.connect('pair-'+id, { deviceId:'phone-'+id, name:'Phone '+id, platform:'other' });
  }
  assert.equal(store.requestDisconnectAll().length, 2);
  assert.ok(store.list().every((item) => item.disconnectRequested));
});
