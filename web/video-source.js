import { createReassembler } from './frame-reassembler.js';

// Picks which transport's frames reach the decoder. The server sends each frame on exactly one transport and only
// changes at a keyframe, so a frame that arrives whole on the data channel is newer than anything still coming over
// the WebSocket; only the server's fallback announcement hands video back.
export function createVideoSource({ isKey, requestKeyframe, deliver, now }) {
  const reassembler = createReassembler({ isKey, requestKeyframe, ...(now ? { now } : {}) });
  let transport = 'websocket';
  return {
    get transport() { return transport; },
    fromSocket(buffer) { if (transport === 'websocket') deliver(buffer, transport); },
    fromChannel(message) {
      for (const frame of reassembler.push(message)) {
        transport = 'webrtc';
        deliver(frame.buffer, transport);
      }
    },
    announce(message) {
      if (message.transport !== 'websocket') return;
      transport = 'websocket';
      if (Number.isInteger(message.frame)) reassembler.skipThrough(message.frame);
    },
    metrics: () => ({ transport, ...reassembler.metrics() })
  };
}
