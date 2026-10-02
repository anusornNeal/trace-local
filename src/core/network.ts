import os from 'node:os';

/**
 * Returns the first non-loopback IPv4 address from the primary network interfaces.
 * Used to construct LAN-accessible proxy URLs.
 */
export function getLanIpAddress(): string | null {
  const interfaces = os.networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;

    for (const address of addresses) {
      // Skip loopback, internal, and IPv6 addresses
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}
