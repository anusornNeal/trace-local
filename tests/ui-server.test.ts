import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceLocalDaemon } from '../src/daemon/server';

test('daemon serves bundled UI with strict local security headers', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tracelocal-ui-'));
  const daemon = new TraceLocalDaemon({
    dataDir: path.join(tempDir, 'data'),
    controlHost: '127.0.0.1',
    controlPort: 0,
    proxyPort: 0,
  });

  try {
    const status = await daemon.start();
    const base = `http://127.0.0.1:${status.controlPort}`;

    const htmlResponse = await fetch(`${base}/`);
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(htmlResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlResponse.headers.get('x-frame-options'), 'DENY');
    assert.equal(htmlResponse.headers.get('referrer-policy'), 'no-referrer');

    const csp = htmlResponse.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);

    const html = await htmlResponse.text();
    assert.match(html, /Trace Local/);
    assert.match(html, /\/styles\.css/);
    assert.match(html, /\/app\.js/);
    assert.doesNotMatch(html, /https?:\/\//);

    const cssResponse = await fetch(`${base}/styles.css`);
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get('content-type') ?? '', /text\/css/);
    assert.ok((await cssResponse.text()).length > 1000);

    const jsResponse = await fetch(`${base}/app.js`);
    assert.equal(jsResponse.status, 200);
    assert.match(jsResponse.headers.get('content-type') ?? '', /javascript/);
    const js = await jsResponse.text();
    assert.match(js, /EventSource\('\/api\/events'\)/);
    assert.match(js, /\/api\/rules/);
  } finally {
    await daemon.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
