import { createDecoder } from './decoder.js';

export async function startStream(canvas, url, report) {
  const decoder = canvas ? await createDecoder(canvas, report) : null;
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
  const fail = message => { report({ type: 'error', message }); close(); };
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    if (socket.bufferedAmount > 65536) fail('Input connection is falling behind. Reconnecting…');
    if (performance.now() - lastVideo > 30000) fail('No stream response for 30 seconds. Reconnecting…');
  }, 2000);
  socket.onopen = () => report({ type: 'connected', inputOnly: !canvas });
  socket.onmessage = event => {
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') { lastVideo = performance.now(); return; }
        report(message);
        if (message.type === 'error') close();
      } else {
        const bytes = new Uint8Array(event.data);
        if (bytes.length >= 12 && bytes[0] === 80 && bytes[1] === 67 && bytes[2] === 77 && bytes[3] === 49)
          report({ type: 'audio', bytes: event.data });
        else {
          lastVideo = performance.now();
          decoder?.write(event.data);
        }
      }
    } catch (error) { fail(error.message); }
  };
  socket.onerror = () => fail('Stream connection failed. The ticket may have expired or another viewer is connected.');
  socket.onclose = () => { if (!stopped) report({ type: 'closed', message: 'Stream disconnected.' }); close(); };
  return {
    input(message) { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 65536) socket.send(JSON.stringify(message)); },
    close
  };
}
