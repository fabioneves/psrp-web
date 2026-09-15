import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { wasmPixels } from '../web/pixels.js';
const context = { JSMpeg: { Renderer: {} } };
vm.runInNewContext(readFileSync('third_party/jsmpeg/canvas2d.js', 'utf8'), context);
const { instance } = await WebAssembly.instantiate(readFileSync('web/vendor/pixels.wasm'));
const results = [];
for (const [width, height] of [[1280, 720], [1920, 1080]]) {
  const size = ((width + 15) & ~15) * ((height + 15) & ~15);
  const y = Uint8Array.from({ length: size }, (_, i) => i % 256);
  const cr = new Uint8Array(size / 4).fill(200), cb = new Uint8Array(size / 4).fill(50);
  const rgba = new Uint8ClampedArray(width * height * 4); rgba.fill(255);
  const pixels = wasmPixels(instance, width, height);
  for (const [engine, convert] of [
    ['JavaScript', () => context.JSMpeg.Renderer.Canvas2D.prototype.YCbCrToRGBA.call({ width, height, enabled: true }, y, cr, cb, rgba)],
    ['WebAssembly including plane copies', () => pixels.convert(y, cr, cb)]
  ]) {
    for (let i = 0; i < 30; i++) convert();
    const times = [];
    for (let i = 0; i < 120; i++) { const start = performance.now(); convert(); times.push(performance.now() - start); }
    times.sort((a, b) => a - b);
    results.push({ width, height, engine, medianMs: times[60], p95Ms: times[114] });
  }
}
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
