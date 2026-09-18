import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue } from '../web/frame-queue.js';

const INTERVAL = 1000 / 60;

// Drives the queue like the presenter does: one take() per display refresh, frames pushed as they arrive.
// Returns the refreshes that presented nothing after warm-up plus the presented frame order.
function simulate(arrivals, { seconds = 20, warmup = 2000, queue = new FrameQueue(() => {}) } = {}) {
  const displayed = [], emptyTicks = [], waits = [];
  let index = 0;
  for (let tick = 0; tick * INTERVAL < seconds * 1000; tick++) {
    const now = tick * INTERVAL;
    while (index < arrivals.length && arrivals[index].savedAt <= now) queue.push(arrivals[index++]);
    const frame = queue.take(now);
    if (frame) { displayed.push(frame.id); waits.push(now - frame.savedAt); }
    else if (now >= warmup && index > 0) emptyTicks.push(now);
  }
  return { displayed, emptyTicks, waits, queue };
}
const cadence = (count, offset = () => 0) => Array.from({ length: count }, (_, id) => ({ id, savedAt: id * INTERVAL + 1 + offset(id) }));
function seeded(seed) { let state = seed; return () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; }; }

test('smooth presentation absorbs alternating early and late arrivals without skipping frames', () => {
  const { displayed, emptyTicks, queue } = simulate(cadence(1200, id => (id % 2 ? 7 : 0)));
  assert.deepEqual(displayed, displayed.slice().sort((a, b) => a - b), 'frames stay in order');
  assert.equal(queue.dropped, 0);
  assert.equal(emptyTicks.length, 0);
});

test('random jitter and periodic late frames no longer repeat a picture every second', () => {
  const random = seeded(7);
  const arrivals = cadence(1200, id => random() * 12 - 4 + (id % 40 === 20 ? 16 : 0));
  const { emptyTicks, waits, queue } = simulate(arrivals);
  assert.ok(emptyTicks.length <= 3, `only a few refreshes repeated after warm-up, got ${emptyTicks.length} at ${emptyTicks.map(t => Math.round(t)).join(',')}`);
  assert.ok(queue.dropped <= 3, `few frames skipped, got ${queue.dropped}`);
  assert.ok(queue.target <= 2, `cushion stays small, got ${queue.target}`);
  assert.ok(Math.max(...waits.slice(200)) <= (queue.target + 2.5) * INTERVAL + 1, 'latency stays bounded by the cushion');
});

test('a permanent delivery shift erodes the cushion and one held refresh rebuilds it', () => {
  const arrivals = cadence(1200, id => (id >= 300 ? 20 : 0));
  const { emptyTicks, queue } = simulate(arrivals);
  const late = emptyTicks.filter(t => t > 300 * INTERVAL + 3000);
  assert.equal(late.length, 0, `no repeats three seconds after the shift, got ${late.map(t => Math.round(t)).join(',')}`);
  assert.ok(queue.rebuilt >= 1, 'the cushion was rebuilt');
});

test('a source below the refresh rate is presented as it arrives without extra holds', () => {
  const arrivals = Array.from({ length: 900 }, (_, id) => ({ id, savedAt: id * (1000 / 45) + 1 }));
  const { displayed, queue } = simulate(arrivals);
  assert.equal(queue.rebuilt, 0, 'no deliberate holds for a 45 fps source');
  assert.equal(queue.target, 1, 'the cushion target does not grow for a slow source');
  assert.equal(displayed.length, 900, 'every frame is shown');
  assert.equal(queue.dropped, 0);
});

test('backlog is bounded and responsive mode presents the newest frame immediately', () => {
  const released = [], queue = new FrameQueue(frame => released.push(frame.id));
  for (let id = 0; id < 20; id++) queue.push({ id, savedAt: 0 });
  assert.equal(queue.frames.length, 6);
  assert.equal(released.length, 14);
  queue.destroy(); assert.equal(released.length, 20);
  const immediate = new FrameQueue(() => {}, 60, 'responsive');
  immediate.push({ id: 1, savedAt: 0 }); immediate.push({ id: 2, savedAt: 1 });
  assert.equal(immediate.take(1).id, 2);
  assert.equal(immediate.take(2), null);
});

