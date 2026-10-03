import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CertificateAuthorityManager } from '../src/certificates/ca-manager';
import { withCertificateInitializationLock } from '../src/certificates/initialization-lock';

test('CertificateAuthorityManager generates and reuses a stable valid CA', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-'));

  try {
    const firstManager = new CertificateAuthorityManager(dataDir);
    const first = await firstManager.ensure();

    assert.match(first.cert, /BEGIN CERTIFICATE/);
    assert.match(first.key, /BEGIN (?:RSA )?PRIVATE KEY/);
    assert.equal(await readFile(first.certPath, 'utf8'), first.cert);
    assert.equal(await readFile(first.keyPath, 'utf8'), first.key);

    const secondManager = new CertificateAuthorityManager(dataDir);
    const second = await secondManager.ensure();

    assert.equal(second.cert, first.cert);
  assert.equal(await readFile(first.publicCertPath, 'utf8'), first.cert);
    assert.equal(second.fingerprint256, first.fingerprint256);
    assert.equal(second.certPath, first.certPath);

    const metadata = await secondManager.metadata();
    assert.deepEqual(Object.keys(metadata).sort(), ['certPath', 'expiresAt', 'fingerprint256', 'publicCertPath']);
    assert.equal('key' in metadata, false);
    assert.equal('keyPath' in metadata, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('CertificateAuthorityManager replaces a corrupt CA pair', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-corrupt-'));

  try {
    const manager = new CertificateAuthorityManager(dataDir);
    const first = await manager.ensure();

    await writeFile(first.keyPath, 'not-a-private-key');

    const repaired = await new CertificateAuthorityManager(dataDir).ensure();
    assert.match(repaired.key, /BEGIN (?:RSA )?PRIVATE KEY/);
    assert.notEqual(repaired.fingerprint256, first.fingerprint256);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('concurrent CA initialization returns one identity matching the persisted pair', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-concurrent-'));
  try {
    const manager = new CertificateAuthorityManager(dataDir);
    const results = await Promise.all(Array.from({ length: 8 }, () => manager.ensure()));
    assert.equal(new Set(results.map((result) => result.fingerprint256)).size, 1);
    const persisted = await new CertificateAuthorityManager(dataDir).ensure();
    assert.equal(persisted.fingerprint256, results[0].fingerprint256);
    assert.equal(persisted.key, results[0].key);
    results[0].fingerprint256 = 'changed-return-value';
    assert.equal((await manager.metadata()).fingerprint256, persisted.fingerprint256);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('CA filesystem failures are reported without replacing existing certificate data', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-io-'));
  try {
    const manager = new CertificateAuthorityManager(dataDir);
    const first = await manager.ensure();
    await rm(first.keyPath);
    await mkdir(first.keyPath);
    await assert.rejects(new CertificateAuthorityManager(dataDir).ensure());
    assert.equal(await readFile(first.certPath, 'utf8'), first.cert);
    // A failed initialization must release its in-flight operation so repair can retry.
    const retryManager = new CertificateAuthorityManager(dataDir);
    await assert.rejects(retryManager.ensure());
    await rm(first.keyPath, { recursive: true });
    await writeFile(first.keyPath, first.key);
    assert.equal((await retryManager.ensure()).fingerprint256, first.fingerprint256);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('expired CA identity is replaced instead of reused', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-expired-'));
  try {
    const first = await new CertificateAuthorityManager(dataDir).ensure();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(first.expiresAt) + 60_000 });
    const renewed = await new CertificateAuthorityManager(dataDir).ensure();
    assert.notEqual(renewed.fingerprint256, first.fingerprint256);
    assert.ok(Date.parse(renewed.expiresAt) > Date.now());
  } finally {
    t.mock.timers.reset();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('separate CA managers initialize one shared directory with the same identity', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-managers-'));
  try {
    const managers = Array.from({ length: 4 }, () => new CertificateAuthorityManager(dataDir));
    const identities = await Promise.all(managers.map((manager) => manager.ensure()));
    assert.equal(new Set(identities.map((identity) => identity.fingerprint256)).size, 1);
    assert.equal((await new CertificateAuthorityManager(dataDir).ensure()).fingerprint256, identities[0].fingerprint256);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('independent processes share the persisted CA instead of overwriting identities', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-processes-'));
  try {
    const child = `const {CertificateAuthorityManager}=require('./src/certificates/ca-manager.ts'); new CertificateAuthorityManager(process.argv[1]).ensure().then(ca=>console.log(ca.fingerprint256)).catch(e=>{console.error(e.message);process.exitCode=1;});`;
    const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', child, dataDir], { cwd: process.cwd(), timeout: 20_000 });
    const results = await Promise.all([run(), run()]);
    const persisted = await new CertificateAuthorityManager(dataDir).ensure();
    for (const result of results) assert.equal(result.stdout.trim(), persisted.fingerprint256);
    assert.equal(await readFile(persisted.publicCertPath, 'utf8'), persisted.cert);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('CA lock contention fails closed and never removes another initializer lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-lock-'));
  try {
    await withCertificateInitializationLock(directory, async () => {
      const before = await readFile(path.join(directory, '.ca-initialize.lock'), 'utf8');
      await assert.rejects(withCertificateInitializationLock(directory, async () => assert.fail('must not initialize'), 25), /CA initialization is locked/);
      assert.equal(await readFile(path.join(directory, '.ca-initialize.lock'), 'utf8'), before);
    });
    await assert.rejects(readFile(path.join(directory, '.ca-initialize.lock')), { code: 'ENOENT' });
    await assert.rejects(withCertificateInitializationLock(directory, async () => { throw new Error('injected write failure'); }), /injected write failure/);
    assert.equal(await withCertificateInitializationLock(directory, async () => 'retried'), 'retried');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cached live CA expiration fails without silently changing the proxy identity', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ca-live-expired-'));
  try {
    const manager = new CertificateAuthorityManager(dataDir);
    const active = await manager.ensure();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(active.expiresAt) + 60_000 });
    await assert.rejects(manager.ensure(), /restart Trace Local/);
    assert.equal(await readFile(active.certPath, 'utf8'), active.cert);
  } finally {
    t.mock.timers.reset();
    await rm(dataDir, { recursive: true, force: true });
  }
});
