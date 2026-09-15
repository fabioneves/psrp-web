import { bindInputs } from './input.js';
import { pollGamepads } from './gamepad.js';
import { Reconnect } from './reconnect.js';
import { AudioOutput } from './audio.js';
import { startStream } from './stream-runtime.js';
import { AdaptiveQuality } from './adaptive.js';

const $ = id => document.getElementById(id);
let token = null, registering = false, worker = null, stream = null, playing = false, attempt = 0;
const resetInputs = bindInputs($('controls'), message => {
  worker?.postMessage(message);
  stream?.input(message);
}, () => playing);

let target = null, forceMain = false, activeSession = null, wakeLock = null, wakeRequest = 0;
let audio = null, quality = null;
const selectedProfile = () => ({ bitrateKbps: Number($('bitrate').value), resolution: $('resolution-profile').value, fps: Number($('fps-profile').value) });
const retry = new Reconnect(() => connect());
const settings = () => ({ mode: $('controller-mode').value, index: $('controller-index').value,
  swap: $('controller-swap').value, deadZone: Number($('dead-zone').value),
  invertAB: $('invert-ab').checked, invertXY: $('invert-xy').checked });
const gamepads = pollGamepads(resetInputs.state, () => playing && !document.hidden && document.hasFocus(),
  settings, text => $('controller-status').textContent = text);
const preferenceIds = ['controller-mode', 'controller-index', 'controller-swap', 'dead-zone', 'invert-ab', 'invert-xy', 'keep-awake'];
for (const id of preferenceIds) {
  const element = $(id);
  try {
    const value = localStorage.getItem(`remote-play:${id}`);
    if (value !== null) {
      if (element.type === 'checkbox') element.checked = value === 'true';
      else element.value = value;
    }
  } catch {}
  element.addEventListener('change', () => {
    try { localStorage.setItem(`remote-play:${id}`, element.type === 'checkbox' ? element.checked : element.value); } catch {}
    gamepads.reset();
    updateWakeLock();
  });
}
const query = new URLSearchParams(location.search);
for (const [param, id] of [['controllerMode', 'controller-mode'], ['controllerIndex', 'controller-index'], ['teslaSwap', 'controller-swap'], ['bitrate', 'bitrate'], ['resolution', 'resolution-profile'], ['fps', 'fps-profile']]) {
  if (query.has(param)) {
    const element = $(id), value = query.get(param);
    if (element.tagName !== 'SELECT' || [...element.options].some(option => option.value === value)) element.value = value;
  }
}
$('browser-diagnostics').textContent = `${/Tesla/i.test(navigator.userAgent) ? 'Tesla browser' : 'Browser'} · ${isSecureContext ? 'Secure context' : 'HTTP context'} · ${typeof navigator.getGamepads === 'function' ? 'Gamepad API exposed' : 'Gamepad API unavailable'}`;
async function updateWakeLock() {
  const request = ++wakeRequest;
  if (wakeLock) { await wakeLock.release().catch(() => {}); wakeLock = null; }
  if (playing && !document.hidden && $('keep-awake').checked && navigator.wakeLock) {
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (request !== wakeRequest || !playing || document.hidden || !$('keep-awake').checked) await lock.release();
      else wakeLock = lock;
    } catch {}
  }
}
document.addEventListener('visibilitychange', updateWakeLock);
window.addEventListener('focus', () => gamepads.reset());

function notify(message) { $('message').textContent = message; $('message').hidden = !message; }
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Remote-Play-Session': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.success === false)
      throw new Error(result?.errorMessage || result?.message || Object.values(result?.errors || {}).flat().join(' ') || `Request failed (${response.status}).`);
    return result?.data ?? result;
  } finally { clearTimeout(timeout); }
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
$('logout').onclick = () => run($('logout'), async () => {
  await api('auth/logout', {});
  stop(); token = null; showAccount(); notify('');
});

async function restoreSession() {
  try {
    const session = await api('auth/session');
    token = session.token;
    if (token) await refresh();
  } catch (error) { notify(`Could not restore your session: ${error.message}`); }
  finally { $('session-status').hidden = true; showAccount(); }
}

