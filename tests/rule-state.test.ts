import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MapRule } from '../src/core/types';
import {
  RULE_STATE_VERSION,
  RuleStateRepository,
} from '../src/state/rule-state';

function rule(id: string, order: number): MapRule {
  return {
    id,
    order,
    enabled: order % 2 === 1,
    target: 'path',
    pattern: `/rule/${order}/*`,
    method: 'GET',
    filePath: path.resolve(`./fixture-${order}.json`),
    statusCode: 200 + order,
    contentType: 'application/json',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

test('RuleStateRepository atomically round-trips versioned rules', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-state-'));
  const repository = new RuleStateRepository(dataDir);

  try {
    const first = [rule('one', 1), rule('two', 2)];
    await repository.save(first);
    assert.deepEqual(await repository.load(), first);

    const second = [rule('three', 3)];
    await repository.save(second);
    assert.deepEqual(await repository.load(), second);

    const entries = await readdir(repository.stateDir);
    assert.deepEqual(entries.sort(), ['rules.json']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('RuleStateRepository rejects corrupt and unsupported state without overwriting it', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-state-bad-'));
  const repository = new RuleStateRepository(dataDir);

  try {
    await mkdir(repository.stateDir, { recursive: true });
    await writeFile(repository.filePath, '{broken', 'utf8');
    await assert.rejects(repository.load(), /Failed to load Map Local state/);

    const unsupported = JSON.stringify({ version: RULE_STATE_VERSION + 1, rules: [] });
    await writeFile(repository.filePath, unsupported, 'utf8');
    await assert.rejects(repository.load(), /unsupported rule state version/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
