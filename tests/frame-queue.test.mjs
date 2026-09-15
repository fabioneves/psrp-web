import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue } from '../web/frame-queue.js';

test('smooth presentation absorbs alternating early and late arrivals without skipping frames', () => {
  const queue = new FrameQueue(() => {});
  const arrivals = Array.from({ length: 120 }, (_, id) => ({ id, savedAt: id * 1000 / 60 + (id % 2 ? 7 : 0) }));
  const displayed = [];
  let index = 0;
  for (let tick = 0; tick < 125; tick++) {
    const now = tick * 1000 / 60;
    while (index < arrivals.length && arrivals[index].savedAt <= now) queue.push(arrivals[index++]);
    const frame = queue.take(now);
    if (frame) displayed.push(frame.id);
  }
  assert.deepEqual(displayed, arrivals.map(frame => frame.id));
  assert.equal(queue.dropped, 0);
});
test('backlog is bounded and responsive mode presents the newest frame immediately', () => {
  const released = [], queue = new FrameQueue(frame => released.push(frame.id));
  for (let id = 0; id < 20; id++) queue.push({ id, savedAt: 0 });
  assert.equal(queue.frames.length, 3);
  assert.equal(released.length, 17);
  queue.destroy(); assert.equal(released.length, 20);
  const immediate = new FrameQueue(() => {}, 60, false);
  immediate.push({ id: 1, savedAt: 0 }); immediate.push({ id: 2, savedAt: 1 });
  assert.equal(immediate.take(1).id, 2);
});
