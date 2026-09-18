import { chooseSetting } from './settings.js';
import { test, expect } from '@playwright/test';

async function register(page, suffix = '') {
  await page.addInitScript(() => localStorage.setItem('remote-play:video-mode', 'mpeg1'));
  await page.goto('/' + suffix);
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `test_${Date.now()}`;
  await page.getByLabel('Username (letters, numbers, underscore)').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
  return name;
}

test('console discovery shows nearby progress, empty results, errors and selectable results', async ({ page }) => {
  await register(page);
  await page.locator('#add-console').click();
  await expect(page.locator('#discover')).toBeEnabled();
  let completeSearch;
  await page.route('**/api/playstation/discover?*', route => new Promise(resolve => {
    completeSearch = async (status, body) => {
      await route.fulfill({ status, json: body });
      resolve();
    };
  }));
  const button = page.locator('#discover');
  const status = page.locator('#discovery-status');
  await button.click();
  await expect(button).toHaveText('Searching…');
  await expect(button).toBeDisabled();
  await expect(status).toContainText('Searching for consoles');
  await expect(status).toBeInViewport();
  await expect.poll(() => typeof completeSearch).toBe('function');
  await completeSearch(200, []);
  await expect(status).toContainText('No consoles found');
  await expect(button).toBeEnabled();

  completeSearch = null;
  await button.click();
  await expect.poll(() => typeof completeSearch).toBe('function');
  await completeSearch(503, { message: 'Discovery is temporarily unavailable.' });
  await expect(status).toContainText('Console search failed');
  await expect(status).toContainText('Discovery is temporarily unavailable.');
  await expect(button).toBeEnabled();

  completeSearch = null;
  await button.click();
  await expect(status).toContainText('Searching for consoles');
  await expect.poll(() => typeof completeSearch).toBe('function');
  await completeSearch(200, [{ name: 'Living room PS5', ip: '192.168.1.50' }]);
  await expect(status).toContainText('Found 1 console');
  await expect(button).toHaveText('Find consoles on this network');
  await page.getByRole('button', { name: 'Living room PS5 · 192.168.1.50' }).click();
  await expect(page.locator('#host-ip')).toHaveValue('192.168.1.50');
  await expect(page.locator('#psn-login')).toBeFocused();
  await expect(status).toContainText('Selected Living room PS5');
});

test('a console IP can be checked directly when broadcast discovery finds nothing', async ({ page }) => {
  await register(page);
  await page.locator('#add-console').click();
  await expect(page.locator('#discover')).toBeEnabled();
  const button = page.locator('#check-ip');
  const status = page.locator('#discovery-status');
  await page.route('**/api/playstation/discover?*', route => route.fulfill({ json: [] }));
  await page.locator('#discover').click();
  await expect(status).toContainText('No consoles found by automatic discovery');
  await button.click();
  await expect(status).toContainText('Enter the console IP address');
  await expect(page.locator('#host-ip')).toBeFocused();
  await page.locator('#host-ip').fill('192.0.2.20');
  let completeSearch;
  await page.route('**/api/playstation/discover/192.0.2.20?*', route => new Promise(resolve => {
    completeSearch = async (code, body) => {
      await route.fulfill({ status: code, json: body });
      resolve();
    };
  }));
  await button.click();
  await expect(status).toContainText('Checking 192.0.2.20');
  await expect(button).toBeDisabled();
  await expect(page.locator('#discover')).toBeDisabled();
  await expect.poll(() => typeof completeSearch).toBe('function');
  await completeSearch(404, { success: false, errorMessage: 'Device not found' });
  await expect(status).toContainText('No console responded at 192.0.2.20');
  await expect(button).toBeEnabled();
  completeSearch = null;
  await button.click();
  await expect.poll(() => typeof completeSearch).toBe('function');
  await completeSearch(200, { success: true, data: { name: 'PS5Pro', ip: '192.0.2.20' } });
  await expect(status).toContainText('Found 1 console');
  await page.getByRole('button', { name: 'PS5Pro · 192.0.2.20' }).click();
  await expect(page.locator('#host-ip')).toHaveValue('192.0.2.20');
  await expect(page.locator('#psn-login')).toBeFocused();
});

