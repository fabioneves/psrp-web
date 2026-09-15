import { createDecoder } from './decoder.js';

export async function startStream(canvas, url, report) {
  const decoder = await createDecoder(canvas, report);
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let stopped = false;
  let lastVideo = performance.now();
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    decoder.destroy();
    socket.close();
  };
  const fail = message => { report({ type: 'error', message }); close(); };
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    if (performance.now() - lastVideo > 30000) fail('No video received for 30 seconds. Check the console and reconnect.');
  }, 2000);
  socket.onmessage = event => {
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        report(message);
        if (message.type === 'error') close();
      } else {
        lastVideo = performance.now();
        decoder.write(event.data);
      }
    } catch (error) { fail(error.message); }
  };
  socket.onerror = () => fail('Stream connection failed. The ticket may have expired or another viewer is connected.');
  socket.onclose = () => { if (!stopped) report({ type: 'closed', message: 'Stream disconnected.' }); close(); };
  return {
    input(message) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); },
    close
  };
}
