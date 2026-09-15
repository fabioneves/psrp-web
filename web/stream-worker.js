importScripts('/vendor/jsmpeg-software.js');
let stream;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'start') {
      const { startStream } = await import('./stream-runtime.js');
      stream = await startStream(data.canvas, data.url, message => postMessage(message));
      postMessage({ type: 'ready' });
    } else if (data.type === 'stop') {
      stream?.close();
      self.close();
    } else stream?.input(data);
  } catch (error) {
    postMessage({ type: 'error', message: error.message });
    stream?.close();
  }
};