test('pairing automatically encodes numeric account IDs and accepts existing Base64', async ({ page }) => {
  await register(page);
  await page.locator('#add-console').click();
  await page.locator('#manual-pairing > summary').click();
  const submitted = [];
  await page.route('**/api/playstation/bind', route => {
    submitted.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { message: 'Pairing intercepted for this test.' } });
  });
  await page.locator('#host-ip').fill('192.168.1.50');
  await page.locator('#pin').fill('12345678');
  await page.getByLabel('PlayStation account ID', { exact: true }).fill('72623859790382856');
  await expect(page.locator('#account-id-preview')).toHaveText('Encoded account ID: CAcGBQQDAgE=');
  await page.getByRole('button', { name: 'Pair console', exact: true }).click();
  await expect(page.locator('#psn-status')).toHaveText('Pairing intercepted for this test.');
  expect(submitted[0].accountId).toBe('CAcGBQQDAgE=');
  await page.locator('#account-id').fill('CAcGBQQDAgE=');
  await expect(page.locator('#account-id-preview')).toBeHidden();
  await page.getByRole('button', { name: 'Pair console', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1].accountId).toBe('CAcGBQQDAgE=');
  await page.locator('#account-id').fill('PSN_Online_Name');
  await page.getByRole('button', { name: 'Pair console', exact: true }).click();
  await expect(page.locator('#psn-status')).toContainText('A PSN online name cannot be encoded');
  expect(submitted.length).toBe(2);
});

test('login survives refresh, uses an HttpOnly cookie, and sign-out survives refresh', async ({ page, context }) => {
  await register(page);
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'remote-play-session');
  expect(cookie).toBeDefined();
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  expect(cookie.path).toBe('/api/auth');
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
  await expect(page.locator('#account')).toBeHidden();
  expect(await page.evaluate(() => document.cookie.includes('remote-play-session'))).toBe(false);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#account')).toBeVisible();
  expect((await context.cookies()).some(cookie => cookie.name === 'remote-play-session')).toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('#library')).toBeHidden();
});

test('a saved login lasts over a year and every visit renews it', async ({ page, context }) => {
  const verified = page.waitForResponse(async response => response.url().endsWith('/api/auth/session') && !!(await response.json()).token);
  await register(page);
  await verified;
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
  await expect(page.locator('#message')).toBeEmpty();
  const saved = async () => (await context.cookies()).find(cookie => cookie.name === 'remote-play-session');
  const nextYear = Date.now() / 1000 + 365 * 86400;
  const first = await saved();
  expect(first.expires).toBeGreaterThan(nextYear);
  expect(JSON.parse(Buffer.from(first.value.split('.')[1], 'base64url')).exp).toBeGreaterThan(nextYear);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
  const renewed = await saved();
  expect(renewed.value).not.toBe(first.value);
  expect(renewed.expires).toBeGreaterThan(nextYear);
});

test('signing out while the saved login is still being verified stays signed out', async ({ page, context }) => {
  let calls = 0, release;
  await page.route('**/api/auth/session', async route => {
    if (++calls !== 2) return route.continue();
    const response = await route.fetch();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response });
  });
  await register(page);
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForTimeout(500);
  release();
  await expect(page.locator('#account')).toBeVisible();
  await expect.poll(async () => (await context.cookies()).some(cookie => cookie.name === 'remote-play-session')).toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('a stale cached unversioned client cannot prevent session restoration', async ({ page }) => {
  await page.route(url => url.pathname === '/app.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: "throw new Error('Stale cached client loaded');"
  }));
  await register(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
});

test('an already-open login page saves its session before loading the updated client', async ({ page, context }) => {
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    const script = (await response.text()).replace("'X-Remote-Play-Session': '1', ", '');
    await route.fulfill({ response,
      headers: { ...response.headers(), etag: '"legacy-client"', 'cache-control': 'no-cache' }, body: script });
  });
  await register(page);
  expect((await context.cookies()).some(cookie => cookie.name === 'remote-play-session')).toBe(true);
  await page.unroute('**/app.js');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
});

