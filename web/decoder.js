export async function createDecoder(canvas, report) {
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true, willReadFrequently: true });
  if (!context) throw new Error('This browser does not support a 2D canvas.');
  const options = { canvas, streaming: true, decodeFirstFrame: false, videoBufferSize: 2 * 1024 * 1024 };
  let engine = 'JavaScript';
  if (typeof WebAssembly === 'object') {
    const response = await fetch('/vendor/jsmpeg.wasm');
    if (!response.ok) throw new Error('The software decoder could not be downloaded.');
    const bytes = await response.arrayBuffer();
    if (!WebAssembly.validate(bytes)) throw new Error('The software decoder download is invalid.');
    const wasm = new JSMpeg.WASMModule();
    await Promise.race([
      new Promise((resolve, reject) => wasm.loadFromBuffer(bytes, result => result ? resolve() : reject(new Error('Decoder initialization failed.')))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Software decoder initialization timed out.')), 10000))
    ]);
    options.wasmModule = wasm;
    engine = 'WebAssembly';
  }
  const renderer = new JSMpeg.Renderer.Canvas2D(options);
  const decoder = options.wasmModule ? new JSMpeg.Decoder.MPEG1VideoWASM(options) : new JSMpeg.Decoder.MPEG1Video(options);
  const demuxer = new JSMpeg.Demuxer.TS(options);
  decoder.connect(renderer);
  demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, decoder);
  let frames = 0, decodeMs = 0, totalFrames = 0, bytesReceived = 0;
  let start = performance.now();
  const timer = setInterval(() => {
    const elapsed = performance.now() - start;
    report({ type: 'stats', fps: frames * 1000 / elapsed, decodeMs: frames ? decodeMs / frames : 0,
      mbps: bytesReceived * 8 / elapsed / 1000, totalFrames, width: renderer.width, height: renderer.height, engine });
    frames = 0; decodeMs = 0; bytesReceived = 0; start = performance.now();
  }, 1000);
  return {
    write(data) {
      bytesReceived += data.byteLength;
      demuxer.write(data);
      const started = performance.now();
      let count = 0;
      while (decoder.decode()) {
        count++;
        if (performance.now() - started > 250) throw new Error('Software decoding cannot keep up. Try a lower bitrate.');
      }
      frames += count;
      totalFrames += count;
      decodeMs += performance.now() - started;
    },
    destroy() { clearInterval(timer); decoder.destroy?.(); renderer.destroy(); }
  };
}
