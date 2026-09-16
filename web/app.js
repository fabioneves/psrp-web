import { bindFullscreenGestures } from './fullscreen-gestures.js';
import { bindChoiceButtons } from './choice-buttons.js';
import { bindSessionTabs } from './session-tabs.js';
import { updateHud, resetHud, copyDiagnostics } from './debug-hud.js';
import { selectVideoCodec, nativeVideoConfig } from './native-decoder.js';
import { bindInputs } from './input.js';
import { pollGamepads } from './gamepad.js';
import { Reconnect } from './reconnect.js';
import { AudioOutput } from './audio.js';
import { startStream } from './stream-runtime.js';
import { AdaptiveQuality } from './adaptive.js';
import { encodeAccountId } from './account-id.js';
import { bindSetup } from './setup.js';

const $ = id => document.getElementById(id);
let token = null, registering = false, worker = null, stream = null, playing = false, attempt = 0;
const setup = bindSetup(api, refresh, notify);
let pairedConsoleIds = new Set(), scanning = false;
const resetInputs = bindInputs($('controls'), message => {
  worker?.postMessage(message);
  stream?.input(message);
}, () => playing);

let target = null, forceMain = false, activeSession = null, wakeLock = null, wakeRequest = 0;
let audio = null, quality = null, activeCodec = 'mpeg1';
const failedCodecs = new Set();
let decoderFailure = '', sleepingHost = null;
const selectedProfile = () => ({ bitrateKbps: Number($('bitrate').value), resolution: $('resolution-profile').value, fps: Number($('fps-profile').value) });
const retry = new Reconnect(() => connect());
const settings = () => ({ mode: $('controller-mode').value, index: $('controller-index').value,
  swap: $('controller-swap').value, deadZone: Number($('dead-zone').value),
  invertAB: $('invert-ab').checked, invertXY: $('invert-xy').checked });
const gamepads = pollGamepads(resetInputs.state, () => playing && !document.hidden && document.hasFocus(),
  settings, text => $('controller-status').textContent = text);
try {
  if (localStorage.getItem('remote-play:video-mode') === null && localStorage.getItem('remote-play:hardware-acceleration') === 'false')
    $('video-mode').value = 'mpeg1';
} catch {}
const preferenceIds = ['controller-mode', 'controller-index', 'controller-swap', 'dead-zone', 'invert-ab', 'invert-xy', 'keep-awake', 'video-mode', 'resolution-profile', 'fps-profile', 'bitrate', 'show-controls', 'debug-mode', 'mute', 'volume', 'audio-delay', 'frame-pacing', 'auto-fullscreen', 'hud-style'];
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
if (!['mpeg1', 'h264', 'h265'].includes($('video-mode').value)) $('video-mode').value = 'h264';
if (!['detailed', 'minimal', 'horizontal'].includes($('hud-style').value)) $('hud-style').value = 'detailed';
const query = new URLSearchParams(location.search);
for (const [param, id] of [['controllerMode', 'controller-mode'], ['controllerIndex', 'controller-index'], ['teslaSwap', 'controller-swap'], ['bitrate', 'bitrate'], ['resolution', 'resolution-profile'], ['fps', 'fps-profile']]) {
  if (query.has(param)) {
    const element = $(id), value = query.get(param);
    if (element.tagName !== 'SELECT' || [...element.options].some(option => option.value === value)) element.value = value;
  }
}
const syncChoices = bindChoiceButtons();
const selectSessionTab = bindSessionTabs();
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

function notify(message) {
  const element = $('setup-dialog').open ? $('psn-status') : $('player').hidden ? $('message') : $('connection-message');
  element.textContent = message;
  if (element.id !== 'connection-message') element.hidden = !message;
}
async function api(path, body, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(`/api/${path}`, {
      method: options.method || (body === undefined ? 'GET' : 'POST'),
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Remote-Play-Session': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.success === false)
      throw Object.assign(new Error(result?.errorMessage || result?.message || Object.values(result?.errors || {}).flat().join(' ') || `Request failed (${response.status}).`), { status: response.status });
    return result?.data ?? result;
  } finally { clearTimeout(timeout); }
}
async function run(button, action, clearMessage = true) {
  button.disabled = true;
  if (clearMessage) notify('');
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
    setup.reset();
    $('password').value = '';
    showAccount();
    await refresh();
    void setup.restore();
    const signedInToken = token;
    try {
      const saved = await api('auth/session');
      if (token === signedInToken && saved.token !== signedInToken)
        notify('Signed in for this page only: the browser did not retain your saved login. Allow cookies for this site, then sign in again.');
    } catch {
      if (token === signedInToken)
        notify('Signed in, but saved login could not be verified. Refreshing may require signing in again.');
    }
  });
};
$('logout').onclick = () => run($('logout'), async () => {
  await api('auth/logout', {});
  stop(); token = null; setup.reset(); showAccount(); notify('');
});

