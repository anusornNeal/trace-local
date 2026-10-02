import type { SessionRecord, SessionSummary } from './types';

function toSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
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

export class SessionStore {
  private readonly records: SessionRecord[] = [];

  constructor(private readonly maxSessions = 500) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error('maxSessions must be a positive integer');
    }
  }

  get size(): number {
    return this.records.length;
  }

  add(record: SessionRecord): void {
    const existingIndex = this.records.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      this.records.splice(existingIndex, 1);
    }

    this.records.unshift(record);

    if (this.records.length > this.maxSessions) {
      this.records.length = this.maxSessions;
    }
  }

  get(id: string): SessionRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  list(limit = this.maxSessions): SessionSummary[] {
    const normalizedLimit = Math.max(0, Math.min(this.maxSessions, Math.floor(limit)));
    return this.records.slice(0, normalizedLimit).map(toSummary);
  }

  clear(): number {
    const removed = this.records.length;
    this.records.length = 0;
    return removed;
  }
}