test('login reports when the saved session is not retained', async ({ page }) => {
  await page.route('**/api/auth/session', route => route.fulfill({ json: { token: null } }));
  await register(page);
  await expect(page.locator('#message')).toContainText('browser did not retain your saved login');
  await expect(page.locator('#library')).toBeVisible();
});

test('invalid saved sessions return to sign-in and cross-origin session requests are rejected', async ({ page, context, baseURL }) => {
  await register(page);
  const headers = { 'X-Remote-Play-Session': '1', Origin: 'https://untrusted.example' };
  expect((await context.request.get('/api/auth/session', { headers })).status()).toBe(403);
  expect((await context.request.post('/api/auth/logout', { headers })).status()).toBe(403);
  expect((await context.request.get('/api/auth/session')).status()).toBe(403);
  await context.addCookies([{ name: 'remote-play-session', value: 'invalid-token',
    domain: new URL(baseURL).hostname, path: '/api/auth', httpOnly: true, sameSite: 'Strict' }]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await context.cookies()).some(cookie => cookie.name === 'remote-play-session')).toBe(false);
});

test('software-only 720p60 test stream renders, reports performance and reconnects', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await register(page);
  await page.screenshot({ path: testInfo.outputPath('library.png') });
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('#connecting')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('#engine')).toContainText('WebAssembly · Canvas 2D');
  await expect(page.locator('#resolution')).toHaveText('1280 × 720');
  const start = Number(await page.locator('#fps').getAttribute('data-frames'));
  const started = Date.now();
  await expect.poll(async () => Number(await page.locator('#fps').getAttribute('data-frames')), { timeout: 15000 }).toBeGreaterThan(start + 300);
  const fps = Number.parseFloat(await page.locator('#fps').textContent());
  expect(fps).toBeGreaterThan(50);
  await page.screenshot({ path: testInfo.outputPath('stream.png') });
  await testInfo.attach('performance', { body: JSON.stringify({ fps, framesSinceWarmup: Number(await page.locator('#fps').getAttribute('data-frames')) - start, measuredSeconds: (Date.now() - started) / 1000, stats: await page.locator('.stats').innerText(), gpuDisabled: true }), contentType: 'application/json' });
  expect(await page.locator('video:not([hidden]),audio').count()).toBe(0, 'canvas output leaves the video-element output hidden');
  await page.locator('#show-controls').check();
  await page.getByRole('button', { name: 'Cross', exact: true }).click();
  await page.keyboard.press('KeyW');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.locator('#library')).toBeVisible();
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('#connecting')).toBeHidden({ timeout: 30000 });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect(errors).toEqual([]);
});

test('tickets reject unknown devices, invalid bitrates and replay; socket closure frees the viewer', async ({ request, baseURL }) => {
  const name = `test_${Date.now()}`;
  const account = await request.post('/api/auth/register', { data: { username: name, email: `${name}@example.test`, password: 'LocalTestPassword_123' } });
  expect(account.ok()).toBe(true);
  const { data: { token } } = await account.json();
  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.post('/api/software/tickets', { headers, data: { hostId: 'unowned-console' } })).status()).toBe(404);
  expect((await request.post('/api/software/tickets', { headers, data: { demo: true, bitrateKbps: 999999 } })).status()).toBe(400);
  expect((await request.post('/api/software/tickets', { headers, data: { demo: true, videoCodec: 'vp9' } })).status()).toBe(400);
  expect((await request.post('/api/software/tickets', { headers, data: { demo: true, videoCodec: null } })).status()).toBe(400);
  expect((await request.post('/api/playstation/bind', { headers, data: { hostIp: '127.0.0.1' } })).status()).toBe(400);
  const createTicket = async () => (await (await request.post('/api/software/tickets', { headers, data: { demo: true } })).json()).ticket;
  const open = ticket => new Promise(resolve => {
    const socket = new WebSocket(baseURL.replace(/^http/, 'ws') + '/api/software/stream?ticket=' + ticket);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => resolve(null), { once: true });
  });
  const ticket = await createTicket();
  const socket = await open(ticket);
  expect(socket).not.toBeNull();
  expect(await open(ticket)).toBeNull();
  expect(await open(await createTicket())).toBeNull();
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  socket.send('invalid json');
  await closed;
  let next;
  await expect.poll(async () => { next = await open(await createTicket()); return next !== null; }).toBe(true);
  next.close();
});