async function restoreSession() {
  try {
    const session = await api('auth/session');
    token = session.token;
    if (token) { await refresh(); void setup.restore(); }
  } catch (error) { notify(`Could not restore your session: ${error.message}`); }
  finally { showAccount(); }
}

function consoleStatus(status) {
  if (/standby/i.test(status || '')) return 'Rest mode';
  if (/^ok$/i.test(status || '')) return 'Ready';
  return status || 'Paired';
}
async function refresh() {
  await refreshActive();
  const devices = await api('playstation/my-devices');
  pairedConsoleIds = new Set(devices.map(device => device.hostId));
  $('devices').replaceChildren();
  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('h2'); title.textContent = 'Connect your first console';
    const text = document.createElement('p'); text.textContent = 'Select a nearby PlayStation below, or choose Add console.';
    empty.append(title, text); $('devices').append(empty);
  }
  for (const device of devices) {
    const card = document.createElement('article'); card.className = 'device'; card.dataset.hostId = device.hostId;
    const icon = document.createElement('span'); icon.className = 'device-icon'; icon.textContent = ''; icon.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div');
    const title = document.createElement('h2'); title.textContent = device.hostName || device.hostType || 'PlayStation';
    const detail = document.createElement('p'); detail.textContent = `${device.hostType || 'Console'} · ${device.ipAddress || 'IP unavailable'} · ${consoleStatus(device.status)}`;
    info.append(title, detail);
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'Play'; button.disabled = !device.isRegistered;
    button.onclick = () => run(button, () => play(device.hostId, title.textContent, false, null, device.hostType));
    const wake = document.createElement('button'); wake.className = 'quiet'; wake.textContent = 'Wake up';
    wake.disabled = !device.isRegistered;
    wake.onclick = () => run(wake, async () => {
      wake.textContent = 'Waking…';
      notify('Waking console…');
      try { await api('software/wake', { hostId: device.hostId }, { timeout: 30000 }); await refresh(); notify('Console is awake. Choose Play to connect.'); }
      finally { wake.textContent = 'Wake up'; }
    });
    const disconnect = document.createElement('button'); disconnect.className = 'quiet'; disconnect.textContent = 'Disconnect all sessions';
    disconnect.disabled = !device.isRegistered;
    disconnect.onclick = () => run(disconnect, () => disconnectConsole(device.hostId));
    const actions = document.createElement('div'); actions.className = 'device-actions'; const sleep = document.createElement('button'); sleep.className = 'quiet'; sleep.textContent = 'Put console to sleep';
    sleep.disabled = !device.isRegistered;
    sleep.onclick = () => run(sleep, () => sleepConsole(device.hostId));
    actions.append(wake, sleep, disconnect, button);
    card.append(icon, info, actions); $('devices').append(card);
  }
  void discoverConsoles();
}
async function sleepConsole(hostId) {
  retry.reset();
  notify('Sending rest-mode request…');
  sleepingHost = hostId;
  try {
    const result = await api('software/sleep', { hostId }, { timeout: 30000 });
    if (target?.hostId === hostId) stop();
    await refresh();
    notify(result.message);
  } finally { sleepingHost = null; }
}
$('sleep-console').onclick = () => {
  if (target?.hostId) void run($('sleep-console'), () => sleepConsole(target.hostId));
};
async function disconnectConsole(hostId) {
  if (target?.hostId === hostId) stop();
  notify('Disconnecting all sessions for this console…');
  const result = await api('software/disconnect', { hostId }, { timeout: 20000 });
  await refreshActive();
  notify(result.message);
}
$('disconnect-all').onclick = () => {
  if (target?.hostId) void run($('disconnect-all'), () => disconnectConsole(target.hostId));
};
$('refresh').onclick = () => run($('refresh'), refresh);
$('account-id').oninput = () => {
  const value = $('account-id').value.trim(), preview = $('account-id-preview');
  preview.hidden = true;
  try {
    const encoded = encodeAccountId(value);
    if (encoded !== value) {
      preview.textContent = `Encoded account ID: ${encoded}`;
      preview.hidden = false;
    }
  } catch {}
};
$('pair-form').onsubmit = event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const accountId = encodeAccountId($('account-id').value);
    if (!$('host-ip').value.trim()) throw new Error('Select a console or enter its IP address first.');
    if (!/^\d{8}$/.test($('pin').value)) throw new Error('Enter the 8-digit Link Device PIN from your console.');
    await api('playstation/bind', { hostIp: $('host-ip').value.trim(), accountId, pin: $('pin').value });
    $('pin').value = '';
    $('setup-dialog').close();
    await refresh();
    notify('Console paired. Choose Play to connect.');
  });
};
$('discover').onclick = () => discoverConsoles();
$('check-ip').onclick = () => {
  const hostIp = $('host-ip').value.trim();
  if (hostIp) return discoverConsoles(hostIp);
  $('discovery-status').textContent = 'Enter the console IP address, then choose Check IP address.';
  $('host-ip').focus();
};