async function refresh() {
  await refreshActive();
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
$('discover').onclick = async () => {
  const discover = $('discover'), status = $('discovery-status');
  discover.disabled = true;
  discover.textContent = 'Searching…';
  discover.setAttribute('aria-busy', 'true');
  notify('');
  $('discovered').replaceChildren();
  status.textContent = 'Searching for consoles… This usually takes a few seconds.';
  try {
    const consoles = await api('playstation/discover?timeoutMs=3000');
    status.textContent = consoles.length
      ? `Found ${consoles.length} console${consoles.length === 1 ? '' : 's'}. Select one to fill in its IP address.`
      : 'No consoles found. Check that the console is reachable from this server, or enter its IP address manually.';
    for (const console of consoles) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${console.name} · ${console.ip}`;
      button.onclick = () => {
        $('host-ip').value = console.ip;
        status.textContent = `Selected ${console.name}. Enter your account ID and Link Device PIN to pair it.`;
        $('account-id').focus();
      };
      $('discovered').append(button);
    }
  } catch (error) {
    status.textContent = error.name === 'AbortError'
      ? 'Console search timed out. Try again, or enter the console IP address manually.'
      : `Console search failed: ${error.message} Try again, or enter the console IP address manually.`;
  } finally {
    discover.disabled = false;
    discover.textContent = 'Find consoles on this network';
    discover.removeAttribute('aria-busy');
  }
};

async function play(hostId, title, demo = false, inputSession = null) {
  stop();
  target = { hostId, title, demo, inputSession, profile: selectedProfile() };
  quality = new AdaptiveQuality(target.profile);
  if (!inputSession) {
    try {
      const output = new AudioOutput(message => { if (audio === output) onAudioMessage(message); });
      audio = output;
      syncAudio();
      audio.setDelay(Number($('audio-delay').value));
    } catch (error) { $('audio-status').textContent = error.message; }
  }
  forceMain = false;
  await connect();
}
async function connect() {
  if (!target) return;
  const intent = target;
  try {
    if (intent.inputSession) {
      const active = await api('software/active');
      if (target !== intent) return;
      if (!active?.sessionId || active.hostId !== intent.hostId || active.demo !== intent.demo)
        throw new Error('Waiting for the same console stream to reconnect…');
      intent.inputSession = active.sessionId;
    }
    await openStream(intent);
  } catch (error) { if (target === intent) reconnect(error.message); }
}
function reconnect(message, workerFailed = false) {
  if (!target) return;
  if (workerFailed) forceMain = true;
  stop(true);
  if (!retry.schedule()) { stop(); notify(`${message} Reconnection failed after five attempts.`); return; }
  $('library').hidden = true; $('player').hidden = false;
  $('stream-status').textContent = `Reconnecting · attempt ${retry.count}/5`;
  notify(message);
}
async function openStream({ hostId, title, demo, inputSession, profile }) {
  stop(true);
  const current = ++attempt;
  const { ticket } = await api('software/tickets', { hostId, demo, inputSession, ...profile });
  if (current !== attempt) return;
  const url = new URL('/api/software/stream', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  $('library').hidden = true; $('player').hidden = false; $('connecting').hidden = !!inputSession;
  $('stage').hidden = !!inputSession; document.querySelector('.stats').hidden = !!inputSession;
  $('input-only-hint').hidden = !inputSession;
  $('audio-controls').hidden = !!inputSession; $('audio-status').hidden = !!inputSession;
  $('playing-profile').append($('profile-settings'));
  $('performance-details').hidden = !!inputSession;
  $('apply-profile').hidden = !!inputSession;
  quality?.restart();
  updateQuality();
  $('stream-title').textContent = demo && !inputSession ? `${profile.resolution}${profile.fps} · Browser test` : title; $('stream-status').textContent = 'Connecting…';
  $('fps').textContent = '— fps'; $('decode').textContent = '— ms / frame'; $('network').textContent = '— Mbps';
  const previous = $('screen');
  const canvas = previous.cloneNode(); previous.replaceWith(canvas);
  const report = message => { if (attempt === current) onStreamMessage(message); };
  try {
    await audio?.ready;
    if (attempt !== current) return;
    const useWorker = !inputSession && !forceMain && typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function' &&
      typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d') &&
      !new URLSearchParams(location.search).has('mainThread');
    if (useWorker) {
      worker = new Worker('/stream-worker.js');
      worker.onmessage = event => report(event.data);
      worker.onerror = () => { if (attempt === current) reconnect('Switching to the compatibility renderer…', true); };
      const offscreen = canvas.transferControlToOffscreen();
      const audioPort = audio?.workerPort();
      worker.postMessage({ type: 'start', canvas: offscreen, url: url.href, audioPort,
        audioEnabled: audio?.context.state === 'running' },
        audioPort ? [offscreen, audioPort] : [offscreen]);
    } else {
      const connection = await startStream(inputSession ? null : canvas, url.href, report);
      if (attempt !== current) { connection.close(); return; }
      stream = connection;
    }
    playing = true;
    gamepads.reset();
    updateWakeLock();
    document.activeElement?.blur();
    $('player').scrollIntoView({ block: 'start' });
  } catch (error) { if (attempt === current) { forceMain = true; stop(true); throw error; } }
}
function onStreamMessage(message) {
  if (message.type === 'audio') audio?.write(message.bytes, message.timestamp);
  else if (message.type === 'sync') audio?.sync(message.timestamp);
  else if (message.type === 'renderer-error') {
    reconnect('Switching to the compatibility renderer…', true);
  } else if (message.type === 'connected') {
    resetInputs(); gamepads.reset();
    if (message.inputOnly) $('stream-status').textContent = 'Controller connected';
  } else if (message.type === 'stats') {
    if (message.totalFrames > 600) retry.reset();
    $('fps').textContent = `${message.fps.toFixed(1)} fps`;
    $('fps').dataset.frames = message.totalFrames;
    $('decode').textContent = `${message.decodeMs.toFixed(1)} ms / frame`;
    $('network').textContent = `${message.mbps.toFixed(1)} Mbps`;
    const ms = value => value == null ? '…' : `${value.toFixed(1)} ms`;
    $('timing-status').textContent = `Round trip ${ms(message.rttMs)} · delivery estimate ${ms(message.transportMs)} · server send queue ${ms(message.serverQueueMs)} · ready-to-canvas ${ms(message.videoAgeMs)}`;
    $('render-status').textContent = `Decode ${ms(message.codecMs)} · color ${ms(message.colorMs)} (${message.pixelEngine}) · draw ${ms(message.drawMs)} · canvas queue ${ms(message.queueMs)} · ${message.droppedFrames} superseded frames`;
    $('timing-status').dataset.metrics = JSON.stringify(message);
    $('resolution').textContent = `${message.width} × ${message.height}`;
    $('engine').textContent = `${message.engine} · Canvas 2D${worker ? ' · worker' : ''}`;
    if (message.totalFrames) { $('connecting').hidden = true; $('stream-status').textContent = 'Playing'; }
    if ($('auto-quality').checked && !target?.inputSession) {
      const change = quality?.sample(message, performance.now(), !document.hidden);
      if (change) changeProfile(change.profile, change.reason);
    }
  } else if (message.type === 'status') $('stream-status').textContent = message.message;
  else if (message.type === 'error' || message.type === 'closed') {
    if ($('auto-quality').checked && quality && message.message.includes('Software decoding cannot keep up')) {
      const change = quality.change(quality.lower(true), 'Browser decoding exceeded its time limit', performance.now());
      if (change) { changeProfile(change.profile, change.reason); return; }
    }
    reconnect(message.message);
  }
}
function stop(preserveTarget = false) {
  attempt++;
  if (!preserveTarget) { retry.reset(); target = null; quality = null; }
  if (preserveTarget) audio?.reset();
  else { audio?.close(); audio = null; }
  gamepads.reset();
  resetInputs();
  playing = false;
  updateWakeLock();
  if (worker) {
    const oldWorker = worker;
    oldWorker.postMessage({ type: 'stop' });
    setTimeout(() => oldWorker.terminate(), 300);
    worker = null;
  }
  stream?.close(); stream = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('player').classList.remove('theater');
  $('library-profile').append($('profile-settings'));
  $('apply-profile').hidden = true;
  $('player').hidden = true;
  $('library').hidden = !token;
}
$('demo').onclick = () => run($('demo'), () => play(null, `${$('resolution-profile').value}${$('fps-profile').value} · Browser test`, true));
$('stop').onclick = () => stop();
$('show-controls').onchange = () => { resetInputs(); gamepads.reset(); $('controls').hidden = !$('show-controls').checked; };
$('fullscreen').onclick = () => run($('fullscreen'), async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else {
    try { if (!$('player').requestFullscreen) throw new Error(); await $('player').requestFullscreen(); }
    catch { $('player').classList.toggle('theater'); }
  }
});
window.addEventListener('pagehide', () => stop());
restoreSession();

async function refreshActive() {
  if (!token) return;
  activeSession = await api('software/active');
  $('attach-panel').hidden = !activeSession?.sessionId;
  $('attached-status').textContent = activeSession?.inputClients ? `${activeSession.inputClients} input device(s) attached` : '';
}
$('attach-input').onclick = () => run($('attach-input'), () =>
  play(activeSession.hostId, 'Input controller', activeSession.demo, activeSession.sessionId));
setInterval(() => { if (token && !document.hidden) refreshActive().catch(() => {}); }, 3000);

function onAudioMessage(message) {
  if (message.type === 'audio-fallback') {
    worker?.postMessage({ type: 'audio-fallback' });
    $('audio-status').textContent = 'Using compatible Web Audio output.';
  } else if (message.type === 'audio-stats') {
    $('audio-status').textContent = `${message.engine} · ${Math.round(message.bufferedMs)} ms queued · ${message.underruns} underruns${message.skewMs == null ? '' : ` · audio lag estimate ${Math.round(message.lagMs)} ms`}`;
    $('audio-status').dataset.skew = message.skewMs ?? '';
    $('audio-status').dataset.trimmed = message.trimmedSamples ?? 0;
    $('audio-status').dataset.samples = message.samples;
    $('audio-status').dataset.rms = message.rms;
    $('audio-status').dataset.underruns = message.underruns;
  } else if (message.type === 'audio-state') {
    worker?.postMessage({ type: 'audio-enabled', enabled: audio?.context.state === 'running' });
    if (audio?.context.state !== 'running') audio?.reset();
    $('audio-status').textContent = message.state === 'suspended' ? 'Tap Enable sound to start audio.' : `Audio ${message.state}`;
  }
}
function syncAudio() { audio?.volume($('mute').checked ? 0 : Number($('volume').value)); }
$('enable-audio').onclick = () => audio?.resume();
$('mute').onchange = syncAudio;
$('volume').oninput = syncAudio;
$('audio-delay').onchange = () => audio?.setDelay(Number($('audio-delay').value));
document.addEventListener('pointerdown', () => { if (audio?.context.state === 'suspended') audio.resume(); });
document.addEventListener('keydown', () => { if (audio?.context.state === 'suspended') audio.resume(); });

$('resolution-profile').onchange = () => {
  $('bitrate').value = { '360p': '3000', '540p': '6000', '720p': '10000', '1080p': '20000' }[$('resolution-profile').value];
};

function updateQuality(reason = '') {
  const profile = target?.profile || selectedProfile();
  const mode = $('auto-quality').checked ? 'Automatic · selected profile is the ceiling' : 'Manual';
  $('quality-status').textContent = `${mode} · active ${profile.resolution}${profile.fps} · ${profile.bitrateKbps / 1000} Mbps${reason ? ` · ${reason}` : ''}`;
}
function changeProfile(profile, reason) {
  if (!target || target.inputSession) return;
  target.profile = { ...profile };
  retry.reset();
  reconnect(`${reason}. Reconnecting with ${profile.resolution}${profile.fps}…`);
  updateQuality(reason);
}
$('auto-quality').onchange = () => {
  if (target) {
    quality = new AdaptiveQuality(selectedProfile());
    const selected = selectedProfile();
    const active = target.profile;
    if ($('auto-quality').checked && (parseInt(active.resolution) > parseInt(selected.resolution) || active.fps > selected.fps || active.bitrateKbps > selected.bitrateKbps)) {
      changeProfile(selected, 'Automatic quality ceiling applied');
    } else quality.current = { ...active };
  }
  updateQuality();
};
$('apply-profile').onclick = () => {
  $('auto-quality').checked = false;
  quality = new AdaptiveQuality(selectedProfile());
  changeProfile(selectedProfile(), 'Manual profile selected');
};
