import { test, expect } from '@playwright/test';
import { chooseSetting } from './settings.js';

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

// Needs the isolated instance started with tests/browser/compose.rtc.yaml, which publishes the WebRTC port to this host.
test('with WebRTC selected the test stream plays over the data channel and says so', async ({ page }) => {
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
