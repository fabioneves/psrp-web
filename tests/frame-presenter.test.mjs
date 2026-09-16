import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FramePresenter } from '../web/frame-presenter.js';

function clock() {
  let id = 0;
  const frames = new Map(), timers = new Map();
  return {
    frames, timers,
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick() { const [id, { fn }] = timers.entries().next().value; timers.delete(id); fn(); },
    frame() { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(); }
  };
}
test('presentation follows animation frames and coalesces pending draws', () => {
  const timers = clock(); let draws = 0;
  const presenter = new FramePresenter(() => draws++, timers);
  presenter.request(); presenter.request();
  assert.equal(timers.frames.size, 1);
  timers.frame();
  assert.equal(draws, 1);
  assert.equal(timers.timers.size, 0);
  presenter.request(); presenter.destroy();
  assert.equal(timers.frames.size + timers.timers.size, 0);
});
test('lost animation callbacks recover without reconnecting and keep 60 Hz scheduling', () => {
  const timers = clock(); let draws = 0;
  const presenter = new FramePresenter(() => draws++, timers);
  presenter.request();
  const stale = [...timers.frames.values()][0];
  timers.tick();
  assert.equal(draws, 1);
  assert.equal(timers.frames.size, 0);
  stale();
  assert.equal(draws, 1);
  presenter.request();
  assert.equal([...timers.timers.values()][0].delay, 1000 / 60);
  timers.tick();
  assert.equal(draws, 2);
  presenter.request();
  assert.equal(timers.frames.size, 1);
  timers.frame();
  assert.equal(presenter.recovering, false);
  assert.equal(draws, 3);
  presenter.destroy(); presenter.request();
  assert.equal(timers.timers.size, 0);
});

test('a late callback cannot present a newer request early', () => {
  const timers = clock(); let draws = 0;
  const presenter = new FramePresenter(() => { draws++; }, timers);
  presenter.request();
  const stale = [...timers.frames.values()][0];
  timers.tick();
  presenter.request();
  stale();
  assert.equal(draws, 1);
  timers.frame();
  assert.equal(draws, 2);
  presenter.destroy();
});

test('metrics count presentation stalls over 2.5 expected intervals and reset each report', () => {
  const timers = clock();
  let now = 0;
  timers.performance = { now: () => now };
  const presenter = new FramePresenter(() => false, timers, 10);
  for (const at of [0, 10, 20, 60, 70]) { now = at; presenter.request(); timers.frame(); }
  const metrics = presenter.metrics();
  assert.equal(metrics.stalls, 1);
  assert.equal(metrics.stallMs, 30);
  assert.equal(metrics.frameMaxMs, 40);
  assert.equal(presenter.metrics().stalls, 0);
});
