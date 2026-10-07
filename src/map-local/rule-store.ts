import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  CreateMapRuleInput,
  MapRule,
  MapTarget,
  UpdateMapRuleInput,
} from '../core/types';
import { matchesMapRule } from './matcher';

const MAP_TARGETS = new Set<MapTarget>(['url', 'host', 'path']);

function normalizeMethod(method: string | undefined): string {
  const normalized = (method ?? '*').trim().toUpperCase();
  if (!normalized) throw new Error('method must not be empty');
  return normalized;
}

function normalizeStatusCode(statusCode: number | undefined): number {
  const value = statusCode ?? 200;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error('statusCode must be an integer between 100 and 599');
  }
  return value;
}

function normalizeDelayMs(delayMs: number | undefined): number | undefined {
  if (delayMs === undefined) return undefined;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error('delayMs must be an integer between 0 and 60000');
  }
  return delayMs;
}

function normalizeTarget(target: MapTarget | undefined): MapTarget {
  const value = target ?? 'url';
  if (!MAP_TARGETS.has(value)) throw new Error('target must be url, host, or path');
  return value;
}

function normalizeMatchMode(mode: MapRule['matchMode']): MapRule['matchMode'] {
  if (mode === undefined) return undefined;
  if (mode !== 'wildcard' && mode !== 'exact' && mode !== 'regex') {
    throw new Error('matchMode must be wildcard, exact, or regex');
  }
  return mode;
}

function normalizePattern(pattern: string | undefined): string {
  const value = pattern?.trim();
  if (!value) throw new Error('pattern must not be empty');
  return value;
}

function validatePatternForMode(pattern: string, mode: MapRule['matchMode']): string {
  if (mode === 'regex') {
    try {
      new RegExp(pattern);
    } catch {
      throw new Error('pattern must be a valid regular expression when matchMode is regex');
    }
  }
  return pattern;
}

function normalizeHost(host: string | null | undefined): string | undefined {
  if (host == null) return undefined;
  const value = host.trim().toLowerCase();
  return value || undefined;
}

function normalizeFilePath(filePath: string | null | undefined): string | undefined {
  if (filePath == null) return undefined;
  const value = filePath.trim();
  return value ? path.resolve(value) : undefined;
}

function normalizeResponseBody(responseBody: string | null | undefined): string | undefined {
  return responseBody == null ? undefined : responseBody;
}

function assertResponseSource(filePath: string | undefined, responseBody: string | undefined): void {
  if (filePath === undefined && responseBody === undefined) {
    throw new Error('Map Local rule requires responseBody or filePath');
  }
}

export interface MatchableRequest {
  method: string;
  url: string;
  host: string;
  path: string;
}

export class MapRuleStore {
  private readonly rules: MapRule[] = [];
  private nextOrder = 1;

  get size(): number {
    return this.rules.length;
  }

  list(): MapRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  get(id: string): MapRule | undefined {
    const rule = this.rules.find((item) => item.id === id);
    return rule ? { ...rule } : undefined;
  }

  create(input: CreateMapRuleInput): MapRule {
    const now = new Date().toISOString();
    const filePath = normalizeFilePath(input.filePath);
    const responseBody = normalizeResponseBody(input.responseBody);
    assertResponseSource(filePath, responseBody);
    const matchMode = normalizeMatchMode(input.matchMode);
    const pattern = validatePatternForMode(normalizePattern(input.pattern), matchMode);
    const rule: MapRule = {
      id: randomUUID(),
      order: this.nextOrder++,
      enabled: input.enabled ?? true,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      target: normalizeTarget(input.target),
      pattern,
      ...(normalizeHost(input.host) ? { host: normalizeHost(input.host) } : {}),
      ...(matchMode ? { matchMode } : {}),
      ...(input.includeSubpaths !== undefined ? { includeSubpaths: input.includeSubpaths } : {}),
      method: normalizeMethod(input.method),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(responseBody !== undefined ? { responseBody } : {}),
      statusCode: normalizeStatusCode(input.statusCode),
      contentType: input.contentType?.trim() || undefined,
      ...(normalizeDelayMs(input.delayMs) !== undefined ? { delayMs: normalizeDelayMs(input.delayMs) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.rules.push(rule);
    return { ...rule };
  }

  update(id: string, input: UpdateMapRuleInput): MapRule | undefined {
    const index = this.rules.findIndex((item) => item.id === id);
    if (index < 0) return undefined;

    const current = this.rules[index];
    const filePath = input.filePath === undefined ? current.filePath : normalizeFilePath(input.filePath);
    const responseBody = input.responseBody === undefined ? current.responseBody : normalizeResponseBody(input.responseBody);
    assertResponseSource(filePath, responseBody);
    const matchMode = input.matchMode === undefined ? current.matchMode : normalizeMatchMode(input.matchMode);
    const pattern = validatePatternForMode(
      input.pattern === undefined ? current.pattern : normalizePattern(input.pattern),
      matchMode,
    );
    const next: MapRule = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      name: input.name === undefined ? current.name : input.name?.trim() || undefined,
      target: input.target === undefined ? current.target : normalizeTarget(input.target),
      pattern,
      host: input.host === undefined ? current.host : normalizeHost(input.host),
      matchMode,
      includeSubpaths: input.includeSubpaths === undefined ? current.includeSubpaths : input.includeSubpaths,
      method: input.method === undefined ? current.method : normalizeMethod(input.method),
      filePath,
      responseBody,
      statusCode:
        input.statusCode === undefined ? current.statusCode : normalizeStatusCode(input.statusCode),
      contentType:
        input.contentType === undefined
          ? current.contentType
          : input.contentType === null
            ? undefined
            : input.contentType.trim() || undefined,
      delayMs: input.delayMs === undefined ? current.delayMs : normalizeDelayMs(input.delayMs),
      updatedAt: new Date().toISOString(),
    };

    this.rules[index] = next;
    return { ...next };
  }

  delete(id: string): boolean {
    const index = this.rules.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    return true;
  }

  findMatch(request: MatchableRequest): MapRule | undefined {
    const rule = this.rules.find((item) => matchesMapRule(item, request));
    return rule ? { ...rule } : undefined;
  }

  hydrate(rules: MapRule[]): MapRule[] {
    this.rules.length = 0;
    for (const rule of [...rules].sort((a, b) => a.order - b.order)) {
      this.rules.push({ ...rule });
    }
    this.nextOrder =
      this.rules.reduce((highest, rule) => Math.max(highest, rule.order), 0) + 1;
    return this.list();
  }

  replaceAll(inputs: CreateMapRuleInput[]): MapRule[] {
    this.rules.length = 0;
    this.nextOrder = 1;
    return inputs.map((input) => this.create(input));
  }
}
