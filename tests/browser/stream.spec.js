import { test, expect } from '@playwright/test';

async function register(page, suffix = '') {
  await page.goto('/' + suffix);
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `test_${Date.now()}`;
  await page.getByLabel('Username (letters, numbers, underscore)').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
}

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
  expect(await page.locator('video,audio').count()).toBe(0);
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
