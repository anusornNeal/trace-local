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
  const mobile = net.createServer();
  const debuggerServer = net.createServer();
  await listen(control, { host: '127.0.0.1', port: 0 });
  await listen(proxy, { host: '127.0.0.1', port: 0 });
  await listen(mobile, { host: '0.0.0.0', port: 0 });
  await listen(debuggerServer, { host: '127.0.0.1', port: 0 });

  const controlPort = control.address().port;
  const proxyPort = proxy.address().port;
  const mobilePort = mobile.address().port;
  const debuggerPort = debuggerServer.address().port;
  await Promise.all([closeServer(control), closeServer(proxy), closeServer(mobile), closeServer(debuggerServer)]);
  return { controlPort, proxyPort, mobilePort, debuggerPort };
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
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Timed out waiting for Electron to exit'));
    }, timeoutMs);

    child.once('exit', onExit);
  });
}

const electronModule = "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')";

async function evaluateDesktop(debuggerPort, expression) {
  const targets = await requestJson(`http://127.0.0.1:${debuggerPort}`, '/json');
  const target = targets.find((entry) => entry.type === 'node');
  assert.ok(target?.webSocketDebuggerUrl, 'Electron main process debugging target missing');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => finish(new Error('Desktop debugger command timed out')), 8_000);
    let sent = false;
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    }
    socket.addEventListener('open', () => {
      sent = true;
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      const result = JSON.parse(event.data);
      if (result.id === 1) {
        const error = result.error?.message ?? result.result?.exceptionDetails?.text;
        finish(error ? new Error(error) : undefined, result.result?.result?.value);
      }
    });
    socket.addEventListener('close', () => finish(sent ? undefined : new Error('Desktop debugger closed before command')));
    socket.addEventListener('error', () => finish(new Error('Desktop debugger connection failed')));
  });
}

async function evaluateRenderer(debuggerPort, expression) {
  return evaluateDesktop(debuggerPort, `${electronModule}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(expression)})`);
}

async function waitForRenderer(debuggerPort, expression) {
  const result = await evaluateRenderer(debuggerPort, `new Promise((resolve) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (${expression}) { clearInterval(timer); resolve({ ok: true }); }
      else if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve({ ok: false, toast: document.querySelector('#toast').textContent });
      }
    }, 50);
  })`);
  assert.equal(result?.ok, true, `Renderer did not reach expected state: ${JSON.stringify(result)}`);
}

