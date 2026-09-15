import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PcmQueue, unpackPcm } from '../web/pcm.js';

test('PCM packet validates its header and preserves signed stereo samples', () => {
  const bytes = new ArrayBuffer(20), view = new DataView(bytes);
  new Uint8Array(bytes).set([80, 67, 77, 49]);
  view.setInt32(4, 48000, true); view.setInt32(8, 2, true);
  view.setInt16(12, 16384, true); view.setInt16(14, -16384, true);
  const packet = unpackPcm(bytes);
  assert.equal(packet.left[0], 0.5); assert.equal(packet.right[0], -0.5);
  view.setInt32(8, 99, true);
  assert.throws(() => unpackPcm(bytes));
});

test('audio queue waits for jitter buffer, plays both channels and bounds backlog', () => {
  const queue = new PcmQueue(48000, 40);
  const sample = { rate: 48000, left: new Float32Array(960).fill(0.2), right: new Float32Array(960).fill(-0.2) };
  queue.push(sample);
  const left = new Float32Array(128), right = new Float32Array(128);
  queue.read(left, right);
  assert.equal(left[0], 0);
  queue.push(sample); queue.read(left, right);
  assert.ok(left[0] > 0); assert.ok(right[0] < 0);
  for (let i = 0; i < 100; i++) queue.push(sample);
  assert.ok(queue.length <= 24000);
  queue.clear(); queue.read(left, right);
  assert.equal(left.at(-1), 0);
});
