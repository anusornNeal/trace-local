import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CertificateAuthorityManager } from '../src/certificates/ca-manager';

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