test('main-thread fallback renders with GPU disabled and small screens remain usable', async ({ page }) => {
  await register(page, '?mainThread=1');
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1080 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('#connecting')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('#engine')).toHaveText('WebAssembly · Canvas 2D');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});

test('unauthenticated clients cannot start streams or use upstream debug endpoints', async ({ request }) => {
  expect((await request.post('/api/software/tickets', { data: { demo: true } })).status()).toBe(401);
  expect((await request.get('/api/playstation/my-devices')).status()).toBe(401);
  expect((await request.post('/api/playstation/attach-ffplay-receiver')).status()).toBe(404);
  expect((await request.get('/api/playstation/get-session')).status()).toBe(404);
});

test('JavaScript decoder fallback also renders without WebAssembly or native media APIs', async ({ page }) => {
  await page.addInitScript(() => {
    window.WebAssembly = undefined;
    for (const name of ['VideoDecoder', 'AudioContext', 'webkitAudioContext', 'RTCPeerConnection']) {
      window[name] = class { constructor() { throw new Error('Native media API used: ' + name); } };
    }
  });
  await register(page, '?mainThread=1');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('#engine')).toHaveText('JavaScript · Canvas 2D', { timeout: 30000 });
  await expect(page.locator('#connecting')).toBeHidden();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});


test('1080p60 software profile renders with real stereo audio', async ({ page }, testInfo) => {
  test.skip(!!process.env.CI, 'performance-bound: shared CI runners cannot sustain software 60 fps decoding');
  await register(page);
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
  await chooseSetting(page, 'resolution-profile', '1080p');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#resolution')).toHaveText('1920 × 1080', { timeout: 30000 });
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  if (await page.getByRole('button', { name: 'Enable sound' }).isVisible()) await page.getByRole('button', { name: 'Enable sound' }).click();
  await expect.poll(async () => Number(await page.locator('#audio-status').getAttribute('data-rms')), { timeout: 10000 }).toBeGreaterThan(0.01);
  await expect.poll(async () => Number(await page.locator('#fps').getAttribute('data-frames')), { timeout: 20000 }).toBeGreaterThan(600);
  const fps = Number.parseFloat(await page.locator('#fps').textContent());
  expect(fps).toBeGreaterThan(55);
  const timing = JSON.parse(await page.locator('#timing-status').getAttribute('data-metrics'));
  expect(timing.rttMs).toBeGreaterThanOrEqual(0);
  expect(timing.videoAgeMs).toBeGreaterThanOrEqual(0);
  expect(timing.videoAgeMs).toBeLessThan(250);
  expect(timing.pixelEngine).toBe('WASM SIMD');
  expect(Math.abs(Number(await page.locator('#audio-status').getAttribute('data-skew')))).toBeLessThanOrEqual(25);
  await testInfo.attach('timing and rendering', { body: JSON.stringify(timing), contentType: 'application/json' });
  await testInfo.attach('1080p60 performance', { body: JSON.stringify({ fps, video: await page.locator('.stats').innerText(), audio: await page.locator('#audio-status').innerText() }), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('1080p60-audio.png') });
  const underruns = Number(await page.locator('#audio-status').getAttribute('data-underruns'));
  const samples = Number(await page.locator('#audio-status').getAttribute('data-samples'));
  await page.evaluate(() => { const end = performance.now() + 500; while (performance.now() < end) {} });
  await expect.poll(async () => Number(await page.locator('#audio-status').getAttribute('data-samples'))).toBeGreaterThan(samples + 24000);
  expect(Number(await page.locator('#audio-status').getAttribute('data-underruns'))).toBe(underruns);
  await page.getByLabel('Mute', { exact: true }).check();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});

