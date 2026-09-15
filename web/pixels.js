export async function createPixelFactory(forceJs = false) {
  if (!forceJs && typeof WebAssembly === 'object') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/vendor/pixels.wasm', { signal: controller.signal });
      if (!response.ok) throw new Error('Pixel converter unavailable');
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      return (width, height) => wasmPixels(instance, width, height);
    } catch {}
    finally { clearTimeout(timeout); }
  }
  return (width, height) => {
    const rgba = new Uint8ClampedArray(width * height * 4); rgba.fill(255);
    return { rgba, engine: 'JavaScript', convert(y, cr, cb) {
      JSMpeg.Renderer.Canvas2D.prototype.YCbCrToRGBA.call({ width, height, enabled: true }, y, cr, cb, rgba);
    } };
  };
}

export function wasmPixels(instance, width, height) {
  const stride = (width + 15) & ~15, size = stride * ((height + 15) & ~15);
  const base = 1024 * 1024, cr = base + size, cb = cr + size / 4, out = cb + size / 4;
  const heap = new Uint8Array(instance.exports.memory.buffer);
  const rgba = new Uint8ClampedArray(heap.buffer, out, width * height * 4);
  return { rgba, engine: 'WASM SIMD', convert(y, red, blue) {
    heap.set(y, base); heap.set(red, cr); heap.set(blue, cb);
    instance.exports.convert(base, cr, cb, out, width, height, stride);
  } };
}
