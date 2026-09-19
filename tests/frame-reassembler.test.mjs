import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReassembler, HEADER_SIZE, MAX_PAYLOAD } from '../web/frame-reassembler.js';

test('a message is 64 KiB at most, so a delta frame travels whole and only keyframes are split', () => {
  assert.equal(HEADER_SIZE + MAX_PAYLOAD, 64 * 1024);
});

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
// Frames here run to hundreds of kilobytes; a failed deepEqual on them spends minutes and gigabytes printing the difference.
const sameFrames = (actual, expected) => assert.ok(actual.length === expected.length &&
  actual.every((data, index) => Buffer.compare(data, expected[index]) === 0), `expected ${expected.length} intact frame(s), got ${actual.length}`);
function setup(options = {}) {
  const state = { time: 0, requests: 0 };
  const reassembler = createReassembler({ frameIntervalMs: 1000 / 60, isKey: data => data[0] === 1,
    requestKeyframe: () => state.requests++, now: () => state.time, ...options });
  const feed = fragments => fragments.flatMap(fragment => reassembler.push(fragment));
  return { state, reassembler, feed };
}

test('fragments in order rebuild the access unit byte for byte', () => {
  const { feed, reassembler } = setup(), data = frame(true, MAX_PAYLOAD * 2 + 300);
  const out = feed(split(1, data));
  sameFrames(out, [data]);
  assert.deepEqual(reassembler.metrics(), { fragments: 3, delivered: 1, abandoned: 0, discarded: 0, keyframeRequests: 0 });
});

test('a one-byte frame and a frame of exactly one payload are single fragments', () => {
  const { feed } = setup();
  sameFrames(feed(split(1, frame(true, 1))), [frame(true, 1)]);
  sameFrames(feed(split(2, frame(false, MAX_PAYLOAD))), [frame(false, MAX_PAYLOAD)]);
});

test('reordered and duplicated fragments still deliver the frame once', () => {
  const { feed, reassembler } = setup(), data = frame(true, MAX_PAYLOAD * 3);
  const [a, b, c] = split(1, data);
  sameFrames(feed([c, a, a, b, b]), [data]);
  assert.equal(reassembler.metrics().delivered, 1);
});

test('a frame whose predecessor is late is held, and both are delivered in order when the retransmission arrives', () => {
  const { feed, reassembler, state } = setup();
  feed(split(1, frame(true, 500)));
  const [first, second] = split(2, frame(false, MAX_PAYLOAD + 900));
  assert.equal(feed([first]).length, 0);
  assert.equal(feed(split(3, frame(false, 600))).length, 0, 'frame 3 cannot be decoded before frame 2');
  state.time = 120;
  sameFrames(feed([second]), [frame(false, MAX_PAYLOAD + 900), frame(false, 600)]);
  assert.deepEqual([reassembler.metrics().abandoned, reassembler.metrics().keyframeRequests, state.requests], [0, 0, 0]);
});

test('a frame still missing after 300 ms is given up: a keyframe is asked for and nothing is delivered until it comes', () => {
  const { feed, reassembler, state } = setup();
  feed(split(1, frame(true, 500)));
  assert.equal(feed(split(3, frame(false, 500))).length, 0);
  state.time = 299;
  assert.equal(feed(split(4, frame(false, 500))).length, 0);
  assert.equal(state.requests, 0, 'still inside the time a retransmission may take');
  state.time = 301;
  assert.equal(feed(split(5, frame(false, 500))).length, 0, 'deltas after a lost frame would decode to garbage');
  assert.equal(reassembler.metrics().abandoned, 1);
  assert.equal(reassembler.metrics().discarded, 3);
  assert.equal(state.requests, 1);
  sameFrames(feed(split(6, frame(true, 700))), [frame(true, 700)]);
  sameFrames(feed(split(7, frame(false, 500))), [frame(false, 500)]);
});

test('a keyframe ends the wait for anything older at once', () => {
  const { feed, reassembler, state } = setup();
  feed(split(1, frame(true, 500)));
  feed(split(3, frame(false, 500)));
  sameFrames(feed(split(4, frame(true, 500))), [frame(true, 500)]);
  assert.equal(reassembler.metrics().abandoned, 1, 'frame 2 never came');
  assert.equal(state.requests, 0, 'the keyframe is already here');
  assert.equal(reassembler.pending, 0);
});

