import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceLocalDaemon } from '../src/daemon/server';
import { InterceptProxy } from '../src/proxy/intercept-proxy';
import { requestPolicyError } from '../src/daemon/request-policy';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(context: { after: (fn: () => Promise<void>) => void }, controlHost = '127.0.0.1') {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-hardening-'));
  const daemon = new TraceLocalDaemon({ dataDir, controlHost, controlPort: 0, proxyPort: 0, allowRemote: true });
  context.after(async () => { await daemon.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const status = await daemon.start();
  return { daemon, status, base: `http://127.0.0.1:${status.controlPort}` };
}

async function request(port: number, pathname: string, headers: Record<string, string> = {}, method = 'GET', body?: string, host = '127.0.0.1') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const call = http.request({ host, port, path: pathname, headers, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    call.on('error', reject);
    call.end(body);
  });
}

const ruleInput = (name: string) => ({ pattern: `/${name}`, target: 'path' as const, filePath: 'unused.txt', enabled: false });

test('control listener rejects rebinding and browser mutation attacks while preserving UI/CLI', async (context) => {
  const { status, base, daemon } = await fixture(context, '0.0.0.0');
  const port = status.controlPort;
  for (const headers of [
    { host: `attacker.invalid:${port}` }, { host: `127.0.0.1:${port + 1}` },
    { origin: 'https://attacker.invalid' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) {
    assert.equal((await request(port, '/api/status', headers)).status, 403);
  }
  assert.equal((await request(port, '/api/rules', { origin: 'https://attacker.invalid', 'content-type': 'text/plain' }, 'POST', JSON.stringify(ruleInput('attack')))).status, 403);
  assert.equal((await request(port, '/api/rules', { 'content-type': 'text/plain' }, 'POST', JSON.stringify(ruleInput('plain')))).status, 415);
  assert.equal((await request(port, '/api/rules', {}, 'POST', JSON.stringify(ruleInput('missing-type')))).status, 415);
  assert.equal(daemon.rules.size, 0);
  const sameOrigin = await request(port, '/api/rules', { origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' }, 'POST', JSON.stringify(ruleInput('valid')));
  assert.equal(sameOrigin.status, 201);
  assert.equal((await request(port, '/api/status')).status, 200);
  assert.equal((await request(port, '/api/ca/mobile-token', {}, 'POST')).status, 201);
});

test('authority policy checks IPv6 ports and preserves explicit configured host', () => {
  const incoming = (host: string, localAddress = '::1') => ({
    headers: { host }, rawHeaders: ['Host', host], socket: { localAddress }, method: 'GET',
  }) as http.IncomingMessage;
  assert.equal(requestPolicyError(incoming('[::1]:4040'), 4040, '::1'), undefined);
  assert.equal(requestPolicyError(incoming('[::1]:4041'), 4040, '::1')?.status, 403);
  assert.equal(requestPolicyError(incoming('dev-host:4040'), 4040, 'dev-host'), undefined);
  assert.equal(requestPolicyError(incoming('attacker.invalid:4040'), 4040, 'dev-host')?.status, 403);
  assert.equal(requestPolicyError(incoming('192.168.1.12:4040', '192.168.1.12'), 4040, '0.0.0.0'), undefined);
});

test('CA download listener rejects browser-origin attacks and serves direct certificate downloads', async (context) => {
  const { status } = await fixture(context);
  const setup = JSON.parse((await request(status.controlPort, '/api/ca/mobile-token', {}, 'POST')).body);
  const download = new URL(setup.url);
  const mobilePort = Number(download.port);

  assert.equal((await request(mobilePort, download.pathname, { origin: 'https://attacker.invalid' })).status, 403);
  const direct = await request(mobilePort, download.pathname);
  assert.equal(direct.status, 200);
  assert.match(direct.body, /BEGIN CERTIFICATE/);
  assert.equal((await request(mobilePort, '/pair/legacy')).status, 404);
  assert.equal((await request(mobilePort, '/device/session', { 'content-type': 'application/json' }, 'POST', '{}')).status, 404);
});

test('cached CA expiry blocks new CA download links', async (context) => {
  const { daemon, status } = await fixture(context);
  const metadata = JSON.parse((await request(status.controlPort, '/api/ca')).body);
  const before = (daemon.caTokenServer as any).tokens.size;

  const realNow = Date.now.bind(Date);
  let expiredNow: number | undefined = Date.parse(metadata.expiresAt);
  context.mock.method(Date, 'now', () => expiredNow ?? realNow());
  try {
    const response = await request(status.controlPort, '/api/ca/mobile-token', {}, 'POST');
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'ca_expired' });
    assert.equal((daemon.caTokenServer as any).tokens.size, before);
    assert.equal((await request(status.controlPort, '/api/ca')).status, 200);
  } finally {
    expiredNow = undefined;
  }

  assert.equal((await request(status.controlPort, '/api/ca/mobile-token', {}, 'POST')).status, 201);
});

test('failed queued rule mutation cannot roll back a later successful transaction', async (context) => {
  const { daemon } = await fixture(context);
  const reached = deferred();
  const release = deferred();
  const save = daemon.ruleState.save.bind(daemon.ruleState);
  let saves = 0;
  daemon.ruleState.save = async (rules) => {
    if (++saves === 1) { reached.resolve(); await release.promise; throw new Error('injected disk failure'); }
    return save(rules);
  };
  const mutate = (callback: () => unknown) => (daemon as any).persistRuleMutation(callback) as Promise<unknown>;
  const first = mutate(() => daemon.rules.create(ruleInput('failed')));
  const failed = assert.rejects(first, /injected disk failure/);
  await reached.promise;
  let secondStarted = false;
  const second = mutate(() => { secondStarted = true; return daemon.rules.create(ruleInput('kept')); });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  release.resolve();
  await failed;
  await second;
  assert.deepEqual(daemon.rules.list().map((rule) => rule.pattern), ['/kept']);
  assert.deepEqual((await daemon.ruleState.loadRecovering()).rules.map((rule) => rule.pattern), ['/kept']);
});

test('queued update/delete check existence after an earlier deletion commits', async (context) => {
  const { daemon, base } = await fixture(context);
  const created = await fetch(`${base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ruleInput('gone')) }).then((response) => response.json()) as { id: string };
  const reached = deferred();
  const release = deferred();
  const queued = deferred();
  const save = daemon.ruleState.save.bind(daemon.ruleState);
  let saves = 0;
  daemon.ruleState.save = async (rules) => {
    if (++saves === 1) { reached.resolve(); await release.promise; }
    return save(rules);
  };
  const original = (daemon as any).persistRuleMutation.bind(daemon);
  let admissions = 0;
  (daemon as any).persistRuleMutation = (mutate: () => unknown) => {
    const result = original(mutate);
    if (++admissions === 3) queued.resolve();
    return result;
  };
  const deleted = fetch(`${base}/api/rules/${created.id}`, { method: 'DELETE' });
  await reached.promise;
  const patched = fetch(`${base}/api/rules/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
  const deletedAgain = fetch(`${base}/api/rules/${created.id}`, { method: 'DELETE' });
  await queued.promise;
  release.resolve();
  assert.equal((await deleted).status, 200);
  assert.equal((await patched).status, 404);
  assert.equal((await deletedAgain).status, 404);
  assert.equal(daemon.rules.size, 0);
});

test('proxy refresh queue recovers after a failed registration', async (context) => {
  const { daemon } = await fixture(context);
  const proxy = daemon.proxy! as any;
  const apply = proxy.applyRulesAndSubscriptions.bind(proxy);
  let calls = 0;
  proxy.applyRulesAndSubscriptions = async () => { if (++calls === 1) throw new Error('injected registration failure'); await apply(); };
  await assert.rejects(proxy.refreshRules(), /injected registration failure/);
  await proxy.refreshRules();
  assert.equal(calls, 2);
});

test('shutdown drains admitted rule saves before restart and rejects new mutations', async (context) => {
  const { daemon, base } = await fixture(context);
  const reached = deferred();
  const release = deferred();
  const save = daemon.ruleState.save.bind(daemon.ruleState);
  let saves = 0;
  daemon.ruleState.save = async (rules) => {
    if (++saves === 1) { reached.resolve(); await release.promise; }
    return save(rules);
  };
  const pending = fetch(`${base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ruleInput('drained')) });
  await reached.promise;
  const stopping = daemon.stop();
  let restarted = false;
  const restarting = daemon.start().then((status) => { restarted = true; return status; });
  assert.equal((await request(daemon.status.controlPort, '/api/rules', { 'content-type': 'application/json' }, 'POST', JSON.stringify(ruleInput('rejected')))).status, 503);
  assert.equal(restarted, false);
  release.resolve();
  assert.equal((await pending).status, 201);
  await stopping;
  await restarting;
  assert.deepEqual(daemon.rules.list().map((rule) => rule.pattern), ['/drained']);
  assert.equal(daemon.status.proxy.running, true);
});

test('failed proxy initialization releases its live listener and daemon can retry', async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-failed-start-'));
  const daemon = new TraceLocalDaemon({ dataDir, controlPort: 0, proxyPort: 0 });
  const prototype = InterceptProxy.prototype as any;
  const apply = prototype.applyRulesAndSubscriptions;
  let failedPort = 0;
  context.after(async () => { prototype.applyRulesAndSubscriptions = apply; await daemon.stop(); await rm(dataDir, { recursive: true, force: true }); });
  prototype.applyRulesAndSubscriptions = async function () { failedPort = this.server.port; throw new Error('injected startup failure'); };
  await assert.rejects(daemon.start(), /injected startup failure/);
  prototype.applyRulesAndSubscriptions = apply;
  assert.ok(failedPort > 0);
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(failedPort, '127.0.0.1', resolve); });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.equal((await daemon.start()).proxy.running, true);
});

test('shutdown coalesces while starting and closes partial bodies plus SSE sockets', async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-stop-start-'));
  const daemon = new TraceLocalDaemon({ dataDir, controlPort: 0, proxyPort: 0 });
  context.after(async () => { await daemon.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const starting = daemon.start();
  assert.equal(daemon.start(), starting);
  const stopping = daemon.stop();
  assert.equal(daemon.stop(), stopping);
  await starting;
  await stopping;
  assert.equal(daemon.status.proxy.running, false);
  const status = await daemon.start();
  const caSetup = JSON.parse((await request(status.controlPort, '/api/ca/mobile-token', {}, 'POST')).body);
  const mobilePort = Number(new URL(caSetup.url).port);
  const clients: net.Socket[] = [];
  for (const port of [status.controlPort, mobilePort]) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    clients.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    if (port === mobilePort) {
      socket.write(`GET /ca/incomplete HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    } else {
      socket.write(`POST /api/rules HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    }
  }
  const eventRequest = http.get(`http://127.0.0.1:${status.controlPort}/api/events`);
  eventRequest.on('error', () => undefined);
  await new Promise<void>((resolve) => eventRequest.once('response', (response) => { response.resume(); resolve(); }));
  const started = Date.now();
  await daemon.stop();
  assert.ok(Date.now() - started < 2_500, 'incomplete clients must not hold shutdown indefinitely');
  for (const client of clients) client.destroy();
  eventRequest.destroy();
  assert.equal(daemon.status.controlPort, 0);
  assert.equal(daemon.status.proxy.running, false);
});

test('shutdown still closes both HTTP listeners when proxy cleanup reports an error', async (context) => {
  const { daemon, status } = await fixture(context);
  const control = (daemon as any).controlServer as http.Server;
  const mobile = (daemon as any).mobileCaServer as http.Server;
  const stop = daemon.proxy!.stop.bind(daemon.proxy!);
  daemon.proxy!.stop = async () => { await stop(); throw new Error('injected cleanup error'); };
  await assert.rejects(daemon.stop(), /Daemon shutdown failed/);
  assert.equal(control.listening, false);
  assert.equal(mobile.listening, false);
  assert.equal(daemon.status.controlPort, 0);
  assert.equal(daemon.status.proxy.running, false);
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(status.proxy.port, '127.0.0.1', resolve); });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

test('LAN-capable proxy refuses its control listener but preserves other local upstream ports', async (context) => {
  const { daemon, status } = await fixture(context);
  const upstream = http.createServer((_request, response) => response.end('ordinary local app'));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const port = status.proxy.port;
  for (const host of ['127.0.0.1', '127.1', '2130706433', 'localhost', '[::1]', 'localhost.', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]']) {
    assert.equal((await request(port, `http://${host}:${status.controlPort}/api/status`)).status, 403);
    assert.equal((await request(port, `http://${host}:${status.controlPort}/api/status`, { host: `127.0.0.1:${status.controlPort}` })).status, 403);
    assert.equal((await request(port, `http://${host}:${status.controlPort}/api/rules`, { host: `127.0.0.1:${status.controlPort}`, 'content-type': 'application/json' }, 'POST', JSON.stringify(ruleInput('host-bypass')))).status, 403);
  }
  assert.equal((await request(port, `http://arbitrary-alias.invalid:${status.controlPort}/api/status`, { host: `127.0.0.1:${status.controlPort}` })).status, 403);
  if (status.proxy.lanUrl) {
    const lanHost = new URL(status.proxy.lanUrl).hostname;
    assert.equal((await request(port, `http://127.0.0.1:${status.controlPort}/api/status`, {}, 'GET', undefined, lanHost)).status, 403);
    assert.equal((await request(port, `http://127.0.0.1:${status.controlPort}/api/rules`, { 'content-type': 'application/json' }, 'POST', JSON.stringify(ruleInput('lan-proxy-attack')), lanHost)).status, 403);
  }
  assert.equal((await request(port, `http://127.0.0.1:${status.controlPort}/api/rules`, { 'content-type': 'application/json' }, 'POST', JSON.stringify(ruleInput('proxy-attack')))).status, 403);
  assert.equal(daemon.rules.size, 0);
  const ordinary = await request(port, `http://127.0.0.1:${upstreamPort}/api/status`);
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body, 'ordinary local app');
  const websocketStatus = await new Promise<number>((resolve, reject) => {
    const upgrade = http.request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${status.controlPort}/api/events`, headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    } });
    upgrade.once('response', (response) => { response.resume(); resolve(response.statusCode!); });
    upgrade.once('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
    upgrade.once('error', reject);
    upgrade.setTimeout(2_000, () => { upgrade.destroy(); reject(new Error('WebSocket control deny timed out')); });
    upgrade.end();
  });
  assert.equal(websocketStatus, 403);
  const tunneledStatus = await new Promise<number>((resolve, reject) => {
    const connect = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${status.controlPort}` });
    connect.once('connect', (_response, socket) => {
      socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error('CONNECT control deny timed out')); });
      socket.once('error', reject);
      socket.once('data', (chunk) => { socket.destroy(); resolve(Number(chunk.toString().match(/^HTTP\/1\.1 (\d+)/)?.[1])); });
      socket.write(`GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${status.controlPort}\r\nConnection: close\r\n\r\n`);
    });
    connect.once('error', reject);
    connect.end();
  });
  assert.equal(tunneledStatus, 403);
});
