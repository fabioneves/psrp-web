import { test, expect } from '@playwright/test';

async function register(page) {
  await page.goto('/?mainThread=1');
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `cleanup_${Date.now()}`;
  await page.getByLabel('Username (letters, numbers, underscore)').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
}

test('disconnect all is authenticated, scoped to paired consoles and shows completion feedback', async ({ page, request }) => {
  expect((await request.post('/api/software/disconnect', { data: { hostId: 'unpaired' } })).status()).toBe(401);
  await page.route('**/api/playstation/my-devices', route => route.fulfill({ json: [{ hostId: 'unpaired', hostName: 'Test PS5', hostType: 'PS5', isRegistered: true }] }));
  await register(page);
  const response = await page.request.get('/api/auth/session', { headers: { 'X-Remote-Play-Session': '1' } });
  const headers = { Authorization: `Bearer ${(await response.json()).token}` };
  expect((await page.request.post('/api/software/disconnect', { headers, data: { hostId: 'unpaired' } })).status()).toBe(404);
  let complete;
  await page.route('**/api/software/disconnect', route => new Promise(resolve => {
    expect(route.request().postDataJSON()).toEqual({ hostId: 'unpaired' });
    complete = async () => { await route.fulfill({ json: { stopped: 2, message: 'All server sessions disconnected.' } }); resolve(); };
  }));
  const button = page.locator('.device').getByRole('button', { name: 'Disconnect all sessions' });
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator('#message')).toContainText('Disconnecting all sessions');
  await expect.poll(() => !!complete).toBe(true);
  await complete();
  await expect(page.locator('#message')).toHaveText('All server sessions disconnected.');
  await expect(button).toBeEnabled();
});

test('a browser without heartbeats is disconnected and releases the viewer slot', async ({ request, baseURL }) => {
  const name = `abandoned_${Date.now()}`;
  const response = await request.post('/api/auth/register', { data: { username: name, email: `${name}@example.test`, password: 'LocalTestPassword_123' } });
  const { data: { token } } = await response.json();
  const headers = { Authorization: `Bearer ${token}` };
  const connect = async () => {
    const response = await request.post('/api/software/tickets', { headers, data: { demo: true, resolution: '360p', fps: 30, videoCodec: 'h264' } });
    const { ticket } = await response.json();
    const socket = new WebSocket(baseURL.replace(/^http/, 'ws') + '/api/software/stream?ticket=' + ticket);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return socket;
  };
  const abandoned = await connect();
  try {
    await expect.poll(() => abandoned.readyState, { timeout: 15000 }).toBe(WebSocket.CLOSED);
    await expect.poll(async () => (await request.get('/api/software/active', { headers })).json()).toBeNull();
    const replacement = await connect();
    replacement.close();
  } finally { abandoned.close(); }
});

test('a forced disconnect stops browser retries instead of reclaiming the console', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = WebSocket;
    window.WebSocket = class extends Native { constructor(...args) { super(...args); window.testSocket = this; } };
  });
  await register(page);
  let tickets = 0;
  page.on('request', request => { if (request.url().includes('/api/software/tickets')) tickets++; });
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#stream-status')).toHaveText('Playing', { timeout: 30000 });
  await page.evaluate(() => window.testSocket.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'Disconnected by user' })));
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#message')).toContainText('All sessions for this console were disconnected');
  const before = tickets;
  await page.waitForTimeout(2500);
  expect(tickets).toBe(before);
});
