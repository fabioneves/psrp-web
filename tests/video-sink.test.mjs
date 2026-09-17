import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplayTiming, supportsVideoSink } from '../web/video-sink.js';

test('display timing reports screen intervals, skipped frames and resets per report', () => {
  const timing = new DisplayTiming();
  let count = 0;
  for (const at of [0, 16.7, 33.3, 50, 83.3, 100]) timing.note({ presentationTime: at, presentedFrames: ++count + (at === 83.3 ? 1 : 0) });
  const metrics = timing.metrics();
  assert.equal(metrics.displayedFrames, 6);
  assert.equal(metrics.displaySkipped, 1, 'a jump in presentedFrames counts a skipped frame');
  assert.ok(Math.abs(metrics.displayMaxMs - 33.3) < 0.01, 'the 50 -> 83.3 gap is the longest interval');
  assert.ok(metrics.displayP95Ms >= 16.7);
  assert.deepEqual(timing.metrics(), { displayP95Ms: null, displayMaxMs: null, displaySkipped: 0, displayedFrames: 0, displayReplaced: 0 }, 'counters reset each report');
  timing.note({ presentationTime: 2000, presentedFrames: 20 });
  assert.equal(timing.metrics().displayMaxMs, null, 'a pause over half a second is not an interval');
});

test('the sink is offered only where the browser has both a track generator and frame callbacks', () => {
  assert.equal(supportsVideoSink({}), false);
  assert.equal(supportsVideoSink({ MediaStreamTrackGenerator: class {}, HTMLVideoElement: { prototype: {} } }), false);
  assert.equal(supportsVideoSink({ MediaStreamTrackGenerator: class {}, HTMLVideoElement: { prototype: { requestVideoFrameCallback() {} } } }), true);
});
