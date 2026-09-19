import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReassembler, HEADER_SIZE, MAX_PAYLOAD } from '../web/frame-reassembler.js';

// A frame's first payload byte marks it: 1 = keyframe, 0 = delta. The rest is filler that must survive intact.
const frame = (key, length, seed = 7) => Uint8Array.from({ length }, (_, i) => i === 0 ? (key ? 1 : 0) : (i * seed) & 0xff);
function split(frameId, data) {
  const count = Math.max(1, Math.ceil(data.length / MAX_PAYLOAD));
  return Array.from({ length: count }, (_, index) => {
    const payload = data.subarray(index * MAX_PAYLOAD, (index + 1) * MAX_PAYLOAD);
    const fragment = new Uint8Array(HEADER_SIZE + payload.length), view = new DataView(fragment.buffer);
    view.setUint32(0, frameId, true); view.setUint16(4, index, true); view.setUint16(6, count, true);
    fragment.set(payload, HEADER_SIZE);
    return fragment;
  });
}
function setup(options = {}) {
  const state = { time: 0, requests: 0 };
  const reassembler = createReassembler({ frameIntervalMs: 1000 / 60, isKey: data => data[0] === 1,
    requestKeyframe: () => state.requests++, now: () => state.time, ...options });
  const feed = fragments => fragments.map(fragment => reassembler.push(fragment)).filter(Boolean);
  return { state, reassembler, feed };
}

test('fragments in order rebuild the access unit byte for byte', () => {
  const { feed, reassembler } = setup(), data = frame(true, MAX_PAYLOAD * 2 + 300);
  const out = feed(split(1, data));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], data);
  assert.deepEqual(reassembler.metrics(), { fragments: 3, delivered: 1, abandoned: 0, discarded: 0, keyframeRequests: 0 });
});

test('a one-byte frame and a frame of exactly one payload are single fragments', () => {
  const { feed } = setup();
  assert.deepEqual(feed(split(1, frame(true, 1)))[0], frame(true, 1));
  assert.deepEqual(feed(split(2, frame(false, MAX_PAYLOAD)))[0], frame(false, MAX_PAYLOAD));
});

test('reordered and duplicated fragments still deliver the frame once', () => {
  const { feed, reassembler } = setup(), data = frame(true, MAX_PAYLOAD * 3);
  const [a, b, c] = split(1, data);
  assert.deepEqual(feed([c, a, a, b, b]), [data]);
  assert.equal(reassembler.metrics().delivered, 1);
});

test('a lost fragment abandons only that frame, then nothing is delivered until a keyframe', () => {
  const { feed, reassembler, state } = setup();
  assert.equal(feed(split(1, frame(true, 2000))).length, 1);
  const [first] = split(2, frame(false, 2000));
  assert.deepEqual(feed([first]), []);
  assert.deepEqual(feed(split(3, frame(false, 2000))), [], 'a delta after a lost frame would decode to garbage');
  assert.equal(reassembler.metrics().abandoned, 1);
  assert.equal(reassembler.metrics().discarded, 1);
  assert.equal(state.requests, 1);
  assert.deepEqual(feed(split(4, frame(true, 2000))), [frame(true, 2000)]);
  assert.deepEqual(feed(split(5, frame(false, 500))), [frame(false, 500)]);
});

test('a frame that never arrived at all counts as lost', () => {
  const { feed, reassembler, state } = setup();
  feed(split(1, frame(true, 500)));
  assert.deepEqual(feed(split(3, frame(false, 500))), []);
  assert.equal(reassembler.metrics().abandoned, 1);
  assert.equal(state.requests, 1);
});

test('a keyframe after a gap is delivered without asking for another', () => {
  const { feed, state } = setup();
  feed(split(1, frame(true, 500)));
  assert.equal(feed(split(9, frame(true, 500))).length, 1);
  assert.equal(state.requests, 0);
});

test('an incomplete frame older than two frame intervals is abandoned', () => {
  const { feed, reassembler, state } = setup();
  feed(split(1, frame(true, 500)));
  const [first, second] = split(2, frame(false, 2000));
  feed([first]);
  state.time = 34;
  assert.deepEqual(feed([second]), [], 'the rest arrived too late');
  assert.equal(reassembler.metrics().abandoned, 1);
  assert.equal(state.requests, 1);
});

test('fragments of a delivered or abandoned frame are dropped', () => {
  const { feed, reassembler } = setup(), fragments = split(1, frame(true, 2000));
  feed(fragments);
  assert.deepEqual(feed(fragments), []);
  assert.equal(reassembler.metrics().delivered, 1);
  assert.equal(reassembler.pending, 0);
});

test('keyframe requests are limited to one per 500 ms', () => {
  const { feed, state } = setup();
  feed(split(1, frame(true, 500)));
  feed(split(3, frame(false, 500)));
  feed(split(4, frame(false, 500)));
  assert.equal(state.requests, 1);
  state.time = 499; feed(split(5, frame(false, 500)));
  assert.equal(state.requests, 1);
  state.time = 500; feed(split(6, frame(false, 500)));
  assert.equal(state.requests, 2);
});

test('the first frame on a channel must be a keyframe', () => {
  const { feed, state } = setup();
  assert.deepEqual(feed(split(1, frame(false, 500))), []);
  assert.equal(state.requests, 1);
  assert.equal(feed(split(2, frame(true, 500))).length, 1);
});

test('at most four frames are held; the oldest gives way', () => {
  const { feed, reassembler } = setup({ frameIntervalMs: 1000 });
  feed(split(1, frame(true, 500)));
  for (let id = 2; id <= 6; id++) feed([split(id, frame(false, 2000))[0]]);
  assert.equal(reassembler.pending, 4);
  assert.equal(reassembler.metrics().abandoned, 1);
});

test('malformed and oversized fragments are ignored', () => {
  const { reassembler } = setup();
  const header = (frameId, index, count, payload = 10) => {
    const fragment = new Uint8Array(HEADER_SIZE + payload), view = new DataView(fragment.buffer);
    view.setUint32(0, frameId, true); view.setUint16(4, index, true); view.setUint16(6, count, true);
    return fragment;
  };
  assert.equal(reassembler.push(new Uint8Array(4)), null, 'shorter than a header');
  assert.equal(reassembler.push(header(1, 0, 0)), null, 'no fragments');
  assert.equal(reassembler.push(header(1, 2, 2)), null, 'index past the count');
  assert.equal(reassembler.push(header(1, 0, 2000)), null, 'more than 2 MiB of fragments');
  assert.equal(reassembler.push(header(1, 0, 2, MAX_PAYLOAD + 1)), null, 'payload above the fragment limit');
  assert.equal(reassembler.pending, 0);
  const [first] = [header(2, 0, 2)];
  reassembler.push(first);
  assert.equal(reassembler.push(header(2, 1, 3)), null, 'count changed mid-frame');
  assert.equal(reassembler.pending, 1);
});

test('an ArrayBuffer is accepted as it comes from a data channel', () => {
  const { reassembler } = setup(), data = frame(true, 100);
  const [fragment] = split(1, data);
  assert.deepEqual(reassembler.push(fragment.buffer), data);
});
