import type { SessionRecord, SessionSummary } from './types';

export type SessionStoreEvent =
  | { type: 'session-added'; session: SessionSummary }
  | { type: 'sessions-cleared'; removed: number };

export type SessionStoreListener = (event: SessionStoreEvent) => void;

function toSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    protocol: record.protocol,
    method: record.method,
    url: record.url,
    host: record.host,
    path: record.path,
    statusCode: record.statusCode,
    mapped: record.mapped,
    mapRuleId: record.mapRuleId,
    requestBodyBytes: record.requestBodyBytes,
    responseBodyBytes: record.responseBodyBytes,
    error: record.error,
  };
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    requestHeaders: { ...record.requestHeaders },
    responseHeaders: record.responseHeaders ? { ...record.responseHeaders } : undefined,
  };
}

export class SessionStore {
  private readonly recordsState: SessionRecord[] = [];
  private readonly listeners = new Set<SessionStoreListener>();

  constructor(private readonly maxSessions = 500) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error('maxSessions must be a positive integer');
    }
  }

  get size(): number {
    return this.recordsState.length;
  }

  subscribe(listener: SessionStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(record: SessionRecord): void {
    const existingIndex = this.recordsState.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      this.recordsState.splice(existingIndex, 1);
    }

    this.recordsState.unshift(cloneRecord(record));

    if (this.recordsState.length > this.maxSessions) {
      this.recordsState.length = this.maxSessions;
    }

    this.emit({ type: 'session-added', session: toSummary(record) });
  }

  get(id: string): SessionRecord | undefined {
    const record = this.recordsState.find((item) => item.id === id);
    return record ? cloneRecord(record) : undefined;
  }

  list(limit = this.maxSessions): SessionSummary[] {
    const normalizedLimit = Math.max(0, Math.min(this.maxSessions, Math.floor(limit)));
    return this.recordsState.slice(0, normalizedLimit).map(toSummary);
  }

  records(limit = this.maxSessions): SessionRecord[] {
    const normalizedLimit = Math.max(0, Math.min(this.maxSessions, Math.floor(limit)));
    return this.recordsState.slice(0, normalizedLimit).map(cloneRecord);
  }

  clear(): number {
    const removed = this.recordsState.length;
    this.recordsState.length = 0;
    if (removed > 0) {
      this.emit({ type: 'sessions-cleared', removed });
    }
    return removed;
  }

  private emit(event: SessionStoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not be able to break capture storage.
      }
    }
  }
}
