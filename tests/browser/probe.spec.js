import { test, expect } from '@playwright/test';
import { createSocket } from 'node:dgram';

// Answers STUN binding requests with a fixed public endpoint; Chrome drops a reflexive candidate that equals its host one.
async function stunServer() {
  const socket = createSocket('udp4');
  socket.on('message', (request, remote) => {
    if (request.length < 20 || request.readUInt16BE(0) !== 0x0001) return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2);
    request.copy(response, 4, 4, 20);
    response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22);
    response.writeUInt8(0x01, 25); response.writeUInt16BE(4242 ^ 0x2112, 26);
    response.writeUInt32BE(((203 << 24 | 0 << 16 | 113 << 8 | 7) ^ 0x2112a442) >>> 0, 28);
    socket.send(response, remote.port, remote.address);
  });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  return socket;
}

test('the WebRTC probe reports data channel support, a UDP answer and loopback throughput', async ({ page }) => {
  const stun = await stunServer();
  try {
    await page.goto(`/probe.html?stun=127.0.0.1:${stun.address().port}`);
    await expect(page.locator('#api-result')).toContainText('supported');
    await expect(page.locator('#stun-result')).toContainText('Outbound UDP works.', { timeout: 15000 });
    await expect(page.locator('#stun-result')).toContainText('203.0.113.7:4242');
    await expect(page.locator('#loopback-result')).toContainText('Mbps', { timeout: 20000 });
    await page.getByRole('button', { name: 'Send to server' }).click({ timeout: 20000 });
    await expect(page.locator('#save-result')).toContainText('Sign in');
  } finally { stun.close(); }
});

test('the probe reports blocked UDP when no STUN server answers, and saves the result for a signed-in account', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a local account' }).click();
  const name = `probe_${Date.now()}`;
  await page.locator('#username').fill(name);
  await page.locator('#email').fill(`${name}@example.test`);
  await page.locator('#password').fill('LocalTestPassword_123');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#library')).toBeVisible();
  await page.goto('/probe.html?stun=127.0.0.1:9');
  await expect(page.locator('#stun-result')).toContainText('looks blocked', { timeout: 15000 });
  await page.getByRole('button', { name: 'Send to server' }).click({ timeout: 20000 });
  await expect(page.locator('#save-result')).toContainText('Saved');
  const session = await page.request.get('/api/auth/session', { headers: { 'X-Remote-Play-Session': '1' } });
  const headers = { Authorization: `Bearer ${(await session.json()).token}` };
  const [latest] = await (await page.request.get('/api/diagnostics', { headers })).json();
  const capture = await (await page.request.get(`/api/diagnostics/${latest.name}`, { headers })).json();
  expect(capture.kind).toBe('webrtc-probe');
  expect(capture.stun.udp).toBe(false);
  expect(capture.loopback.receivedMbps).toBeGreaterThan(0);
});

test('peers that cannot reach each other inside the page read as not measurable, not as a WebRTC failure', async ({ page }) => {
  await page.addInitScript(() => { RTCPeerConnection.prototype.addIceCandidate = async () => {}; });
  await page.goto('/probe.html?stun=127.0.0.1:9');
  await expect(page.locator('#loopback-result')).toContainText('Could not measure here', { timeout: 30000 });
  await expect(page.locator('#loopback-result')).not.toHaveAttribute('data-tone', 'bad');
});
