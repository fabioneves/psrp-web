import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamLog, describeEvent } from '../web/diagnostics.js';

test('stream log records stalls, superseded frames, underruns and console loss from metric deltas', () => {
  let now = 0;
  const log = new StreamLog(() => now, () => 1700000000000);
  log.videoStats({ fps: 60, frameP95Ms: 17, frameMaxMs: 17.5, droppedFrames: 0, totalFrames: 60, decodeQueue: 1 });
  now = 1000;
  log.videoStats({ fps: 59, frameP95Ms: 17, frameMaxMs: 68, droppedFrames: 2, totalFrames: 120, decodeQueue: 12 });
  log.audioStats({ underruns: 0, bufferedMs: 120 });
  log.audioStats({ underruns: 3, bufferedMs: 40 });
  assert.equal(log.serverStats({ lost: 10, dropped: 1, idr: 1 }), null);
  const delta = log.serverStats({ lost: 14, dropped: 2, idr: 2 });
  assert.deepEqual([delta.lost, delta.dropped, delta.idr], [4, 1, 1]);
  assert.deepEqual(log.events.map(event => event.type), ['superseded', 'decode-backlog', 'audio-underrun', 'server-loss']);
  assert.equal(log.events[0].t, 1000);
  assert.match(describeEvent(log.events[0]), /2 superseded frames/);
  assert.match(describeEvent(log.events[2]), /underrun ×3/);
  const exported = log.export({ codec: 'h264' });
  assert.equal(exported.samples.length, 2);
  assert.equal(exported.samples[1].dropped, 2);
  assert.equal(exported.codec, 'h264');
  assert.equal(exported.startedAt, '2023-11-14T22:13:20.000Z');
});

test('stream log records delivery gaps and presentation stalls', () => {
  const log = new StreamLog(() => 0);
  log.videoStats({ fps: 60, frameMaxMs: 17, droppedFrames: 0, arrivalP95Ms: 18, arrivalMaxMs: 240, stalls: 2, stallMs: 130 });
  assert.deepEqual(log.events.map(event => event.type), ['delivery-gap', 'stall']);
  assert.match(describeEvent(log.events[0]), /paused 240 ms/);
  assert.match(describeEvent(log.events[1]), /2 presentation stalls, 130 ms late/);
  assert.equal(log.samples[0].arrivalMax, 240);
  assert.equal(log.samples[0].stallMs, 130);
});

test('stream log bounds its buffers and resets between sessions', () => {
  const log = new StreamLog(() => 0);
  for (let i = 0; i < 500; i++) log.event('status', { message: String(i) });
  assert.equal(log.events.length, 400);
  for (let i = 0; i < 400; i++) log.videoStats({ fps: 60, frameMaxMs: 17, droppedFrames: 0 });
  assert.equal(log.samples.length, 300);
  log.reset();
  assert.deepEqual([log.events.length, log.samples.length, log.server], [0, 0, null]);
});
