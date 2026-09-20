import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveQuality } from '../web/adaptive.js';

const ceiling = { resolution: '1080p', fps: 60, bitrateKbps: 20000 };
const healthy = { width: 1920, fps: 60, codecMs: 3, colorMs: 1, drawMs: 1, transportMs: 5, serverQueueMs: 0, rttMs: 10 };
const slow = { ...healthy, codecMs: 20, fps: 40 };

test('transient stalls and hidden tabs do not reduce quality; sustained CPU pressure lowers resolution', () => {
  const quality = new AdaptiveQuality(ceiling, 0);
  assert.equal(quality.sample(slow, 1000), null);
  assert.equal(quality.sample(slow, 15000), null);
  quality.sample(healthy, 16000);
  quality.sample(slow, 17000); quality.sample(slow, 18000);
  const change = quality.sample(slow, 19000);
  assert.equal(change.profile.resolution, '720p'); assert.equal(change.profile.fps, 60);
  for (let time = 20000; time < 40000; time += 1000) assert.equal(quality.sample(slow, time, false), null);
  assert.equal(quality.current.resolution, '720p');
});

test('congestion lowers bitrate first; cooldown and stable recovery prevent oscillation and exceed no ceiling', () => {
  const quality = new AdaptiveQuality(ceiling, 0), congested = { ...healthy, transportMs: 200 };
  for (let time = 15000; time < 20000; time += 1000) assert.equal(quality.sample(congested, time), null, 'a burst under six seconds keeps the bitrate');
  assert.deepEqual(quality.sample(congested, 20000).profile, { ...ceiling, bitrateKbps: 15000 });
  for (let time = 21000; time < 35000; time += 1000) assert.equal(quality.sample(congested, time), null);
  for (let time = 35000; time < 65000; time += 1000) assert.equal(quality.sample(healthy, time), null);
  assert.equal(quality.sample(healthy, 65000).profile.bitrateKbps, 19000);
  for (let time = 66000; time <= 163000; time += 1000) quality.sample(healthy, time);
  assert.deepEqual(quality.current, ceiling);
});

test('adaptation bottoms out at 360p30 and preserves a manual 30fps ceiling', () => {
  const quality = new AdaptiveQuality({ resolution: '360p', fps: 30, bitrateKbps: 3000 }, 0);
  for (let time = 15000; time < 100000; time += 1000) assert.equal(quality.sample(slow, time), null);
  assert.equal(quality.current.fps, 30);
});

// Over WebRTC a struggling link does not queue video, it loses it: delivery time stays low while frames are abandoned in the
// browser or skipped by the server, and the frame rate dips as the picture waits for a keyframe.
const channel = (abandoned, skipped = 0, fps = 60) => ({ ...healthy, fps, videoTransport: 'webrtc', rtcAbandoned: abandoned, rtcSkipped: skipped });

test('video lost on the data channel lowers the bitrate, not the resolution', () => {
  const quality = new AdaptiveQuality(ceiling, 0);
  let change = null, abandoned = 0;
  for (let second = 16; second <= 40 && !change; second++) {
    const lossy = second % 5 === 0; // one bad second in five, the pattern of the 1080p field failure's first minute
    if (lossy) abandoned += 2;
    change = quality.sample(channel(abandoned, 0, lossy ? 35 : 60), second * 1000);
  }
  assert.ok(change, 'four lossy seconds within twenty are enough');
  assert.equal(change.profile.resolution, '1080p');
  assert.equal(change.profile.bitrateKbps, 15000);
  assert.match(change.reason, /losing video/i);
});

test('frames the server skipped for a send backlog count the same way', () => {
  const quality = new AdaptiveQuality(ceiling, 0);
  let change = null, skipped = 0;
  for (let second = 16; second <= 40 && !change; second++) { if (second % 4 === 0) skipped += 9; change = quality.sample(channel(0, skipped), second * 1000); }
  assert.equal(change?.profile.bitrateKbps, 15000);
});

test('one lost frame changes nothing, and a lossy second is not mistaken for a slow browser', () => {
  const quality = new AdaptiveQuality(ceiling, 0);
  quality.sample(channel(0), 16000);
  for (let second = 17; second <= 19; second++) assert.equal(quality.sample(channel(1, 0, 30), second * 1000), null, 'fps fell with the loss, not because decoding is slow');
  for (let second = 20; second <= 60; second++) assert.equal(quality.sample(channel(1), second * 1000), null);
});
