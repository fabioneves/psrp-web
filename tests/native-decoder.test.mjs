import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h264Info, h265Info, supportsNativeVideo, nativeVideoConfig, selectVideoCodec, NativeDecodeQueue, createNativeDecoder } from '../web/native-decoder.js';

test('H.264 detects three/four byte Annex B start codes, SPS profile and IDR frames', () => {
  const info = h264Info(Uint8Array.from([0, 0, 0, 1, 103, 100, 0, 42, 0, 0, 1, 104, 5, 0, 0, 1, 101, 128]));
  assert.equal(info.codec, 'avc1.64002a'); assert.equal(info.key, true); assert.equal(info.picture, true);
  assert.deepEqual(info.parameters.map(parameter => [parameter.type, [...parameter.data]]), [[7, [0, 0, 0, 1, 103, 100, 0, 42]], [8, [0, 0, 0, 1, 104, 5]]]);
  assert.deepEqual(h264Info(Uint8Array.from([0, 0, 1, 65, 128])), { codec: undefined, key: false, picture: true, parameters: [] });
  assert.equal(h264Info(Uint8Array.from([0, 0, 1, 103])).codec, undefined);
});
test('capability probe requests hardware decoding at selected dimensions and handles unavailable APIs', async () => {
  let configuration;
  const platform = { VideoDecoder: { isConfigSupported: async config => { configuration = config; return { supported: true }; } } };
  assert.equal(await supportsNativeVideo({ resolution: '1080p' }, platform), true);
  assert.equal(configuration.hardwareAcceleration, 'prefer-hardware');
  assert.equal(configuration.codedWidth, 1920);
  assert.equal(configuration.codedHeight, 1080);
  assert.equal(await supportsNativeVideo({ resolution: '720p' }, {}), false);
  platform.VideoDecoder.isConfigSupported = async () => { throw new Error('GPU unavailable'); };
  assert.equal(await supportsNativeVideo({ resolution: '720p' }, platform), false);
});

test('HEVC parses the actual SPS profile, tier, level and escaped compatibility flags', () => {
  const sps = Buffer.from('00000001420101016000000300900000030000030078a00280802d165ba4a4c2f0168080000003008000001e0400', 'hex');
  const info = h265Info(sps);
  assert.equal(info.codec, 'hev1.1.6.L120.90');
  assert.equal(info.picture, false);
  assert.equal(info.parameters[0].type, 33);
  assert.equal(h265Info(Uint8Array.from([0, 0, 1, 0x26, 1, 9])).key, true);
  assert.equal(h265Info(Uint8Array.from([0, 0, 1, 0x2a, 1, 9])).key, true);
  assert.equal(h265Info(Uint8Array.from([0, 0, 1, 2, 1, 9])).key, false);
  assert.equal(h265Info(Uint8Array.from([0, 0, 1, 0x42, 1])).codec, undefined);
  assert.equal(h265Info(Uint8Array.from([0, 0, 1, 0x26])).picture, false);
});

test('video selection respects Canvas, console support and ordered native fallbacks', async () => {
  const seen = [];
  const platform = { VideoDecoder: { isConfigSupported: async config => { seen.push(config.codec); return { supported: true }; } } };
  const profile = { resolution: '1080p' };
  assert.equal(await selectVideoCodec('mpeg1', profile, new Set(), 'PS5', platform), 'mpeg1');
  assert.deepEqual(seen, []);
  assert.equal(await selectVideoCodec('h265', profile, new Set(), 'PS5', platform), 'h265');
  assert.deepEqual(seen, ['hev1.1.6.L123.B0']);
  assert.equal(await selectVideoCodec('h265', profile, new Set(), 'PS4', platform), 'h264');
  assert.equal(await selectVideoCodec('h265', profile, new Set(['h265']), 'PS5', platform), 'h264');
  assert.equal(await selectVideoCodec('h265', profile, new Set(['h265', 'h264']), 'PS5', platform), 'mpeg1');
  assert.equal(await selectVideoCodec('auto', profile, new Set(), 'PS5', platform), 'h265', 'automatic prefers H.265 on a PS5');
  assert.equal(await selectVideoCodec('auto', profile, new Set(), 'PS4', platform), 'h264', 'automatic uses H.264 on a PS4');
  assert.equal(await selectVideoCodec('auto', profile, new Set(), null, platform), 'h264', 'automatic uses H.264 for the test stream');
  assert.equal(await selectVideoCodec('auto', profile, new Set(['h265']), 'PS5', platform), 'h264', 'automatic skips a codec that failed');
  assert.equal(await selectVideoCodec('h265', profile, new Set(), 'PS5', {}), 'mpeg1');
});