test('a burst drains in order, excess latency skips one frame, and a lone late frame is never dropped', () => {
  const queue = new FrameQueue(() => {});
  for (let id = 0; id < 3; id++) queue.push({ id, savedAt: 0 });
  assert.equal(queue.take(INTERVAL).id, 0);
  assert.equal(queue.take(2 * INTERVAL).id, 1, 'a burst is presented in order rather than dropped');
  assert.equal(queue.take(4 * INTERVAL).id, 2);
  for (let id = 3; id < 8; id++) queue.push({ id, savedAt: 4 * INTERVAL });
  assert.equal(queue.take(5 * INTERVAL).id, 4, 'five queued frames exceed target + 2, so the oldest is skipped');
  assert.equal(queue.dropped, 1);
  queue.destroy();
  queue.push({ id: 9, savedAt: 9 * INTERVAL });
  assert.equal(queue.take(20 * INTERVAL).id, 9, 'a lone late frame is never dropped');
  assert.equal(queue.dropped, 1);
  const metrics = queue.metrics();
  assert.deepEqual(Object.keys(metrics), ['pacingTarget', 'underruns', 'rebuilt']);
});

function simulateAt(refreshMs, arrivals, { seconds = 20, warmup = 2000 } = {}) {
  const queue = new FrameQueue(() => {});
  const presentedAt = [];
  let index = 0;
  for (let tick = 0; tick * refreshMs < seconds * 1000; tick++) {
    const now = tick * refreshMs;
    while (index < arrivals.length && arrivals[index].savedAt <= now) queue.push(arrivals[index++]);
    if (queue.take(now)) presentedAt.push(now);
  }
  const intervals = presentedAt.filter(t => t >= warmup).map((t, i, all) => (i ? t - all[i - 1] : null)).filter(Boolean);
  return { queue, intervals, presented: presentedAt.length };
}

test('a 120 Hz display absorbs the 60 fps cadence drift with 8 ms waits instead of full-frame repeats', () => {
  const arrivals = Array.from({ length: 1300 }, (_, id) => ({ id, savedAt: id * (1000 / 60) + 3 }));
  const { queue, intervals } = simulateAt(1000 / 120, arrivals);
  assert.equal(queue.underruns, 0);
  assert.equal(Math.max(...intervals) <= 25.1, true, `longest presented interval ${Math.max(...intervals).toFixed(1)} ms`);
  assert.ok(intervals.filter(i => i > 20).length <= 6, `few 25 ms holds in 18 s, got ${intervals.filter(i => i > 20).length}`);
  assert.equal(queue.dropped, 0);
});

test('a 60 Hz display whose refresh runs slightly fast holds one frame every few seconds instead of every second', () => {
  const arrivals = Array.from({ length: 1300 }, (_, id) => ({ id, savedAt: id * (1000 / 60) + 3 }));
  const { queue, intervals } = simulateAt(16.6, arrivals);
  assert.equal(queue.underruns, 0);
  const holds = intervals.filter(i => i > 30).length;
  assert.ok(holds <= 6, `at most one hold per three seconds, got ${holds}`);
  assert.equal(queue.dropped, 0);
});

test('recurring drift waits raise the cushion target once', () => {
  const released = [];
  const queue = new FrameQueue(frame => released.push(frame));
  let fed = 0;
  const feed = until => { for (; fed < until; fed += INTERVAL) queue.push({ id: fed, savedAt: fed }); }; // keepingUp needs ~60 arrivals in the last second
  const wait = at => { feed(at); queue.waited(at); };
  for (let i = 0; i < 4; i++) wait(1000 + i * 100);
  assert.equal(queue.target, 1, 'four waits in ten seconds are tolerated');
  wait(1500);
  assert.equal(queue.target, 2, 'the fifth wait raises the target');
  for (let i = 0; i < 6; i++) wait(1600 + i * 100);
  assert.equal(queue.target, 2, 'a further raise waits at least five seconds');
  for (let i = 0; i < 6; i++) wait(7000 + i * 100);
  assert.equal(queue.target, 3, 'and then raises again, up to the maximum');
  for (let i = 0; i < 20; i++) wait(13000 + i * 100);
  assert.equal(queue.target, 3);
});

