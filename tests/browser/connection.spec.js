import { test, expect } from '@playwright/test';

async function register(page) {
  await page.addInitScript(() => localStorage.setItem('remote-play:video-mode', 'mpeg1'));
  await page.goto('/?mainThread=1');
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `connection_${Date.now()}`;
  await page.getByLabel('Username (letters, numbers, underscore)').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('#library')).toBeVisible();
}

test('retry keeps the player, settings, scroll position and readable message in place', async ({ page }) => {
  await register(page);
  const pending = [];
  await page.route('**/api/software/tickets', route => { pending.push(route); });
  await page.locator('#demo').click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('#library')).toBeHidden();
  await page.evaluate(() => {
    window.playerHides = 0;
    new MutationObserver(records => {
      window.playerHides += records.filter(record => record.oldValue === null).length;
    }).observe(document.getElementById('player'), { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
    window.scrollTo(0, 160);
  });
  const before = await page.locator('#stage').boundingBox();
  const scroll = await page.evaluate(() => scrollY);
  const message = 'The console is still starting. Please wait for the next attempt.';
  await pending[0].fulfill({ status: 503, json: { message } });
  await expect.poll(() => pending.length).toBe(2);
  await expect(page.locator('#connection-message')).toHaveText(message);
  expect(await page.locator('#stage').boundingBox()).toEqual(before);
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  expect(await page.evaluate(() => window.playerHides)).toBe(0);
  await expect(page.locator('#playing-profile #profile-settings')).toHaveCount(1);
  await page.locator('#stop').click();
  await expect(page.locator('#library')).toBeVisible();
});

test('busy feedback stays visible and retries only when the user asks', async ({ page }) => {
  await register(page);
  let requests = 0;
  const message = 'Another stream is still active on this server. Disconnect that stream before trying again.';
  await page.route('**/api/software/tickets', route => {
    requests++;
    return route.fulfill({ status: 409, json: { message } });
  });
  await page.locator('#demo').click();
  await expect(page.locator('#connection-message')).toHaveText(message);
  await expect(page.locator('#stream-status')).toHaveText('Connection failed');
  await expect(page.locator('#retry-stream')).toBeEnabled();
  const before = await page.locator('#stage').boundingBox();
  await page.waitForTimeout(1200);
  expect(requests).toBe(1);
  await page.locator('#retry-stream').click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('#retry-stream')).toBeEnabled();
  expect(await page.locator('#stage').boundingBox()).toEqual(before);
  await expect(page.locator('#connection-message')).toHaveText(message);
  await page.locator('#stop').click();
});

test('exhausted retries leave the failure on screen with a manual retry action', async ({ page }) => {
  await register(page);
  await page.clock.install();
  let requests = 0;
  await page.route('**/api/software/tickets', route => {
    requests++;
    return route.fulfill({ status: 503, json: { message: 'Console did not respond.' } });
  });
  await page.locator('#demo').click();
  await expect(page.locator('#stream-status')).toContainText('attempt 1/5');
  for (const [index, delay] of [500, 1000, 2000, 4000, 8000].entries()) {
    await page.clock.runFor(delay + 50);
    await expect.poll(() => requests).toBe(index + 2);
    if (index < 4) await expect(page.locator('#stream-status')).toContainText(`attempt ${index + 2}/5`);
  }
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('#library')).toBeHidden();
  await expect(page.locator('#connection-message')).toContainText('Console did not respond. Automatic reconnection stopped after five attempts.');
  await expect(page.locator('#retry-stream')).toBeEnabled();
  await page.locator('#stop').click();
});

test('retry preserves fullscreen until the user disconnects', async ({ page }) => {
  await register(page);
  const pending = [];
  await page.route('**/api/software/tickets', route => { pending.push(route); });
  await page.locator('#demo').click();
  await expect.poll(() => pending.length).toBe(1);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('player');
  await pending[0].fulfill({ status: 503, json: { message: 'Retrying the connection.' } });
  await expect.poll(() => pending.length).toBe(2);
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('player');
  await expect(page.locator('#connection-message')).toHaveText('Retrying the connection.');
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('busy tickets explain the conflict and a replacement waits for the previous viewer to close', async ({ request, baseURL }) => {
  const name = `handoff_${Date.now()}`;
  const account = await request.post('/api/auth/register', { data: { username: name, email: `${name}@example.test`, password: 'LocalTestPassword_123' } });
  const { data: { token } } = await account.json();
  const headers = { Authorization: `Bearer ${token}` };
  const ticket = () => request.post('/api/software/tickets', { headers, data: { demo: true, resolution: '360p', fps: 30 } });
  const open = async response => {
    expect(response.status()).toBe(200);
    const socket = new WebSocket(baseURL.replace(/^http/, 'ws') + '/api/software/stream?ticket=' + (await response.json()).ticket);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return socket;
  };
  const first = await open(await ticket());
  const heartbeat = setInterval(() => { if (first.readyState === WebSocket.OPEN) first.send(JSON.stringify({ type: 'ping', clientTime: Date.now() })); }, 1000);
  let replacement;
  try {
    const busy = await ticket();
    expect(busy.status()).toBe(409);
    expect((await busy.json()).message).toContain('Another stream is still active');
    let settled = false;
    const pending = ticket().then(response => { settled = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    first.close();
    replacement = await open(await pending);
  } finally { clearInterval(heartbeat); first.close(); replacement?.close(); }
});
