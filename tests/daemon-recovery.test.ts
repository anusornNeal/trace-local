import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceLocalDaemon } from '../src/daemon/server';

test('daemon quarantines invalid persisted rules and starts with a recovery warning', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-daemon-recovery-'));
  const dataDir = path.join(tempDir, 'data');
  const stateDir = path.join(dataDir, 'state');
  const rulesPath = path.join(stateDir, 'rules.json');
  const original = '{"version":1,"rules":[{"broken":true}]}\n';

  await mkdir(stateDir, { recursive: true });
  await writeFile(rulesPath, original, 'utf8');

  const daemon = new TraceLocalDaemon({
    dataDir,
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
  });

  try {
    const status = await daemon.start();
    assert.equal(status.proxy.running, true);
    assert.equal(status.rules, 0);
    assert.equal(status.warnings.length, 1);
    assert.match(status.warnings[0]!, /original state was preserved/i);

    const response = await fetch(
      `http://127.0.0.1:${status.controlPort}/api/status`,
    );
    assert.equal(response.status, 200);
    const apiStatus = (await response.json()) as {
      rules: number;
      warnings: string[];
    };
    assert.equal(apiStatus.rules, 0);
    assert.deepEqual(apiStatus.warnings, status.warnings);

    const entries = await readdir(stateDir);
    const backup = entries.find((entry) => /^rules\.rejected-.*\.json$/.test(entry));
    assert.ok(backup, 'expected quarantined rule-state backup');
    assert.equal(await readFile(path.join(stateDir, backup), 'utf8'), original);
    assert.equal(entries.includes('rules.json'), false);
  } finally {
    await daemon.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
