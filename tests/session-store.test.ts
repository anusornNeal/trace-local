import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/core/session-store';
import type { SessionRecord } from '../src/core/types';

function record(id: string, startedAt: number): SessionRecord {
  return {
    id,
    startedAt,
    completedAt: startedAt + 5,
    durationMs: 5,
    protocol: 'http',
    httpVersion: '1.1',
    method: 'GET',
    url: `http://example.test/${id}`,
    host: 'example.test',
    path: `/${id}`,
    requestHeaders: {},
    requestBody: null,
    requestBodyBytes: 0,
    mapped: false,
  };
}

test('SessionStore keeps newest sessions first and evicts oldest', () => {
  const store = new SessionStore(2);
  store.add(record('one', 1));
  store.add(record('two', 2));
  store.add(record('three', 3));

  assert.equal(store.size, 2);
  assert.deepEqual(store.list().map((item) => item.id), ['three', 'two']);
  assert.equal(store.get('one'), undefined);
  assert.equal(store.get('two')?.path, '/two');
});

test('SessionStore isolates repeated header arrays on input and every output', () => {
  const store = new SessionStore();
  const source = record('headers', 1);
  source.requestHeaders.accept = ['text/plain'];
  source.responseHeaders = { 'set-cookie': ['original=1', 'other=2'] };
  store.add(source);
  source.requestHeaders.accept.push('mutated-input');
  (source.responseHeaders['set-cookie'] as string[]).push('mutated-input');
  const retrieved = store.get('headers')!;
  (retrieved.requestHeaders.accept as string[]).push('mutated-output');
  (retrieved.responseHeaders!['set-cookie'] as string[]).splice(0);
  const exported = store.records()[0];
  (exported.requestHeaders.accept as string[]).push('mutated-export');
  assert.deepEqual(store.get('headers')!.requestHeaders.accept, ['text/plain']);
  assert.deepEqual(store.records()[0].responseHeaders!['set-cookie'], ['original=1', 'other=2']);
});

test('SessionStore replaces duplicate ids and clears all sessions', () => {
  const store = new SessionStore(3);
  store.add(record('same', 1));
  store.add(record('same', 2));

  assert.equal(store.size, 1);
  assert.equal(store.get('same')?.startedAt, 2);
  assert.equal(store.clear(), 1);
  assert.equal(store.size, 0);
});


test('SessionStore emits add and clear events without exposing mutable records', () => {
  const store = new SessionStore(2);
  const events: unknown[] = [];
  const unsubscribe = store.subscribe((event) => events.push(event));

  const source = record('event', 10);
  store.add(source);
  source.path = '/mutated-after-add';

  assert.equal(store.get('event')?.path, '/event');
  assert.deepEqual(
    events.map((event) => (event as { type: string }).type),
    ['session-added'],
  );

  assert.equal(store.clear(), 1);
  assert.deepEqual(
    events.map((event) => (event as { type: string }).type),
    ['session-added', 'sessions-cleared'],
  );

  unsubscribe();
  store.add(record('after-unsubscribe', 20));
  assert.equal(events.length, 2);
});
