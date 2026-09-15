import { test, expect } from '@playwright/test';

async function register(page, suffix = '?mainThread=1') {
  await page.goto('/' + suffix);
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `hardware_${Date.now()}`;
  await page.getByLabel('Username (letters, numbers, underscore)').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('LocalTestPassword_123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your consoles', exact: true })).toBeVisible();
  await page.locator('#stream-settings > summary').click();
}

async function useNativeSoftwareDecoder(page, fail = false, dropOutputs = false) {
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.log(message.text()); });
  const install = ({ fail, dropOutputs }) => {
    const Native = globalThis.VideoDecoder;
    globalThis.decoderPreferences = [];
    globalThis.nativeErrors = [];
    globalThis.VideoDecoder = class extends Native {
      constructor(options) {
        let frames = 0;
        super({ ...options,
          output(frame) { if (dropOutputs === 'all' || (dropOutputs && ++frames % 5 === 0)) frame.close(); else options.output(frame); },
          error(error) { globalThis.nativeErrors.push(error.message); options.error(error); } });
      }
      decode(chunk) {
        try { super.decode(chunk); }
        catch (error) { globalThis.nativeErrors.push(error.message); throw error; }
      }
      static isConfigSupported(config) { return Native.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' }); }
      configure(config) {
        globalThis.decoderPreferences.push(config.hardwareAcceleration);
        if (fail) throw new Error('Simulated hardware decoder failure');
        try { super.configure({ ...config, hardwareAcceleration: 'prefer-software' }); }
        catch (error) { globalThis.nativeErrors.push(error.message); throw error; }
      }
    };
  };
  await page.addInitScript(install, { fail, dropOutputs });
  page.on('worker', worker => worker.evaluate(install, { fail, dropOutputs }).catch(() => {}));
}

test('native video tolerates decoder-discarded frames without mistaking timing records for a stall', async ({ page }) => {
  await useNativeSoftwareDecoder(page, false, true);
  await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('H.264', { timeout: 30000 });
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number), { timeout: 15000 }).toBeGreaterThan(300);
  await expect(page.locator('#engine')).toContainText('H.264');
  await page.locator('#stop').click();
});

test('native video falls back when the decoder genuinely stops producing frames', async ({ page }) => {
  await useNativeSoftwareDecoder(page, false, 'all');
  await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('WebAssembly · Canvas 2D', { timeout: 30000 });
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(60);
  await expect(page.locator('#hardware-acceleration')).toBeChecked();
  await page.locator('#stop').click();
});

test('acceleration defaults on, unavailable hardware falls back, and opting out survives refresh', async ({ page }) => {
  await page.addInitScript(() => { window.VideoDecoder = undefined; });
  await register(page);
  await expect(page.locator('#hardware-acceleration')).toBeChecked();
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('WebAssembly · Canvas 2D', { timeout: 30000 });
  await expect(page.locator('#acceleration-status')).toContainText('unavailable');
  await page.locator('#stop').click();
  await page.locator('#hardware-acceleration').uncheck();
  await page.reload();
  await page.locator('#stream-settings > summary').click();
  await expect(page.locator('#hardware-acceleration')).not.toBeChecked();
});

for (const resolution of ['720p', '1080p']) {
  test(`native H.264 ${resolution}60 renders real frames with audio and switches to software`, async ({ page }) => {
    await useNativeSoftwareDecoder(page);
    await register(page);
    await page.locator('#resolution-profile').selectOption(resolution);
    await page.getByRole('button', { name: 'Start test stream' }).click();
    await expect(page.locator('#engine')).toContainText('H.264 · hardware preferred', { timeout: 30000 });
    await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(100);
    await expect(page.locator('#resolution')).toHaveText(resolution === '720p' ? '1280 × 720' : '1920 × 1080');
    await page.getByRole('button', { name: 'Enable sound' }).click();
    await expect.poll(() => page.locator('#audio-status').getAttribute('data-rms').then(Number)).toBeGreaterThan(0.01);
    expect(await page.evaluate(() => window.decoderPreferences.every(value => value === 'prefer-hardware'))).toBe(true);
    await page.locator('#fullscreen').click();
    const before = Number(await page.locator('#fps').getAttribute('data-frames'));
    await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(before + 60);
    await page.locator('#fullscreen').click();
    await page.locator('#performance-details > summary').click();
    await page.locator('#hardware-acceleration').uncheck();
    await expect(page.locator('#engine')).toContainText('WebAssembly · Canvas 2D', { timeout: 30000 });
    await page.locator('#stop').click();
  });
}

test('native decoder failure automatically retries in software without changing the preference', async ({ page }) => {
  await useNativeSoftwareDecoder(page, true);
  await register(page);
  const codecs = [];
  page.on('request', request => {
    if (request.url().includes('/api/software/tickets')) codecs.push(request.postDataJSON().videoCodec);
  });
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('WebAssembly · Canvas 2D', { timeout: 30000 });
  expect(codecs[0]).toBe('h264');
  expect(codecs.slice(1).every(codec => codec === 'mpeg1')).toBe(true);
  await expect(page.locator('#message')).toHaveText('');
  await expect(page.locator('#hardware-acceleration')).toBeChecked();
  await page.locator('#stop').click();
});

test('native H.264 runs in the video worker with direct audio output', async ({ page }) => {
  await useNativeSoftwareDecoder(page);
  await register(page, '');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toHaveText('H.264 · hardware preferred · Canvas 2D · worker', { timeout: 30000 });
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Enable sound' }).click();
  await expect.poll(() => page.locator('#audio-status').getAttribute('data-rms').then(Number)).toBeGreaterThan(0.01);
  const worker = page.workers().find(worker => worker.url().endsWith('/stream-worker.js'));
  expect(await worker.evaluate(() => globalThis.decoderPreferences)).toEqual(['prefer-hardware']);
  await page.locator('#stop').click();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus)
    console.log('Native decoder diagnostics:', await page.evaluate(() => ({ errors: window.nativeErrors, preferences: window.decoderPreferences, message: document.getElementById('message')?.textContent })));
});