test('a slow keyframe is not given up while its fragments keep coming', () => {
  const { feed, reassembler, state } = setup(), data = frame(true, MAX_PAYLOAD * 5);
  const out = split(1, data).flatMap(fragment => { state.time += 90; return feed([fragment]); });
  sameFrames(out, [data]);
  assert.equal(reassembler.metrics().abandoned, 0);
  assert.equal(state.requests, 0);
});

test('no more than 24 frames are held behind a missing one', () => {
  const { feed, reassembler, state } = setup();
  feed(split(1, frame(true, 500)));
  for (let id = 3; id <= 27; id++) feed(split(id, frame(false, 500)));
  assert.equal(state.requests, 1, 'the 25th held frame ends the wait');
  assert.equal(reassembler.metrics().abandoned, 1);
  assert.ok(reassembler.pending <= 24);
});

test('fragments of a delivered or abandoned frame are dropped', () => {
  const { feed, reassembler } = setup(), fragments = split(1, frame(true, MAX_PAYLOAD + 900));
  feed(fragments);
  assert.equal(feed(fragments).length, 0);
  assert.equal(reassembler.metrics().delivered, 1);
  assert.equal(reassembler.pending, 0);
});

test('keyframe requests are limited to one a second, so a lost keyframe cannot start a storm', () => {
  const { feed, state } = setup();
  feed(split(1, frame(true, 500)));
  feed(split(3, frame(false, 500)));
  state.time = 301; feed(split(4, frame(false, 500)));
  assert.equal(state.requests, 1);
  state.time = 1300; feed(split(5, frame(false, 500)));
  assert.equal(state.requests, 1);
  state.time = 1301; feed(split(6, frame(false, 500)));
  assert.equal(state.requests, 2);
});
test('the first frame on a channel must be a keyframe', () => {
  const { feed, state } = setup();
  assert.deepEqual(feed(split(1, frame(false, 500))), []);
  assert.equal(state.requests, 1);
  assert.equal(feed(split(2, frame(true, 500))).length, 1);
});

test('malformed and oversized fragments are ignored', () => {
  const { reassembler } = setup();
  const header = (frameId, index, count, payload = 10) => {
    const fragment = new Uint8Array(HEADER_SIZE + payload), view = new DataView(fragment.buffer);
    view.setUint32(0, frameId, true); view.setUint16(4, index, true); view.setUint16(6, count, true);
    return fragment;
  };
  assert.equal(reassembler.push(new Uint8Array(4)).length, 0, 'shorter than a header');
  assert.equal(reassembler.push(header(1, 0, 0)).length, 0, 'no fragments');
  assert.equal(reassembler.push(header(1, 2, 2)).length, 0, 'index past the count');
  assert.equal(reassembler.push(header(1, 0, Math.ceil(2 * 1024 * 1024 / MAX_PAYLOAD) + 1)).length, 0, 'more than 2 MiB of fragments');
  assert.equal(reassembler.push(header(1, 0, 2, MAX_PAYLOAD + 1)).length, 0, 'payload above the fragment limit');
  assert.equal(reassembler.pending, 0);
  const [first] = [header(2, 0, 2)];
  reassembler.push(first);
  assert.equal(reassembler.push(header(2, 1, 3)).length, 0, 'count changed mid-frame');
  assert.equal(reassembler.pending, 1);
});

test('an ArrayBuffer is accepted as it comes from a data channel', () => {
  const { reassembler } = setup(), data = frame(true, 100);
  const [fragment] = split(1, data);
  sameFrames(reassembler.push(fragment.buffer), [data]);
});

test('after a fallback, channel frames up to the named one are ignored and the next must be a keyframe', () => {
  const { feed, reassembler, state } = setup();
  feed(split(1, frame(true, 500)));
  const [late] = split(3, frame(false, MAX_PAYLOAD + 900));
  feed([late]);
  reassembler.skipThrough(5);
  assert.equal(reassembler.pending, 0);
  assert.equal(feed(split(4, frame(true, 500))).length, 0, 'sent before the fallback, arrived after it');
  assert.equal(feed(split(6, frame(false, 500))).length, 0, 'a delta cannot start the channel again');
  sameFrames(feed(split(7, frame(true, 500))), [frame(true, 500)]);
  assert.equal(reassembler.metrics().abandoned, 0, 'frames set aside by a fallback are not losses');
  assert.equal(state.requests, 1);
});
