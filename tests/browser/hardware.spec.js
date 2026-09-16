import { chooseSetting } from './settings.js';
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
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
}

async function useNativeSoftwareDecoder(page, fail = false, dropOutputs = false, hevcMode = null) {
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.log(message.text()); });
  const install = ({ fail, dropOutputs, hevcMode }) => {
    const Native = globalThis.VideoDecoder;
    globalThis.decoderPreferences = [];
    globalThis.nativeErrors = [];
    globalThis.hevcChunks = [];
    globalThis.hevcConfigurations = [];
    globalThis.VideoDecoder = class extends Native {
      constructor(options) {
        let frames = 0;
        super({ ...options,
          output(frame) { if (dropOutputs === 'all' || (dropOutputs === 'late' && ++frames > 60) || (dropOutputs === true && ++frames % 5 === 0)) frame.close(); else options.output(frame); },
          error(error) { globalThis.nativeErrors.push(error.message); options.error(error); } });
        this.output = options.output;
      }
      get decodeQueueSize() { return this.hevc ? 0 : super.decodeQueueSize; }
      get state() { return this.hevc ? 'configured' : super.state; }
      decode(chunk) {
        if (this.hevc) {
          if (globalThis.hevcChunks.length < 20) {
            const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
            const types = [];
            for (let i = 0; i + 4 < bytes.length; i++)
              if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) types.push((bytes[i + 3] >> 1) & 63);
            globalThis.hevcChunks.push({ type: chunk.type, types });
          }
          const canvas = new OffscreenCanvas(1280, 720);
          canvas.getContext('2d').fillRect(0, 0, 1280, 720);
          this.output(new VideoFrame(canvas, { timestamp: chunk.timestamp }));
          return;
        }
        try { super.decode(chunk); }
        catch (error) { globalThis.nativeErrors.push(error.message); throw error; }
      }
      static isConfigSupported(config) {
        if (hevcMode && config.codec.startsWith('hev1.')) return Promise.resolve({ supported: hevcMode !== 'unsupported' });
        return Native.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' });
      }
      configure(config) {
        globalThis.decoderPreferences.push(config.hardwareAcceleration);
        if (hevcMode && config.codec.startsWith('hev1.')) {
          if (hevcMode === 'fail') throw new Error('Simulated HEVC decoder failure');
          this.hevc = true; globalThis.hevcConfigurations.push(config); return;
        }
        if (fail) throw new Error('Simulated hardware decoder failure');
        try { super.configure({ ...config, hardwareAcceleration: 'prefer-software' }); }
        catch (error) { globalThis.nativeErrors.push(error.message); throw error; }
      }
    };
  };
  await page.addInitScript(install, { fail, dropOutputs, hevcMode });
  page.on('worker', worker => worker.evaluate(install, { fail, dropOutputs, hevcMode }).catch(() => {}));
}

test('native video tolerates decoder-discarded frames without mistaking timing records for a stall', async ({ page }) => {
  test.skip(!!process.env.CI, 'performance-bound: shared CI runners cannot sustain software 60 fps decoding');
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
  await expect(page.locator('#video-mode')).toHaveValue('auto');
  await page.locator('#stop').click();
});

test('a decoder that stalls after producing frames reconnects with the same codec instead of downgrading', async ({ page }) => {
  await useNativeSoftwareDecoder(page, false, 'late');
  await register(page);
  const codecs = [];
  page.on('request', request => { if (request.url().includes('/api/software/tickets')) codecs.push(request.postDataJSON().videoCodec); });
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('H.264', { timeout: 30000 });
  await expect.poll(() => codecs.length, { timeout: 30000 }).toBeGreaterThan(1);
  expect(codecs.every(codec => codec === 'h264')).toBe(true);
  await expect(page.locator('#video-mode-status')).not.toContainText('Using');
  await expect(page.locator('#engine')).toContainText('H.264');
  await page.locator('#stop').click();
});

test('Automatic defaults on, unavailable decoding falls back, and Canvas survives refresh', async ({ page }) => {
  await page.addInitScript(() => { window.VideoDecoder = undefined; });
  await register(page);
  await expect(page.locator('#video-mode')).toHaveValue('auto');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('WebAssembly · Canvas 2D', { timeout: 30000 });
  await expect(page.locator('#video-mode-status')).toContainText('unavailable');
  await page.locator('#stop').click();
  await chooseSetting(page, 'video-mode', 'mpeg1');
  await page.reload();
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
  await expect(page.locator('#video-mode')).toHaveValue('mpeg1');
});

