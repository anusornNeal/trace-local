import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceLocalDaemon } from '../src/daemon/server';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('daemon control API lists, inspects, and clears captures', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-daemon-'));
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const daemon = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
    maxSessions: 5,
    dataDir: path.join(tempDir, 'data'),
  });

  try {
    const status = await daemon.start();

    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: status.proxy.port,
          method: 'GET',
          path: `http://127.0.0.1:${upstreamPort}/api/test`,
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      request.on('error', reject);
      request.end();
    });

    await new Promise((resolve) => setImmediate(resolve));

    const base = `http://127.0.0.1:${status.controlPort}`;
    const listResponse = await fetch(`${base}/api/sessions`);
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as {
      total: number;
      sessions: Array<{ id: string; path: string }>;
    };

    assert.equal(list.total, 1);
    assert.equal(list.sessions[0]?.path, '/api/test');

    const id = list.sessions[0]!.id;
    const detailResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`);
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as { statusCode: number };
    assert.equal(detail.statusCode, 200);

    const caResponse = await fetch(`${base}/api/ca`);
    assert.equal(caResponse.status, 200);
    const ca = (await caResponse.json()) as { certPath: string; fingerprint256: string };
    assert.match(ca.certPath, /ca-cert\.pem$/);
    assert.ok(ca.fingerprint256);

    const clearResponse = await fetch(`${base}/api/sessions`, { method: 'DELETE' });
    assert.equal(clearResponse.status, 200);
    assert.deepEqual(await clearResponse.json(), { removed: 1 });
  } finally {
    await daemon.stop();
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
});
