import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatestFrame } from '../web/latest-frame.js';

test('burst delivery retains only the newest owned pixels and counts skipped presentations', () => {
  const frame = new LatestFrame(); frame.resize(16, 16);
  const y = new Uint8Array(256), c = new Uint8Array(64);
  y.fill(5); frame.save(y, c, c, 1);
  y.fill(9); frame.save(y, c, c, 2); y.fill(77);
  assert.equal(frame.dropped, 1);
  assert.equal(frame.take().y[0], 9);
  assert.equal(frame.timestamp, 2);
  assert.equal(frame.take(), null);
});
