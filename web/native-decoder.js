import { FramePresenter } from './frame-presenter.js';

export const nativeConfig = codec => ({ codec, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });

export async function supportsNativeVideo(profile, platform = globalThis) {
  if (typeof platform.VideoDecoder?.isConfigSupported !== 'function') return false;
  const sizes = { '360p': [640, 360], '540p': [960, 540], '720p': [1280, 720], '1080p': [1920, 1080] };
  const [codedWidth, codedHeight] = sizes[profile.resolution];
  let timer;
  try {
    const result = await Promise.race([
      platform.VideoDecoder.isConfigSupported({ ...nativeConfig('avc1.64002a'), codedWidth, codedHeight }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ supported: false }), 2000); })
    ]);
    return result.supported;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export function h264Info(data) {
  let codec, key = false, picture = false;
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
    const type = data[i + 3] & 31;
    if (type === 5) key = true;
    if (type === 1 || type === 5) picture = true;
    if (type === 7 && i + 6 < data.length)
      codec = 'avc1.' + [...data.subarray(i + 4, i + 7)].map(value => value.toString(16).padStart(2, '0')).join('');
    i += 3;
  }
  return { codec, key, picture };
}

export class NativeDecodeQueue {
  constructor(decoder, submit, onError) {
    this.decoder = decoder; this.submit = submit; this.items = []; this.stopped = false;
    decoder.ondequeue = () => { try { this.drain(); } catch (error) { onError(error.message); } };
  }
  push(item) {
    if (this.stopped) return;
    if (this.items.length >= 30) throw new Error('Native video decoding is falling behind.');
    this.items.push(item);
    this.drain();
  }
  drain() {
    while (!this.stopped && this.items.length && this.decoder.decodeQueueSize < 4)
      this.submit(this.items.shift());
  }
  destroy() { this.stopped = true; this.items.length = 0; this.decoder.ondequeue = null; }
}

export function createNativeDecoder(canvas, report, options = {}) {
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) throw new Error('This browser does not support video drawing.');
  const pending = new Map();
  let stopped = false, latest = null, configuration, mediaTimestamp, savedAt = 0, progressAt = null;
  let decoded = 0, drawn = 0, dropped = 0, totalFrames = 0, bytesReceived = 0, decodeMs = 0, drawMs = 0, queueMs = 0;
  let start = performance.now();
  const presentation = new FramePresenter(() => {
    const frame = latest; latest = null;
    if (!frame) return;
    try {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
      }
      queueMs = performance.now() - savedAt;
      const before = performance.now();
      context.drawImage(frame, 0, 0);
      drawMs += performance.now() - before;
      drawn++; totalFrames++;
      options.onPresent?.(latestTimestamp);
    } catch (error) { options.onError?.(error.message); }
    finally { frame.close(); }
  });
  let latestTimestamp = null;
  const decoder = new VideoDecoder({
    output(frame) {
      if (stopped) { frame.close(); return; }
      const timing = pending.get(frame.timestamp);
      for (const timestamp of pending.keys()) if (timestamp <= frame.timestamp) pending.delete(timestamp);
      progressAt = pending.size ? performance.now() : null;
      if (timing) decodeMs += performance.now() - timing.started;
      decoded++;
      if (latest) { latest.close(); dropped++; }
      latest = frame; latestTimestamp = timing?.mediaTimestamp ?? null; savedAt = performance.now();
      presentation.request();
    },
    error(error) { if (!stopped) options.onError?.(error.message); }
  });
  const queue = new NativeDecodeQueue(decoder, ({ timestamp, mediaTimestamp, data, key }) => {
    progressAt ??= performance.now();
    if (pending.size >= 30) pending.delete(pending.keys().next().value);
    pending.set(timestamp, { started: performance.now(), mediaTimestamp });
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
  }, message => options.onError?.(message));
  const demuxer = new JSMpeg.Demuxer.TS({});
  demuxer.guessVideoFrameEnd = false;
  demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, { write(pts, buffers) {
    const size = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    if (size > 2 * 1024 * 1024) throw new Error('H.264 frame exceeds its size limit.');
    const data = new Uint8Array(size);
    let offset = 0;
    for (const buffer of buffers) { data.set(buffer, offset); offset += buffer.length; }
    const info = h264Info(data);
    if (info.codec && info.codec !== configuration) {
      decoder.configure(nativeConfig(info.codec));
      configuration = info.codec;
    }
    if (!configuration || !info.picture) return;
    queue.push({ timestamp: Math.round(pts * 1000000), mediaTimestamp, data, key: info.key });
  } });
  const timer = setInterval(() => {
    if (progressAt !== null && performance.now() - progressAt > 3000) {
      options.onError?.('Native video decoder stopped producing frames.');
      return;
    }
    const elapsed = performance.now() - start;
    report({ type: 'stats', fps: drawn * 1000 / elapsed, decodedFps: decoded * 1000 / elapsed,
      decodeMs: drawn ? (decodeMs + drawMs) / drawn : 0, codecMs: 0, nativeDecodeMs: decoded ? decodeMs / decoded : 0,
      colorMs: 0, drawMs: drawn ? drawMs / drawn : 0, queueMs, droppedFrames: dropped,
      pixelEngine: 'Browser', mbps: bytesReceived * 8 / elapsed / 1000, totalFrames,
      width: canvas.width, height: canvas.height, engine: 'H.264 · hardware preferred' });
    decoded = drawn = bytesReceived = decodeMs = drawMs = 0; start = performance.now();
  }, 1000);
  return {
    write(data, timestamp) {
      if (stopped) return;
      mediaTimestamp = timestamp;
      bytesReceived += data.byteLength;
      demuxer.write(data);
    },
    destroy() {
      stopped = true; clearInterval(timer); presentation.destroy(); queue.destroy();
      latest?.close(); latest = null; pending.clear();
      if (decoder.state !== 'closed') decoder.close();
    }
  };
}
