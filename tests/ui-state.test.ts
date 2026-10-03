import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function inspector() {
  const elements = new Map<string, any>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', hidden: false, textContent: '', innerHTML: '', dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {}, querySelectorAll: () => [], focus() {}, reset() {},
    });
    return elements.get(selector);
  };
  let current = { sessions: [] as any[], rules: [] as any[], devices: [] as any[] };
  let hold = false;
  const held: Array<() => void> = [];
  class Events {
    static current: Events;
    listeners = new Map<string, (event: any) => void>();
    constructor() { Events.current = this; }
    addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
    close() {}
    emit(type: string, payload?: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(payload) }); }
  }
  const context: any = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} }, location: { origin: 'http://127.0.0.1:4040' },
    EventSource: Events, AbortSignal,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (url: string) => {
      const data: Record<string, unknown> = {
        '/api/status': { sessions: current.sessions.length, rules: current.rules.length, proxy: {} },
        '/api/sessions?limit=500': { sessions: current.sessions },
        '/api/rules': { rules: current.rules },
        '/api/ca': {}, '/api/ca/mobile-status': { devices: current.devices, activeClients: current.devices.length },
      };
      assert.ok(url in data, 'Unexpected API request: ' + url);
      const snapshot = structuredClone(data[url]);
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      return { ok: true, status: 200, json: async () => snapshot };
    },
  });
  // Expose closure functions only in this VM; the production renderer has no testing API.
  const script = readFileSync('src/ui/app.js', 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.inspector = { state, loadBootstrap, curlFor }; })();');
  vm.runInContext(script, context);
  return {
    context, elements, events: Events.current,
    setSnapshot(value: typeof current) { current = value; },
    hold() { hold = true; },
    release() { hold = false; held.splice(0).forEach((resolve) => resolve()); },
  };
}

const session = (id: string) => ({
  id, protocol: 'http', httpVersion: '1.1', method: 'GET',
  host: 'example.test', path: '/' + id, url: 'http://example.test/' + id, startedAt: 1,
});

test('SSE reconnect resynchronizes missed clears, captures, rules and devices', async () => {
  const ui = inspector();
  await tick();
  assert.equal(ui.elements.get('#caPath').textContent, '—');
  assert.equal(ui.elements.get('#ruleCount').textContent, '0');
  const old = session('old');
  ui.events.emit('session-added', { session: old });
  ui.context.inspector.state.selected = old;
  ui.events.emit('error');
  ui.setSnapshot({ sessions: [session('new')], rules: [], devices: [{ sessionId: 'new-device', name: 'Phone' }] });
  ui.events.emit('open');
  await tick();
  assert.equal(ui.context.inspector.state.sessions[0].id, 'new');
  assert.equal(ui.context.inspector.state.selected, null);
  assert.equal(ui.context.inspector.state.mobileStatus.devices[0].sessionId, 'new-device');
  assert.equal(ui.context.inspector.state.connected, true);
});

test('live events arriving during REST refresh survive stale snapshot completion', async () => {
  const ui = inspector();
  await tick();
  ui.setSnapshot({ sessions: [session('stale')], rules: [], devices: [] });
  ui.hold();
  const refresh = ui.context.inspector.loadBootstrap();
  ui.events.emit('sessions-cleared', { removed: 1 });
  ui.events.emit('session-added', { session: session('live') });
  ui.events.emit('devices-changed', { devices: [{ sessionId: 'live-device', name: 'Phone' }] });
  ui.release();
  await refresh;
  assert.deepEqual(Array.from(ui.context.inspector.state.sessions, (entry: any) => entry.id), ['live']);
  assert.equal(ui.context.inspector.state.status.sessions, 1);
  assert.equal(ui.context.inspector.state.mobileStatus.devices[0].sessionId, 'live-device');
});

test('an older bootstrap response cannot overwrite a newer reconnect snapshot', async () => {
  const ui = inspector();
  await tick();
  ui.setSnapshot({ sessions: [session('old')], rules: [], devices: [] });
  ui.hold();
  const oldRefresh = ui.context.inspector.loadBootstrap();
  ui.setSnapshot({ sessions: [session('latest')], rules: [], devices: [] });
  const newRefresh = ui.context.inspector.loadBootstrap();
  ui.release();
  await Promise.all([oldRefresh, newRefresh]);
  assert.equal(ui.context.inspector.state.sessions[0].id, 'latest');
});

test('copy cURL quotes untrusted HTTP method tokens as well as headers and URL', async () => {
  const ui = inspector();
  await tick();
  const command = ui.context.inspector.curlFor({ ...session('curl'), method: 'GET`whoami`', requestHeaders: { 'x-value': "a'b" } });
  assert.match(command, /^curl -X 'GET`whoami`'/);
  assert.ok(command.includes("'x-value: a'\\''b'"));
});
