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

test('audio priming grows after an underrun and relaxes back after a calm minute', () => {
  const queue = new PcmQueue(48000, 40);
  const sample = { rate: 48000, left: new Float32Array(960).fill(0.2), right: new Float32Array(960).fill(-0.2) };
  const left = new Float32Array(128), right = new Float32Array(128);
  for (let i = 0; i < 3; i++) queue.push(sample);
  while (queue.length > 128) queue.read(left, right);
  queue.read(left, right);
  assert.equal(queue.underruns, 1);
  assert.equal(queue.delayMs, 80, 'one underrun adds 40 ms of priming');
  assert.equal(queue.baseDelayMs, 40);
  for (let i = 0; i < 40; i++) queue.push(sample);
  for (let i = 0; i < 48000 * 61 / 128; i++) { if (queue.length < 4800) for (let j = 0; j < 10; j++) queue.push(sample); queue.read(left, right); }
  assert.equal(queue.underruns, 1, 'steady feeding causes no further underruns');
  assert.equal(queue.delayMs, 40, 'a calm minute restores the chosen priming');
});

test('audio follows presented video, discards stale samples and holds future samples', () => {
  const queue = new PcmQueue(48000, 40);
  const sample = { rate: 48000, timestamp: 1000, left: new Float32Array(9600).fill(0.2), right: new Float32Array(9600).fill(-0.2) };
  queue.push(sample); queue.sync(1190);
  const left = new Float32Array(128), right = new Float32Array(128);
  queue.read(left, right);
  assert.ok(queue.trimmed >= 6240);
  assert.ok(left[0] > 0); assert.ok(Math.abs(queue.skewMs) <= 20);
  queue.clear(); queue.push(sample); queue.sync(940); queue.read(left, right);
  assert.equal(left[0], 0); assert.equal(queue.length, 9600);
  for (let i = 0; i < 50; i++) queue.read(left, right);
  assert.ok(left[0] > 0);
  queue.clear(); assert.equal(queue.target, null);
});

test('ordinary video timestamp jitter never interrupts continuous audio', () => {
  const queue = new PcmQueue(48000, 120);
  const left = new Float32Array(128), right = new Float32Array(128);
  let written = 0, silent = 0;
  for (let block = 0; block < 3750; block++) {
    const time = block * 128 / 48;
    while (written < time + 140) {
      queue.push({ rate: 48000, timestamp: 1000 + written,
        left: new Float32Array(960).fill(0.2), right: new Float32Array(960).fill(0.2) });
      written += 20;
    }
    if (block % 6 === 0) queue.sync(1000 + time + 40 + (block % 12 ? 32 : -32));
    queue.read(left, right);
    if (block > 100 && left.every(value => value === 0)) silent++;
  }
  assert.equal(silent, 0);
  assert.equal(queue.underruns, 0);
  assert.ok(queue.trimmed < 960, `unexpected discarded samples: ${queue.trimmed}`);
});
