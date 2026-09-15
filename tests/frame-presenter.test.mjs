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
  presenter.destroy(); presenter.request();
  assert.equal(timers.timers.size, 0);
});
