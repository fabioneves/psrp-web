import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: process.env.TEST_URL || 'http://127.0.0.1:8080',
    viewport: { width: 1440, height: 1080 },
    launchOptions: {
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      args: ['--disable-gpu', '--disable-accelerated-video-decode', '--disable-accelerated-2d-canvas', '--disable-webgl']
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});