test('manual profile changes reconnect at 540p30 and burst frames recover with JavaScript pixels', async ({ page }) => {
  await page.route('**/vendor/pixels.wasm', route => route.abort());
  await register(page, '?mainThread=1');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#connecting')).toBeHidden({ timeout: 30000 });
  await page.getByRole('tab', { name: 'Picture', exact: true }).click();
  await expect(page.locator('#playing-profile')).toBeVisible();
  await chooseSetting(page, 'resolution-profile', '540p');
  await chooseSetting(page, 'fps-profile', '30');
  await expect(page.locator('#quality-status')).toContainText('press Apply to use the new settings');
  await expect(page.locator('#resolution')).toHaveText('1280 × 720');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('#resolution')).toHaveText('960 × 540', { timeout: 30000 });
  await expect(page.locator('#quality-status')).toContainText('Manual · active 540p30');
  await expect(page.locator('#render-status')).toContainText('JavaScript');
  const dropped = JSON.parse(await page.locator('#timing-status').getAttribute('data-metrics')).droppedFrames;
  await page.evaluate(() => { const until = performance.now() + 500; while (performance.now() < until) {} });
  await expect.poll(async () => JSON.parse(await page.locator('#timing-status').getAttribute('data-metrics')).droppedFrames).toBeGreaterThan(dropped);
  await expect.poll(async () => parseFloat(await page.locator('#fps').textContent())).toBeGreaterThan(27);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});

test('automatic quality responds to sustained CPU pressure and Apply restores the ceiling while keeping automatic mode', async ({ page }) => {
  await page.route('**/decoder.js', async route => {
    const response = await route.fetch();
    const script = (await response.text()).replace('codecMs: decoded ? decodeMs / decoded : 0', 'codecMs: 30');
    await route.fulfill({ response, body: script });
  });
  await register(page, '?mainThread=1');
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
  await chooseSetting(page, 'resolution-profile', '1080p');
  await page.getByLabel('Automatically adjust quality').check();
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#resolution')).toHaveText('1920 × 1080', { timeout: 30000 });
  await expect(page.locator('#resolution')).toHaveText('1280 × 720', { timeout: 30000 });
  await page.getByRole('tab', { name: 'Picture', exact: true }).click();
  await expect(page.locator('#playing-profile')).toBeVisible();
  await expect(page.locator('#quality-status')).toContainText('active 720p60');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByLabel('Automatically adjust quality')).toBeChecked();
  await expect(page.locator('#quality-status')).toContainText('Automatic');
  await expect(page.locator('#resolution')).toHaveText('1920 × 1080', { timeout: 30000 });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});

test('phone attaches input only without interrupting video and detaches independently', async ({ page, browser }) => {
  const name = await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#connecting')).toBeHidden({ timeout: 30000 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await phone.goto(page.url());
  await phone.getByLabel('Username or email').fill(name);
  await phone.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
  await phone.getByRole('button', { name: 'Attach input only' }).click();
  await expect(phone.locator('#stream-status')).toHaveText('Controller connected');
  await expect(phone.locator('#stage')).toBeHidden();
  await expect(phone.locator('#audio-controls')).toBeHidden();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const before = Number(await page.locator('#fps').getAttribute('data-frames'));
  await phone.locator('#show-controls').check();
  await phone.getByRole('button', { name: 'Cross', exact: true }).click();
  await expect.poll(async () => Number(await page.locator('#fps').getAttribute('data-frames'))).toBeGreaterThan(before + 60);
  await phone.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.bringToFront();
  await expect(page.locator('#stream-status')).toHaveText('Playing');
  await expect(page.locator('#attached-status')).toBeEmpty({ timeout: 10000 });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await context.close();
});

