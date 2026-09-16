import { test, expect } from '@playwright/test';
import { chooseSetting } from './settings.js';

const password = 'LocalTestPassword_123';

async function register(page, name) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a local account' }).click();
  await page.getByLabel('Username (letters, numbers, underscore)').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('#library')).toBeVisible();
}

async function signIn(page, name) {
  await page.goto('/');
  await page.getByLabel('Username or email').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#library')).toBeVisible();
}

test('settings follow the account to a browser that never saw them', async ({ browser }) => {
  const name = `sync_${Date.now()}`;
  const first = await browser.newContext();
  const page = await first.newPage();
  await register(page, name);
  await chooseSetting(page, 'resolution-profile', '540p');
  await page.getByLabel('Automatically adjust quality').check();
  const upload = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT' && response.status() === 204 && response.request().postData().includes('"fps-profile":"30"'));
  await chooseSetting(page, 'fps-profile', '30');
  await upload;
  await first.close();

  const second = await browser.newContext();
  const other = await second.newPage();
  await signIn(other, name);
  await expect(other.locator('#resolution-profile')).toHaveValue('540p');
  await expect(other.getByLabel('Automatically adjust quality')).toBeChecked();
  await expect(other.locator('#fps-profile')).toHaveValue('30');
  await expect(other.locator('#quality-status')).toContainText('Automatic');
  await second.close();
});

test('a browser with local settings uploads them when the account has none yet', async ({ browser }) => {
  const name = `seed_${Date.now()}`;
  const first = await browser.newContext();
  const page = await first.newPage();
  await page.addInitScript(() => { localStorage.setItem('remote-play:fps-profile', '30'); localStorage.setItem('remote-play:invert-y', 'true'); });
  const upload = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT' && response.status() === 204);
  await register(page, name);
  await upload;
  await first.close();

  const second = await browser.newContext();
  const other = await second.newPage();
  await signIn(other, name);
  await expect(other.locator('#fps-profile')).toHaveValue('30');
  await expect(other.locator('#invert-y')).toBeChecked();
  await second.close();
});
