import { createNativeDecoder } from './native-decoder.js';
import { createDecoder } from './decoder.js';
import { now, StreamClock, unpackMedia } from './timing.js';

export async function startStream(canvas, url, report, videoCodec = 'mpeg1', hardwareAcceleration = 'prefer-hardware', presentation = {}) {
  const clock = new StreamClock();
  let videoAgeMs = null, transportMs = null, serverQueueMs = 0;
  const decoder = canvas ? await (videoCodec !== 'mpeg1' ? createNativeDecoder : createDecoder)(canvas, message => {
    report({ ...message, videoAgeMs, transportMs, serverQueueMs, rttMs: clock.rttMs });
    serverQueueMs = 0;
  }, {
    ...presentation, videoCodec, hardwareAcceleration,
    onError(message) { fail(message, failureType()); },
    onPresent(timestamp) {
      videoAgeMs = clock.age(timestamp);
      report({ type: 'sync', timestamp });
    }
  }) : null;
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let stopped = false;
  let lastVideo = performance.now();
  const failureType = () => videoCodec !== 'mpeg1' && !decoder?.healthy ? 'renderer-error' : 'error';
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    decoder?.destroy();
    socket.close();
  };
  const fail = (message, type = 'error') => { if (!stopped) { close(); report({ type, message }); } };
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', clientTime: now() }));
    if (socket.bufferedAmount > 65536) fail('Input connection is falling behind. Reconnecting…');
    if (performance.now() - lastVideo > 30000) fail('No stream response for 30 seconds. Reconnecting…');
  }, 2000);
  socket.onopen = () => { if (!stopped) { socket.send(JSON.stringify({ type: 'ping', clientTime: now() })); report({ type: 'connected', inputOnly: !canvas }); } };
  socket.onmessage = event => {
    if (stopped) return;
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') { clock.sample(message); if (!canvas) lastVideo = performance.now(); return; }
        if (message.type === 'status') lastVideo = performance.now();
        report(message);
        if (message.type === 'error') close();
      } else {
        const media = unpackMedia(event.data);
        if (media.kind !== 2 && (media.kind === 3) !== (videoCodec !== 'mpeg1')) throw new Error('The server sent an unexpected video format. Reload the page.');
        if (media.kind !== 2) transportMs = clock.age(media.sent);
        serverQueueMs = Math.max(serverQueueMs, media.sent - media.ready);
        if (media.kind === 2)
          report({ type: 'audio', bytes: media.bytes, timestamp: media.timestamp });
        else {
          lastVideo = performance.now();
          decoder?.write(media.bytes, media.timestamp);
        }
      }
    } catch (error) { fail(error.message, failureType()); }
  };
  socket.onerror = () => fail('Could not open the streaming connection. Check your connection to the server.');
  socket.onclose = event => {
    if (!stopped) report(event.reason === 'Disconnected by user'
      ? { type: 'stopped', message: 'All sessions for this console were disconnected.' }
      : { type: 'closed', message: 'Stream disconnected.' });
    close();
  };
  return {
    input(message) { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 65536) socket.send(JSON.stringify(message)); },
    close
  };
}
