import { randomBytes } from 'node:crypto';
import type http from 'node:http';

export interface CaToken {
  token: string;
  createdAt: number;
  expiresAt: number;
}

export interface ClientConnection {
  ip: string;
  lastSeenAt: number;
}

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CLIENT_STALE_MS = 5 * 60 * 1000; // 5 minutes

export class CaTokenServer {
  private tokens = new Map<string, CaToken>();
  private clients = new Map<string, ClientConnection>();

  createToken(): CaToken {
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    const caToken: CaToken = {
      token,
      createdAt: now,
      expiresAt: now + TOKEN_TTL_MS,
    };
    this.tokens.set(token, caToken);
    this.pruneExpiredTokens();
    return caToken;
  }

  validateToken(token: string): boolean {
    const caToken = this.tokens.get(token);
    if (!caToken) {
      return false;
    }
    if (Date.now() > caToken.expiresAt) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  trackClient(ip: string): void {
    this.clients.set(ip, {
      ip,
      lastSeenAt: Date.now(),
    });
    this.pruneStaleClients();
  }

  getActiveClientCount(): number {
    this.pruneStaleClients();
    return this.clients.size;
  }

  private pruneExpiredTokens(): void {
    const now = Date.now();
    for (const [token, caToken] of this.tokens) {
      if (now > caToken.expiresAt) {
        this.tokens.delete(token);
      }
    }
  }

  private pruneStaleClients(): void {
    const now = Date.now();
    for (const [ip, client] of this.clients) {
      if (now - client.lastSeenAt > CLIENT_STALE_MS) {
        this.clients.delete(ip);
      }
    }
  }
}
