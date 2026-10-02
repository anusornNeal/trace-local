import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/core/session-store';
import { TraceLocalDaemon } from '../src/daemon/server';
import { MapRuleStore } from '../src/map-local/rule-store';
import { HttpCaptureProxy } from '../src/proxy/http-proxy';

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

async function proxyRequest(proxyPort: number, url: string): Promise<{
  statusCode: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: url,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('MapRuleStore keeps stable order and matches target/method globs', () => {
  const store = new MapRuleStore();
  const first = store.create({
    enabled: false,
    target: 'path',
    pattern: '/api/*',
    method: 'GET',
    filePath: './first.json',
  });
  const second = store.create({
    target: 'path',
    pattern: '/api/*',
    method: '*',
    filePath: './second.json',
  });

  const request = {
    method: 'GET',
    url: 'http://example.test/api/users',
    host: 'example.test',
    path: '/api/users',
  };

  assert.equal(store.findMatch(request)?.id, second.id);
  store.update(first.id, { enabled: true });
  assert.equal(store.findMatch(request)?.id, first.id);
  assert.deepEqual(store.list().map((rule) => rule.order), [1, 2]);

  const host = store.create({
    target: 'host',
    pattern: '*.EXAMPLE.TEST',
    filePath: './host.txt',
  });
  assert.equal(
    store.findMatch({
      method: 'POST',
      url: 'http://api.example.test/other',
      host: 'api.example.test',
      path: '/other',
    })?.id,
    host.id,
  );
});

test('Map Local serves live file content, bypasses upstream, and captures mapped errors', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-map-'));
  const mappedPath = path.join(tempDir, 'response.json');
  await writeFile(mappedPath, '{"source":"local-1"}');

  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.end('upstream');
  });

  const upstreamPort = await listen(upstream);
  const sessions = new SessionStore(10);
  const rules = new MapRuleStore();
  const rule = rules.create({
    target: 'path',
    pattern: '/api/*',
    method: 'GET',
    filePath: mappedPath,
  });

  const proxy = new HttpCaptureProxy(sessions, {
    host: '127.0.0.1',
    port: 0,
    ruleStore: rules,
  });

  try {
    const status = await proxy.start();
    const requestUrl = `http://127.0.0.1:${upstreamPort}/api/users`;

    const first = await proxyRequest(status.port, requestUrl);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body, '{"source":"local-1"}');
    assert.equal(first.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(first.headers['x-tracelocal-map-rule'], rule.id);

    await writeFile(mappedPath, '{"source":"local-2"}');
    const second = await proxyRequest(status.port, requestUrl);
    assert.equal(second.body, '{"source":"local-2"}');
    assert.equal(upstreamRequests, 0);

    await unlink(mappedPath);
    const missing = await proxyRequest(status.port, requestUrl);
    assert.equal(missing.statusCode, 500);
    assert.match(missing.body, /Map Local failed/i);
    assert.equal(upstreamRequests, 0);

    await new Promise((resolve) => setImmediate(resolve));
    const captures = sessions.list(10);
    assert.equal(captures.length, 3);
    assert.ok(captures.every((capture) => capture.mapped));
    assert.ok(captures.every((capture) => capture.mapRuleId === rule.id));

    const failedCapture = sessions.get(captures[0]!.id);
    assert.match(failedCapture?.error ?? '', /ENOENT/i);
  } finally {
    await proxy.stop();
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('daemon exposes Map Local rule CRUD API', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-rules-'));
  const mappedPath = path.join(tempDir, 'rule.txt');
  await writeFile(mappedPath, 'hello');

  const daemon = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyHost: '127.0.0.1',
    proxyPort: 0,
    dataDir: path.join(tempDir, 'data'),
  });

  try {
    const status = await daemon.start();
    const base = `http://127.0.0.1:${status.controlPort}`;

    const createResponse = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'path',
        pattern: '/local/*',
        method: 'GET',
        filePath: mappedPath,
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { id: string; enabled: boolean };
    assert.equal(created.enabled, true);

    const listResponse = await fetch(`${base}/api/rules`);
    const list = (await listResponse.json()) as { rules: Array<{ id: string }> };
    assert.deepEqual(list.rules.map((rule) => rule.id), [created.id]);

    const mapped = await proxyRequest(
      status.proxy.port,
      'http://unreachable.invalid/local/smoke',
    );
    assert.equal(mapped.statusCode, 200);
    assert.equal(mapped.body, 'hello');

    const disableResponse = await fetch(`${base}/api/rules/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableResponse.status, 200);
    const disabled = (await disableResponse.json()) as { enabled: boolean };
    assert.equal(disabled.enabled, false);

    const deleteResponse = await fetch(`${base}/api/rules/${created.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteResponse.status, 200);

    const finalList = (await (await fetch(`${base}/api/rules`)).json()) as {
      rules: unknown[];
    };
    assert.equal(finalList.rules.length, 0);
  } finally {
    await daemon.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
