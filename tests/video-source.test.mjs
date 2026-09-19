import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVideoSource } from '../web/video-source.js';
import { HEADER_SIZE } from '../web/frame-reassembler.js';

// One-message frames: first payload byte 1 = keyframe, 0 = delta, second byte names the frame.
function message(frameId, key, name) {
  const bytes = new Uint8Array(HEADER_SIZE + 2), view = new DataView(bytes.buffer);
  view.setUint32(0, frameId, true); view.setUint16(4, 0, true); view.setUint16(6, 1, true);
  bytes[HEADER_SIZE] = key ? 1 : 0; bytes[HEADER_SIZE + 1] = name;
  return bytes.buffer;
}
const socketFrame = name => Uint8Array.of(0, name).buffer;
function setup() {
  const delivered = [], state = { requests: 0 };
  const source = createVideoSource({ frameIntervalMs: 1000 / 60, isKey: data => data[0] === 1, requestKeyframe: () => state.requests++,
    deliver: (buffer, transport) => delivered.push(`${transport}:${new Uint8Array(buffer)[1]}`), now: () => 0 });
  return { source, delivered, state };
}

test('video comes from the WebSocket until a frame arrives whole on the data channel', () => {
  const { source, delivered } = setup();
  source.fromSocket(socketFrame(1));
  source.fromChannel(message(1, true, 2));
  assert.equal(source.transport, 'webrtc');
  source.fromSocket(socketFrame(3));
  source.fromChannel(message(2, false, 4));
  assert.deepEqual(delivered, ['websocket:1', 'webrtc:2', 'webrtc:4'], 'a WebSocket frame still in flight at the switch is older than the channel keyframe and is dropped');
});

test('the channel keyframe may overtake the announcement; the announcement alone changes nothing', () => {
  const { source, delivered } = setup();
  source.announce({ transport: 'webrtc', frame: 1 });
  assert.equal(source.transport, 'websocket');
  source.fromSocket(socketFrame(1));
  assert.deepEqual(delivered, ['websocket:1']);
});

test('a fallback announcement returns video to the WebSocket and sets aside channel frames sent before it', () => {
  const { source, delivered } = setup();
  source.fromChannel(message(1, true, 1));
  source.announce({ transport: 'websocket', frame: 2 });
  assert.equal(source.transport, 'websocket');
  source.fromChannel(message(2, false, 2));
  source.fromSocket(socketFrame(3));
  source.fromChannel(message(3, true, 4));
  assert.deepEqual(delivered, ['webrtc:1', 'websocket:3', 'webrtc:4'], 'frame 2 was sent before the fallback; frame 3 opens the channel again');
  assert.equal(source.transport, 'webrtc');
});

test('metrics name the transport in use and carry the reassembler counts', () => {
  const { source } = setup();
  source.fromChannel(message(1, true, 1));
  source.fromChannel(message(3, false, 2));
  assert.deepEqual(source.metrics(), { transport: 'webrtc', fragments: 2, delivered: 1, abandoned: 1, discarded: 1, keyframeRequests: 1 });
});
