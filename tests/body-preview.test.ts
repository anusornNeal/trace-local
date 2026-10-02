import assert from 'node:assert/strict';
import test from 'node:test';
import { BodyPreviewCollector } from '../src/core/body-preview';

test('BodyPreviewCollector bounds retained text while tracking full byte count', () => {
  const collector = new BodyPreviewCollector(5);
  collector.append('hello');
  collector.append(' world');

  assert.deepEqual(collector.snapshot('text/plain'), {
    body: 'hello',
    totalBytes: 11,
    encoding: 'text',
    truncated: true,
  });
});

test('BodyPreviewCollector encodes binary previews as base64', () => {
  const collector = new BodyPreviewCollector(8);
  collector.append(Buffer.from([0, 1, 2]));

  const snapshot = collector.snapshot('application/octet-stream');
  assert.equal(snapshot.encoding, 'binary');
  assert.equal(snapshot.body, Buffer.from([0, 1, 2]).toString('base64'));
  assert.equal(snapshot.truncated, false);
});
