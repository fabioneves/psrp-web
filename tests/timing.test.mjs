import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamClock, unpackMedia } from '../web/timing.js';

test('clock excludes server queue time and chooses least delayed offset sample', () => {
  const clock = new StreamClock();
  assert.equal(clock.age(0, 100), null);
  clock.sample({ clientTime: 100, received: 1110, sent: 1140 }, 150);
  assert.equal(clock.offset, 1000); assert.equal(clock.rttMs, 20);
  assert.equal(clock.age(1140, 150), 10);
  clock.sample({ clientTime: 200, received: 1300, sent: 1300 }, 310);
  assert.equal(clock.offset, 1000);
  clock.sample({ clientTime: NaN, received: 0, sent: 0 }, 0);
  assert.equal(clock.offset, 1000);
});

test('versioned media envelope separates timing from payload and rejects malformed input', () => {
  const bytes = new ArrayBuffer(33), view = new DataView(bytes);
  view.setUint32(0, 0x52504d31); view.setUint32(4, 1, true);
  for (const offset of [8, 16, 24]) view.setFloat64(offset, 1234, true);
  view.setUint8(32, 0x47);
  assert.equal(unpackMedia(bytes).bytes.byteLength, 1);
  assert.equal(unpackMedia(bytes).timestamp, 1234);
  view.setUint32(4, 3, true);
  assert.equal(unpackMedia(bytes).kind, 3);
  view.setUint32(4, 4, true);
  assert.throws(() => unpackMedia(bytes));
  view.setUint32(4, 1, true);
  assert.throws(() => unpackMedia(bytes.slice(0, 20)));
  view.setFloat64(24, NaN, true);
  assert.throws(() => unpackMedia(bytes));
});
