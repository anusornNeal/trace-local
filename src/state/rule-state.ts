import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MapRule, MapTarget } from '../core/types';

export const RULE_STATE_VERSION = 1;

export interface RuleStateDocument {
  version: typeof RULE_STATE_VERSION;
  rules: MapRule[];
}

const TARGETS = new Set<MapTarget>(['url', 'host', 'path']);

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function validateRule(value: unknown, index: number): MapRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`rules[${index}] must be an object`);
  }

  const rule = value as Partial<MapRule>;
  assertString(rule.id, `rules[${index}].id`);

  if (!Number.isInteger(rule.order) || Number(rule.order) < 1) {
    throw new Error(`rules[${index}].order must be a positive integer`);
  }
  if (typeof rule.enabled !== 'boolean') {
    throw new Error(`rules[${index}].enabled must be boolean`);
  }
  if (!rule.target || !TARGETS.has(rule.target)) {
    throw new Error(`rules[${index}].target must be url, host, or path`);
  }

  assertString(rule.pattern, `rules[${index}].pattern`);
  assertString(rule.method, `rules[${index}].method`);
  assertString(rule.filePath, `rules[${index}].filePath`);

  if (
    !Number.isInteger(rule.statusCode) ||
    Number(rule.statusCode) < 100 ||
    Number(rule.statusCode) > 599
  ) {
    throw new Error(`rules[${index}].statusCode must be 100-599`);
  }

  if (rule.contentType !== undefined && typeof rule.contentType !== 'string') {
    throw new Error(`rules[${index}].contentType must be a string`);
  }

  assertString(rule.createdAt, `rules[${index}].createdAt`);
  assertString(rule.updatedAt, `rules[${index}].updatedAt`);

  if (Number.isNaN(Date.parse(rule.createdAt)) || Number.isNaN(Date.parse(rule.updatedAt))) {
    throw new Error(`rules[${index}] timestamps must be valid ISO dates`);
  }

  return {
    id: rule.id,
    order: Number(rule.order),
    enabled: rule.enabled,
    target: rule.target,
    pattern: rule.pattern,
    method: rule.method.toUpperCase(),
    filePath: path.resolve(rule.filePath),
    statusCode: Number(rule.statusCode),
    contentType: rule.contentType?.trim() || undefined,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export function parseRuleStateDocument(value: unknown): RuleStateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('rule state must be an object');
  }

  const document = value as { version?: unknown; rules?: unknown };
  if (document.version !== RULE_STATE_VERSION) {
    throw new Error(
      `unsupported rule state version: ${String(document.version)} (expected ${RULE_STATE_VERSION})`,
    );
  }

  if (!Array.isArray(document.rules)) {
    throw new Error('rule state rules must be an array');
  }

  const rules = document.rules.map(validateRule);
  const ids = new Set<string>();
  const orders = new Set<number>();

  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    if (orders.has(rule.order)) {
      throw new Error(`duplicate rule order: ${rule.order}`);
    }
    ids.add(rule.id);
    orders.add(rule.order);
  }

  return {
    version: RULE_STATE_VERSION,
    rules: rules.sort((a, b) => a.order - b.order),
  };
}

export class RuleStateRepository {
  readonly stateDir: string;
  readonly filePath: string;

  constructor(dataDir: string) {
    this.stateDir = path.join(dataDir, 'state');
    this.filePath = path.join(this.stateDir, 'rules.json');
  }

  document(rules: MapRule[]): RuleStateDocument {
    return parseRuleStateDocument({
      version: RULE_STATE_VERSION,
      rules,
    });
  }

  async load(): Promise<MapRule[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    try {
      return parseRuleStateDocument(JSON.parse(raw)).rules;
    } catch (error) {
      throw new Error(
        `Failed to load Map Local state from ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async save(rules: MapRule[]): Promise<void> {
    const document = this.document(rules);
    await mkdir(this.stateDir, { recursive: true });

    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(document, null, 2)}\n`;

    try {
      await writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