async function discoverConsoles(hostIp = '') {
  if (scanning) return;
  scanning = true;
  const viewer = token;
  const button = hostIp ? $('check-ip') : $('discover'), status = $('discovery-status');
  const label = button.textContent;
  $('discover').disabled = $('check-ip').disabled = true;
  button.textContent = hostIp ? 'Checking…' : 'Searching…';
  button.setAttribute('aria-busy', 'true');
  notify('');
  $('discovered').replaceChildren();
  $('nearby-panel').hidden = false;
  $('nearby-status').textContent = 'Searching for consoles…';
  status.textContent = hostIp ? `Checking ${hostIp}… This usually takes a few seconds.`
    : 'Searching for consoles… This usually takes a few seconds.';
  try {
    const result = await api(`playstation/discover${hostIp ? '/' + encodeURIComponent(hostIp) : ''}?timeoutMs=3000`);
    const consoles = hostIp ? [result] : result;
    if (token !== viewer) return;
    $('nearby-devices').replaceChildren();
    $('nearby-status').textContent = consoles.length ? '' : 'No nearby consoles found. Use Add console to enter an IP address.';
    status.textContent = consoles.length
      ? `Found ${consoles.length} console${consoles.length === 1 ? '' : 's'}. Select one to fill in its IP address.`
      : 'No consoles found by automatic discovery. Enter the console IP address above and choose Check IP address to search directly.';
    const cards = new Map([...$('devices').children].map(card => [card.dataset.hostId, card]));
    for (const console of consoles) {
      const card = cards.get(console.uuid);
      if (card) card.querySelector('p').textContent = `${console.hostType || 'Console'} · ${console.ip} · ${consoleStatus(console.status)}`;
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${console.name} · ${console.ip}`;
      button.onclick = () => {
        setup.select(console);
        status.textContent = `Selected ${console.name}. Sign in to PSN to pair automatically, or use a Link Device PIN.`;
      };
      $('discovered').append(button);
      if (!pairedConsoleIds.has(console.uuid)) {
        const nearby = document.createElement('button');
        nearby.className = 'nearby-console';
        nearby.textContent = `${console.name} · Set up`;
        nearby.onclick = () => setup.select(console);
        $('nearby-devices').append(nearby);
      }
    }
  } catch (error) {
    $('nearby-status').textContent = 'Console search failed. Choose Refresh to try again.';
    if (hostIp && error.status === 404)
      status.textContent = `No console responded at ${hostIp}. Check the IP address, turn on the console and enable Remote Play, then try again.`;
    else status.textContent = error.name === 'AbortError'
      ? 'Console search timed out. Try again, or enter the console IP address and choose Check IP address.'
      : `Console search failed: ${error.message} Try again, or enter the console IP address and choose Check IP address.`;
  } finally {
    scanning = false;
    $('discover').disabled = $('check-ip').disabled = false;
    button.textContent = label;
    button.removeAttribute('aria-busy');
  }
}

async function play(hostId, title, demo = false, inputSession = null, hostType = null) {
  stop();
  target = { hostId, title, demo, inputSession, hostType, profile: selectedProfile() };
  resetHud();
  quality = new AdaptiveQuality(target.profile);
  $('connection-message').textContent = '';
  showPlayer(target);
  $('player').scrollIntoView({ block: 'start' });
  selectSessionTab(inputSession ? 'input-panel' : 'picture-panel');
  if (hostId && !inputSession && $('auto-fullscreen').checked) void enterFullscreen();
  if (!inputSession) {
    try {
      const output = new AudioOutput(message => { if (audio === output) onAudioMessage(message); });
      audio = output;
      syncAudio();
      audio.setDelay(Number($('audio-delay').value));
    } catch (error) { $('audio-status').textContent = error.message; }
  }
  forceMain = false; failedCodecs.clear(); decoderFailure = '';
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
  } catch (error) {
    if (target === intent) {
      if ([401, 403, 404, 409].includes(error.status)) failConnection(error.message);
      else reconnect(error.message);
    }
  }
}
function failConnection(message) {
  stop(true);
  retry.reset();
  $('retry-stream').disabled = false;
  $('stream-status').textContent = 'Connection failed';
  $('connecting').textContent = 'Connection failed';
  notify(message);
}
function reconnect(message, workerFailed = false) {
  if (!target) return;
  if (sleepingHost && target.hostId === sleepingHost) { stop(); return; }
  if (workerFailed) forceMain = true;
  stop(true);
  if (!retry.schedule()) { failConnection(`${message} Automatic reconnection stopped after five attempts. Choose Try again when ready.`); return; }
  $('stream-status').textContent = `Reconnecting · attempt ${retry.count}/5`;
  notify(message);
}
function showPlayer({ hostId, title, demo, inputSession, profile }) {
  $('library').hidden = true; $('player').hidden = false;
  $('connecting').hidden = !!inputSession;
  $('connecting').textContent = 'Preparing video…';
  $('stage').hidden = !!inputSession; document.querySelector('.stats').hidden = !!inputSession;
  $('input-only-hint').hidden = !inputSession;
  $('disconnect-all').hidden = demo || !hostId;
  document.querySelector('.console-utilities').hidden = demo || !hostId;
  $('picture-tab').disabled = $('sound-tab').disabled = !!inputSession;
  $('sleep-console').hidden = demo || !hostId;
  $('player').classList.toggle('input-only', !!inputSession);
  $('audio-controls').hidden = !!inputSession; $('audio-status').hidden = !!inputSession;
  if ($('profile-settings').parentElement !== $('playing-profile')) $('playing-profile').append($('profile-settings'));
  $('performance-details').hidden = !!inputSession;
  $('apply-profile').hidden = !!inputSession;
  $('retry-stream').disabled = true;
  $('stream-title').textContent = demo && !inputSession ? `${profile.resolution}${profile.fps} · Browser test` : title;
  $('stream-status').textContent = 'Connecting…';
}
async function openStream({ hostId, title, demo, inputSession, hostType, profile }) {
  stop(true);
  showPlayer({ hostId, title, demo, inputSession, profile });
  const current = ++attempt;
  const preferred = $('video-mode').value;
  const codec = inputSession ? 'mpeg1' : await selectVideoCodec(preferred, profile, failedCodecs, hostType);
  const native = codec === 'mpeg1' ? null : await nativeVideoConfig(profile, globalThis, codec);
  const hardwareAcceleration = native?.hardwareAcceleration || 'prefer-hardware';
  if (current !== attempt) return;
  activeCodec = codec;
  const label = { mpeg1: 'Canvas software video', h264: 'H.264', h265: 'H.265' }[codec];
  $('video-mode-status').textContent = codec === preferred
    ? (codec === 'mpeg1' ? 'Canvas software video selected.' : `${label} · ${hardwareAcceleration === 'prefer-hardware' ? 'hardware decoding preferred' : 'browser decoding; hardware preference unavailable'}.`)
    : `Using ${label}; ${decoderFailure || 'the selected mode is unavailable for this browser or console'}.${!isSecureContext ? ' Open the HTTPS address for browser decoding.' : ''}`;
  await audio?.ready;
  if (current !== attempt) return;
  const { ticket } = await api('software/tickets', { hostId, demo, inputSession, ...profile, videoCodec: activeCodec });
  if (current !== attempt) return;
  const url = new URL('/api/software/stream', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  quality?.restart();
  updateQuality();
  $('fps').textContent = '— fps'; $('decode').textContent = '— ms / frame'; $('network').textContent = '— Mbps';
  const previous = $('screen');
  const canvas = previous.cloneNode(); previous.replaceWith(canvas);
  const report = message => { if (attempt === current) onStreamMessage(message); };
  try {
    const useWorker = !inputSession && !forceMain && typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function' &&
      typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d') &&
      !new URLSearchParams(location.search).has('mainThread');
    if (useWorker) {
      worker = new Worker('/stream-worker.js');
      worker.onmessage = event => report(event.data);
      worker.onerror = () => { if (attempt === current) reconnect('Switching to the compatibility renderer…', true); };
      const offscreen = canvas.transferControlToOffscreen();
      const audioPort = audio?.workerPort();
      worker.postMessage({ type: 'start', canvas: offscreen, url: url.href, audioPort, videoCodec: activeCodec, hardwareAcceleration,
        presentation: { fps: profile.fps, pacing: $('frame-pacing').value },
        audioEnabled: audio?.context.state === 'running' },
        audioPort ? [offscreen, audioPort] : [offscreen]);
    } else {
      const connection = await startStream(inputSession ? null : canvas, url.href, report, activeCodec, hardwareAcceleration, { fps: profile.fps, pacing: $('frame-pacing').value });
      if (attempt !== current) { connection.close(); return; }
      stream = connection;
    }
    playing = true;
    gamepads.reset();
    updateWakeLock();
  } catch (error) { if (attempt === current) { if (activeCodec !== 'mpeg1') failedCodecs.add(activeCodec); else forceMain = true; stop(true); throw error; } }
}
function onStreamMessage(message) {
  if (message.type === 'stopped') { stop(); notify(message.message); }
  else if (message.type === 'audio') audio?.write(message.bytes, message.timestamp);
  else if (message.type === 'sync') audio?.sync(message.timestamp);
  else if (message.type === 'renderer-error') {
    if (activeCodec !== 'mpeg1') {
      console.warn('Native video decoder fallback:', message.message);
      decoderFailure = message.message;
      failedCodecs.add(activeCodec);
      reconnect('Browser video decoding failed. Trying the next supported video mode…');
      return;
    }
    reconnect('Switching to the compatibility renderer…', true);
  } else if (message.type === 'connected') {
    resetInputs(); gamepads.reset();
    if (message.inputOnly) $('stream-status').textContent = 'Controller connected';
  } else if (message.type === 'stats') {
    updateHud(message, activeCodec);
    if (message.totalFrames > 600) retry.reset();
    $('fps').textContent = `${message.fps.toFixed(1)} fps`;
    $('fps').dataset.frames = message.totalFrames;
    $('decode').textContent = `${message.decodeMs.toFixed(1)} ms / frame`;
    $('network').textContent = `${message.mbps.toFixed(1)} Mbps`;
    const ms = value => value == null ? '…' : `${value.toFixed(1)} ms`;
    $('timing-status').textContent = `Round trip ${ms(message.rttMs)} · delivery estimate ${ms(message.transportMs)} · server send queue ${ms(message.serverQueueMs)} · ready-to-canvas ${ms(message.videoAgeMs)}`;
    $('render-status').textContent = `Decode ${ms(message.nativeDecodeMs ?? message.codecMs)} · color ${ms(message.colorMs)} (${message.pixelEngine}) · draw ${ms(message.drawMs)} · canvas queue ${ms(message.queueMs)} · ${message.droppedFrames} superseded frames`;
    $('timing-status').dataset.metrics = JSON.stringify(message);
    $('resolution').textContent = `${message.width} × ${message.height}`;
    $('engine').textContent = `${message.engine} · Canvas 2D${worker ? ' · worker' : ''}`;
    if (message.totalFrames) {
      $('connecting').hidden = true;
      $('stream-status').textContent = 'Playing';
    }
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
  if (preserveTarget) return;
  resetFullscreenGestures();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('player').classList.remove('theater');
  $('library-profile').append($('profile-settings'));
  $('apply-profile').hidden = true;
  $('player').hidden = true;
  $('library').hidden = !token;
}
$('demo').onclick = () => run($('demo'), () => play(null, `${$('resolution-profile').value}${$('fps-profile').value} · Browser test`, true));
$('stop').onclick = () => stop();
$('retry-stream').onclick = () => { retry.reset(); void connect(); };
$('show-controls').onchange = () => { resetFullscreenGestures(); resetInputs(); gamepads.reset(); $('controls').hidden = !$('show-controls').checked; };
$('controls').hidden = !$('show-controls').checked;
async function enterFullscreen() {
  if ($('player').hidden || document.fullscreenElement === $('player')) return;
  try {
    if (!$('player').requestFullscreen) throw new Error();
    await $('player').requestFullscreen();
    if ($('player').hidden && document.fullscreenElement) await document.exitFullscreen();
  } catch { if (!$('player').hidden) $('player').classList.add('theater'); }
}
async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else if ($('player').classList.contains('theater')) $('player').classList.remove('theater');
  else await enterFullscreen();
}
$('fullscreen').onclick = () => run($('fullscreen'), toggleFullscreen, false);
$('hud-exit').onclick = () => {
  if (document.fullscreenElement || $('player').classList.contains('theater')) void toggleFullscreen();
};
function updateDebug() {
  $('player').classList.toggle('debug', $('debug-mode').checked);
  $('debug-overlay').hidden = !$('debug-mode').checked;
  $('debug-overlay').dataset.layout = $('hud-style').value;
  $('hud-settings').hidden = !$('debug-mode').checked;
}
$('debug-mode').onchange = updateDebug;
$('hud-style').onchange = updateDebug;
updateDebug();
$('copy-debug').onclick = () => run($('copy-debug'), copyDiagnostics, false);
function togglePreference(id) {
  $(id).checked = !$(id).checked;
  $(id).dispatchEvent(new Event('change', { bubbles: true }));
}
function cycleHud(direction = 1) {
  const choices = $('hud-style');
  choices.selectedIndex = (choices.selectedIndex + direction + choices.options.length) % choices.options.length;
  choices.dispatchEvent(new Event('change', { bubbles: true }));
}
const resetFullscreenGestures = bindFullscreenGestures($('stage'), {
  isFullscreen: () => !!document.fullscreenElement || $('player').classList.contains('theater'),
  exitFullscreen: toggleFullscreen,
  touchControlsEnabled: () => $('show-controls').checked,
  debugEnabled: () => $('debug-mode').checked,
  toggleTouchControls: () => togglePreference('show-controls'),
  toggleDebugHud: () => togglePreference('debug-mode'),
  cycleHud,
  exitButton: $('fullscreen-exit')
});
document.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea') || event.repeat) return;
  if (event.code === 'Escape') { resetFullscreenGestures(); $('player').classList.remove('theater'); }
  if (event.shiftKey && event.code === 'KeyH' && !$('player').hidden && $('debug-mode').checked) {
    event.preventDefault(); event.stopPropagation();
    cycleHud();
  }
  if (event.shiftKey && event.code === 'KeyD' && !$('player').hidden) {
    event.preventDefault();
    event.stopPropagation();
    togglePreference('debug-mode');
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
    updateHud(message, activeCodec);
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

$('video-mode').addEventListener('change', () => {
  failedCodecs.clear(); decoderFailure = '';
  if (target && !target.inputSession) { retry.reset(); reconnect('Applying video mode…'); }
});

const presets = {
  tesla: { codec: 'mpeg1', resolution: '720p', fps: 60, bitrateKbps: 10000 },
  balanced: { codec: 'h264', resolution: '720p', fps: 60, bitrateKbps: 10000 },
  detail: { codec: 'h264', resolution: '1080p', fps: 60, bitrateKbps: 20000 }
};
function savePlaybackPreferences() {
  syncChoices();
  for (const id of preferenceIds) {
    const element = $(id);
    try { localStorage.setItem(`remote-play:${id}`, element.type === 'checkbox' ? element.checked : element.value); } catch {}
  }
  for (const button of document.querySelectorAll('[data-preset]')) {
    const preset = presets[button.dataset.preset], selected = selectedProfile();
    button.setAttribute('aria-pressed', String(preset.codec === $('video-mode').value && preset.resolution === selected.resolution && preset.fps === selected.fps && preset.bitrateKbps === selected.bitrateKbps));
  }
}
for (const button of document.querySelectorAll('[data-preset]')) button.onclick = () => {
  const preset = presets[button.dataset.preset];
  $('video-mode').value = preset.codec;
  $('resolution-profile').value = preset.resolution;
  $('fps-profile').value = String(preset.fps);
  $('bitrate').value = String(preset.bitrateKbps);
  failedCodecs.clear(); decoderFailure = '';
  savePlaybackPreferences();
  if (target && !target.inputSession) changeProfile(selectedProfile(), 'Quick profile selected');
  else updateQuality();
};
document.addEventListener('change', event => { if (preferenceIds.includes(event.target.id)) savePlaybackPreferences(); });
savePlaybackPreferences();

$('frame-pacing').onchange = () => { if (target && !target.inputSession) changeProfile(selectedProfile(), 'Frame pacing updated'); };
