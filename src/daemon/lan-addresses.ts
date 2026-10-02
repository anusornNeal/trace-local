import { networkInterfaces } from 'node:os';

export interface LanAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
  interface: string;
}

export function getLanAddresses(): LanAddress[] {
  const interfaces = networkInterfaces();
  const addresses: LanAddress[] = [];

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) continue;
    for (const net of nets) {
      // Skip internal/loopback addresses
      if (net.internal) continue;

      // Skip IPv6 link-local addresses
      if (net.family === 'IPv6' && net.address.startsWith('fe80:')) continue;

      addresses.push({
        address: net.address,
        family: net.family as 'IPv4' | 'IPv6',
        interface: name,
      });
    }
  }

  return addresses;
}

export function getPrimaryLanAddress(): string | null {
  const addresses = getLanAddresses();

  // Prefer IPv4 addresses
  const ipv4 = addresses.find((addr) => addr.family === 'IPv4');
  if (ipv4) {
    return ipv4.address;
  }

  // Fall back to IPv6
  const ipv6 = addresses.find((addr) => addr.family === 'IPv6');
  if (ipv6) {
    return `[${ipv6.address}]`;
  }

  return null;
}
