import { randomBytes, randomUUID } from 'node:crypto';

export const PAIRING_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_PAIRING_TOKEN_TTL_MS = 2 * 60 * 1000;

export interface PairingTokenRecord {
  token: string;
  pairingId: string;
  createdAt: number;
  expiresAt: number;
}

export class PairingTokenStore {
  private readonly tokens = new Map<string, PairingTokenRecord>();

  constructor(
    private readonly ttlMs = DEFAULT_PAIRING_TOKEN_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(): PairingTokenRecord {
    const createdAt = this.now();
    const record: PairingTokenRecord = {
      token: randomBytes(32).toString('base64url'),
      pairingId: randomUUID(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.tokens.set(record.token, record);
    this.prune();
    return { ...record };
  }

  redeem(token: string): PairingTokenRecord | null {
    const record = this.tokens.get(token);
    if (!record) return null;
    this.tokens.delete(token);
    if (this.now() >= record.expiresAt) return null;
    return { ...record };
  }

  validate(token: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    if (this.now() >= record.expiresAt) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, record] of this.tokens) {
      if (now >= record.expiresAt) this.tokens.delete(token);
    }
  }
}