test('controller-only sessions show connection feedback in the toast instead of the hidden stage', async ({ page, browser }) => {
  const name = await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#connecting')).toBeHidden({ timeout: 30000 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await phone.goto(page.url());
  await phone.getByLabel('Username or email').fill(name);
  await phone.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
  await phone.getByRole('button', { name: 'Attach input only' }).click();
  await expect(phone.locator('#stream-status')).toHaveText('Controller connected');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(phone.locator('#message')).toContainText('Waiting for the same console stream', { timeout: 15000 });
  await expect(phone.locator('#toast')).toBeVisible();
  await phone.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await context.close();
});

test('stream diagnostics lists events and downloads a JSON log with per-second samples', async ({ page }) => {
  test.setTimeout(90000);
  await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(120);
  await page.locator('#stream-diagnostics summary').click();
  await expect(page.locator('#event-log li').first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download diagnostics log' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^remote-play-diagnostics-.*\.json$/);
  const data = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
  expect(data.samples.length).toBeGreaterThan(1);
  expect(data.samples.at(-1).fps).toBeGreaterThan(30);
  expect(data.events.map(event => event.type)).toEqual(expect.arrayContaining(['play', 'connected']));
  await page.locator('#send-debug').click();
  await expect(page.locator('#diagnostics-status')).toContainText('Saved on the server as', { timeout: 15000 });
  await page.locator('#stop').click();
  await expect(page.locator('#library')).toBeVisible();
  await page.locator('#diagnostics-archive summary').click();
  const entry = page.locator('#diagnostics-list a').first();
  await expect(entry).toHaveText(/^\d{8}T\d{6}Z(-\d+)?\.json$/);
  const [saved] = await Promise.all([page.waitForEvent('download'), entry.click()]);
  const stored = JSON.parse(await (await import('node:fs/promises')).readFile(await saved.path(), 'utf8'));
  expect(stored.samples.length).toBeGreaterThan(1);
  expect(data.codec).toBe('mpeg1');
});

test('gamepads poll without connection events and release when unplugged', async ({ page }) => {
  await page.addInitScript(() => {
    window.pads = [];
    Object.defineProperty(navigator, 'getGamepads', { value: () => window.pads });
    window.sentInputs = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.testSocket = this; }
      send(message) { window.sentInputs.push(JSON.parse(message)); super.send(message); }
    };
  });
  await register(page, '?mainThread=1');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#connecting')).toBeHidden({ timeout: 30000 });
  await page.evaluate(() => {
    const buttons = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
    buttons[0].pressed = true; buttons[6].value = 0.4;
    window.effects = [];
    window.pads = [{ id: 'TESLA VIRTUAL GAMEPAD (Vendor: 045a Product: 02d1)', index: 3, connected: true, mapping: 'standard', axes: [0.5, 0, 0, 0], buttons,
      vibrationActuator: { playEffect(type, params) { window.effects.push({ type, ...params }); return Promise.resolve('complete'); }, reset() { window.effects.push({ type: 'reset' }); } } }];
  });
  await expect(page.locator('#controller-status')).toContainText('Controller 3');
  await expect.poll(() => page.evaluate(() => window.sentInputs.some(m => m.button === 'CIRCLE' && m.pressed))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.sentInputs.some(m => m.type === 'triggers' && m.l2 === 0.4))).toBe(true);
  await page.evaluate(() => window.testSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'rumble', left: 255, right: 51 }) })));
  await expect.poll(() => page.evaluate(() => window.effects.at(-1))).toEqual({ type: 'dual-rumble', startDelay: 0, duration: 400, strongMagnitude: 1, weakMagnitude: 0.2 });
  await page.evaluate(() => window.testSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'rumble', left: 0, right: 0 }) })));
  await expect.poll(() => page.evaluate(() => window.effects.at(-1).type)).toBe('reset');
  await page.evaluate(() => { window.pads = []; });
  await expect.poll(() => page.evaluate(() => window.sentInputs.some(m => m.button === 'CIRCLE' && !m.pressed))).toBe(true);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});

