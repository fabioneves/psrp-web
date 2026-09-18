import { test, expect } from '@playwright/test';

test('a missing page answers 404 with a readable body, so browsers show it instead of offering a download', async ({ request }) => {
  for (const path of ['/no-such-page.html', '/no-such-page', '/assets/0000/app.js']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()['content-type'], path).toContain('text/plain');
    expect(await response.text(), path).toContain('Not found');
  }
  expect((await request.get('/api/no-such-endpoint')).status()).toBe(404);
  expect((await request.get('/api/settings')).status()).toBe(401);
});
