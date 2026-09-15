import { test, expect } from '@playwright/test';

async function register(page) {
  await page.goto('/');
  await page.locator('#auth-toggle').click();
  const name = `retro_${Date.now()}`;
  await page.locator('#username').fill(name);
  await page.locator('#email').fill(`${name}@example.test`);
  await page.locator('#password').fill('LocalTestPassword_123');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#library')).toBeVisible();
}

test('retro lobby exposes presets, saves custom profiles and fits desktop and mobile', async ({ page }) => {
  await register(page);
  await expect(page.locator('#video-mode')).toBeVisible();
  await page.locator('[data-preset=detail]').click();
  await expect(page.locator('#resolution-profile')).toHaveValue('1080p');
  await expect(page.locator('#bitrate')).toHaveValue('20000');
  await page.reload();
  await expect(page.locator('#resolution-profile')).toHaveValue('1080p');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: '/tmp/psrp-retro-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: '/tmp/psrp-retro-desktop.png', fullPage: true });
});

test('fullscreen is video only, touch is opt-in and the debug overlay contains measured data', async ({ page }) => {
  await register(page);
  await page.locator('[data-preset=tesla]').click();
  await page.locator('#demo').click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await expect(page.locator('#controls')).toBeHidden();
  await page.locator('#show-controls').check();
  await expect(page.getByRole('button', { name: 'D-pad up', exact: true })).toBeVisible();
  await page.locator('#show-controls').uncheck();
  await page.locator('#fullscreen').click();
  await expect(page.locator('.player-bar')).toBeHidden();
  await expect(page.locator('#debug-overlay')).toBeHidden();
  await expect(page.locator('#controls')).toBeHidden();
  const box = await page.locator('#stage').boundingBox();
  expect(box).toEqual({ x: 0, y: 0, ...page.viewportSize() });
  await page.keyboard.press('Shift+D');
  await expect(page.locator('#debug-overlay')).toBeVisible();
  await expect(page.locator('#hud-codec')).toHaveText('MPEG-1 / CANVAS');
  await expect.poll(() => page.locator('#hud-fps').textContent().then(Number.parseFloat)).toBeGreaterThan(50);
  await expect(page.locator('#hud-pacing')).toContainText('ms');
  await expect(page.locator('#hud-audio')).toContainText('ms');
  await page.screenshot({ path: '/tmp/psrp-retro-hud.png' });
  await page.locator('#hud-exit').click();
  await expect(page.locator('.player-bar')).toBeVisible();
  await page.locator('#stop').click();
});

test('sleep endpoint requires a paired account and library shows rest-mode feedback', async ({ page, request }) => {
  expect((await request.post('/api/software/sleep', { data: { hostId: 'unpaired' } })).status()).toBe(401);
  await register(page);
  const session = await page.request.get('/api/auth/session', { headers: { 'X-Remote-Play-Session': '1' } });
  const { token } = await session.json();
  expect((await page.request.post('/api/software/sleep', { headers: { Authorization: `Bearer ${token}` }, data: { hostId: 'unpaired' } })).status()).toBe(404);
  await page.route('**/api/playstation/my-devices', route => route.fulfill({ json: [{ hostId: 'test-ps5', hostName: 'Living room', hostType: 'PS5', isRegistered: true, status: 'OK' }] }));
  await page.locator('#refresh').click();
  let finish;
  await page.route('**/api/software/sleep', route => new Promise(resolve => {
    finish = async () => { await route.fulfill({ json: { message: 'Rest mode requested.' } }); resolve(); };
  }));
  await page.getByRole('button', { name: 'Put console to sleep', exact: true }).click();
  await expect(page.locator('#message')).toHaveText('Sending rest-mode request…');
  await expect.poll(() => typeof finish).toBe('function');
  await finish();
  await expect(page.locator('#message')).toHaveText('Rest mode requested.');
});

test('theater fallback keeps fullscreen clean and touch gestures can exit it', async ({ page }) => {
  await page.addInitScript(() => { Element.prototype.requestFullscreen = undefined; });
  await register(page);
  await page.route('**/api/software/tickets', route => route.fulfill({ status: 409, json: { message: 'Test console busy.' } }));
  await page.locator('#demo').click();
  await expect(page.locator('#retry-stream')).toBeEnabled();
  await page.locator('#show-controls').check();
  await page.locator('#fullscreen').click();
  await expect(page.locator('#player')).toHaveClass(/theater/);
  await expect(page.locator('.player-bar')).toBeHidden();
  await expect(page.getByRole('button', { name: 'D-pad up', exact: true })).toBeVisible();
  await page.locator('#screen').dispatchEvent('pointerup', { pointerType: 'touch' });
  await page.locator('#screen').dispatchEvent('pointerup', { pointerType: 'touch' });
  await expect(page.locator('#player')).not.toHaveClass(/theater/);
  await expect(page.locator('#connection-message')).toHaveText('Test console busy.');
  await page.locator('#stop').click();
});
