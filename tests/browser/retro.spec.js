import { chooseSetting } from './settings.js';
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
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
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
  await expect(page.locator('#stream-status')).toHaveText('Connection failed');
  await page.locator('#show-controls').check();
  await page.locator('#fullscreen').click();
  await expect(page.locator('#player')).toHaveClass(/theater/);
  await expect(page.locator('.player-bar')).toBeHidden();
  await expect(page.getByRole('button', { name: 'D-pad up', exact: true })).toBeVisible();
  for (let tap = 0; tap < 2; tap++) {
    await page.locator('#screen').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1, isPrimary: true });
    await page.locator('#screen').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1, isPrimary: true });
  }
  await expect(page.locator('#player')).not.toHaveClass(/theater/);
  await expect(page.locator('#connection-message')).toHaveText('Test console busy.');
  await page.locator('#stop').click();
});

test('codec tiles default to H.264, support keyboard selection and save preferences', async ({ page }) => {
  await register(page);
  const modes = page.getByRole('radiogroup', { name: 'Video mode', exact: true });
  await expect(modes.getByRole('radio', { name: 'H.264', exact: true })).toBeChecked();
  await expect(page.locator('#video-mode')).toBeHidden();
  await modes.getByRole('radio', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('#video-mode')).toHaveValue('mpeg1');
  await page.keyboard.press('End');
  await expect(modes.getByRole('radio', { name: 'H.265', exact: true })).toBeFocused();
  await expect(page.locator('#video-mode')).toHaveValue('h265');
  await page.reload();
  await expect(modes.getByRole('radio', { name: 'H.265', exact: true })).toBeChecked();
  await expect(page.locator('.banner-nav #logout')).toBeVisible();
  await expect(page.locator('.site-header')).toHaveCount(0);
});

