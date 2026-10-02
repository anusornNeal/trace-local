import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLanAddresses, getPrimaryLanAddress } from '../src/daemon/lan-addresses';

describe('LAN addresses', () => {
  it('getLanAddresses returns array', () => {
    const addresses = getLanAddresses();
    assert.ok(Array.isArray(addresses));
  });

  it('getLanAddresses excludes loopback', () => {
    const addresses = getLanAddresses();
    for (const addr of addresses) {
      assert.notEqual(addr.address, '127.0.0.1');
      assert.notEqual(addr.address, '::1');
      assert.ok(!addr.address.startsWith('::ffff:127.'));
    }
  });

  it('getLanAddresses excludes link-local IPv6', () => {
    const addresses = getLanAddresses();
    for (const addr of addresses) {
      if (addr.family === 'IPv6') {
        assert.ok(!addr.address.startsWith('fe80:'));
      }
    }
  });

  it('getLanAddresses includes interface name', () => {
    const addresses = getLanAddresses();
    for (const addr of addresses) {
      assert.ok(addr.interface);
      assert.ok(typeof addr.interface === 'string');
      assert.ok(addr.interface.length > 0);
    }
  });

  it('getPrimaryLanAddress returns string or null', () => {
    const address = getPrimaryLanAddress();
    assert.ok(address === null || typeof address === 'string');
  });

  it('getPrimaryLanAddress prefers IPv4', () => {
    const addresses = getLanAddresses();
    const hasIPv4 = addresses.some((addr) => addr.family === 'IPv4');
    const hasIPv6 = addresses.some((addr) => addr.family === 'IPv6');

    if (hasIPv4) {
      const primary = getPrimaryLanAddress();
      // If we have IPv4, primary should not be wrapped in brackets (IPv6 format)
      if (primary) {
        assert.ok(!primary.startsWith('['));
      }
    }
  });

  it('getPrimaryLanAddress wraps IPv6 in brackets', () => {
    const addresses = getLanAddresses();
    const hasIPv4 = addresses.some((addr) => addr.family === 'IPv4');
    const hasIPv6 = addresses.some((addr) => addr.family === 'IPv6');

    if (!hasIPv4 && hasIPv6) {
      const primary = getPrimaryLanAddress();
      if (primary) {
        assert.ok(primary.startsWith('['));
        assert.ok(primary.endsWith(']'));
      }
    }
  });
});
