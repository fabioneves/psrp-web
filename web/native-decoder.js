import { FrameQueue } from './frame-queue.js';
import { FramePresenter } from './frame-presenter.js';

export const nativeConfig = codec => ({ codec, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });

export async function nativeVideoConfig(profile, platform = globalThis, videoCodec = 'h264') {
  if (typeof platform.VideoDecoder?.isConfigSupported !== 'function') return null;
  const sizes = { '360p': [640, 360], '540p': [960, 540], '720p': [1280, 720], '1080p': [1920, 1080] };
  const [codedWidth, codedHeight] = sizes[profile.resolution];
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    let timer;
    const config = { ...nativeConfig(videoCodec === 'h265' ? 'hev1.1.6.L123.B0' : 'avc1.64002a'), codedWidth, codedHeight, hardwareAcceleration };
    try {
      const result = await Promise.race([
        platform.VideoDecoder.isConfigSupported(config),
        new Promise(resolve => { timer = setTimeout(() => resolve({ supported: false }), 2000); })
      ]);
      if (result.supported) return config;
    } catch {}
    finally { clearTimeout(timer); }
  }
  return null;
}

export async function supportsNativeVideo(profile, platform = globalThis, videoCodec = 'h264') {
  return !!await nativeVideoConfig(profile, platform, videoCodec);
}

export async function selectVideoCodec(preferred, profile, failed = new Set(), hostType = null, platform = globalThis) {
  const candidates = { mpeg1: ['mpeg1'], h264: ['h264', 'mpeg1'], h265: ['h265', 'h264', 'mpeg1'] }[preferred] || ['h264', 'mpeg1'];
  for (const codec of candidates) {
    if (codec === 'mpeg1') return codec;
    if (failed.has(codec) || (codec === 'h265' && hostType && hostType !== 'PS5')) continue;
    if (await supportsNativeVideo(profile, platform, codec)) return codec;
  }
  return 'mpeg1';
}

function annexBUnits(data) {
  const starts = [];
  for (let i = 0; i + 3 < data.length; i++)
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) { starts.push(i + 3); i += 2; }
  return starts.map((start, index) => {
    let end = index + 1 < starts.length ? starts[index + 1] - 3 : data.length;
    while (end > start && data[end - 1] === 0) end--;
    return data.subarray(start, end);
  });
}
const withStartCode = nal => Uint8Array.from([0, 0, 0, 1, ...nal]);

