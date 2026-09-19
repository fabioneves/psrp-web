import { test, expect } from '@playwright/test';
import { chooseSetting } from './settings.js';
import { startRelay } from './udp-relay.js';

// The isolated instance advertises the relay's port, so every WebRTC session here runs through one.
let relay;
test.afterEach(async () => { await relay?.close(); relay = null; });

async function signedIn(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `rtc_${Date.now()}`;
  await page.locator('#username').fill(name);
  await page.locator('#email').fill(`${name}@example.test`);
  await page.locator('#password').fill('LocalTestPassword_123');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#library')).toBeVisible();
  const session = await page.request.get('/api/auth/session', { headers: { 'X-Remote-Play-Session': '1' } });
  return { Authorization: `Bearer ${(await session.json()).token}` };
}

test('a stream ticket accepts a transport, and refuses WebRTC for Canvas mode', async ({ page }) => {
  const headers = await signedIn(page);
  const ticket = data => page.request.post('/api/software/tickets', { headers, data: { demo: true, ...data } });
  expect((await ticket({ videoCodec: 'h264' })).status()).toBe(200);
  expect((await ticket({ videoCodec: 'h264', transport: 'websocket' })).status()).toBe(200);
  expect((await ticket({ videoCodec: 'h265', transport: 'webrtc' })).status()).toBe(200);
  const canvas = await ticket({ videoCodec: 'mpeg1', transport: 'webrtc' });
  expect(canvas.status()).toBe(400);
  expect((await canvas.json()).message).toContain('WebRTC');
  expect((await ticket({ videoCodec: 'h264', transport: 'quic' })).status()).toBe(400);
});

// Needs the isolated instance started with WEBRTC_PORT=18444 WEBRTC_PUBLIC_PORT=18445 WEBRTC_PUBLIC_ADDRESS=127.0.0.1: a bridge-network container only
// knows its private address, so the published UDP port has to be advertised on an address this browser can reach.
test('with WebRTC selected the test stream plays over the data channel and says so', async ({ page }) => {
  relay = await startRelay();
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.log(message.text()); });
  await page.addInitScript(() => { localStorage.setItem('remote-play:video-output', 'canvas'); localStorage.setItem('remote-play:video-mode', 'h264'); });
  await signedIn(page);
  await page.locator('#advanced-settings > summary').click();
  await chooseSetting(page, 'transport', 'webrtc');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  // Headless Chrome may settle on software decoding; the transport at the end of the label is what this test is about.
  await expect(page.locator('#engine')).toHaveText(/^H\.264 · .+ · Canvas 2D · worker · WebRTC$/, { timeout: 30000 });
  const framesAtSwitch = Number(await page.locator('#fps').getAttribute('data-frames'));
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number), { timeout: 20000 }).toBeGreaterThan(framesAtSwitch + 300);
  expect(parseFloat(await page.locator('#fps').textContent())).toBeGreaterThan(55);
  const metrics = JSON.parse(await page.locator('#timing-status').getAttribute('data-metrics'));
  expect(metrics.width).toBe(1280);
  await page.locator('#stop').click();
});

test('the transport choice is saved with the other stream settings and hidden for Canvas mode', async ({ page }) => {
  await signedIn(page);
  await page.locator('#advanced-settings > summary').click();
  await chooseSetting(page, 'transport', 'webrtc');
  await page.reload();
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#advanced-settings')).toHaveAttribute('open', '');
  await expect(page.locator('[data-choice-for=transport] [data-value=webrtc]')).toHaveAttribute('aria-checked', 'true');
  await chooseSetting(page, 'video-mode', 'mpeg1');
  await expect(page.locator('[data-choice-for=transport]')).toBeHidden();
  await chooseSetting(page, 'video-mode', 'h264');
  await expect(page.locator('[data-choice-for=transport]')).toBeVisible();
});

// Needs the instance started with WEBRTC_TEST_DROP=1 as well. The test stream cannot make a keyframe on request, so each lost
// frame freezes the picture until the generator's next one, at most a second away; a console answers within a few frames.
test('lost fragments are counted, a keyframe is asked for, and playback carries on without falling behind', async ({ page }) => {
  relay = await startRelay();
  await page.addInitScript(() => { localStorage.setItem('remote-play:video-output', 'canvas'); localStorage.setItem('remote-play:video-mode', 'h264'); localStorage.setItem('remote-play:transport', 'webrtc'); });
  await page.route('**/api/software/tickets', route => route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), testDropPercent: 1 }) }));
  await signedIn(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toHaveText(/ · WebRTC$/, { timeout: 30000 });
  const metrics = async () => JSON.parse(await page.locator('#timing-status').getAttribute('data-metrics'));
  await expect.poll(async () => (await metrics()).rtcAbandoned, { timeout: 60000 }).toBeGreaterThan(2);
  const lossy = await metrics();
  expect(lossy.rtcKeyframeRequests).toBeGreaterThan(0);
  expect(lossy.videoTransport).toBe('webrtc');
  const frames = lossy.totalFrames;
  await expect.poll(async () => (await metrics()).totalFrames, { timeout: 30000 }).toBeGreaterThan(frames + 120);
  expect((await metrics()).videoAgeMs).toBeLessThan(1500);
  await page.locator('#stop').click();
});

