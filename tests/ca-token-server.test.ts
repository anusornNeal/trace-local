import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CaTokenServer } from '../src/certificates/ca-token-server';

describe('CaTokenServer', () => {
  it('creates unique tokens', () => {
    const server = new CaTokenServer();
    const token1 = server.createToken();
    const token2 = server.createToken();

    assert.notEqual(token1.token, token2.token);
    assert.ok(token1.token.length > 0);
    assert.ok(token2.token.length > 0);
  });

  it('validates valid tokens', () => {
    const server = new CaTokenServer();
    const { token } = server.createToken();

    assert.ok(server.validateToken(token));
  });

  it('rejects invalid tokens', () => {
    const server = new CaTokenServer();
    assert.ok(!server.validateToken('invalid-token'));
  });

  it('rejects expired tokens', async () => {
    const server = new CaTokenServer();
    const { token } = server.createToken();

    // Manually expire the token by manipulating time
    const tokenObj = (server as any).tokens.get(token);
    assert.ok(tokenObj);
    tokenObj.expiresAt = Date.now() - 1000;

    assert.ok(!server.validateToken(token));
  });

  it('revokes tokens', () => {
    const server = new CaTokenServer();
    const { token } = server.createToken();

    assert.ok(server.validateToken(token));
    server.revokeToken(token);
    assert.ok(!server.validateToken(token));
  });

  it('tracks clients', () => {
    const server = new CaTokenServer();
    assert.equal(server.getActiveClientCount(), 0);

    server.trackClient('192.168.1.100');
    assert.equal(server.getActiveClientCount(), 1);

    server.trackClient('192.168.1.101');
    assert.equal(server.getActiveClientCount(), 2);

    // Same client updates timestamp
    server.trackClient('192.168.1.100');
    assert.equal(server.getActiveClientCount(), 2);
  });

  it('prunes stale clients', async () => {
    const server = new CaTokenServer();
    server.trackClient('192.168.1.100');
    assert.equal(server.getActiveClientCount(), 1);

    // Manually age the client
    const client = (server as any).clients.get('192.168.1.100');
    assert.ok(client);
    client.lastSeenAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago

    assert.equal(server.getActiveClientCount(), 0);
  });

  it('sets correct expiry time', () => {
    const server = new CaTokenServer();
    const before = Date.now();
    const { createdAt, expiresAt } = server.createToken();
    const after = Date.now();

    assert.ok(createdAt >= before && createdAt <= after);
    assert.ok(expiresAt > createdAt);
    const ttl = expiresAt - createdAt;
    assert.ok(ttl >= 14 * 60 * 1000 && ttl <= 16 * 60 * 1000); // ~15 minutes
  });
});