test('failed socket startup retries with a fresh ticket; Stop cancels further attempts', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.socketAttempts = 0;
    window.WebSocket = class extends Native {
      constructor(url) { super(++window.socketAttempts === 1 ? url.replace(/ticket=.*/, 'ticket=invalid') : url); }
    };
  });
  await register(page, '?mainThread=1');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  expect(await page.evaluate(() => window.socketAttempts)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  let requests = 0;
  await page.route('**/api/software/tickets', route => { requests++; return route.fulfill({ status: 503, json: { message: 'Test outage' } }); });
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toContainText('Reconnecting');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const stoppedAt = requests;
  await page.waitForTimeout(1200);
  expect(requests).toBe(stoppedAt);
});


test('input tickets enforce account isolation, client cap, and session lifetime', async ({ request, baseURL }) => {
  const account = async suffix => {
    const name = `test_${Date.now()}_${suffix}`;
    const response = await request.post('/api/auth/register', { data: { username: name, email: `${name}@example.test`, password: 'LocalTestPassword_123' } });
    const { data: { token } } = await response.json();
    return { Authorization: `Bearer ${token}` };
  };
  const alice = await account('a'), bob = await account('b');
  const ticket = async (headers, data) => (await (await request.post('/api/software/tickets', { headers, data })).json()).ticket;
  const open = value => new Promise(resolve => {
    const socket = new WebSocket(baseURL.replace(/^http/, 'ws') + '/api/software/stream?ticket=' + value);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => resolve(null), { once: true });
  });
  const viewer = await open(await ticket(alice, { demo: true }));
  expect(viewer).not.toBeNull();
  const heartbeat = setInterval(() => { if (viewer.readyState === WebSocket.OPEN) viewer.send('{"type":"ping"}'); }, 1000);
  let session;
  await expect.poll(async () => { session = await (await request.get('/api/software/active', { headers: alice })).json(); return !!session?.sessionId; }).toBe(true);
  expect(await (await request.get('/api/software/active', { headers: bob })).json()).toBeNull();
  expect((await request.post('/api/software/tickets', { headers: bob, data: { inputSession: session.sessionId } })).status()).toBe(404);
  expect((await request.post('/api/software/tickets', { headers: alice, data: { demo: true, resolution: '4k' } })).status()).toBe(400);
  const peers = [];
  for (let i = 0; i < 4; i++) peers.push(await open(await ticket(alice, { inputSession: session.sessionId })));
  expect(peers.every(Boolean)).toBe(true);
  expect(await open(await ticket(alice, { inputSession: session.sessionId }))).toBeNull();
  const stale = await ticket(alice, { inputSession: session.sessionId });
  const closed = peers.map(peer => new Promise(resolve => peer.addEventListener('close', resolve, { once: true })));
  viewer.close(); clearInterval(heartbeat);
  await Promise.all(closed);
  expect(await open(stale)).toBeNull();
});

test('audio fallback and automatic video worker fallback remain playable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(AudioContext.prototype, 'audioWorklet', { get: () => undefined });
    window.Worker = class {
      constructor() { setTimeout(() => this.onerror?.(new Event('error')), 0); }
      postMessage() {}
      terminate() {}
    };
  });
  await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await expect(page.locator('#engine')).toHaveText('WebAssembly · Canvas 2D');
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  if (await page.getByRole('button', { name: 'Enable sound' }).isVisible()) await page.getByRole('button', { name: 'Enable sound' }).click();
  await expect(page.locator('#audio-status')).toContainText('Web Audio fallback', { timeout: 10000 });
  await expect.poll(async () => Number(await page.locator('#audio-status').getAttribute('data-rms'))).toBeGreaterThan(0.01);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});

test('balanced software playback applies during a stream and survives refresh', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing');
  await page.getByRole('tab', { name: 'Picture', exact: true }).click();
  await page.locator('#advanced-settings > summary').click();
  await chooseSetting(page, 'frame-pacing', 'balanced');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(100);
  await expect(page.locator('#engine')).toContainText('Canvas 2D');
  await page.reload();
  await expect(page.locator('#stream-status')).toHaveText('Playing');
  await expect(page.locator('#frame-pacing')).toHaveValue('balanced');
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(100);
  await page.locator('#stop').click();
  expect(errors).toEqual([]);
});

