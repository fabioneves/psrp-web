import { test, expect } from '@playwright/test';

const account = { numericId: '72623859790382856', accountId: 'CAcGBQQDAgE=', onlineId: 'ExamplePSN', canAutoPair: true };

async function register(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `setup_${Date.now()}`;
  await page.locator('#username').fill(name);
  await page.locator('#email').fill(`${name}@example.test`);
  await page.locator('#password').fill('LocalTestPassword_123');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#library')).toBeVisible();
}

async function mockDiscovery(page) {
  await page.route('**/api/playstation/discover?*', route => route.fulfill({ json: [{ name: 'Example PS5', ip: '192.0.2.5', uuid: '001122334455', hostType: 'PS5' }] }));
}

test('first run offers only the owner account, then sign-ups close unless registration is open', async ({ page }) => {
  await page.route('**/api/auth/setup', route => route.fulfill({ json: { needsSetup: true, registrationOpen: true } }));
  await page.goto('/');
  await expect(page.locator('#auth-title')).toHaveText('Create the owner account');
  await expect(page.locator('#auth-intro')).toBeVisible();
  await expect(page.locator('#auth-toggle')).toBeHidden();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.locator('#auth-submit')).toHaveText('Create account');
  await page.unroute('**/api/auth/setup');
  await page.route('**/api/auth/setup', route => route.fulfill({ json: { needsSetup: false, registrationOpen: false } }));
  await page.goto('/');
  await expect(page.locator('#auth-title')).toHaveText('Sign in to play');
  await expect(page.locator('#auth-toggle')).toBeHidden();
  await expect(page.locator('#auth-intro')).toBeHidden();
  await page.unroute('**/api/auth/setup');
  await page.goto('/');
  await expect(page.locator('#auth-toggle')).toBeVisible();
  const setup = await page.request.get('/api/auth/setup');
  expect((await setup.json()).registrationOpen).toBe(true);
});

