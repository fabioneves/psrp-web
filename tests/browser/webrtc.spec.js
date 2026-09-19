import { test, expect } from '@playwright/test';

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
