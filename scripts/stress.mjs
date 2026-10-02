import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { TraceLocalDaemon } = require('../dist/daemon/server.js');

const requestCount = positiveInt(process.env.TRACELOCAL_STRESS_REQUESTS, 2000);
const concurrency = positiveInt(process.env.TRACELOCAL_STRESS_CONCURRENCY, 32);
const maxSessions = positiveInt(process.env.TRACELOCAL_STRESS_MAX_SESSIONS, 500);
const ruleCount = positiveInt(process.env.TRACELOCAL_STRESS_RULES, 150);
const mappedRequestCount = positiveInt(process.env.TRACELOCAL_STRESS_MAPPED_REQUESTS, 250);
const memoryBudgetBytes = 256 * 1024 * 1024;

function positiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mib(bytes) {
  return round(bytes / 1024 / 1024);
}

function snapshotMemory() {
  global.gc?.();
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
  };
}

function proxyGet(proxyPort, targetUrl) {
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: {
        host: target.host,
        connection: 'close',
      },
    }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.once('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          bytes,
        });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

async function runConcurrent(total, workerCount, fn) {
  let nextIndex = 0;
  const latencies = [];
  const failures = [];

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;

      const started = performance.now();
      try {
        await fn(index);
        latencies.push(performance.now() - started);
      } catch (error) {
        failures.push({
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const started = performance.now();
  await Promise.all(
    Array.from(
      { length: Math.min(workerCount, total) },
      () => worker(),
    ),
  );

  return {
    durationMs: performance.now() - started,
    latencies,
    failures,
  };
}

function summarizeRun(run, total) {
  return {
    requests: total,
    durationMs: round(run.durationMs),
    requestsPerSecond: round((total / run.durationMs) * 1000),
    failures: run.failures.length,
    latencyMs: {
      p50: round(percentile(run.latencies, 0.5)),
      p95: round(percentile(run.latencies, 0.95)),
      p99: round(percentile(run.latencies, 0.99)),
      max: round(Math.max(0, ...run.latencies)),
    },
  };
}

async function requestJson(baseUrl, requestPath, init) {
  const response = await fetch(new URL(requestPath, baseUrl), init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-stress-'));
const dataDir = path.join(tempDir, 'data');
const mappedFile = path.join(tempDir, 'mapped.json');
await mkdir(dataDir, { recursive: true });
await writeFile(mappedFile, '{"mapped":true}\n', 'utf8');

const upstreamBody = Buffer.alloc(8 * 1024, 0x61);
let upstreamRequests = 0;
const upstream = http.createServer((_request, response) => {
  upstreamRequests += 1;
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': upstreamBody.length,
  });
  response.end(upstreamBody);
});

const daemon = new TraceLocalDaemon({
  dataDir,
  controlHost: '127.0.0.1',
  controlPort: 0,
  proxyPort: 0,
  maxSessions,
  maxBodyPreviewBytes: 64 * 1024,
});

try {
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  const status = await daemon.start();
  const controlUrl = `http://127.0.0.1:${status.controlPort}`;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const memoryBefore = snapshotMemory();

  const trafficRun = await runConcurrent(
    requestCount,
    concurrency,
    async (index) => {
      const response = await proxyGet(
        status.proxy.port,
        `${upstreamBase}/load/${index}`,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.bytes, upstreamBody.length);
    },
  );

  assert.equal(
    trafficRun.failures.length,
    0,
    `traffic failures: ${JSON.stringify(trafficRun.failures.slice(0, 5))}`,
  );
  assert.equal(upstreamRequests, requestCount);
  assert.equal(daemon.store.size, Math.min(maxSessions, requestCount));

  const memoryAfterTraffic = snapshotMemory();
  const trafficRssDelta = memoryAfterTraffic.rss - memoryBefore.rss;
  assert.ok(
    trafficRssDelta < memoryBudgetBytes,
    `RSS grew by ${mib(trafficRssDelta)} MiB, above the 256 MiB stress budget`,
  );
  assert.ok(
    trafficRun.durationMs < 30_000,
    `default traffic phase exceeded broad 30s safety budget: ${round(trafficRun.durationMs)} ms`,
  );

  const now = new Date().toISOString();
  const rules = Array.from({ length: ruleCount }, (_, index) => ({
    id: `stress-rule-${index + 1}`,
    order: index + 1,
    enabled: true,
    target: 'path',
    pattern: index === ruleCount - 1
      ? '/mapped-target'
      : `/never-match-${index}/*`,
    method: 'GET',
    filePath: mappedFile,
    statusCode: 203,
    contentType: 'application/json',
    createdAt: now,
    updatedAt: now,
  }));

  const ruleInstallStarted = performance.now();
  const imported = await requestJson(controlUrl, '/api/rules/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, rules }),
  });
  const ruleInstallMs = performance.now() - ruleInstallStarted;
  assert.equal(imported.imported, ruleCount);

  const upstreamBeforeMapped = upstreamRequests;
  const mappedRun = await runConcurrent(
    mappedRequestCount,
    Math.min(concurrency, 24),
    async () => {
      const response = await proxyGet(
        status.proxy.port,
        `${upstreamBase}/mapped-target`,
      );
      assert.equal(response.statusCode, 203);
      assert.equal(response.bytes, Buffer.byteLength('{"mapped":true}\n'));
    },
  );

  assert.equal(
    mappedRun.failures.length,
    0,
    `mapped failures: ${JSON.stringify(mappedRun.failures.slice(0, 5))}`,
  );
  assert.equal(
    upstreamRequests,
    upstreamBeforeMapped,
    'mapped requests unexpectedly reached upstream',
  );

  const memoryAfterMapped = snapshotMemory();
  const totalRssDelta = memoryAfterMapped.rss - memoryBefore.rss;
  assert.ok(
    totalRssDelta < memoryBudgetBytes,
    `total RSS grew by ${mib(totalRssDelta)} MiB, above the 256 MiB stress budget`,
  );

  console.log(JSON.stringify({
    ok: true,
    config: {
      requestCount,
      concurrency,
      maxSessions,
      ruleCount,
      mappedRequestCount,
    },
    traffic: summarizeRun(trafficRun, requestCount),
    mapLocal: {
      ruleInstallMs: round(ruleInstallMs),
      ...summarizeRun(mappedRun, mappedRequestCount),
    },
    sessionsRetained: daemon.store.size,
    memoryMiB: {
      beforeRss: mib(memoryBefore.rss),
      afterTrafficRss: mib(memoryAfterTraffic.rss),
      afterMappedRss: mib(memoryAfterMapped.rss),
      trafficRssDelta: mib(trafficRssDelta),
      totalRssDelta: mib(totalRssDelta),
      heapDelta: mib(memoryAfterMapped.heapUsed - memoryBefore.heapUsed),
      externalDelta: mib(memoryAfterMapped.external - memoryBefore.external),
    },
  }, null, 2));
} finally {
  await daemon.stop().catch(() => undefined);
  await close(upstream).catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
}
