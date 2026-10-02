import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceLocalDaemon } from '../src/daemon/server';
import { getLanIpAddress } from '../src/core/network';

test('getLanIpAddress returns non-loopback IPv4 address or null', () => {
  const lanIp = getLanIpAddress();
  if (lanIp !== null) {
    assert.match(lanIp, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    assert.notEqual(lanIp, '127.0.0.1');
  }
});

test('daemon proxy includes LAN URL when network interface available', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-lan-'));
  const daemon = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
    dataDir: path.join(tempDir, 'data'),
  });

  try {
    const status = await daemon.start();

    assert.equal(status.proxy.running, true);
    assert.ok(status.proxy.port > 0);
    assert.ok(status.proxy.proxyUrl);
    assert.match(status.proxy.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const lanIp = getLanIpAddress();
    if (lanIp) {
      assert.ok(status.proxy.lanUrl);
      assert.match(status.proxy.lanUrl, /^http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/);
      assert.equal(status.proxy.lanUrl, `http://${lanIp}:${status.proxy.port}`);
    } else {
      assert.equal(status.proxy.lanUrl, null);
    }

    assert.equal(status.proxy.error, undefined);
  } finally {
    await daemon.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('daemon status shows proxy ready when running', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-status-'));
  const daemon = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
    dataDir: path.join(tempDir, 'data'),
  });

  try {
    await daemon.start();
    const status = daemon.status;

    assert.equal(status.proxy.running, true);
    assert.ok(status.proxy.proxyUrl);
    assert.equal(status.proxy.error, undefined);
  } finally {
    await daemon.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('daemon proxy advertises stable LAN endpoint across requests', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-stable-'));
  const daemon = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
    dataDir: path.join(tempDir, 'data'),
  });

  try {
    const status1 = await daemon.start();
    const lanUrl1 = status1.proxy.lanUrl;
    const port1 = status1.proxy.port;

    // Get status again - should be identical
    const status2 = daemon.status;
    assert.equal(status2.proxy.lanUrl, lanUrl1);
    assert.equal(status2.proxy.port, port1);

    // Verify LAN URL is stable across multiple status checks
    for (let i = 0; i < 5; i++) {
      const status = daemon.status;
      assert.equal(status.proxy.lanUrl, lanUrl1);
      assert.equal(status.proxy.port, port1);
    }
  } finally {
    await daemon.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('proxy accepts connections on LAN address when available', async () => {
  const lanIp = getLanIpAddress();
  if (!lanIp) {
    console.log('Skipping LAN connectivity test: no LAN interface available');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-connect-'));
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('OK');
  });

  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, lanIp, () => resolve());
  });

  const upstreamPort = (upstream.address() as any).port;
  const daemon = new TraceLocalDaemon({
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
    dataDir: path.join(tempDir, 'data'),
    allowRemote: true,
  });

  try {
    const status = await daemon.start();
    assert.ok(status.proxy.lanUrl);

    // Try to connect through the LAN address
    const proxyResponse = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request(
        {
          host: lanIp,
          port: status.proxy.port,
          method: 'GET',
          path: `http://${lanIp}:${upstreamPort}/test`,
          headers: { host: `${lanIp}:${upstreamPort}` },
        },
        resolve,
      );
      request.on('error', reject);
      request.setTimeout(5000, () => {
        request.destroy(new Error('Request timeout'));
      });
      request.end();
    });

    assert.equal(proxyResponse.statusCode, 200);
  } finally {
    await daemon.stop();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});
