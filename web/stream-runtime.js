import { createNativeDecoder } from './native-decoder.js';
import { createDecoder } from './decoder.js';
import { now, StreamClock, unpackMedia } from './timing.js';

export async function startStream(canvas, url, report, videoCodec = 'mpeg1') {
  const clock = new StreamClock();
  let videoAgeMs = null, transportMs = null, serverQueueMs = 0;
  const decoder = canvas ? await (videoCodec === 'h264' ? createNativeDecoder : createDecoder)(canvas, message => {
    report({ ...message, videoAgeMs, transportMs, serverQueueMs, rttMs: clock.rttMs });
    serverQueueMs = 0;
  }, {
    onError(message) { fail(message, 'renderer-error'); },
    onPresent(timestamp) {
      videoAgeMs = clock.age(timestamp);
      report({ type: 'sync', timestamp });
    }
  }) : null;
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let stopped = false;
  let lastVideo = performance.now();
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    decoder?.destroy();
    socket.close();
  };
  const fail = (message, type = 'error') => { report({ type, message }); close(); };
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', clientTime: now() }));
    if (socket.bufferedAmount > 65536) fail('Input connection is falling behind. Reconnecting…');
    if (performance.now() - lastVideo > 30000) fail('No stream response for 30 seconds. Reconnecting…');
  }, 2000);
  socket.onopen = () => { socket.send(JSON.stringify({ type: 'ping', clientTime: now() })); report({ type: 'connected', inputOnly: !canvas }); };
  socket.onmessage = event => {
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') { clock.sample(message); if (!canvas) lastVideo = performance.now(); return; }
        if (message.type === 'status') lastVideo = performance.now();
        report(message);
        if (message.type === 'error') close();
      } else {
        const media = unpackMedia(event.data);
        if (media.kind === 1) transportMs = clock.age(media.sent);
        serverQueueMs = Math.max(serverQueueMs, media.sent - media.ready);
        if (media.kind === 2)
          report({ type: 'audio', bytes: media.bytes, timestamp: media.timestamp });
        else {
          lastVideo = performance.now();
          decoder?.write(media.bytes, media.timestamp);
        }
      }
    } catch (error) { fail(error.message, videoCodec === 'h264' ? 'renderer-error' : 'error'); }
  };
  socket.onerror = () => fail('Stream connection failed. The ticket may have expired or another viewer is connected.');
  socket.onclose = () => { if (!stopped) report({ type: 'closed', message: 'Stream disconnected.' }); close(); };
  return {
    input(message) { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 65536) socket.send(JSON.stringify(message)); },
    close
  };
}