for (const resolution of ['720p', '1080p']) {
  test(`native H.264 ${resolution}60 renders real frames with audio and switches to software`, async ({ page }) => {
    await useNativeSoftwareDecoder(page);
    await register(page);
    await chooseSetting(page, 'resolution-profile', resolution);
    await page.getByRole('button', { name: 'Start test stream' }).click();
    await expect(page.locator('#engine')).toContainText('H.264 · hardware preferred', { timeout: 30000 });
    await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(100);
    await expect(page.locator('#resolution')).toHaveText(resolution === '720p' ? '1280 × 720' : '1920 × 1080');
    await page.getByRole('tab', { name: 'Sound', exact: true }).click();
    if (await page.getByRole('button', { name: 'Enable sound' }).isVisible()) await page.getByRole('button', { name: 'Enable sound' }).click();
    await expect.poll(() => page.locator('#audio-status').getAttribute('data-rms').then(Number)).toBeGreaterThan(0.01);
    expect(await page.evaluate(() => window.decoderPreferences.every(value => value === 'prefer-hardware'))).toBe(true);
    await page.locator('#fullscreen').click();
    const before = Number(await page.locator('#fps').getAttribute('data-frames'));
    await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(before + 60);
    await page.locator('#stage').dblclick();
    await page.getByRole('tab', { name: 'Picture', exact: true }).click();
    await expect(page.locator('#playing-profile')).toBeVisible();
    await chooseSetting(page, 'video-mode', 'mpeg1');
    await expect(page.locator('#engine')).toContainText('H.264 · hardware preferred');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
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
  await expect(page.locator('#video-mode')).toHaveValue('auto');
  await page.locator('#stop').click();
});

test('native H.264 runs in the video worker with direct audio output', async ({ page }) => {
  await useNativeSoftwareDecoder(page);
  await register(page, '');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toHaveText('H.264 · hardware preferred · Canvas 2D · worker', { timeout: 30000 });
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(100);
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  if (await page.getByRole('button', { name: 'Enable sound' }).isVisible()) await page.getByRole('button', { name: 'Enable sound' }).click();
  await expect.poll(() => page.locator('#audio-status').getAttribute('data-rms').then(Number)).toBeGreaterThan(0.01);
  const worker = page.workers().find(worker => worker.url().endsWith('/stream-worker.js'));
  expect(await worker.evaluate(() => globalThis.decoderPreferences)).toEqual(['prefer-hardware']);
  await page.locator('#debug-mode').check();
  await chooseSetting(page, 'hud-style', 'horizontal');
  await expect(page.locator('#hud-codec')).toHaveText('H.264');
  await expect(page.locator('#hud-health')).toContainText('underruns');
  const hudText = await page.locator('#debug-overlay').innerText();
  expect(hudText.match(/H\.264/g)).toHaveLength(1);
  expect(hudText).not.toMatch(/hardware|preferred/i);
  await page.locator('#stop').click();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus)
    console.log('Native decoder diagnostics:', await page.evaluate(() => ({ errors: window.nativeErrors, preferences: window.decoderPreferences, message: document.getElementById('message')?.textContent })));
});

test('saved acceleration opt-out migrates to Canvas and a new codec choice survives refresh', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('remote-play:hardware-acceleration', 'false'));
  await register(page);
  await expect(page.locator('#video-mode')).toHaveValue('mpeg1');
  await chooseSetting(page, 'video-mode', 'h265');
  await page.reload();
  await expect(page.locator('[data-choice-for=video-mode]')).toBeVisible();
  await expect(page.locator('#video-mode')).toHaveValue('h265');
});

for (const failure of ['unsupported', 'fail']) {
  test(`HEVC ${failure} falls back to H.264 without changing the saved choice`, async ({ page }) => {
    await useNativeSoftwareDecoder(page, false, false, failure);
    await register(page);
    await chooseSetting(page, 'video-mode', 'h265');
    const codecs = [];
    page.on('request', request => { if (request.url().includes('/api/software/tickets')) codecs.push(request.postDataJSON().videoCodec); });
    await page.getByRole('button', { name: 'Start test stream' }).click();
    await expect(page.locator('#engine')).toContainText('H.264', { timeout: 30000 });
    await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(60);
    await expect(page.locator('#video-mode')).toHaveValue('h265');
    expect(codecs[0]).toBe(failure === 'fail' ? 'h265' : 'h264');
    expect(codecs.at(-1)).toBe('h264');
    await expect(page.locator('#video-mode-status')).toContainText('Using H.264');
    await page.locator('#stop').click();
  });
}

test('real HEVC transport reaches a stubbed WebCodecs boundary with codec configuration and keyframe parameter sets', async ({ page }) => {
  await useNativeSoftwareDecoder(page, false, false, 'boundary');
  await register(page);
  await chooseSetting(page, 'video-mode', 'h265');
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('H.265', { timeout: 30000 });
  const received = await page.evaluate(() => ({ chunks: globalThis.hevcChunks, configurations: globalThis.hevcConfigurations }));
  expect(received.configurations[0].codec).toMatch(/^hev1\.1\.6\.L\d+\.90$/);
  expect(received.configurations[0].hardwareAcceleration).toBe('prefer-hardware');
  const key = received.chunks.find(chunk => chunk.type === 'key');
  expect(key.types).toEqual(expect.arrayContaining([32, 33, 34]));
  expect(received.chunks.some(chunk => chunk.type === 'delta')).toBe(true);
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  if (await page.getByRole('button', { name: 'Enable sound' }).isVisible()) await page.getByRole('button', { name: 'Enable sound' }).click();
  await expect.poll(() => page.locator('#audio-status').getAttribute('data-rms').then(Number)).toBeGreaterThan(0.01);
  await page.locator('#stop').click();
});

test('H.264 stays native when Chrome can decode it without a hardware preference', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = VideoDecoder;
    window.VideoDecoder = class extends Native {
      static isConfigSupported(config) {
        if (config.hardwareAcceleration === 'prefer-hardware') return Promise.resolve({ supported: false });
        return Native.isConfigSupported(config);
      }
    };
  });
  await register(page);
  await page.getByRole('button', { name: 'Start test stream' }).click();
  await expect(page.locator('#engine')).toContainText('H.264 · browser decoding', { timeout: 30000 });
  await expect(page.locator('#video-mode-status')).toContainText('hardware preference unavailable');
  await expect.poll(() => page.locator('#fps').getAttribute('data-frames').then(Number)).toBeGreaterThan(120);
  await expect.poll(() => page.locator('#audio-status').getAttribute('data-rms').then(Number)).toBeGreaterThan(0.01);
  await expect(page.locator('#video-mode')).toHaveValue('auto');
  await page.locator('#stop').click();
});
