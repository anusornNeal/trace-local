import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingTokenStore } from '../src/pairing/pairing-store';

test('pairing token is short-lived and single-use', () => {
  let now = 1000;
  const store = new PairingTokenStore(5000, () => now);
  const token = store.create();

  assert.equal(store.validate(token.token), true);
  assert.equal(store.redeem(token.token)?.pairingId, token.pairingId);
  assert.equal(store.redeem(token.token), null);
  assert.equal(store.validate(token.token), false);

  const expiring = store.create();
  now = expiring.expiresAt;
  assert.equal(store.validate(expiring.token), false);
  assert.equal(store.redeem(expiring.token), null);
});

test('pairing tokens are unguessable-looking and unique', () => {
  const store = new PairingTokenStore();
  const a = store.create();
  const b = store.create();
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(a.pairingId, b.pairingId);
});
