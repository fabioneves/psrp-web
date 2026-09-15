import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h264Info, h265Info, supportsNativeVideo, selectVideoCodec, NativeDecodeQueue } from '../web/native-decoder.js';

test('H.264 detects three/four byte Annex B start codes, SPS profile and IDR frames', () => {
  assert.deepEqual(h264Info(Uint8Array.from([0, 0, 0, 1, 103, 100, 0, 42, 0, 0, 1, 101, 128])),
    { codec: 'avc1.64002a', key: true, picture: true });
  assert.deepEqual(h264Info(Uint8Array.from([0, 0, 1, 65, 128])), { codec: undefined, key: false, picture: true });
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
