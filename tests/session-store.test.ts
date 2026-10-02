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

test('SessionStore replaces duplicate ids and clears all sessions', () => {
  const store = new SessionStore(3);
  store.add(record('same', 1));
  store.add(record('same', 2));

  assert.equal(store.size, 1);
  assert.equal(store.get('same')?.startedAt, 2);
  assert.equal(store.clear(), 1);
  assert.equal(store.size, 0);
});
