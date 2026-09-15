import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { wasmPixels } from '../web/pixels.js';
const context = { JSMpeg: { Renderer: {} } };
vm.runInNewContext(readFileSync('third_party/jsmpeg/canvas2d.js', 'utf8'), context);
const reference = context.JSMpeg.Renderer.Canvas2D.prototype.YCbCrToRGBA;
const { instance } = await WebAssembly.instantiate(readFileSync('web/vendor/pixels.wasm'));
for (const [width, height] of [[18, 18], [640, 360], [1920, 1080]]) {
  test(`WASM color conversion matches JavaScript byte-for-byte at ${width}x${height}`, () => {
    const size = ((width + 15) & ~15) * ((height + 15) & ~15);
    const y = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 256);
    const cr = Uint8Array.from({ length: size / 4 }, (_, i) => (i * 71) % 256);
    const cb = Uint8Array.from({ length: size / 4 }, (_, i) => (i * 97) % 256);
    const expected = new Uint8ClampedArray(width * height * 4); expected.fill(255);
    reference.call({ width, height, enabled: true }, y, cr, cb, expected);
    const pixels = wasmPixels(instance, width, height); pixels.convert(y, cr, cb);
    assert.deepEqual(pixels.rgba, expected);
  });
}