test('lower profiles use the selected dimensions and frame rate', async ({ page }) => {
  await register(page);
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
  for (const [resolution, fps, dimensions] of [['360p', '30', '640 × 360'], ['540p', '60', '960 × 540']]) {
    await chooseSetting(page, 'resolution-profile', resolution);
    await chooseSetting(page, 'fps-profile', fps);
    await page.getByRole('button', { name: 'Start test stream' }).click();
    await expect(page.locator('#resolution')).toHaveText(dimensions, { timeout: 30000 });
    await expect.poll(async () => Number.parseFloat(await page.locator('#fps').textContent())).toBeGreaterThan(Number(fps) - 4);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  }
});

for (const renderer of ['worker', 'mainThread']) {
  test(`${renderer} playback survives repeated fullscreen transitions and reconnects`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await register(page, renderer === 'mainThread' ? '?mainThread=1' : '');
    await page.getByRole('button', { name: 'Start test stream' }).click();
    await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
    const frames = async () => Number(await page.locator('#fps').getAttribute('data-frames'));
    for (let i = 0; i < 4; i++) {
      const before = await frames();
      if (i % 2 === 0) await page.locator('#fullscreen').click();
      else await page.locator('#stage').dblclick();
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(i % 2 === 0);
      await expect.poll(frames).toBeGreaterThan(before + 30);
    }
    await page.locator('#fullscreen').click();
    await page.locator('#stage').dblclick();
    await page.locator('#stop').click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await page.getByRole('button', { name: 'Start test stream' }).click();
    await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
    await page.locator('#stop').click();
    expect(errors).toEqual([]);
  });
}

test('worker playback recovers when browser animation callbacks stop', async ({ page }) => {
  await register(page);
  let tickets = 0;
  page.on('request', request => { if (request.url().includes('/api/software/tickets')) tickets++; });
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await expect(page.locator('#engine')).toContainText('worker');
  const frames = () => page.locator('#fps').getAttribute('data-frames').then(Number);
  const worker = page.workers().find(worker => worker.url().endsWith('/stream-worker.js'));
  expect(worker).toBeTruthy();
  await worker.evaluate(() => {
    self.requestAnimationFrame = () => 1;
    self.cancelAnimationFrame = () => {};
  });
  const before = await frames();
  await page.locator('#fullscreen').click();
  await expect.poll(frames).toBeGreaterThan(before + 100);
  expect(tickets).toBe(1);
  await page.locator('#stage').dblclick();
  await page.locator('#stop').click();
});

test('live telemetry reaches the server while the debug switch is on', async ({ page }) => {
  const name = await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await page.locator('#debug-mode').check();
  await page.locator('#debug-telemetry').check();
  const login = await page.request.post('/api/auth/login', { data: { usernameOrEmail: name, password: 'LocalTestPassword_123' } });
  const token = (await login.json()).data.token;
  const live = async () => page.request.get('/api/diagnostics/live', { headers: { Authorization: `Bearer ${token}` } });
  await expect.poll(async () => { const response = await live(); return response.ok() ? (await response.json()).samples.length : -1; }, { timeout: 20000 }).toBeGreaterThan(1);
  const snapshot = await (await live()).json();
  expect(snapshot.demo).toBe(true);
  expect(snapshot.samples.at(-1).fps).toBeGreaterThan(30);
  expect(snapshot.received).toBeGreaterThan(1);
  await page.locator('#stop').click();
  await expect.poll(async () => (await live()).status()).toBe(404);
});

test('Test rumble explains itself without a controller', async ({ page }) => {
  await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await page.getByRole('tab', { name: 'Controls', exact: true }).click();
  await page.getByRole('button', { name: 'Test rumble' }).click();
  await expect(page.locator('#rumble-status')).toContainText('No controller detected');
  await page.locator('#stop').click();
});
