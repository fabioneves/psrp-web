import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamHealth } from '../web/stream-health.js';

test('health rates seconds, holds a degraded level for three seconds and tracks cumulative counters', () => {
  const health = new StreamHealth();
  assert.equal(health.sample({ arrivalMaxMs: 24, transportMs: 6, consoleLost: 0, audioUnderruns: 0 }, 0).level, 'good');
  assert.equal(health.sample({ stalls: 1, consoleLost: 0, audioUnderruns: 0 }, 1000).level, 'fair');
  assert.equal(health.sample({ consoleLost: 0, audioUnderruns: 0 }, 2000).level, 'fair', 'held after the blip');
  assert.equal(health.sample({ consoleLost: 0, audioUnderruns: 0 }, 4100).level, 'good', 'released after three seconds');
  assert.deepEqual(health.sample({ transportMs: 140, consoleLost: 0, audioUnderruns: 0 }, 5000), { level: 'poor', reason: 'video is queuing on the network' });
  assert.equal(health.sample({ stalls: 1, consoleLost: 0, audioUnderruns: 0 }, 5500).level, 'poor', 'a better level does not replace a held worse one');
  assert.equal(health.sample({ consoleLost: 0, audioUnderruns: 0 }, 9000).level, 'good');
  assert.equal(health.sample({ consoleLost: 3, audioUnderruns: 0 }, 10000).reason, 'a few console packets were lost', 'counter deltas, not totals, drive the rating');
  assert.equal(health.sample({ consoleLost: 3, audioUnderruns: 1 }, 14000).reason, 'audio ran short');
  health.reset();
  assert.equal(health.sample({ consoleLost: 3, audioUnderruns: 1 }, 20000).level, 'good', 'a reset forgets earlier counters');
});
