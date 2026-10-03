import { randomUUID } from 'node:crypto';

export const DEFAULT_DEVICE_HEARTBEAT_MS = 3_000;
export const DEFAULT_DEVICE_STALE_MS = 15_000;

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  platform: 'android' | 'ios' | 'other';
}

export interface DeviceSession {
  sessionId: string;
  pairingId: string;
  deviceId: string;
  name: string;
  platform: DeviceIdentity['platform'];
  connectedAt: number;
  lastHeartbeatAt: number;
  state: 'connected' | 'disconnecting';
  disconnectRequested: boolean;
}

export interface DeviceHeartbeat {
  session: DeviceSession;
  disconnectRequested: boolean;
  restoreRouting: boolean;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
}

export class DeviceSessionStore {
  private readonly pairingAuthorizations = new Map<string, number>();
  private readonly sessions = new Map<string, DeviceSession>();

  constructor(
    private readonly staleAfterMs = DEFAULT_DEVICE_STALE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  authorizePairing(pairingId: string, expiresAt: number): void {
    this.pairingAuthorizations.set(pairingId, expiresAt);
    this.prune();
  }

  connect(pairingId: string, identity: DeviceIdentity): DeviceSession | null {
    this.prune();
    const expiresAt = this.pairingAuthorizations.get(pairingId);
    if (!expiresAt || this.now() >= expiresAt) {
      this.pairingAuthorizations.delete(pairingId);
      return null;
    }
    this.pairingAuthorizations.delete(pairingId);

    const now = this.now();
    const session: DeviceSession = {
      sessionId: randomUUID(),
      pairingId,
      deviceId: identity.deviceId,
      name: identity.name,
      platform: identity.platform,
      connectedAt: now,
      lastHeartbeatAt: now,
      state: 'connected',
      disconnectRequested: false,
    };
    this.sessions.set(session.sessionId, session);
    return { ...session };
  }

  heartbeat(sessionId: string): DeviceHeartbeat | null {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastHeartbeatAt = this.now();
    return {
      session: { ...session },
      disconnectRequested: session.disconnectRequested,
      restoreRouting: session.disconnectRequested,
      heartbeatIntervalMs: DEFAULT_DEVICE_HEARTBEAT_MS,
      staleAfterMs: this.staleAfterMs,
    };
  }

  requestDisconnect(sessionId: string): DeviceSession | null {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.disconnectRequested = true;
    session.state = 'disconnecting';
    return { ...session };
  }

  requestDisconnectAll(): DeviceSession[] {
    this.prune();
    const changed: DeviceSession[] = [];
    for (const session of this.sessions.values()) {
      session.disconnectRequested = true;
      session.state = 'disconnecting';
      changed.push({ ...session });
    }
    return changed;
  }

  acknowledgeDisconnected(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  list(): DeviceSession[] {
    this.prune();
    return [...this.sessions.values()]
      .map((session) => ({ ...session }))
      .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
  }

  get size(): number {
    this.prune();
    return this.sessions.size;
  }

  prune(): string[] {
    const now = this.now();
    for (const [pairingId, expiresAt] of this.pairingAuthorizations) {
      if (now >= expiresAt) this.pairingAuthorizations.delete(pairingId);
    }

    const removed: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastHeartbeatAt >= this.staleAfterMs) {
        this.sessions.delete(sessionId);
        removed.push(sessionId);
      }
    }
    return removed;
  }
}
