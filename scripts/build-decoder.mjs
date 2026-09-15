import { readFile, writeFile } from 'node:fs/promises';

const files = ['buffer', 'ts', 'decoder', 'mpeg1', 'mpeg1-wasm', 'canvas2d', 'wasm-module'];
const sources = await Promise.all(files.map(name => readFile(`third_party/jsmpeg/${name}.js`, 'utf8')));
const namespace = `/*! JSMpeg | (c) Dominic Szablewski | MIT; see JSMpeg-LICENSE */
var JSMpeg = {
  Decoder: {}, Renderer: {}, Demuxer: {}, Source: {},
  Now: function() { return performance.now() / 1000; },
  Fill: function(array, value) { array.fill(value); }
};\n`;
await writeFile('web/vendor/jsmpeg-software.js', namespace + sources.join('\n'));