export function h264Info(data) {
  let codec, key = false, picture = false;
  const parameters = [];
  for (const nal of annexBUnits(data)) {
    if (!nal.length) continue;
    const type = nal[0] & 31;
    if (type === 5) key = true;
    if (type === 1 || type === 5) picture = true;
    if (type === 7 || type === 8) {
      if (nal.length > 65536) throw new Error('H.264 parameter set exceeds its size limit.');
      parameters.push({ type, data: withStartCode(nal) });
    }
    if (type === 7 && nal.length >= 4)
      codec = 'avc1.' + [...nal.subarray(1, 4)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  return { codec, key, picture, parameters };
}

export function h265Info(data) {
  let codec, key = false, picture = false;
  const parameters = [];
  for (const nal of annexBUnits(data)) {
    if (nal.length < 2) continue;
    const type = (nal[0] >> 1) & 63;
    if (type <= 31) picture = true;
    if (type >= 16 && type <= 21) key = true;
    if (type >= 32 && type <= 34) {
      if (nal.length > 65536) throw new Error('HEVC parameter set exceeds its size limit.');
      parameters.push({ type, data: withStartCode(nal) });
    }
    if (type !== 33) continue;
    const rbsp = nal.subarray(2).filter((byte, i, bytes) => !(i >= 2 && byte === 3 && bytes[i - 1] === 0 && bytes[i - 2] === 0));
    if (rbsp.length < 13) continue;
    const flags = new DataView(rbsp.buffer, rbsp.byteOffset).getUint32(2);
    let compatibility = 0;
    for (let bit = 0; bit < 32; bit++) compatibility = compatibility * 2 + ((flags >>> bit) & 1);
    const constraints = [...rbsp.subarray(6, 12)];
    while (constraints.length > 1 && constraints.at(-1) === 0) constraints.pop();
    codec = `hev1.${['', 'A', 'B', 'C'][rbsp[1] >> 6]}${rbsp[1] & 31}.${compatibility.toString(16).toUpperCase()}.${rbsp[1] & 32 ? 'H' : 'L'}${rbsp[12]}.${constraints.map(value => value.toString(16).toUpperCase().padStart(2, '0')).join('.')}`;
  }
  return { codec, key, picture, parameters };
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
  const hevc = options.videoCodec === 'h265';
  const label = hevc ? 'H.265' : 'H.264';
  const parameterTypes = hevc ? [32, 33, 34] : [7, 8];
  const hardwareAcceleration = options.hardwareAcceleration || 'prefer-hardware';
  const engine = `${label} · ${hardwareAcceleration === 'prefer-hardware' ? 'hardware preferred' : 'browser decoding'}`;
  const parameters = new Map();
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) throw new Error('This browser does not support video drawing.');
  const pending = new Map();
  let stopped = false, configuration, progressAt = null, waitingForKey = true, firstMedia = null, lastTimestamp = -1, everDecoded = false, lastInputAt = null;
  let decoded = 0, drawn = 0, totalFrames = 0, bytesReceived = 0, decodeMs = 0, drawMs = 0, queueMs = 0;
  let start = performance.now();
  const frames = new FrameQueue(item => item.frame.close(), options.fps, options.pacing !== 'responsive');
  const presentation = new FramePresenter(() => {
    const item = frames.take(performance.now());
    if (!item) return frames.pending ? 'waiting' : false;
    const { frame, timestamp, savedAt } = item;
    try {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
      }
      queueMs = performance.now() - savedAt;
      const before = performance.now();
      context.drawImage(frame, 0, 0);
      drawMs += performance.now() - before;
      drawn++; totalFrames++;
      options.onPresent?.(timestamp);
    } catch (error) { options.onError?.(error.message); }
    finally { frame.close(); }
    return frames.pending;
  });
  const decoder = new VideoDecoder({
    output(frame) {
      if (stopped) { frame.close(); return; }
      const timing = pending.get(frame.timestamp);
      for (const timestamp of pending.keys()) if (timestamp <= frame.timestamp) pending.delete(timestamp);
      progressAt = pending.size ? performance.now() : null;
      if (timing) decodeMs += performance.now() - timing.started;
      decoded++; everDecoded = true;
      frames.push({ frame, timestamp: timing?.mediaTimestamp ?? null, savedAt: performance.now() });
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
  function accessUnit(data, mediaTimestamp) {
    if (data.length > 2 * 1024 * 1024) throw new Error(`${label} frame exceeds its size limit.`);
    const info = hevc ? h265Info(data) : h264Info(data);
    for (const parameter of info.parameters) parameters.set(parameter.type, parameter.data);
    if (info.codec && info.codec !== configuration) {
      decoder.configure({ ...nativeConfig(info.codec), hardwareAcceleration });
      configuration = info.codec;
      waitingForKey = true;
    }
    if (!configuration || !info.picture || (waitingForKey && !info.key)) return;
    if (info.key) {
      if (parameters.size < parameterTypes.length) return;
      if (info.parameters.length < parameterTypes.length) {
        const headers = parameterTypes.map(type => parameters.get(type));
        const prefixed = new Uint8Array(headers.reduce((sum, header) => sum + header.length, data.length));
        let position = 0;
        for (const header of headers) { prefixed.set(header, position); position += header.length; }
        prefixed.set(data, position); data = prefixed;
      }
    }
    waitingForKey = false;
    firstMedia ??= mediaTimestamp;
    const timestamp = Math.max(lastTimestamp + 1, Math.round((mediaTimestamp - firstMedia) * 1000));
    lastTimestamp = timestamp;
    queue.push({ timestamp, mediaTimestamp, data, key: info.key });
  }
  const timer = setInterval(() => {
    if (progressAt !== null && performance.now() - progressAt > 3000 && lastInputAt !== null && performance.now() - lastInputAt < 1500) {
      options.onError?.('Video decoding stalled. Reconnecting…');
      return;
    }
    const elapsed = performance.now() - start;
    report({ type: 'stats', ...presentation.metrics(), fps: drawn * 1000 / elapsed, decodedFps: decoded * 1000 / elapsed,
      decodeMs: drawn ? (decodeMs + drawMs) / drawn : 0, codecMs: 0, nativeDecodeMs: decoded ? decodeMs / decoded : 0,
      colorMs: 0, drawMs: drawn ? drawMs / drawn : 0, queueMs, droppedFrames: frames.dropped, decodeQueue: queue.items.length + decoder.decodeQueueSize,
      pixelEngine: 'Browser', mbps: bytesReceived * 8 / elapsed / 1000, totalFrames,
      width: canvas.width, height: canvas.height, engine });
    decoded = drawn = bytesReceived = decodeMs = drawMs = 0; start = performance.now();
  }, 1000);
  return {
    get healthy() { return everDecoded; },
    write(data, timestamp) {
      if (stopped) return;
      bytesReceived += data.byteLength;
      lastInputAt = performance.now();
      accessUnit(new Uint8Array(data), timestamp);
    },
    destroy() {
      stopped = true; clearInterval(timer); presentation.destroy(); queue.destroy();
      frames.destroy(); pending.clear(); parameters.clear();
      if (decoder.state !== 'closed') decoder.close();
    }
  };
}