test('simple console screen restores silently and setup fits small screens', async ({ page }) => {
  await mockDiscovery(page);
  await register(page);
  await expect(page.getByRole('button', { name: 'Example PS5 · Set up' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  let restore;
  await page.route('**/api/auth/session', async route => { await new Promise(resolve => { restore = resolve; }); await route.continue(); });
  await page.reload();
  await expect.poll(() => !!restore).toBe(true);
  await expect(page.getByText(/restoring/i)).toHaveCount(0);
  restore();
  await page.unroute('**/api/auth/session');
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#setup-dialog')).toBeHidden();
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
  await page.getByRole('button', { name: 'Example PS5 · Set up' }).click();
  await expect(page.locator('#setup-title')).toHaveText('Set up Example PS5');
  await expect(page.locator('#manual-pairing')).not.toHaveAttribute('open');
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.locator('#setup-dialog').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.locator('#setup-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#setup-dialog')).toBeHidden();
});

test('guided PSN sign-in saves metadata, supports pinless pairing, and restores and forgets the account', async ({ page }) => {
  await mockDiscovery(page);
  let saved = null;
  await page.route('**/api/psn/login', route => route.fulfill({ json: { loginUrl: 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize?state=test-state' } }));
  await page.route('**/api/psn/account', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().redirectUrl).toContain('code=test-code');
      saved = account;
      return route.fulfill({ json: saved });
    }
    if (route.request().method() === 'DELETE') saved = null;
    return route.fulfill({ json: { account: saved } });
  });
  let pairing = 0;
  await page.route('**/api/psn/pair', route => {
    expect(route.request().postDataJSON()).toEqual({ hostIp: '192.0.2.5' });
    pairing++;
    return route.fulfill({ json: { hostId: '001122334455', isRegistered: true } });
  });
  await register(page);
  await page.getByRole('button', { name: 'Example PS5 · Set up' }).click();
  await page.locator('#psn-login').click();
  await expect(page.locator('#psn-login-link')).toHaveAttribute('href', /sonyentertainmentnetwork.com/);
  await page.locator('#psn-login-help > summary').click();
  await expect(page.locator('#psn-copy-url')).toHaveValue(/sonyentertainmentnetwork.com/);
  await page.locator('#psn-copy-link').click();
  await expect(page.locator('#psn-status')).toContainText(/copied|Select and copy/);
  await page.locator('#psn-redirect').fill('https://remoteplay.dl.playstation.net/remoteplay/redirect?code=test-code&state=test-state');
  await page.locator('#psn-complete').click();
  await expect(page.locator('#psn-account-status')).toHaveText('Account saved: ExamplePSN');
  await expect(page.locator('#psn-redirect')).toHaveValue('');
  await expect(page.locator('#account-id')).toHaveValue(account.accountId);
  await page.locator('#auto-pair').click();
  await expect(page.locator('#setup-dialog')).toBeHidden();
  expect(pairing).toBe(1);
  await page.reload();
  await page.locator('#account-settings').click();
  await expect(page.locator('#psn-account-status')).toHaveText('Account saved: ExamplePSN');
  await page.locator('#psn-disconnect').click();
  await expect(page.locator('#auto-pair')).toBeHidden();
  await expect(page.locator('#account-id')).toHaveValue('');
  await page.reload();
  await page.locator('#account-settings').click();
  await expect(page.locator('#psn-disconnect')).toBeHidden();
});

test('failed automatic pairing exposes PIN fallback and public lookup reports errors', async ({ page }) => {
  await mockDiscovery(page);
  await page.route('**/api/psn/account', route => route.fulfill({ json: { account } }));
  await page.route('**/api/psn/pair', route => route.fulfill({ status: 409, json: { message: 'Pair with a PIN instead.' } }));
  let lookups = 0;
  await page.route('**/api/psn/lookup', route => {
    lookups++;
    return route.fulfill(lookups === 1 ? { status: 503, json: { message: 'Public lookup is unavailable. Use PSN sign-in or enter your account ID manually.' } } : { json: { ...account, canAutoPair: false } });
  });
  await register(page);
  await page.getByRole('button', { name: 'Example PS5 · Set up' }).click();
  await page.locator('#auto-pair').click();
  await expect(page.locator('#psn-status')).toHaveText('Pair with a PIN instead.');
  await expect(page.locator('#manual-pairing')).toHaveAttribute('open');
  await page.locator('#public-lookup > summary').click();
  await page.locator('#psn-online-name').fill('!');
  await page.locator('#psn-lookup').click();
  await expect(page.locator('#psn-status')).toContainText('Enter your PSN online name');
  expect(lookups).toBe(0);
  await page.locator('#psn-online-name').fill('ExamplePSN');
  await page.locator('#psn-lookup').click();
  await expect(page.locator('#psn-status')).toContainText('Public lookup is unavailable');
  await page.locator('#psn-lookup').click();
  await expect(page.locator('#pin')).toBeFocused();
  await expect(page.locator('#auto-pair')).toBeHidden();
  await expect(page.locator('#account-id')).toHaveValue(account.accountId);
});

test('PSN setup endpoints require authentication and reject an invalid callback before contacting Sony', async ({ page, request }) => {
  for (const path of ['login', 'account', 'lookup', 'pair'])
    expect((await request.post(`/api/psn/${path}`, { data: {} })).status()).toBe(401);
  await register(page);
  const response = await page.request.get('/api/auth/session', { headers: { 'X-Remote-Play-Session': '1' } });
  const headers = { Authorization: `Bearer ${(await response.json()).token}` };
  const invalid = await page.request.post('/api/psn/account', { headers, data: { redirectUrl: 'https://untrusted.example/?code=abc' } });
  expect(invalid.status()).toBe(400);
  expect((await page.request.get('/api/psn/account', { headers })).headers()['cache-control']).toBe('no-store');
});

test('paired console wake shows progress, confirms readiness and reports failure', async ({ page, request }) => {
  expect((await request.post('/api/software/wake', { data: { hostId: 'test-console' } })).status()).toBe(401);
  await page.route('**/api/playstation/my-devices', route => route.fulfill({ json: [{ hostId: 'test-console', hostName: 'Test PS5', hostType: 'PS5', ipAddress: '192.0.2.5', status: 'STANDBY', isRegistered: true }] }));
  await mockDiscovery(page);
  await register(page);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  let complete;
  await page.route('**/api/software/wake', route => new Promise(resolve => {
    expect(route.request().postDataJSON()).toEqual({ hostId: 'test-console' });
    complete = async (status, json) => { await route.fulfill({ status, json }); resolve(); };
  }));
  await page.getByRole('button', { name: 'Wake up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Waking…', exact: true })).toBeDisabled();
  await expect.poll(() => typeof complete).toBe('function');
  await complete(200, { status: 'Ok' });
  await expect(page.locator('#message')).toContainText('Console is awake');
  complete = null;
  await page.getByRole('button', { name: 'Wake up', exact: true }).click();
  await expect.poll(() => typeof complete).toBe('function');
  await complete(504, { message: 'The console did not wake. Enable network wake in Rest Mode settings.' });
  await expect(page.locator('#message')).toContainText('The console did not wake');
  await expect(page.getByRole('button', { name: 'Wake up', exact: true })).toBeEnabled();
  await page.unroute('**/api/software/wake');
  await page.getByRole('button', { name: 'Wake up', exact: true }).click();
  await expect(page.locator('#message')).toContainText('Pair this console with your account first.');
});

test('paired cards replace saved standby status with live console state', async ({ page }) => {
  await page.route('**/api/playstation/my-devices', route => route.fulfill({ json: [{ hostId: '001122334455', hostName: 'Test PS5', hostType: 'PS5', ipAddress: '192.0.2.5', status: 'STANDBY', isRegistered: true }] }));
  let status = 'Ok';
  await page.route('**/api/playstation/discover?*', route => route.fulfill({ json: [{ uuid: '001122334455', name: 'Test PS5', ip: '192.0.2.5', hostType: 'PS5', status }] }));
  await register(page);
  await expect(page.locator('.device p')).toContainText('Ready');
  status = 'STANDBY';
  await page.locator('#refresh').click();
  await expect(page.locator('.device p')).toContainText('Rest mode');
});

test('a page from an older build reloads itself once when the server has moved on', async ({ page }) => {
  let versionCalls = 0;
  await page.route('**/api/version', route => { versionCalls++; route.fulfill({ json: { version: 'zzz9999', latest: 'zzz9999', updateAvailable: false, checkedAt: null } }); });
  await page.goto('/');
  const built = await page.locator('meta[name=app-version]').getAttribute('content');
  test.skip(built === 'dev', 'needs a build stamped with APP_VERSION; development pages never reload themselves');
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `stale_${Date.now()}`;
  await page.getByLabel('Username (letters, numbers, underscore)').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await reloaded;
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#update-notice')).toContainText('Server updated to zzz9999', { timeout: 10000 });
  expect(await page.evaluate(() => sessionStorage.getItem('remote-play:reloaded-for'))).toBe('zzz9999');
  expect(versionCalls).toBeGreaterThanOrEqual(2);
});
