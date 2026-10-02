import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceLocalDaemon } from '../src/daemon/server';

interface ParsedEvent {
  event: string;
  data: any;
}

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

async function proxyGet(proxyPort: number, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: url,
      },
      (response) => {
        response.resume();
        response.on('end', resolve);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function nextNamedEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<ParsedEvent> {
  const decoder = new TextDecoder();

  while (true) {
    const separator = state.buffer.indexOf('\n\n');
    if (separator >= 0) {
      const block = state.buffer.slice(0, separator);
      state.buffer = state.buffer.slice(separator + 2);

      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLines = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length));

      if (eventLine && dataLines.length > 0) {
        return {
          event: eventLine.slice('event: '.length),
          data: JSON.parse(dataLines.join('\n')),
        };
      }

      continue;
    }

    const result = await reader.read();
    if (result.done) {
      throw new Error('SSE stream closed before event arrived');
    }
    state.buffer += decoder.decode(result.value, { stream: true });
  }
}

test('daemon SSE streams status, completed sessions, and rule changes', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-sse-'));
  const mappedFile = path.join(tempDir, 'mapped.txt');
  await writeFile(mappedFile, 'sse-map');

  const upstream = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const upstreamPort = await listen(upstream);

  const daemon = new TraceLocalDaemon({
    dataDir: path.join(tempDir, 'data'),
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
  });

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const status = await daemon.start();
    const base = `http://127.0.0.1:${status.controlPort}`;

    const response = await fetch(`${base}/api/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.ok(response.body);

    reader = response.body!.getReader();
    const state = { buffer: '' };

    const initial = await nextNamedEvent(reader, state);
    assert.equal(initial.event, 'status');
    assert.equal(initial.data.proxy.running, true);

    await proxyGet(
      status.proxy.port,
      `http://127.0.0.1:${upstreamPort}/event-test`,
    );

    const captureEvent = await nextNamedEvent(reader, state);
    assert.equal(captureEvent.event, 'session-added');
    assert.equal(captureEvent.data.session.path, '/event-test');
    assert.equal(captureEvent.data.session.statusCode, 204);

    const createRule = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'path',
        pattern: '/mapped',
        filePath: mappedFile,
      }),
    });
    assert.equal(createRule.status, 201);

    const ruleEvent = await nextNamedEvent(reader, state);
    assert.equal(ruleEvent.event, 'rules-changed');
    assert.equal(ruleEvent.data.rules.length, 1);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await daemon.stop();
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
});
