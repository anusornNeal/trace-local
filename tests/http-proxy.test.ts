import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { SessionStore } from '../src/core/session-store';
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

test('HTTP proxy forwards and captures request/response traffic', async () => {
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(201, {
        'content-type': 'text/plain; charset=utf-8',
        'x-upstream': 'yes',
        'x-saw-remove': request.headers['x-remove'] ? 'yes' : 'no',
      });
      response.end(`pong:${body}`);
    });
  });

  const upstreamPort = await listen(upstream);
  const store = new SessionStore(10);
  const proxy = new HttpCaptureProxy(store, {
    host: '127.0.0.1',
    port: 0,
    maxBodyPreviewBytes: 1024,
  });

  try {
    const proxyStatus = await proxy.start();

    const responseBody = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: proxyStatus.port,
          method: 'POST',
          path: `http://127.0.0.1:${upstreamPort}/hello?x=1`,
          headers: {
            'content-type': 'text/plain',
            connection: 'x-remove',
            'x-remove': 'secret',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          assert.equal(response.statusCode, 201);
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      request.on('error', reject);
      request.end('ping');
    });

    assert.equal(responseBody, 'pong:ping');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.size, 1);

    const summary = store.list(1)[0];
    assert.equal(summary.method, 'POST');
    assert.equal(summary.path, '/hello?x=1');
    assert.equal(summary.statusCode, 201);

    const capture = store.get(summary.id);
    assert.equal(capture?.requestBody, 'ping');
    assert.equal(capture?.requestBodyBytes, 4);
    assert.equal(capture?.responseBody, 'pong:ping');
    assert.equal(capture?.responseBodyBytes, 9);
    assert.equal(capture?.responseHeaders?.['x-upstream'], 'yes');
    assert.equal(capture?.responseHeaders?.['x-saw-remove'], 'no');
    assert.equal(capture?.mapped, false);
  } finally {
    await proxy.stop();
    await close(upstream);
  }
});


test('HTTP proxy times out stalled upstream requests and records the error', async () => {
  const upstream = http.createServer((_request, _response) => {
    // Intentionally never respond.
  });

  const upstreamPort = await listen(upstream);
  const store = new SessionStore(10);
  const proxy = new HttpCaptureProxy(store, {
    host: '127.0.0.1',
    port: 0,
    upstreamTimeoutMs: 50,
  });

  try {
    const proxyStatus = await proxy.start();

    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: proxyStatus.port,
          method: 'GET',
          path: `http://127.0.0.1:${upstreamPort}/stall`,
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.end();
    });

    assert.equal(statusCode, 502);
    await new Promise((resolve) => setImmediate(resolve));

    const capture = store.get(store.list(1)[0]!.id);
    assert.match(capture?.error ?? '', /timed out/i);
    assert.equal(capture?.path, '/stall');
  } finally {
    await proxy.stop();
    await close(upstream);
  }
});
