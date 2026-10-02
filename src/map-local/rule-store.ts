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
  if (!normalized) {
    throw new Error('method must not be empty');
  }
  return normalized;
}

function normalizeStatusCode(statusCode: number | undefined): number {
  const value = statusCode ?? 200;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error('statusCode must be an integer between 100 and 599');
  }
  return value;
}

function normalizeTarget(target: MapTarget | undefined): MapTarget {
  const value = target ?? 'url';
  if (!MAP_TARGETS.has(value)) {
    throw new Error('target must be url, host, or path');
  }
  return value;
}

function normalizePattern(pattern: string | undefined): string {
  const value = pattern?.trim();
  if (!value) {
    throw new Error('pattern must not be empty');
  }
  return value;
}

function normalizeFilePath(filePath: string | undefined): string {
  const value = filePath?.trim();
  if (!value) {
    throw new Error('filePath must not be empty');
  }
  return path.resolve(value);
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
    const rule: MapRule = {
      id: randomUUID(),
      order: this.nextOrder++,
      enabled: input.enabled ?? true,
      target: normalizeTarget(input.target),
      pattern: normalizePattern(input.pattern),
      method: normalizeMethod(input.method),
      filePath: normalizeFilePath(input.filePath),
      statusCode: normalizeStatusCode(input.statusCode),
      contentType: input.contentType?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };

    this.rules.push(rule);
    return { ...rule };
  }

  update(id: string, input: UpdateMapRuleInput): MapRule | undefined {
    const index = this.rules.findIndex((item) => item.id === id);
    if (index < 0) {
      return undefined;
    }

    const current = this.rules[index];
    const next: MapRule = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      target: input.target === undefined ? current.target : normalizeTarget(input.target),
      pattern: input.pattern === undefined ? current.pattern : normalizePattern(input.pattern),
      method: input.method === undefined ? current.method : normalizeMethod(input.method),
      filePath: input.filePath === undefined ? current.filePath : normalizeFilePath(input.filePath),
      statusCode:
        input.statusCode === undefined ? current.statusCode : normalizeStatusCode(input.statusCode),
      contentType:
        input.contentType === undefined
          ? current.contentType
          : input.contentType === null
            ? undefined
            : input.contentType.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };

    this.rules[index] = next;
    return { ...next };
  }

  delete(id: string): boolean {
    const index = this.rules.findIndex((item) => item.id === id);
    if (index < 0) {
      return false;
    }
    this.rules.splice(index, 1);
    return true;
  }

  findMatch(request: MatchableRequest): MapRule | undefined {
    const rule = this.rules.find((item) => matchesMapRule(item, request));
    return rule ? { ...rule } : undefined;
  }

  replaceAll(inputs: CreateMapRuleInput[]): MapRule[] {
    this.rules.length = 0;
    this.nextOrder = 1;
    return inputs.map((input) => this.create(input));
  }
}
