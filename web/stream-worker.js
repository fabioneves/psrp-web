importScripts('/vendor/jsmpeg-software.js');
let stream;
let audioPort;
let audioEnabled = false;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'start') {
      audioPort = data.audioPort;
      audioEnabled = data.audioEnabled;
      const { startStream } = await import('./stream-runtime.js');
      stream = await startStream(data.canvas, data.url, message => {
        if ((message.type === 'audio' || message.type === 'sync') && !audioEnabled) return;
        if (message.type === 'sync' && audioPort) { audioPort.postMessage(message); return; }
        if (message.type === 'audio' && audioPort) audioPort.postMessage(message, [message.bytes]);
        else if (message.type === 'audio') postMessage(message, [message.bytes]);
        else postMessage(message);
      }, data.videoCodec, data.hardwareAcceleration);
      postMessage({ type: 'ready' });
    } else if (data.type === 'audio-enabled') {
      audioEnabled = data.enabled;
    } else if (data.type === 'audio-fallback') {
      audioPort?.close(); audioPort = null;
    } else if (data.type === 'stop') {
      stream?.close();
      self.close();
    } else stream?.input(data);
  } catch (error) {
    postMessage({ type: 'renderer-error', message: error.message });
    stream?.close();
  }
};