test('native decode queues network bursts in order and drains when the decoder is ready', () => {
  const decoder = { decodeQueueSize: 0 }; const sent = [];
  const queue = new NativeDecodeQueue(decoder, value => { sent.push(value); decoder.decodeQueueSize++; }, assert.fail);
  for (let i = 0; i < 12; i++) queue.push(i);
  assert.deepEqual(sent, [0, 1, 2, 3]);
  while (queue.items.length) { decoder.decodeQueueSize = 0; decoder.ondequeue(); }
  assert.deepEqual(sent, Array.from({ length: 12 }, (_, index) => index));
  decoder.decodeQueueSize = 4;
  for (let i = 0; i < 30; i++) queue.push(i);
  assert.throws(() => queue.push(31), /falling behind/);
  queue.destroy();
  queue.push(99);
  assert.equal(queue.items.length, 0);
  assert.equal(decoder.ondequeue, null);
});

test('browser H.264 remains available when the GPU preference is unsupported', async () => {
  const seen = [];
  const platform = { VideoDecoder: { isConfigSupported: async config => {
    seen.push(config.hardwareAcceleration);
    return { supported: config.hardwareAcceleration === 'no-preference' };
  } } };
  const config = await nativeVideoConfig({ resolution: '1080p' }, platform);
  assert.equal(config.hardwareAcceleration, 'no-preference');
  assert.deepEqual(seen, ['prefer-hardware', 'no-preference']);
  assert.equal(await selectVideoCodec('h264', { resolution: '1080p' }, new Set(), 'PS5', platform), 'h264');
});

test('console H.264 key frames receive the separately delivered SPS/PPS header before decoding', async () => {
  const decoded = [];
  const saved = { VideoDecoder: globalThis.VideoDecoder, EncodedVideoChunk: globalThis.EncodedVideoChunk };
  globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
  globalThis.VideoDecoder = class {
    constructor() { this.decodeQueueSize = 0; this.state = 'unconfigured'; }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { decoded.push(chunk); }
    close() { this.state = 'closed'; }
  };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  const decoder = createNativeDecoder(canvas, () => {}, { videoCodec: 'h264', fps: 60 });
  try {
    const header = Uint8Array.from([0, 0, 0, 1, 103, 100, 0, 42, 0, 0, 0, 1, 104, 5, 0, 0, 0, 0]);
    const idr = Uint8Array.from([0, 0, 0, 1, 101, 128, 9]);
    const delta = Uint8Array.from([0, 0, 0, 1, 65, 128, 9]);
    decoder.write(header.buffer, 1000); decoder.write(delta.buffer, 1016); decoder.write(idr.buffer, 1033); decoder.write(delta.buffer, 1050);
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0].type, 'key');
    assert.deepEqual([...decoded[0].data], [0, 0, 0, 1, 103, 100, 0, 42, 0, 0, 0, 1, 104, 5, ...idr]);
    assert.equal(decoded[1].type, 'delta');
    assert.ok(decoded[1].timestamp > decoded[0].timestamp);
  } finally { decoder.destroy(); Object.assign(globalThis, saved); }
});

test('a corrupt frame after playback resets the decoder, asks for a keyframe and waits for it', async () => {
  const instances = [], requests = [], reports = [];
  const saved = { VideoDecoder: globalThis.VideoDecoder, EncodedVideoChunk: globalThis.EncodedVideoChunk, VideoFrame: globalThis.VideoFrame };
  globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
  globalThis.VideoDecoder = class {
    constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; this.state = 'unconfigured'; this.decoded = []; instances.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { this.decoded.push(chunk); this.callbacks.output({ timestamp: chunk.timestamp, displayWidth: 16, displayHeight: 16, close() {} }); }
    close() { this.state = 'closed'; }
  };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  let errors = 0;
  const decoder = createNativeDecoder(canvas, message => reports.push(message), { videoCodec: 'h264', fps: 60, onError: () => errors++, requestKeyframe: () => requests.push(1) });
  try {
    const header = Uint8Array.from([0, 0, 0, 1, 103, 100, 0, 42, 0, 0, 0, 1, 104, 5]);
    const idr = Uint8Array.from([0, 0, 0, 1, 101, 128, 9]);
    const delta = Uint8Array.from([0, 0, 0, 1, 65, 128, 9]);
    decoder.write(header.buffer, 1000); decoder.write(idr.buffer, 1016); decoder.write(delta.buffer, 1033);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].decoded.length, 2);
    instances[0].callbacks.error(new Error('corrupt slice'));
    assert.equal(instances.length, 2, 'a fresh decoder replaces the failed one');
    assert.equal(instances[1].config.codec, 'avc1.64002a');
    assert.equal(requests.length, 1, 'a keyframe is requested once');
    assert.equal(reports.filter(message => message.type === 'decoder-reset').length, 1);
    decoder.write(delta.buffer, 1050);
    assert.equal(instances[1].decoded.length, 0, 'delta frames wait for the next keyframe');
    decoder.write(idr.buffer, 1066);
    assert.equal(instances[1].decoded.length, 1);
    assert.equal(errors, 0);
    instances[1].callbacks.error(new Error('again')); instances[2].callbacks.error(new Error('again')); instances[3].callbacks.error(new Error('again'));
    assert.equal(errors, 1, 'a fourth failure inside 30 s reports the error');
  } finally { decoder.destroy(); Object.assign(globalThis, saved); }
});
