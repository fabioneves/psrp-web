import { FrameQueue } from './frame-queue.js';
import { FramePresenter } from './frame-presenter.js';
import { LatestFrame } from './latest-frame.js';
import { createPixelFactory } from './pixels.js';

export async function createDecoder(canvas, report, options = {}) {
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true, willReadFrequently: true });
  if (!context) throw new Error('This browser does not support a 2D canvas.');
  const makePixels = await createPixelFactory(options.pixelJs);
  const settings = { canvas, streaming: true, decodeFirstFrame: false, videoBufferSize: 2 * 1024 * 1024 };
  let engine = 'JavaScript';
  if (typeof WebAssembly === 'object') {
    const response = await fetch('/vendor/jsmpeg.wasm');
    if (!response.ok) throw new Error('The software decoder could not be downloaded.');
    const bytes = await response.arrayBuffer();
    if (!WebAssembly.validate(bytes)) throw new Error('The software decoder download is invalid.');
    const wasm = new JSMpeg.WASMModule();
    let timeout;
    try {
      await Promise.race([
        new Promise((resolve, reject) => wasm.loadFromBuffer(bytes, result => result ? resolve() : reject(new Error('Decoder initialization failed.')))),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Software decoder initialization timed out.')), 10000); })
      ]);
    } finally { clearTimeout(timeout); }
    settings.wasmModule = wasm; engine = 'WebAssembly';
  }
  const decoder = settings.wasmModule ? new JSMpeg.Decoder.MPEG1VideoWASM(settings) : new JSMpeg.Decoder.MPEG1Video(settings);
  const demuxer = new JSMpeg.Demuxer.TS(settings);
  const dimensions = { width: canvas.width, height: canvas.height };
  const pool = [];
  const frames = new FrameQueue(frame => pool.push(frame), options.fps, options.pacing !== 'responsive');
  let pixels, image, decoded = 0, drawn = 0, totalFrames = 0, decodeMs = 0, colorMs = 0, drawMs = 0, bytesReceived = 0;
  let start = performance.now(), stopped = false, queueMs = 0, mediaTimestamp = null;
  const timestamps = [];
  decoder.connect({
    resize(width, height) {
      dimensions.width = width; dimensions.height = height; pixels = makePixels(width, height);
      frames.destroy(); pool.length = 0;
      for (let i = 0; i < 4; i++) { const frame = new LatestFrame(); frame.resize(width, height); pool.push(frame); }
      canvas.width = width; canvas.height = height;
      image = new ImageData(pixels.rgba, width, height);
    },
    render(y, cr, cb) {
      const frame = pool.pop();
      frame.save(y, cr, cb, timestamps.shift() ?? null);
      frame.savedAt = performance.now();
      frames.push(frame);
    }
  });
  demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, { write(pts, buffers) {
    timestamps.push(mediaTimestamp);
    if (timestamps.length > 120) throw new Error('Video timestamps exceeded the queue limit.');
    decoder.write(pts, buffers);
  } });
  const present = () => {
    if (stopped) return;
    const frame = frames.take(performance.now());
    if (!frame) return frames.pending ? 'waiting' : false;
    queueMs = performance.now() - frame.savedAt;
    let before = performance.now(); pixels.convert(frame.y, frame.cr, frame.cb); colorMs += performance.now() - before;
    before = performance.now(); context.putImageData(image, 0, 0); drawMs += performance.now() - before;
    drawn++; totalFrames++;
    options.onPresent?.(frame.timestamp);
    frame.take(); pool.push(frame);
    return frames.pending;
  };
  const presentation = new FramePresenter(present, globalThis, 1000 / (options.fps || 60));
  const timer = setInterval(() => {
    const elapsed = performance.now() - start;
    report({ type: 'stats', ...presentation.metrics(), fps: drawn * 1000 / elapsed, decodedFps: decoded * 1000 / elapsed,
      decodeMs: drawn ? (decodeMs + colorMs + drawMs) / drawn : 0,
      codecMs: decoded ? decodeMs / decoded : 0, colorMs: drawn ? colorMs / drawn : 0,
      drawMs: drawn ? drawMs / drawn : 0, queueMs, droppedFrames: frames.dropped,
      pixelEngine: pixels?.engine, mbps: bytesReceived * 8 / elapsed / 1000,
      totalFrames, width: dimensions.width, height: dimensions.height, engine });
    decoded = 0; drawn = 0; decodeMs = 0; colorMs = 0; drawMs = 0; bytesReceived = 0; start = performance.now();
  }, 1000);
  return {
    write(data, timestamp) {
      mediaTimestamp = timestamp;
      bytesReceived += data.byteLength;
      demuxer.write(data);
      const before = performance.now();
      let count = 0;
      while (decoder.decode()) {
        count++;
        if (performance.now() - before > 250) throw new Error('Software decoding cannot keep up. Select a lower profile.');
      }
      if (frames.pending) presentation.request();
      decoded += count; decodeMs += performance.now() - before;
    },
    destroy() { stopped = true; clearInterval(timer); presentation.destroy(); frames.destroy(); decoder.destroy?.(); }
  };
}