test('rehearsed loss above one fragment in two is refused even where tests may ask for it', async ({ page }) => {
  const headers = await signedIn(page);
  const response = await page.request.post('/api/software/tickets', { headers, data: { demo: true, videoCodec: 'h264', transport: 'webrtc', testDropPercent: 80 } });
  expect(response.status()).toBe(400);
});

// Retransmission and the in-order hold, without the network getting in the way: on loopback a repair is immediate.
test('one datagram in a hundred lost on the way to the browser does not cost frames or keyframes', async ({ page }) => {
  relay = await startRelay({ lossPercent: 1 });
  await page.addInitScript(() => { localStorage.setItem('remote-play:video-output', 'canvas'); localStorage.setItem('remote-play:video-mode', 'h264'); localStorage.setItem('remote-play:transport', 'webrtc'); });
  await signedIn(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toHaveText(/ · WebRTC$/, { timeout: 30000 });
  const metrics = async () => JSON.parse(await page.locator('#timing-status').getAttribute('data-metrics'));
  await expect.poll(() => relay.counts.lost, { timeout: 40000 }).toBeGreaterThan(60);
  const end = await metrics();
  console.log(`relay lost ${relay.counts.lost} of ${relay.counts.toBrowser} datagrams; abandoned ${end.rtcAbandoned}, keyframe requests ${end.rtcKeyframeRequests}, fps ${end.fps.toFixed(1)}, age ${Math.round(end.videoAgeMs)} ms`);
  expect(end.rtcAbandoned).toBeLessThanOrEqual(1);
  expect(end.rtcKeyframeRequests).toBeLessThanOrEqual(1);
  expect(end.fps).toBeGreaterThan(55);
  expect(end.videoAgeMs).toBeLessThan(400);
  await page.locator('#stop').click();
});

// NOT MET, 2026-09-19. 40 ms each way is the round trip the phone and the car showed. With 10 datagrams lost in about
// 50 s of the 8 Mbps test stream: 5 frames abandoned, 1 keyframe request, 40.6 fps (without retransmission, same relay:
// 9 abandoned, 14 keyframe requests, 28.9 fps, 13 send backlogs). What fails is not the repair but the data channel's
// congestion control: a loss halves its window, the window regrows by a packet per round trip, and for seconds the
// stream does not fit, so messages expire in the send queue. Kept as the measurement to beat.
test.fixme('datagrams lost at an 80 ms round trip are repaired without costing frames or keyframes', async ({ page }) => {
  test.setTimeout(180000);
  relay = await startRelay({ lossPercent: 0.04, delayMs: 40 });
  await page.addInitScript(() => { localStorage.setItem('remote-play:video-output', 'canvas'); localStorage.setItem('remote-play:video-mode', 'h264'); localStorage.setItem('remote-play:transport', 'webrtc'); });
  await signedIn(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toHaveText(/ · WebRTC$/, { timeout: 30000 });
  const metrics = async () => JSON.parse(await page.locator('#timing-status').getAttribute('data-metrics'));
  const start = (await metrics()).totalFrames, began = Date.now();
  await expect.poll(() => relay.counts.lost, { timeout: 150000, intervals: [1000] }).toBeGreaterThanOrEqual(10);
  const end = await metrics(), seconds = (Date.now() - began) / 1000;
  console.log(`relay lost ${relay.counts.lost} of ${relay.counts.toBrowser} datagrams in ${Math.round(seconds)} s; abandoned ${end.rtcAbandoned}, keyframe requests ${end.rtcKeyframeRequests}, mean ${((end.totalFrames - start) / seconds).toFixed(1)} fps, age ${Math.round(end.videoAgeMs)} ms`);
  expect(end.rtcAbandoned).toBeLessThanOrEqual(1);
  expect(end.rtcKeyframeRequests).toBeLessThanOrEqual(1);
  expect((end.totalFrames - start) / seconds).toBeGreaterThan(55);
  expect(end.videoAgeMs).toBeLessThan(500);
  await page.locator('#stop').click();
});
