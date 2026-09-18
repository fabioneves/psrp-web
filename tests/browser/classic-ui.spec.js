import { test, expect } from '@playwright/test';

const consoleDevice = { hostId: 'ui-console', hostName: 'Living room', hostType: 'PS5', ipAddress: '192.0.2.10', isRegistered: true, status: 'OK' };

async function preview(page, { signedIn = true, devices = [consoleDevice] } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/software/tickets') return route.fulfill({ status: 409, json: { message: 'Console is busy. Try again shortly.' } });
    const responses = {
      '/api/auth/session': { token: signedIn ? 'ui-preview' : null },
      '/api/auth/setup': { registrationOpen: true },
      '/api/settings': { settings: {} },
      '/api/playstation/my-devices': devices,
      '/api/playstation/discover': [],
      '/api/diagnostics': []
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto('/');
  await expect(page.locator(signedIn ? '#library' : '#account')).toBeVisible();
  return errors;
}

async function fitsViewport(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const clipped = await page.locator('button:visible, [role=radio]:visible, .fullscreen-toggle:visible').evaluateAll(elements =>
    elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent.trim()));
  expect(clipped).toEqual([]);
}

test('classic lobby and console setup fit narrow screens with usable illustrated controls', async ({ page }) => {
  const errors = await preview(page);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    await fitsViewport(page);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Console settings', exact: true }).click();
    await page.locator('#console-custom').check();
    await fitsViewport(page);
    await page.getByRole('button', { name: 'Close console settings' }).click();
    await page.getByRole('button', { name: 'Add console', exact: true }).click();
    await fitsViewport(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Add console', exact: true })).toBeFocused();
  }
  await page.screenshot({ path: '/tmp/psrp-classic-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: '/tmp/psrp-classic-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('profiles remain keyboard accessible and the larger control deck preserves fullscreen', async ({ page }) => {
  const errors = await preview(page);
  await page.locator('[data-preset=detail]').click();
  await expect(page.locator('#resolution-profile')).toHaveValue('1080p');
  const modes = page.getByRole('radiogroup', { name: 'Video mode', exact: true });
  await modes.getByRole('radio', { name: 'Automatic', exact: true }).click();
  await page.keyboard.press('End');
  await expect(modes.getByRole('radio', { name: 'Canvas', exact: true })).toBeFocused();
  await expect(page.locator('#video-mode')).toHaveValue('mpeg1');
  await page.locator('#demo').click();
  await expect(page.locator('#connection-message')).toHaveText('Console is busy. Try again shortly.');
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    for (const tab of ['Picture', 'Sound', 'Controls']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await fitsViewport(page);
    }
  }
  await page.getByRole('tab', { name: 'Picture', exact: true }).click();
  await page.screenshot({ path: '/tmp/psrp-classic-player-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: '/tmp/psrp-classic-player.png', fullPage: true });
  await page.locator('#fullscreen').click();
  await expect(page.locator('#session-sidebar')).toBeHidden();
  await expect(page.locator('.player-bar')).toBeHidden();
  await page.locator('#stage').dblclick();
  await page.locator('#stop').click();
  await expect(page.locator('#library')).toBeVisible();
  expect(errors).toEqual([]);
});

test('sign-in and empty library remain readable on phones', async ({ page }) => {
  const errors = await preview(page, { signedIn: false });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    await fitsViewport(page);
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await page.locator('#auth-toggle').click();
    await fitsViewport(page);
    await page.locator('#auth-toggle').click();
  }
  await page.screenshot({ path: '/tmp/psrp-classic-signin-mobile.png', fullPage: true });
  await preview(page, { devices: [] });
  await expect(page.getByRole('heading', { name: 'Connect your first console' })).toBeVisible();
  await fitsViewport(page);
  await page.getByRole('button', { name: 'Add console', exact: true }).click();
  await expect(page.locator('#setup-dialog')).toBeVisible();
  expect(errors).toEqual([]);
});