async function stopElectron(child, debuggerPort) {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0, 'Electron exited unexpectedly');
    assert.equal(child.signalCode, null, 'Electron was terminated by a signal');
    return;
  }

  try {
    await evaluateDesktop(debuggerPort, `${electronModule}.app.quit(); ${electronModule}.app.quit()`);
    await waitForExit(child, 10_000);
    assert.equal(child.exitCode, 0, 'Electron did not exit cleanly');
    assert.equal(child.signalCode, null, 'Electron was terminated by a signal');
    return;
  } catch (error) {
    child.kill();
    await waitForExit(child, 5_000);
    throw error;
  }
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
  const response = await fetch(new URL(requestPath, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function createCaDownload(controlUrl) {
  const setup = await requestJson(controlUrl, '/api/ca/mobile-token', { method: 'POST' });
  assert.ok(setup.qrSvg, 'CA setup must return a real QR');
  assert.match(setup.qrSvg, /<svg[\s>]/);
  assert.match(setup.url, /^http:\/\//);

  const response = await fetch(setup.url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') || '', /tracelocal/i);
  const certificate = await response.text();
  assert.match(certificate, /BEGIN CERTIFICATE/);
  return setup;
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
const unauthorizedFile = path.join(tempRoot, 'unauthorized.txt');
const oversizedFile = path.join(tempRoot, 'oversized.txt');
const missingFile = path.join(tempRoot, 'missing.txt');
await mkdir(dataDir, { recursive: true });
await mkdir(electronUserDataDir, { recursive: true });
await writeFile(mappedFile, '{"source":"map-local-e2e"}\n', 'utf8');
await writeFile(unauthorizedFile, 'not-authorized', 'utf8');
await writeFile(oversizedFile, 'x'.repeat(1024 * 1024 + 1), 'utf8');

const upstreamRequests = [];
const upstream = http.createServer((request, response) => {
  upstreamRequests.push(request.url ?? '/');
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(request.url?.startsWith('/capture') ? 'upstream-capture' : 'upstream-mapped');
});

let electron;
let proxyPort;
let controlPort;
let debuggerPort;

try {
  await listen(upstream, { host: '127.0.0.1', port: 0 });
  const upstreamPort = upstream.address().port;
  const reserved = await reservePorts();
  ({ controlPort, proxyPort, debuggerPort } = reserved);

  electron = spawn(electronPath, [`--inspect=127.0.0.1:${debuggerPort}`, projectRoot], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TRACELOCAL_E2E: '1',
      TRACELOCAL_DATA_DIR: dataDir,
      TRACELOCAL_ELECTRON_USER_DATA_DIR: electronUserDataDir,
      TRACELOCAL_CONTROL_PORT: String(controlPort),
      TRACELOCAL_PROXY_PORT: String(proxyPort),
      TRACELOCAL_MOBILE_PORT: String(reserved.mobilePort),
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

  const ruleId = created.id || created.rule?.id;
  const ruleSelector = `[data-rule="${ruleId}"]`;
  const sessionSelector = `[data-session="${captured.id}"]`;
  await waitForRenderer(debuggerPort, `document.querySelector(${JSON.stringify(ruleSelector)}) && document.querySelector(${JSON.stringify(sessionSelector)})`);

  const oversizedRule = await requestJson(controlUrl, '/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'path',
      pattern: '/desktop-e2e-oversized',
      filePath: oversizedFile,
      enabled: false,
    }),
  });
  const missingRule = await requestJson(controlUrl, '/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'path',
      pattern: '/desktop-e2e-missing',
      filePath: missingFile,
      enabled: false,
    }),
  });
  assert.ok(oversizedRule.id && missingRule.id);

  const allowedRead = await evaluateRenderer(
    debuggerPort,
    `window.traceLocalDesktop.readTextFile(${JSON.stringify(mappedFile)})`,
  );
  assert.equal(allowedRead, '{"source":"map-local-e2e"}\n');

  const unauthorizedRead = await evaluateRenderer(
    debuggerPort,
    `(async () => { try { await window.traceLocalDesktop.readTextFile(${JSON.stringify(unauthorizedFile)}); return { ok: true }; } catch (error) { return { ok: false, message: error.message }; } })()`,
  );
  assert.equal(unauthorizedRead.ok, false);
  assert.match(unauthorizedRead.message, /not selected by a Map Local rule/i);

  const oversizedRead = await evaluateRenderer(
    debuggerPort,
    `(async () => { try { await window.traceLocalDesktop.readTextFile(${JSON.stringify(oversizedFile)}); return { ok: true }; } catch (error) { return { ok: false, message: error.message }; } })()`,
  );
  assert.equal(oversizedRead.ok, false);
  assert.match(oversizedRead.message, /smaller than 1 MiB/i);

  const missingRead = await evaluateRenderer(
    debuggerPort,
    `(async () => { try { await window.traceLocalDesktop.readTextFile(${JSON.stringify(missingFile)}); return { ok: true }; } catch (error) { return { ok: false, message: error.message }; } })()`,
  );
  assert.equal(missingRead.ok, false);
  assert.match(missingRead.message, /ENOENT|no such file/i);

  const oversizedWrite = await evaluateRenderer(
    debuggerPort,
    `(async () => { try { await window.traceLocalDesktop.writeTextFile(${JSON.stringify(mappedFile)}, 'x'.repeat(1024 * 1024 + 1)); return { ok: true }; } catch (error) { return { ok: false, message: error.message }; } })()`,
  );
  assert.equal(oversizedWrite.ok, false);
  assert.match(oversizedWrite.message, /exceeds 1 MiB/i);

  await evaluateRenderer(debuggerPort, `document.querySelector(${JSON.stringify(ruleSelector)}).click()`);
  await waitForRenderer(debuggerPort, `document.querySelector('#ruleFileContent').value.includes('map-local-e2e')`);
  const editedBody = '{"source":"edited-ui"}\n';
  await evaluateRenderer(debuggerPort, `(() => {
    document.querySelector('#ruleName').value = 'Edited E2E rule';
    document.querySelector('#ruleDelay').value = '15';
    document.querySelector('#ruleFileContent').value = ${JSON.stringify(editedBody)};
    document.querySelector('#ruleForm').requestSubmit();
    return true;
  })()`);
  await waitForRenderer(debuggerPort, `document.querySelector(${JSON.stringify(ruleSelector)})?.textContent.includes('Edited E2E rule')`);

  const editedRule = (await requestJson(controlUrl, '/api/rules')).rules.find((rule) => rule.id === ruleId);
  assert.equal(editedRule.name, 'Edited E2E rule');
  assert.equal(editedRule.delayMs, 15);
  const editedMappedResponse = await requestViaProxy(proxyPort, mappedUrl);
  assert.equal(editedMappedResponse.statusCode, 203);
  assert.equal(editedMappedResponse.body, editedBody);
  await evaluateRenderer(debuggerPort, `document.querySelector(${JSON.stringify(sessionSelector)}).click()`);
  await waitForRenderer(debuggerPort, "document.querySelector('#detailRequest').textContent.includes('x-tracelocal-e2e')");
  await evaluateRenderer(debuggerPort, `document.querySelector(${JSON.stringify(ruleSelector)}).querySelector('[data-toggle]').click()`);
  await waitForRenderer(debuggerPort, `!document.querySelector(${JSON.stringify(ruleSelector)}).querySelector('[data-toggle]').classList.contains('on')`);
  const disabledRule = (await requestJson(controlUrl, '/api/rules')).rules.find((rule) => rule.id === ruleId);
  assert.equal(disabledRule.enabled, false, 'Renderer rule toggle did not persist');
  await evaluateRenderer(debuggerPort, `document.querySelector(${JSON.stringify(ruleSelector)}).querySelector('[data-toggle]').click()`);
  await waitForRenderer(debuggerPort, `document.querySelector(${JSON.stringify(ruleSelector)}).querySelector('[data-toggle]').classList.contains('on')`);
  await evaluateRenderer(debuggerPort, `document.querySelector(${JSON.stringify(ruleSelector)}).querySelector('[data-delete]').click()`);
  await waitForRenderer(debuggerPort, `!document.querySelector(${JSON.stringify(ruleSelector)})`);
  const deletedRule = (await requestJson(controlUrl, '/api/rules')).rules.find((rule) => rule.id === ruleId);
  assert.equal(deletedRule, undefined, 'Renderer rule delete did not persist');

  const mobileSetup = await createCaDownload(controlUrl);
  assert.equal(new URL(mobileSetup.url).port, String(reserved.mobilePort));
  const mobileStatus = await requestJson(controlUrl, '/api/ca/mobile-status');
  assert.equal(mobileStatus.proxyAddress.endsWith(':' + proxyPort), true);

  await evaluateRenderer(debuggerPort, "document.querySelector('#generateQr').click()");
  await waitForRenderer(
    debuggerPort,
    "!document.querySelector('#mobileQrSection').hidden && document.querySelector('#mobileQrSvg svg')",
  );
  const renderedCaLink = await evaluateRenderer(
    debuggerPort,
    "document.querySelector('#mobileCaLink').textContent",
  );
  assert.match(renderedCaLink, /^http:\/\//);

  await stopElectron(electron, debuggerPort);
  electron = undefined;

  await assertPortReleased(proxyPort);
  await assertPortReleased(controlPort, '127.0.0.1');
  await assertPortReleased(reserved.mobilePort);
  await assertPortReleased(debuggerPort, '127.0.0.1');

  console.log(JSON.stringify({
    ok: true,
    proxyPort,
    controlPort,
    capturedSessionId: captured.id,
    mappedSessionId: mappedSession.id,
    renderer: {
      trafficDetail: true,
      ruleEditAndFileWrite: true,
      editorSecurity: true,
      ruleTogglePersisted: true,
      ruleDeletePersisted: true,
      caDownloadQr: true,
    },
    upstreamRequests,
    mobileSetup: {
      manualProxy: true,
      caDownloadQr: true,
      caDownloadVerified: true,
      mobilePortReleased: true,
    },
    stderr: stderr.trim() || undefined,
  }, null, 2));
} finally {
  if (electron) {
    await stopElectron(electron, debuggerPort).catch(() => electron.kill());
  }
  await closeServer(upstream).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
