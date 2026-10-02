import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const READY_PREFIX = 'TRACELOCAL_E2E_READY ';

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reservePorts() {
  const control = net.createServer();
  const proxy = net.createServer();
  await listen(control, { host: '127.0.0.1', port: 0 });
  await listen(proxy, { host: '127.0.0.1', port: 0 });

  const controlPort = control.address().port;
  const proxyPort = proxy.address().port;
  await Promise.all([closeServer(control), closeServer(proxy)]);
  return { controlPort, proxyPort };
}

function waitForReady(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ value, stderr: stderrBuffer });
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onStdout = (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith(READY_PREFIX)) continue;
        try {
          succeed(JSON.parse(line.slice(READY_PREFIX.length)));
        } catch (error) {
          fail(error);
        }
      }
    };

    const onStderr = (chunk) => {
      stderrBuffer += chunk.toString();
    };

    const onExit = (code, signal) => {
      fail(new Error(
        `Electron exited before readiness (code=${code}, signal=${signal}).\n${stderrBuffer}`,
      ));
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for Electron readiness.\n${stderrBuffer}`));
    }, timeoutMs);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for Electron to exit'));
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopElectron(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.stdin?.write('quit\n');
  try {
    await waitForExit(child, 2_000);
    return;
  } catch {
    child.kill();
  }

  await waitForExit(child, 5_000);
}

function requestViaProxy(proxyPort, targetUrl) {
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
        'x-tracelocal-e2e': '1',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.once('error', reject);
    request.end();
  });
}

async function requestJson(baseUrl, requestPath, init) {
  const response = await fetch(new URL(requestPath, baseUrl), init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function waitForSession(baseUrl, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await requestJson(baseUrl, '/api/sessions?limit=50');
    const match = payload.sessions.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for captured session');
}

async function assertPortReleased(port, host, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    const probe = net.createServer();
    try {
      await listen(probe, host ? { host, port } : { port });
      await closeServer(probe);
      return;
    } catch (error) {
      lastError = error;
      await closeServer(probe).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Port ${port} was not released: ${lastError?.message ?? 'unknown error'}`);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-desktop-e2e-'));
const dataDir = path.join(tempRoot, 'data');
const electronUserDataDir = path.join(tempRoot, 'electron-user-data');
const mappedFile = path.join(tempRoot, 'mapped.json');
await mkdir(dataDir, { recursive: true });
await mkdir(electronUserDataDir, { recursive: true });
await writeFile(mappedFile, '{"source":"map-local-e2e"}\n', 'utf8');

const upstreamRequests = [];
const upstream = http.createServer((request, response) => {
  upstreamRequests.push(request.url ?? '/');
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(request.url?.startsWith('/capture') ? 'upstream-capture' : 'upstream-mapped');
});

let electron;
let proxyPort;
let controlPort;

try {
  await listen(upstream, { host: '127.0.0.1', port: 0 });
  const upstreamPort = upstream.address().port;
  ({ controlPort, proxyPort } = await reservePorts());

  electron = spawn(electronPath, [projectRoot], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TRACELOCAL_E2E: '1',
      TRACELOCAL_DATA_DIR: dataDir,
      TRACELOCAL_ELECTRON_USER_DATA_DIR: electronUserDataDir,
      TRACELOCAL_CONTROL_PORT: String(controlPort),
      TRACELOCAL_PROXY_PORT: String(proxyPort),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const { value: ready, stderr } = await waitForReady(electron);
  assert.equal(ready.controlPort, controlPort);
  assert.equal(ready.proxy?.port, proxyPort);
  assert.equal(ready.proxy?.running, true);

  const controlUrl = `http://127.0.0.1:${controlPort}`;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const captureUrl = `${upstreamBase}/capture?case=desktop-e2e`;
  const captureResponse = await requestViaProxy(proxyPort, captureUrl);
  assert.equal(captureResponse.statusCode, 200);
  assert.equal(captureResponse.body, 'upstream-capture');

  const captured = await waitForSession(
    controlUrl,
    (session) => session.url === captureUrl,
  );
  assert.equal(captured.method, 'GET');
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.mapped, false);

  const mappedUrl = `${upstreamBase}/mapped`;
  const rulesBefore = upstreamRequests.length;
  const created = await requestJson(controlUrl, '/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'url',
      pattern: mappedUrl,
      method: 'GET',
      filePath: mappedFile,
      statusCode: 203,
      contentType: 'application/json',
      enabled: true,
    }),
  });
  assert.ok(created.id || created.rule?.id, 'Map Local rule was not created');

  const mappedResponse = await requestViaProxy(proxyPort, mappedUrl);
  assert.equal(mappedResponse.statusCode, 203);
  assert.equal(mappedResponse.body, '{"source":"map-local-e2e"}\n');
  assert.equal(upstreamRequests.length, rulesBefore, 'Mapped request unexpectedly reached upstream');

  const mappedSession = await waitForSession(
    controlUrl,
    (session) => session.url === mappedUrl && session.mapped === true,
  );
  assert.equal(mappedSession.statusCode, 203);
  assert.equal(mappedSession.mapped, true);

  await stopElectron(electron);
  electron = undefined;

  await assertPortReleased(proxyPort);
  await assertPortReleased(controlPort, '127.0.0.1');

  console.log(JSON.stringify({
    ok: true,
    proxyPort,
    controlPort,
    capturedSessionId: captured.id,
    mappedSessionId: mappedSession.id,
    upstreamRequests,
    stderr: stderr.trim() || undefined,
  }, null, 2));
} finally {
  if (electron) {
    await stopElectron(electron).catch(() => electron.kill());
  }
  await closeServer(upstream).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
