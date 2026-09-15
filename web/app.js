import { bindInputs } from './input.js';
import { startStream } from './stream-runtime.js';

const $ = id => document.getElementById(id);
let token = null, registering = false, worker = null, stream = null, playing = false, attempt = 0;
const resetInputs = bindInputs($('controls'), message => {
  worker?.postMessage(message);
  stream?.input(message);
}, () => playing);

function notify(message) { $('message').textContent = message; $('message').hidden = !message; }
async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false)
    throw new Error(result.errorMessage || result.message || Object.values(result.errors || {}).flat().join(' ') || `Request failed (${response.status}).`);
  return result.data ?? result;
}
async function run(button, action) {
  button.disabled = true;
  notify('');
  try { await action(); } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}
function showAccount() {
  $('account').hidden = !!token;
  $('library').hidden = !token;
  $('logout').hidden = !token;
}
$('auth-toggle').onclick = () => {
  registering = !registering;
  $('email-label').hidden = !registering;
  $('email').required = registering;
  $('username').previousSibling.textContent = registering ? 'Username (letters, numbers, underscore)' : 'Username or email';
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('auth-title').textContent = registering ? 'Create your account' : 'Sign in to play';
  $('auth-submit').textContent = registering ? 'Create account' : 'Sign in';
  $('auth-toggle').textContent = registering ? 'Already have an account? Sign in' : 'Create a local account';
};
$('auth-form').onsubmit = event => {
  event.preventDefault();
  run($('auth-submit'), async () => {
    const credentials = { usernameOrEmail: $('username').value.trim(), password: $('password').value };
    if (registering) await api('auth/register', { username: credentials.usernameOrEmail, email: $('email').value, password: credentials.password });
    const result = await api('auth/login', credentials);
    token = result.token;
    $('password').value = '';
    showAccount();
    await refresh();
  });
};
$('logout').onclick = () => { stop(); token = null; showAccount(); notify(''); };

async function refresh() {
  const devices = await api('playstation/my-devices');
  $('devices').replaceChildren();
  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('h2'); title.textContent = 'Your screen is waiting.';
    const text = document.createElement('p'); text.textContent = 'Pair a PlayStation to get started, or try the test stream below.';
    empty.append(title, text); $('devices').append(empty);
  }
  for (const device of devices) {
    const card = document.createElement('article'); card.className = 'device';
    const icon = document.createElement('span'); icon.className = 'device-icon'; icon.textContent = '▥'; icon.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div');
    const title = document.createElement('h2'); title.textContent = device.hostName || device.hostType || 'PlayStation';
    const detail = document.createElement('p'); detail.textContent = `${device.hostType || 'Console'} · ${device.ipAddress || 'IP unavailable'} · ${device.status || 'Paired'}`;
    info.append(title, detail);
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'Play'; button.disabled = !device.isRegistered;
    button.onclick = () => run(button, () => play(device.hostId, title.textContent));
    card.append(icon, info, button); $('devices').append(card);
  }
}
$('refresh').onclick = () => run($('refresh'), refresh);
$('pair-form').onsubmit = event => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('playstation/bind', { hostIp: $('host-ip').value.trim(), accountId: $('account-id').value.trim(), pin: $('pin').value });
    $('pin').value = '';
    await refresh();
    notify('Console paired. Choose Play to connect.');
  });
};
$('discover').onclick = () => run($('discover'), async () => {
  const consoles = await api('playstation/discover?timeoutMs=3000');
  $('discovered').replaceChildren();
  if (!consoles.length) { notify('No consoles found. Enter the console IP manually and check its network connection.'); return; }
  for (const console of consoles) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `${console.name} · ${console.ip}`;
    button.onclick = () => { $('host-ip').value = console.ip; $('account-id').focus(); };
    $('discovered').append(button);
  }
});

async function play(hostId, title, demo = false) {
  stop();
  const current = ++attempt;
  const { ticket } = await api('software/tickets', { hostId, demo, bitrateKbps: Number($('bitrate').value) });
  if (current !== attempt) return;
  const url = new URL('/api/software/stream', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  $('library').hidden = true; $('player').hidden = false; $('connecting').hidden = false;
  $('stream-title').textContent = title; $('stream-status').textContent = 'Connecting…';
  $('fps').textContent = '— fps'; $('decode').textContent = '— ms / frame'; $('network').textContent = '— Mbps';
  const previous = $('screen');
  const canvas = previous.cloneNode(); previous.replaceWith(canvas);
  const report = message => { if (attempt === current) onStreamMessage(message); };
  try {
    const useWorker = typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function' &&
      typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d') &&
      !new URLSearchParams(location.search).has('mainThread');
    if (useWorker) {
      worker = new Worker('/stream-worker.js');
      worker.onmessage = event => report(event.data);
      worker.onerror = () => report({ type: 'error', message: 'Video worker failed. Reload with ?mainThread=1 to use the compatibility renderer.' });
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'start', canvas: offscreen, url: url.href }, [offscreen]);
    } else {
      const connection = await startStream(canvas, url.href, report);
      if (attempt !== current) { connection.close(); return; }
      stream = connection;
    }
    playing = true;
    document.activeElement?.blur();
    $('player').scrollIntoView({ block: 'start' });
  } catch (error) { stop(); throw error; }
}
function onStreamMessage(message) {
  if (message.type === 'stats') {
    $('fps').textContent = `${message.fps.toFixed(1)} fps`;
    $('fps').dataset.frames = message.totalFrames;
    $('decode').textContent = `${message.decodeMs.toFixed(1)} ms / frame`;
    $('network').textContent = `${message.mbps.toFixed(1)} Mbps`;
    $('resolution').textContent = `${message.width} × ${message.height}`;
    $('engine').textContent = `${message.engine} · Canvas 2D${worker ? ' · worker' : ''}`;
    if (message.totalFrames) { $('connecting').hidden = true; $('stream-status').textContent = 'Playing'; }
  } else if (message.type === 'status') $('stream-status').textContent = message.message;
  else if (message.type === 'error' || message.type === 'closed') { stop(); notify(message.message); }
}
function stop() {
  attempt++;
  resetInputs();
  playing = false;
  if (worker) {
    const oldWorker = worker;
    oldWorker.postMessage({ type: 'stop' });
    setTimeout(() => oldWorker.terminate(), 300);
    worker = null;
  }
  stream?.close(); stream = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('player').hidden = true;
  $('library').hidden = !token;
}
$('demo').onclick = () => run($('demo'), () => play(null, '720p60 · Browser test', true));
$('stop').onclick = stop;
$('show-controls').onchange = () => { resetInputs(); $('controls').hidden = !$('show-controls').checked; };
$('fullscreen').onclick = () => run($('fullscreen'), async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else if ($('player').requestFullscreen) await $('player').requestFullscreen();
  else notify('Full screen is unavailable in this browser.');
});
window.addEventListener('pagehide', stop);
showAccount();