test('control deck sits beside a smaller player and keeps its toolbar on one row', async ({ page }) => {
  await register(page);
  await page.route('**/api/software/tickets', route => route.fulfill({ status: 409, json: { message: 'Test console busy.' } }));
  await page.locator('#demo').click();
  await expect(page.locator('#stream-status')).toHaveText('Connection failed');
  const stage = await page.locator('#stage').boundingBox();
  const sidebar = await page.locator('#session-sidebar').boundingBox();
  expect(sidebar.x).toBeGreaterThan(stage.x + stage.width);
  expect(stage.width).toBeLessThan(1000);
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Audio startup buffer' })).toBeVisible();
  await page.getByRole('tab', { name: 'Controls', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Tesla virtual', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Picture', exact: true }).click();
  await page.screenshot({ path: '/tmp/psrp-touch-session-desktop.png', fullPage: true });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const fullscreen = await page.locator('#fullscreen').boundingBox();
    const stop = await page.locator('#stop').boundingBox();
    const title = await page.locator('.session-title').boundingBox();
    expect(fullscreen.y).toBe(stop.y);
    expect(Math.abs(title.y + title.height / 2 - stop.y - stop.height / 2)).toBeLessThan(2);
    expect(fullscreen.height).toBeGreaterThanOrEqual(48);
    for (const tab of await page.getByRole('tab').all()) {
      expect(await tab.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  }
  await page.screenshot({ path: '/tmp/psrp-touch-session-mobile.png', fullPage: true });
  await page.locator('#stop').click();
});

for (const fallback of [false, true]) {
  test(`fullscreen on Play is opt-in, saved and enters before connection (${fallback ? 'theater' : 'native'})`, async ({ page }) => {
    if (fallback) await page.addInitScript(() => { Element.prototype.requestFullscreen = undefined; });
    await register(page);
    await page.route('**/api/playstation/my-devices', route => route.fulfill({ json: [{ hostId: 'test-ps5', hostName: 'Living room', hostType: 'PS5', isRegistered: true, status: 'OK' }] }));
    await page.locator('#refresh').click();
    const pending = [];
    await page.route('**/api/software/tickets', route => { pending.push(route); });
    await expect(page.getByRole('checkbox', { name: 'Start in fullscreen', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => pending.length).toBe(1);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(page.locator('#player')).not.toHaveClass(/theater/);
    await page.locator('#stop').click();
    await page.locator('.fullscreen-toggle').click();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Start in fullscreen', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => pending.length).toBe(2);
    if (fallback) await expect(page.locator('#player')).toHaveClass(/theater/);
    else await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('player');
    await expect(page.locator('#session-sidebar')).toBeHidden();
    await expect(page.locator('.player-bar')).toBeHidden();
    await page.locator('#stage').dblclick();
    await page.locator('#stop').click();
    await page.locator('#demo').click();
    await expect.poll(() => pending.length).toBe(3);
    await expect(page.locator('.player-bar')).toBeVisible();
    await page.locator('#stop').click();
  });
}

test('three translucent HUD layouts show live data, stay compact and switch without reconnecting', async ({ page }) => {
  await register(page);
  await page.locator('[data-preset=tesla]').click();
  let tickets = 0;
  page.on('request', request => { if (request.url().includes('/api/software/tickets')) tickets++; });
  await page.locator('#demo').click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await page.locator('#debug-mode').check();
  const hud = page.locator('#debug-overlay');
  await expect(hud).toHaveAttribute('data-layout', 'detailed');
  await expect.poll(() => page.locator('#hud-fps').textContent().then(Number.parseFloat)).toBeGreaterThan(50);
  await expect(page.locator('#hud-rtt')).toBeVisible();
  const initialTickets = tickets;
  for (const layout of ['detailed', 'minimal', 'horizontal']) {
    await chooseSetting(page, 'hud-style', layout);
    await expect(hud).toHaveAttribute('data-layout', layout);
    await expect(page.locator('#hud-fps')).toBeVisible();
    await expect(page.locator('#hud-codec')).toHaveText('MPEG-1 / CANVAS');
    const alpha = await hud.evaluate(element => Number(getComputedStyle(element).backgroundColor.match(/[\d.]+/g).at(-1)));
    expect(alpha).toBeGreaterThan(0.5);
    expect(alpha).toBeLessThan(0.85);
    const box = await hud.boundingBox();
    if (layout === 'minimal') { expect(box.width).toBeLessThanOrEqual(180); expect(box.height).toBeLessThan(90); }
    if (layout === 'horizontal') expect(box.height).toBeLessThan(40);
    await page.locator('#stage').screenshot({ path: `/tmp/psrp-hud-${layout}.png` });
  }
  expect(tickets).toBe(initialTickets);
  await page.locator('#fullscreen').click();
  await expect(page.locator('#session-sidebar')).toBeHidden();
  await expect(hud).toHaveAttribute('data-layout', 'horizontal');
  expect((await hud.boundingBox()).height).toBeLessThan(40);
  await page.keyboard.press('Shift+H');
  await expect(hud).toHaveAttribute('data-layout', 'detailed');
  await page.keyboard.press('Shift+H');
  await expect(hud).toHaveAttribute('data-layout', 'minimal');
  await page.keyboard.press('Shift+H');
  await expect(hud).toHaveAttribute('data-layout', 'horizontal');
  await page.locator('#stage').dblclick();
  await page.setViewportSize({ width: 320, height: 900 });
  const box = await hud.boundingBox(), stage = await page.locator('#stage').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width);
  expect(box.height).toBeLessThan(40);
  expect(await hud.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
  await page.locator('#stop').click();
  await page.reload();
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#hud-style')).toHaveValue('horizontal');
  expect(await page.locator('#debug-mode').isChecked()).toBe(true);
});

test('each Play button has a labeled fullscreen toggle on its left, with shared saved state', async ({ page }) => {
  await register(page);
  const devices = ['Living room', 'Office'].map((hostName, index) => ({ hostId: `layout-${index}`, hostName, hostType: 'PS5', isRegistered: true, status: 'OK' }));
  await page.route('**/api/playstation/my-devices', route => route.fulfill({ json: devices }));
  await page.locator('#refresh').click();
  const toggles = page.getByRole('checkbox', { name: 'Start in fullscreen', exact: true });
  await expect(toggles).toHaveCount(2);
  await expect(toggles.first()).not.toBeChecked();
  await page.locator('.fullscreen-toggle').first().click();
  await expect(page.locator('.fullscreen-toggle').first()).toHaveClass(/is-selected/);
  await expect(toggles.last()).toBeChecked();
  await page.reload();
  await expect(toggles.first()).toBeChecked();
  await expect(toggles.last()).toBeChecked();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    for (const row of await page.locator('.play-actions').all()) {
      const toggle = row.locator('.fullscreen-toggle');
      await expect(toggle).toHaveText('Start in fullscreen');
      await expect(toggle).toHaveClass(/is-selected/);
      expect(await toggle.locator('input').evaluate(element => getComputedStyle(element).clipPath)).toBe('inset(50%)');
      await expect(toggle.locator('img')).toBeVisible();
      const check = await toggle.boundingBox(), play = await row.getByRole('button', { name: 'Play', exact: true }).boundingBox();
      expect(check.x + check.width).toBeLessThan(play.x);
      expect(check.y).toBe(play.y);
      expect(check.height).toBeGreaterThanOrEqual(48);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: '/tmp/psrp-compact-play-mobile.png', fullPage: true });
  await toggles.first().focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.play-actions').first().getByRole('button', { name: 'Play', exact: true })).toBeFocused();
  await page.locator('.fullscreen-toggle').last().click();
  await expect(page.locator('.fullscreen-toggle').first()).not.toHaveClass(/is-selected/);
  await toggles.first().focus();
  await page.keyboard.press('Space');
  await expect(toggles.last()).toBeChecked();
  await page.keyboard.press('Space');
  await expect(toggles.first()).not.toBeChecked();
});
