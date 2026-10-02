import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import test from 'node:test';
import { generateCACertificate } from 'mockttp';
import { TraceLocalDaemon } from '../src/daemon/server';

async function listenHttps(server: https.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }
  return address.port;
}

async function close(server: https.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readConnectResponse(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker >= 0) {
        socket.off('data', onData);
        socket.off('error', reject);
        resolve(buffer.subarray(marker + 4));
      }
    };

    socket.on('data', onData);
    socket.once('error', reject);
  });
}

async function httpsThroughProxy(options: {
  proxyPort: number;
  targetPort: number;
  ca: string;
  path: string;
}): Promise<{ statusCode: number; body: string }> {
  const socket = net.connect(options.proxyPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(
    `CONNECT localhost:${options.targetPort} HTTP/1.1\r\nHost: localhost:${options.targetPort}\r\nConnection: keep-alive\r\n\r\n`,
  );

  const remainder = await readConnectResponse(socket);
  assert.equal(remainder.length, 0);

  const secureSocket = tls.connect({
    socket,
    servername: 'localhost',
    ca: options.ca,
    rejectUnauthorized: true,
  });

  await new Promise<void>((resolve, reject) => {
    secureSocket.once('secureConnect', resolve);
    secureSocket.once('error', reject);
  });

  secureSocket.write(
    `GET ${options.path} HTTP/1.1\r\nHost: localhost:${options.targetPort}\r\nConnection: close\r\n\r\n`,
  );

  const response = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    secureSocket.on('data', (chunk: Buffer) => chunks.push(chunk));
    secureSocket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    secureSocket.once('error', reject);
  });

  const [head, ...bodyParts] = response.split('\r\n\r\n');
  const statusMatch = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
  if (!statusMatch) {
    throw new Error(`Invalid HTTP response: ${head}`);
  }

  return {
    statusCode: Number(statusMatch[1]),
    body: bodyParts.join('\r\n\r\n'),
  };
}

test('Trace Local intercepts HTTPS, captures it, and Map Local bypasses HTTPS upstream', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-https-'));
  const mappedFile = path.join(tempDir, 'mapped.json');
  await writeFile(mappedFile, '{"source":"https-map-local"}');

  const upstreamCa = await generateCACertificate({
    subject: { commonName: 'localhost' },
  });

  let upstreamRequests = 0;
  const upstream = https.createServer(
    {
      key: upstreamCa.key,
      cert: upstreamCa.cert,
    },
    (_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"source":"upstream"}');
    },
  );
  const upstreamPort = await listenHttps(upstream);

  const daemon = new TraceLocalDaemon({
    dataDir: path.join(tempDir, 'data'),
    controlPort: 0,
    proxyPort: 0,
    additionalTrustedCaCerts: [upstreamCa.cert],
  });

  daemon.rules.create({
    target: 'path',
    pattern: '/mapped',
    method: 'GET',
    filePath: mappedFile,
  });

  try {
    const status = await daemon.start();
    const traceCa = await daemon.caManager.ensure();

    const passthrough = await httpsThroughProxy({
      proxyPort: status.proxy.port,
      targetPort: upstreamPort,
      ca: traceCa.cert,
      path: '/secure',
    });
    assert.equal(passthrough.statusCode, 200);
    assert.match(passthrough.body, /upstream/);
    assert.equal(upstreamRequests, 1);

    const mapped = await httpsThroughProxy({
      proxyPort: status.proxy.port,
      targetPort: upstreamPort,
      ca: traceCa.cert,
      path: '/mapped',
    });
    assert.equal(mapped.statusCode, 200);
    assert.match(mapped.body, /https-map-local/);
    assert.equal(upstreamRequests, 1);

    await new Promise((resolve) => setImmediate(resolve));
    const captures = daemon.store.list(10);
    assert.equal(captures.length, 2);

    assert.ok(captures.every((capture) => capture.protocol === 'https'));

    const mappedCapture = captures.find((capture) => capture.path === '/mapped');
    assert.equal(mappedCapture?.mapped, true);
    assert.ok(mappedCapture?.mapRuleId);

    const passthroughCapture = captures.find((capture) => capture.path === '/secure');
    assert.equal(passthroughCapture?.mapped, false);
    assert.equal(passthroughCapture?.statusCode, 200);
  } finally {
    await daemon.stop();
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
});
