import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reconnect } from '../web/reconnect.js';

test('retries back off, stop cancels pending retries, and failures have a limit', () => {
  let queued, delay, calls = 0;
  const timers = { setTimeout(fn, ms) { queued = fn; delay = ms; return 1; }, clearTimeout() { queued = null; } };
  const retry = new Reconnect(() => calls++, timers);
  for (const expected of [500, 1000, 2000, 4000, 8000]) {
    assert.equal(retry.schedule(), true);
    assert.equal(delay, expected);
    queued();
  }
  assert.equal(calls, 5);
  assert.equal(retry.schedule(), false);
  retry.reset();
  retry.schedule(3000); assert.equal(delay, 3000, 'a busy console waits at least three seconds before the first retry'); queued();
  retry.schedule(3000); assert.equal(delay, 3000); queued();
  retry.schedule(3000); assert.equal(delay, 3000); queued();
  retry.schedule(3000); assert.equal(delay, 4000, 'the exponential schedule takes over once it exceeds the minimum');
  retry.reset();
  retry.schedule();
  retry.reset();
  assert.equal(queued, null);
});

test('a busy console keeps retrying at the minimum delay for a minute without spending attempts', () => {
  let queued, delay, calls = 0;
  const timers = { setTimeout(fn, ms) { queued = fn; delay = ms; return 1; }, clearTimeout() { queued = null; } };
  const retry = new Reconnect(() => calls++, timers);
  let now = 0;
  for (let i = 0; i < 12; i++) { assert.equal(retry.schedule(4000, true, now), true); assert.equal(delay, 4000); queued(); now += 4000; }
  assert.equal(retry.count, 0);
  now = 61000;
  assert.equal(retry.schedule(4000, true, now), true);
  assert.equal(retry.count, 1, 'after a minute the counted schedule takes over');
  retry.reset();
  assert.equal(retry.waitingSince, null);
});
