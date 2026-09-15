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
  const latest = new LatestFrame();
  let pixels, image, decoded = 0, drawn = 0, totalFrames = 0, decodeMs = 0, colorMs = 0, drawMs = 0, bytesReceived = 0;
  let start = performance.now(), pendingPlanes, presentation, stopped = false, savedAt = 0, queueMs = 0, mediaTimestamp = null;
  const timestamps = [];
  const schedule = globalThis.requestAnimationFrame?.bind(globalThis) || (callback => setTimeout(callback, 1000 / 60));
  const cancel = globalThis.cancelAnimationFrame?.bind(globalThis) || clearTimeout;
  decoder.connect({
    resize(width, height) {
      latest.resize(width, height); pixels = makePixels(width, height);
      canvas.width = width; canvas.height = height;
      image = new ImageData(pixels.rgba, width, height);
    },
    render(y, cr, cb) { pendingPlanes = [y, cr, cb, timestamps.shift() ?? null]; }
  });
  demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, { write(pts, buffers) {
    timestamps.push(mediaTimestamp);
    if (timestamps.length > 120) throw new Error('Video timestamps exceeded the queue limit.');
    decoder.write(pts, buffers);
  } });
  const present = () => {
    presentation = null;
    if (stopped) return;
    const frame = latest.take();
    if (!frame) return;
    queueMs = performance.now() - savedAt;
    let before = performance.now(); pixels.convert(frame.y, frame.cr, frame.cb); colorMs += performance.now() - before;
    before = performance.now(); context.putImageData(image, 0, 0); drawMs += performance.now() - before;
    drawn++; totalFrames++;
    options.onPresent?.(frame.timestamp);
  };
  const timer = setInterval(() => {
    const elapsed = performance.now() - start;
    report({ type: 'stats', fps: drawn * 1000 / elapsed, decodedFps: decoded * 1000 / elapsed,
      decodeMs: drawn ? (decodeMs + colorMs + drawMs) / drawn : 0,
      codecMs: decoded ? decodeMs / decoded : 0, colorMs: drawn ? colorMs / drawn : 0,
      drawMs: drawn ? drawMs / drawn : 0, queueMs, droppedFrames: latest.dropped,
      pixelEngine: pixels?.engine, mbps: bytesReceived * 8 / elapsed / 1000,
      totalFrames, width: latest.width, height: latest.height, engine });
    decoded = 0; drawn = 0; decodeMs = 0; colorMs = 0; drawMs = 0; bytesReceived = 0; start = performance.now();
  }, 1000);
  return {
    write(data, timestamp) {
      mediaTimestamp = timestamp;
      bytesReceived += data.byteLength;
      demuxer.write(data);
      const before = performance.now();
      let count = 0; pendingPlanes = null;
      while (decoder.decode()) {
        count++;
        if (performance.now() - before > 250) throw new Error('Software decoding cannot keep up. Select a lower profile.');
      }
      if (pendingPlanes) {
        latest.dropped += Math.max(0, count - 1);
        latest.save(...pendingPlanes); savedAt = performance.now();
        if (presentation == null) presentation = schedule(present);
      }
      decoded += count; decodeMs += performance.now() - before;
    },
    destroy() { stopped = true; clearInterval(timer); cancel(presentation); decoder.destroy?.(); }
  };
}
