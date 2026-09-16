import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

async function register(page) {
  await page.goto('/');
  await page.locator('#auth-toggle').click();
  const name = `swipe_${Date.now()}`;
  await page.locator('#username').fill(name);
  await page.locator('#email').fill(`${name}@example.test`);
  await page.locator('#password').fill('LocalTestPassword_123');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#library')).toBeVisible();
}

async function swipe(session, from, to) {
  const point = (x, y) => ({ x, y, id: 1 });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(...from)] });
  for (let step = 1; step <= 5; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(from[0] + (to[0] - from[0]) * step / 5, from[1] + (to[1] - from[1]) * step / 5)] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

for (const fallback of [true, false]) {
  test(`downward swipe exits ${fallback ? 'iPhone-style theater' : 'native fullscreen'} while other gestures keep playing`, async ({ page, context }) => {
    if (fallback) await page.addInitScript(() => { Element.prototype.requestFullscreen = undefined; });
    await register(page);
    await page.route('**/api/software/tickets', route => route.fulfill({ status: 409, json: { message: 'Test connection feedback.' } }));
    await page.locator('#demo').click();
    await expect(page.locator('#retry-stream')).toBeEnabled();
    await page.locator('#fullscreen').click();
    const active = () => page.evaluate(() => !!document.fullscreenElement || document.getElementById('player').classList.contains('theater'));
    await expect.poll(active).toBe(true);
    const session = await context.newCDPSession(page);
    await swipe(session, [100, 200], [100, 230]);
    expect(await active()).toBe(true);
    await swipe(session, [100, 200], [250, 210]);
    expect(await active()).toBe(true);
    await swipe(session, [100, 250], [100, 100]);
    expect(await active()).toBe(true);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 100, id: 1 }, { x: 200, y: 100, id: 2 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y: 250, id: 1 }, { x: 200, y: 250, id: 2 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await active()).toBe(true);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 100, id: 1 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(await active()).toBe(true);
    await swipe(session, [100, 100], [110, 250]);
    await expect.poll(active).toBe(false);
    await expect(page.locator('.player-bar')).toBeVisible();
    await expect(page.locator('#connection-message')).toHaveText('Test connection feedback.');
    await expect(page.locator('#player')).toBeVisible();
    await page.locator('#show-controls').check();
    await page.locator('#fullscreen').click();
    const pad = await page.getByRole('button', { name: 'D-pad up', exact: true }).boundingBox();
    await swipe(session, [pad.x + pad.width / 2, pad.y + 5], [pad.x + pad.width / 2, pad.y + 120]);
    expect(await active()).toBe(true);
    await swipe(session, [100, 100], [100, 260]);
    await expect.poll(active).toBe(false);
    await page.locator('#stop').click();
  });
  test(`a tap reveals a temporary exit button with touch controls off (${fallback ? 'theater' : 'native'})`, async ({ page }) => {
    if (fallback) await page.addInitScript(() => { Element.prototype.requestFullscreen = undefined; });
    await register(page);
    await page.route('**/api/software/tickets', route => route.fulfill({ status: 409, json: { message: 'Test connection feedback.' } }));
    await page.locator('#demo').click();
    await expect(page.locator('#retry-stream')).toBeEnabled();
    await page.locator('#fullscreen').click();
    const exit = page.locator('#fullscreen-exit');
    await expect(exit).toBeHidden();
    await page.touchscreen.tap(150, 200);
    await expect(exit).toBeVisible();
    expect((await exit.boundingBox()).height).toBeGreaterThanOrEqual(48);
    await expect(page.locator('.player-bar')).toBeHidden();
    await page.screenshot({ path: `/tmp/psrp-exit-${fallback ? 'theater' : 'native'}.png` });
    await expect(exit).toBeHidden({ timeout: 6500 });
    await page.touchscreen.tap(150, 200);
    await expect(exit).toBeVisible();
    await exit.tap();
    await expect(page.locator('.player-bar')).toBeVisible();
    await expect(exit).toBeHidden();
    await page.locator('#show-controls').check();
    await page.locator('#fullscreen').click();
    await page.touchscreen.tap(150, 150);
    await expect(exit).toBeHidden();
    await page.locator('#stage').dblclick();
    await page.locator('#stop').click();
  });

  test(`multi-finger taps toggle controls and debug, swipes cycle HUDs without reconnecting (${fallback ? 'theater' : 'native'})`, async ({ page, context }) => {
    if (fallback) await page.addInitScript(() => { Element.prototype.requestFullscreen = undefined; });
    await register(page);
    let tickets = 0;
    await page.route('**/api/software/tickets', route => { tickets++; return route.fulfill({ status: 409, json: { message: 'Test connection feedback.' } }); });
    await page.locator('#demo').click();
    await expect(page.locator('#retry-stream')).toBeEnabled();
    await page.locator('#fullscreen').click();
    const session = await context.newCDPSession(page);
    const tap = async count => {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: Array.from({ length: count }, (_, id) => ({ x: 90 + id * 60, y: 110, id: id + 1 })) });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const hud = page.locator('#debug-overlay');
    await expect(hud).toBeHidden();
    await tap(2);
    await expect(hud).toBeVisible();
    await expect(hud).toHaveAttribute('data-layout', 'detailed');
    await swipe(session, [270, 120], [90, 120]);
    await expect(hud).toHaveAttribute('data-layout', 'minimal');
    await swipe(session, [90, 120], [270, 120]);
    await expect(hud).toHaveAttribute('data-layout', 'detailed');
    await swipe(session, [90, 120], [270, 120]);
    await expect(hud).toHaveAttribute('data-layout', 'horizontal');
    await tap(3);
    await expect(page.locator('#controls')).toBeVisible();
    await tap(3);
    await expect(page.locator('#controls')).toBeHidden();
    await expect(page.locator('#fullscreen-exit')).toBeHidden();
    await tap(2);
    await expect(hud).toBeHidden();
    await swipe(session, [270, 120], [90, 120]);
    await expect(hud).toHaveAttribute('data-layout', 'horizontal');
    await tap(2);
    await expect(hud).toBeVisible();
    await expect(hud).toHaveAttribute('data-layout', 'horizontal');
    await tap(4);
    await expect(hud).toBeVisible();
    await expect(page.locator('#controls')).toBeHidden();
    await expect(page.locator('.player-bar')).toBeHidden();
    expect(tickets).toBe(1);
    await swipe(session, [100, 100], [100, 260]);
    await expect(page.locator('.player-bar')).toBeVisible();
    await page.locator('#stop').click();
    await page.reload();
    await expect(page.locator('#library')).toBeVisible();
    await expect(page.locator('#debug-mode')).toBeChecked();
    await expect(page.locator('#show-controls')).not.toBeChecked();
    await expect(page.locator('#hud-style')).toHaveValue('horizontal');
  });

}
