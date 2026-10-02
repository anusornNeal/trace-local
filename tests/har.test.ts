import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionRecord } from '../src/core/types';
import { buildHar } from '../src/export/har';

test('buildHar emits HAR 1.2 entries with bodies and Trace Local metadata', () => {
  const record: SessionRecord = {
    id: 'capture-1',
    startedAt: Date.parse('2026-10-02T00:00:00.000Z'),
    completedAt: Date.parse('2026-10-02T00:00:00.125Z'),
    durationMs: 125,
    protocol: 'https',
    httpVersion: '1.1',
    method: 'POST',
    url: 'https://api.example.test/items?q=trace',
    host: 'api.example.test',
    path: '/items?q=trace',
    statusCode: 201,
    statusMessage: 'Created',
    requestHeaders: {
      'content-type': 'application/json',
      'x-request-id': 'abc',
    },
    responseHeaders: {
      'content-type': 'application/json',
      location: '/items/1',
    },
    requestBody: '{"name":"demo"}',
    responseBody: '{"id":1}',
    requestBodyBytes: 15,
    responseBodyBytes: 8,
    requestBodyEncoding: 'text',
    responseBodyEncoding: 'text',
    mapped: true,
    mapRuleId: 'rule-1',
  };

  const har = buildHar([record]) as {
    log: {
      version: string;
      entries: Array<Record<string, any>>;
    };
  };

  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 1);

  const entry = har.log.entries[0]!;
  assert.equal(entry.request.method, 'POST');
  assert.equal(entry.request.url, record.url);
  assert.deepEqual(entry.request.queryString, [{ name: 'q', value: 'trace' }]);
  assert.equal(entry.request.postData.text, '{"name":"demo"}');
  assert.equal(entry.response.status, 201);
  assert.equal(entry.response.content.text, '{"id":1}');
  assert.equal(entry.response.redirectURL, '/items/1');
  assert.equal(entry.time, 125);
  assert.equal(entry._traceLocal.mapped, true);
  assert.equal(entry._traceLocal.mapRuleId, 'rule-1');
});