test('balanced pacing absorbs paired arrivals that responsive pacing skips', () => {
  const arrivals = cadence(1200, id => (id % 2 ? 0 : INTERVAL));
  const balanced = simulate(arrivals, { queue: new FrameQueue(() => {}, 60, 'balanced') });
  const responsive = simulate(arrivals, { queue: new FrameQueue(() => {}, 60, 'responsive') });
  assert.equal(balanced.emptyTicks.length, 0);
  assert.equal(balanced.queue.dropped, 0);
  assert.deepEqual(balanced.displayed, arrivals.slice(0, balanced.displayed.length).map(frame => frame.id));
  assert.ok(responsive.emptyTicks.length > 500);
});

test('balanced pacing trades some burst recovery smoothness for at least one frame less delay', () => {
  const arrivals = cadence(1200).map(frame => ({ ...frame, savedAt: Math.max(frame.savedAt, Math.floor(frame.id / 60) * 1000 + 50) }));
  const smooth = simulate(arrivals);
  const balanced = simulate(arrivals, { queue: new FrameQueue(() => {}, 60, 'balanced') });
  const responsive = simulate(arrivals, { queue: new FrameQueue(() => {}, 60, 'responsive') });
  const percentile = result => result.waits.slice(120).sort((a, b) => a - b)[Math.floor((result.waits.length - 120) * 0.95)];
  assert.ok(percentile(smooth) - percentile(balanced) >= INTERVAL - 0.01);
  assert.ok(percentile(balanced) <= INTERVAL * 2);
  assert.ok(balanced.emptyTicks.length < responsive.emptyTicks.length);
  assert.ok(balanced.queue.dropped < responsive.queue.dropped);
});

for (const fps of [30, 60]) {
  test(`balanced ${fps} fps pacing bounds backlog, skips stale pictures and releases each frame once`, () => {
    const interval = 1000 / fps, released = [];
    const queue = new FrameQueue(frame => released.push(frame.id), fps, 'balanced');
    queue.push({ id: 0, savedAt: 0 });
    assert.equal(queue.take(interval), null, 'startup retains a one-frame cushion');
    for (let id = 1; id < 8; id++) queue.push({ id, savedAt: interval });
    assert.equal(queue.frames.length, 2);
    const first = queue.take(interval);
    assert.equal(first.id, 6, 'only the newest pair survives a large burst');
    queue.release(first);
    queue.push({ id: 8, savedAt: 4 * interval });
    const next = queue.take(4 * interval);
    assert.equal(next.id, 8, 'an old picture does not delay a fresh one after a stall');
    queue.release(next);
    queue.push({ id: 9, savedAt: 5 * interval });
    const lone = queue.take(10 * interval);
    assert.equal(lone.id, 9, 'the only available picture is retained even when late');
    queue.release(lone);
    queue.push({ id: 10, savedAt: 11 * interval });
    queue.destroy();
    assert.deepEqual(released.sort((a, b) => a - b), Array.from({ length: 11 }, (_, id) => id));
  });
}

test('balanced pacing keeps its one-frame target through sustained underruns and drift', () => {
  const queue = new FrameQueue(() => {}, 60, 'balanced');
  for (let tick = 0; tick < 1200; tick++) {
    const at = tick * INTERVAL;
    queue.push({ id: tick, savedAt: at });
    queue.take(at);
    if (tick % 60 === 0) queue.underrun(at);
    if (tick % 30 === 0) queue.waited(at);
    assert.equal(queue.metrics().pacingTarget, 1);
  }
});
