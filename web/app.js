import { bindFullscreenGestures } from './fullscreen-gestures.js';
import { bindChoiceButtons } from './choice-buttons.js';
import { bindSessionTabs } from './session-tabs.js';
import { updateHud, resetHud, copyDiagnostics } from './debug-hud.js';
import { selectVideoCodec, nativeVideoConfig } from './native-decoder.js';
import { StreamHealth } from './stream-health.js';
import { createVideoSink, supportsVideoSink } from './video-sink.js';
import { bindInputs } from './input.js';
import { pollGamepads } from './gamepad.js';
import { Reconnect } from './reconnect.js';
import { AudioOutput } from './audio.js';
import { startStream } from './stream-runtime.js';
import { AdaptiveQuality } from './adaptive.js';
import { encodeAccountId } from './account-id.js';
import { bindSetup } from './setup.js';
import { StreamLog, describeEvent } from './diagnostics.js';

const $ = id => document.getElementById(id);
let token = null, registering = false, worker = null, stream = null, playing = false, attempt = 0;
const setup = bindSetup(api, refresh, notify);
let pairedConsoleIds = new Set(), scanning = false, knownDevices = [];
const sendToServer = message => { worker?.postMessage(message); stream?.input(message); };
const resetInputs = bindInputs($('controls'), sendToServer, () => playing);
let telemetryEventsSent = 0;

let target = null, forceMain = false, activeSession = null, wakeLock = null, wakeRequest = 0;
// Presentation needs display-aligned animation frames. A worker without them (Safari) would pace by
// timer and judder, so those browsers render on the main thread instead; probed once at startup.
const workerAnimationFrames = new Promise(resolve => {
  if (typeof Worker !== 'function') { resolve(false); return; }
  let probe = null;
  const done = value => { resolve(value); probe?.terminate(); probe = null; };
  try {
    probe = new Worker('/stream-worker.js');
    probe.onmessage = event => { if (event.data?.type === 'capabilities') done(!!event.data.animationFrames); };
    probe.onerror = () => done(false);
    probe.postMessage({ type: 'probe' });
    setTimeout(() => done(false), 5000);
  } catch { done(false); }
});
let audio = null, quality = null, activeCodec = 'mpeg1', videoSink = null;
const failedCodecs = new Set();
let decoderFailure = '', sleepingHost = null;
const selectedProfile = () => ({ bitrateKbps: Number($('bitrate').value), resolution: $('resolution-profile').value, fps: Number($('fps-profile').value) });
const retry = new Reconnect(() => connect());
const log = new StreamLog();
const health = new StreamHealth();
const settings = () => ({ mode: $('controller-mode').value, index: $('controller-index').value,
  swap: $('controller-swap').value, deadZone: Number($('dead-zone').value),
  invertAB: $('invert-ab').checked, invertXY: $('invert-xy').checked, invertY: $('invert-y').checked, rumble: $('rumble').checked });
const controllerOverridden = () => $('controller-mode').value !== 'auto' || $('controller-index').value !== '' || $('controller-swap').value !== 'auto' ||
  $('dead-zone').value !== '0.12' || $('invert-ab').checked || $('invert-xy').checked || $('invert-y').checked || !$('rumble').checked;
const gamepads = pollGamepads(resetInputs.state, () => playing && !document.hidden && document.hasFocus(),
  settings, (text, preview = '') => {
    $('controller-status').textContent = text; $('controller-preview').textContent = preview;
    if (/is not connected|excluded by/.test(text)) $('controller-advanced').open = true;
  });
$('controller-reset').onclick = () => {
  $('controller-mode').value = 'auto'; $('controller-index').value = ''; $('controller-swap').value = 'auto'; $('dead-zone').value = '0.12';
  $('invert-ab').checked = $('invert-xy').checked = $('invert-y').checked = false; $('rumble').checked = true;
  for (const id of ['controller-mode', 'controller-index', 'controller-swap', 'dead-zone', 'invert-ab', 'invert-xy', 'invert-y', 'rumble']) $(id).dispatchEvent(new Event('change', { bubbles: true }));
};
for (const type of ['gamepadconnected', 'gamepaddisconnected']) window.addEventListener(type, event => {
  log.event(type, { id: event.gamepad?.id, index: event.gamepad?.index, mapping: event.gamepad?.mapping, buttons: event.gamepad?.buttons?.length, axes: event.gamepad?.axes?.length });
  gamepads.reset();
});
try {
  if (localStorage.getItem('remote-play:video-mode') === null && localStorage.getItem('remote-play:hardware-acceleration') === 'false')
    $('video-mode').value = 'mpeg1';
} catch {}
let startInFullscreen = false;
try { startInFullscreen = localStorage.getItem('remote-play:auto-fullscreen') === 'true'; } catch {}
const preferenceIds = ['controller-mode', 'controller-index', 'controller-swap', 'dead-zone', 'invert-ab', 'invert-xy', 'invert-y', 'rumble', 'keep-awake', 'video-mode', 'resolution-profile', 'fps-profile', 'bitrate', 'show-controls', 'debug-mode', 'mute', 'volume', 'audio-delay', 'frame-pacing', 'hud-style', 'auto-quality', 'video-output', 'debug-telemetry'];
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
    if (!(profileScope && Object.values(profileFields).includes(id)))
      try { localStorage.setItem(`remote-play:${id}`, element.type === 'checkbox' ? element.checked : element.value); } catch {}
    gamepads.reset();
    updateWakeLock();
  });
}
if (!['auto', 'mpeg1', 'h264', 'h265'].includes($('video-mode').value)) $('video-mode').value = 'auto';
if (!['detailed', 'minimal', 'horizontal'].includes($('hud-style').value)) $('hud-style').value = 'detailed';
const query = new URLSearchParams(location.search);
const launchOverrides = new Set();
for (const [param, id] of [['controllerMode', 'controller-mode'], ['controllerIndex', 'controller-index'], ['teslaSwap', 'controller-swap'], ['bitrate', 'bitrate'], ['resolution', 'resolution-profile'], ['fps', 'fps-profile']]) {
  if (query.has(param)) {
    const element = $(id), value = query.get(param);
    if (element.tagName !== 'SELECT' || [...element.options].some(option => option.value === value)) { element.value = value; launchOverrides.add(id); }
    element.addEventListener('change', () => launchOverrides.delete(id));
  }
}
const syncChoices = bindChoiceButtons();
$('controller-advanced').open = controllerOverridden();
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

let toastTimer;
function notify(message, tone = 'info') {
  if ($('setup-dialog').open) { $('psn-status').textContent = message; $('psn-status').hidden = !message; return; }
  if ($('console-dialog').open) { $('console-message').textContent = message; $('console-message').dataset.tone = tone; $('console-message').hidden = !message; return; }
  if (!$('player').hidden && !$('stage').hidden) {
    $('connection-message').textContent = message;
    $('connection-message').dataset.tone = tone;
    return;
  }
  clearTimeout(toastTimer);
  $('message').textContent = message;
  $('toast').dataset.tone = tone;
  $('toast').dataset.open = String(!!message);
  if (message && tone === 'info') toastTimer = setTimeout(() => { $('toast').dataset.open = 'false'; }, 8000);
}
$('dismiss-message').onclick = () => { clearTimeout(toastTimer); $('toast').dataset.open = 'false'; };
for (const link of document.querySelectorAll('.tesla-link')) link.href = `https://www.youtube.com/redirect?q=${encodeURIComponent(`${location.origin}/`)}`;
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
  button.setAttribute('aria-busy', 'true');
  if (clearMessage) notify('');
  try { await action(); } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}
function showAccount() {
  $('restoring')?.remove();
  $('account').hidden = !!token;
  $('library').hidden = !token;
  $('logout').hidden = !token;
}
let firstRun = false;
function setRegistering(value) {
  registering = value;
  $('email-label').hidden = !registering;
  $('email').required = registering;
  $('username').previousSibling.textContent = registering ? 'Username (letters, numbers, underscore)' : 'Username or email';
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('auth-eyebrow').textContent = firstRun ? 'FIRST RUN' : 'WELCOME BACK';
  $('auth-title').textContent = firstRun ? 'Create the owner account' : registering ? 'Create your account' : 'Sign in to play';
  $('auth-submit').textContent = registering ? 'Create account' : 'Sign in';
  $('auth-toggle').textContent = registering ? 'Already have an account? Sign in' : 'Create a local account';
  $('auth-intro').hidden = !firstRun;
}
$('auth-toggle').onclick = () => setRegistering(!registering);
async function loadSetupState() {
  try {
    const state = await api('auth/setup');
    firstRun = !!state.needsSetup;
    $('auth-toggle').hidden = firstRun || !state.registrationOpen;
    setRegistering(firstRun);
  } catch {
    firstRun = false;
    setRegistering(false);
  }
}
$('auth-form').onsubmit = event => {
  event.preventDefault();
  run($('auth-submit'), async () => {
    const credentials = { usernameOrEmail: $('username').value.trim(), password: $('password').value };
    if (registering) await api('auth/register', { username: credentials.usernameOrEmail, email: $('email').value, password: credentials.password });
    const result = await api('auth/login', credentials);
    firstRun = false; $('auth-toggle').hidden = true; setRegistering(false);
    token = result.token;
    setup.reset();
    $('password').value = '';
    await loadSettings();
    showAccount();
    await refresh();
    void setup.restore();
    const signedInToken = token;
    try {
      const saved = await api('auth/session');
      if (token === signedInToken && saved.token !== signedInToken)
        notify('Signed in for this page only: the browser did not retain your saved login. Allow cookies for this site, then sign in again.', 'error');
    } catch {
      if (token === signedInToken)
        notify('Signed in, but saved login could not be verified. Refreshing may require signing in again.', 'error');
    }
  });
};
$('logout').onclick = () => run($('logout'), async () => {
  await api('auth/logout', {});
  stop(); token = null; setup.reset(); showAccount(); notify('');
  await loadSetupState();
});

async function restoreSession() {
  try {
    const session = await api('auth/session');
    token = session.token;
    if (token) { await loadSettings(); await refresh(); void setup.restore(); }
  } catch (error) { notify(`Could not restore your session: ${error.message}`, 'error'); }
  finally { showAccount(); }
  if (token) resumeRoute();
  else await loadSetupState();
}
function resumeRoute() {
  const match = /^#\/(play\/(.+)|test)$/.exec(location.hash);
  if (!match || target) return;
  if (match[1] === 'test') { void play(null, `${$('resolution-profile').value}${$('fps-profile').value} · Browser test`, true); return; }
  const device = knownDevices.find(candidate => candidate.hostId === decodeURIComponent(match[2]));
  if (device?.isRegistered) void play(device.hostId, device.hostName || device.hostType || 'PlayStation', false, null, device.hostType);
  else { history.replaceState(null, '', location.pathname + location.search); notify('That console is no longer paired with your account.', 'error'); }
}
window.addEventListener('popstate', () => { if (target && !target.inputSession && !/^#\/(play\/|test)/.test(location.hash)) stop(); });

const defaultBitrate = { '360p': '3000', '540p': '6000', '720p': '10000', '1080p': '20000' };
const profileFields = { codec: 'video-mode', resolution: 'resolution-profile', fps: 'fps-profile', bitrateKbps: 'bitrate', pacing: 'frame-pacing' };
let consoleProfiles = {}, profileScope = null, sharedSettings = null, dialogConsole = null;
try { consoleProfiles = JSON.parse(localStorage.getItem('remote-play:console-profiles') || '{}') || {}; } catch {}
function persistConsoleProfiles() { try { localStorage.setItem('remote-play:console-profiles', JSON.stringify(consoleProfiles)); } catch {} scheduleSettingsUpload(); }
// Settings follow the account: every local save also uploads, and sign-in applies the account copy
// (or uploads this browser's copy when the account has none yet). Launch overrides never travel.
let settingsUploadTimer = null, applyingSettings = false, settingsChangedAt = 0, settingsReady = false;
try { settingsChangedAt = Number(localStorage.getItem('remote-play:settings-changed-at')) || 0; } catch {}
function collectSettings() {
  const preferences = {};
  for (const id of preferenceIds) {
    const element = $(id);
    const profileKey = profileScope ? Object.keys(profileFields).find(key => profileFields[key] === id) : null;
    if (launchOverrides.has(id)) { try { const saved = localStorage.getItem(`remote-play:${id}`); if (saved !== null) preferences[id] = saved; } catch {} }
    else if (profileKey) preferences[id] = String(sharedSettings[profileKey]);
    else preferences[id] = element.type === 'checkbox' ? String(element.checked) : element.value;
  }
  return { preferences, consoleProfiles, autoFullscreen: startInFullscreen, updatedAt: settingsChangedAt };
}
function uploadSettings(keepalive = false) {
  clearTimeout(settingsUploadTimer); settingsUploadTimer = null;
  if (!token) return;
  const body = JSON.stringify(collectSettings());
  fetch('/api/settings', { method: 'PUT', keepalive, headers: { 'Content-Type': 'application/json', 'X-Remote-Play-Session': '1', Authorization: `Bearer ${token}` }, body })
    .then(response => { if (!response.ok) throw new Error(`Request failed (${response.status}).`); })
    .catch(error => log.event('settings-upload-failed', { message: error.message }));
}
function scheduleSettingsUpload() {
  if (applyingSettings || !settingsReady) return;
  settingsChangedAt = Date.now();
  try { localStorage.setItem('remote-play:settings-changed-at', String(settingsChangedAt)); } catch {}
  if (!token) return;
  clearTimeout(settingsUploadTimer);
  settingsUploadTimer = setTimeout(uploadSettings, 300);
}
window.addEventListener('pagehide', () => { if (settingsUploadTimer) uploadSettings(true); });
function applySettings(saved) {
  applyingSettings = true;
  try {
    for (const [id, value] of Object.entries(saved.preferences || {})) {
      if (!preferenceIds.includes(id) || launchOverrides.has(id)) continue;
      const element = $(id);
      if (element.type === 'checkbox') element.checked = value === 'true' || value === true;
      else if (element.tagName !== 'SELECT' || [...element.options].some(option => option.value === String(value))) element.value = String(value);
    }
    if (saved.consoleProfiles && typeof saved.consoleProfiles === 'object') { consoleProfiles = saved.consoleProfiles; persistConsoleProfiles(); }
    if (typeof saved.autoFullscreen === 'boolean') setStartInFullscreen(saved.autoFullscreen);
    if (!['auto', 'mpeg1', 'h264', 'h265'].includes($('video-mode').value)) $('video-mode').value = 'auto';
    if (!['detailed', 'minimal', 'horizontal'].includes($('hud-style').value)) $('hud-style').value = 'detailed';
    $('advanced-settings').open = $('frame-pacing').value !== 'smooth' || $('bitrate').value !== defaultBitrate[$('resolution-profile').value];
    $('controller-advanced').open = controllerOverridden();
    savePlaybackPreferences(); updateQuality(); updateDebug(); syncAudio(); updateTouchOverlay(); gamepads.reset(); void updateWakeLock();
  } finally { applyingSettings = false; }
}
async function loadSettings() {
  try {
    const { settings } = await api('settings');
    // Last writer wins: a change made here moments before a reload outranks an older account copy.
    if (settings && (settings.updatedAt || 0) >= settingsChangedAt) applySettings(settings);
    else uploadSettings();
  } catch (error) { notify(`Could not load your saved settings: ${error.message}`, 'error'); }
}
function readSettings() { return Object.fromEntries(Object.entries(profileFields).map(([key, id]) => [key, $(id).value])); }
function writeSettings(values) {
  for (const [key, id] of Object.entries(profileFields)) if (values[key] !== undefined && [...$(id).options].some(option => option.value === String(values[key]))) $(id).value = String(values[key]);
  $('advanced-settings').open = $('frame-pacing').value !== 'smooth' || $('bitrate').value !== defaultBitrate[$('resolution-profile').value];
  savePlaybackPreferences();
}
function describeProfile(profile) {
  return `${profile.resolution}${profile.fps} · ${{ auto: 'Automatic', mpeg1: 'Canvas', h264: 'H.264', h265: 'H.265' }[profile.codec] || profile.codec} · ${Number(profile.bitrateKbps) / 1000} Mbps${profile.pacing === 'responsive' ? ' · responsive' : ''}`;
}
function enterConsoleScope(hostId) {
  if (profileScope === hostId) return;
  if (!profileScope) sharedSettings = readSettings();
  profileScope = hostId;
  writeSettings(consoleProfiles[hostId]);
}
function leaveConsoleScope() {
  if (!profileScope) return;
  profileScope = null;
  writeSettings(sharedSettings);
  sharedSettings = null;
}
function consoleState(status) {
  if (/standby/i.test(status || '')) return 'rest';
  if (/^ok$/i.test(status || '')) return 'ready';
  return 'unknown';
}
function consoleStatus(status) {
  return { rest: 'Rest mode', ready: 'Ready' }[consoleState(status)] || status || 'Paired';
}
function setDeviceStatus(card, hostType, ip, status) {
  const state = consoleState(status);
  const detail = card.querySelector('.device-status');
  detail.replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot'; dot.dataset.state = state; dot.setAttribute('aria-hidden', 'true');
  detail.append(dot, `${hostType || 'Console'} · ${ip || 'IP unavailable'} · ${consoleStatus(status)}`);
  card.querySelector('.wake').hidden = state === 'ready';
  card.querySelector('.sleep').hidden = state === 'rest';
}
function setStartInFullscreen(value) {
  startInFullscreen = value;
  try { localStorage.setItem('remote-play:auto-fullscreen', String(startInFullscreen)); } catch {}
  for (const input of document.querySelectorAll('.fullscreen-toggle input')) {
    input.checked = startInFullscreen;
    input.closest('label').classList.toggle('is-selected', startInFullscreen);
  }
  scheduleSettingsUpload();
}
function fullscreenToggle() {
  const label = document.createElement('label'); label.className = 'check fullscreen-toggle'; label.title = 'Start in fullscreen';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = startInFullscreen;
  checkbox.setAttribute('aria-label', 'Start in fullscreen');
  checkbox.onchange = () => setStartInFullscreen(checkbox.checked);
  const icon = document.createElement('img'); icon.src = '/art/fullscreen.svg'; icon.width = icon.height = 20; icon.alt = '';
  const text = document.createElement('span'); text.textContent = 'Start in fullscreen';
  label.classList.toggle('is-selected', startInFullscreen);
  label.append(checkbox, icon, text);
  return label;
}
async function checkForUpdate() {
  try {
    const status = await api('version');
    $('update-notice').hidden = !status.updateAvailable;
    if (status.updateAvailable) $('update-notice').textContent = `Update available · ${status.version} → ${status.latest} · run psrp update on the server`;
  } catch { $('update-notice').hidden = true; }
}
async function refresh() {
  void checkForUpdate();
  await refreshActive();
  const devices = await api('playstation/my-devices');
  knownDevices = devices;
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
    const detail = document.createElement('p'); detail.className = 'device-status';
    const custom = document.createElement('span'); custom.className = 'device-custom';
    info.append(title, detail, custom);
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'Play'; button.disabled = !device.isRegistered;
    button.onclick = () => run(button, () => play(device.hostId, title.textContent, false, null, device.hostType));
    const wake = document.createElement('button'); wake.className = 'quiet wake'; wake.textContent = 'Wake up';
    wake.disabled = !device.isRegistered;
    wake.onclick = () => run(wake, async () => {
      wake.textContent = 'Waking…';
      try { await wakeConsole(device.hostId); } finally { wake.textContent = 'Wake up'; }
    });
    const settings = document.createElement('button'); settings.className = 'quiet'; settings.textContent = 'Console settings';
    settings.onclick = () => openConsoleDialog(device);
    const disconnect = document.createElement('button'); disconnect.className = 'quiet danger'; disconnect.textContent = 'Disconnect all sessions';
    disconnect.disabled = !device.isRegistered;
    disconnect.onclick = () => run(disconnect, () => disconnectConsole(device.hostId));
    const recovery = document.createElement('details'); recovery.className = 'device-recovery';
    const summary = document.createElement('summary'); summary.textContent = 'Trouble connecting?';
    const recoveryHint = document.createElement('span'); recoveryHint.className = 'hint'; recoveryHint.textContent = 'Release every session this server holds for the console, then press Play again.';
    recovery.append(summary, recoveryHint, disconnect);
    const actions = document.createElement('div'); actions.className = 'device-actions'; const sleep = document.createElement('button'); sleep.className = 'quiet sleep'; sleep.textContent = 'Put console to sleep';
    sleep.disabled = !device.isRegistered;
    sleep.onclick = () => run(sleep, () => sleepConsole(device.hostId));
    const playActions = document.createElement('div'); playActions.className = 'play-actions';
    playActions.append(fullscreenToggle(), button);
    actions.append(playActions, wake, sleep, settings, recovery);
    card.append(icon, info, actions); $('devices').append(card);
    setDeviceStatus(card, device.hostType, device.ipAddress, device.status);
    updateCustomLine(card, device.hostId);
  }
  void discoverConsoles();
}
function updateCustomLine(card, hostId) {
  const profile = consoleProfiles[hostId];
  card.querySelector('.device-custom').textContent = profile ? `Custom settings · ${describeProfile(profile)}` : '';
}
async function wakeConsole(hostId) {
  notify('Waking console…', 'busy');
  await api('software/wake', { hostId }, { timeout: 30000 });
  await refresh();
  notify('Console is awake. Choose Play to connect.');
}
function openConsoleDialog(device) {
  dialogConsole = device;
  $('console-title').textContent = device.hostName || device.hostType || 'PlayStation';
  const detail = $('console-detail'), state = consoleState(device.status);
  detail.replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot'; dot.dataset.state = state; dot.setAttribute('aria-hidden', 'true');
  detail.append(dot, `${device.hostType || 'Console'} · ${device.ipAddress || 'IP unavailable'} · ${consoleStatus(device.status)}`);
  $('console-wake').hidden = state === 'ready';
  $('console-sleep').hidden = state === 'rest';
  for (const id of ['console-play', 'console-wake', 'console-sleep', 'console-disconnect']) $(id).disabled = !device.isRegistered;
  $('console-message').hidden = true;
  $('console-custom').checked = !!consoleProfiles[device.hostId];
  syncConsoleProfile();
  $('console-dialog').showModal();
}
function syncConsoleProfile() {
  const custom = $('console-custom').checked, hostId = dialogConsole.hostId;
  $('console-profile-hint').textContent = custom ? 'These settings apply only when you play this console. Presets and tiles edit the console profile while this is on.' : 'The shared Stream settings apply when you press Play.';
  if (custom) {
    consoleProfiles[hostId] ??= readSettings();
    persistConsoleProfiles();
    enterConsoleScope(hostId);
    $('console-profile-host').append($('profile-settings'));
  } else {
    delete consoleProfiles[hostId];
    persistConsoleProfiles();
    leaveConsoleScope();
    $('library-profile').append($('profile-settings'));
  }
}
function closeConsoleDialog() {
  if (!dialogConsole) return;
  leaveConsoleScope();
  $('library-profile').append($('profile-settings'));
  const card = $('devices').querySelector(`[data-host-id="${CSS.escape(dialogConsole.hostId)}"]`);
  if (card) updateCustomLine(card, dialogConsole.hostId);
  dialogConsole = null;
  if ($('console-dialog').open) $('console-dialog').close();
}
$('console-custom').onchange = syncConsoleProfile;
$('close-console').onclick = closeConsoleDialog;
$('console-dialog').addEventListener('close', closeConsoleDialog);
$('console-play').onclick = () => { const device = dialogConsole; closeConsoleDialog(); void run($('console-play'), () => play(device.hostId, device.hostName || device.hostType || 'PlayStation', false, null, device.hostType)); };
$('console-wake').onclick = () => run($('console-wake'), () => wakeConsole(dialogConsole.hostId));
$('console-sleep').onclick = () => run($('console-sleep'), () => sleepConsole(dialogConsole.hostId));
$('console-disconnect').onclick = () => run($('console-disconnect'), () => disconnectConsole(dialogConsole.hostId));
async function sleepConsole(hostId) {
  retry.reset();
  notify('Sending rest-mode request…', 'busy');
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
  notify('Disconnecting all sessions for this console…', 'busy');
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
      const card = console.uuid ? cards.get(console.uuid) : null;
      if (card) setDeviceStatus(card, console.hostType, console.ip, console.status);
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
  if (hostId && !inputSession && consoleProfiles[hostId]) enterConsoleScope(hostId);
  target = { hostId, title, demo, inputSession, hostType, profile: selectedProfile(), codec: $('video-mode').value, pacing: $('frame-pacing').value, auto: $('auto-quality').checked };
  resetHud(); log.reset(); telemetryEventsSent = 0; health.reset(); showHealth({ level: 'good', reason: '' }); renderEvents();
  log.event('play', { hostId, demo, inputSession: !!inputSession, profile: target.profile, codec: $('video-mode').value });
  quality = new AdaptiveQuality(target.profile);
  $('connection-message').textContent = '';
  showPlayer(target);
  window.scrollTo(0, 0);
  if (!inputSession) {
    const route = demo ? '#/test' : `#/play/${encodeURIComponent(hostId)}`;
    if (location.hash !== route) history.pushState({ route }, '', route);
  }
  selectSessionTab(inputSession ? 'input-panel' : 'picture-panel');
  if (hostId && !inputSession && startInFullscreen) void enterFullscreen();
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
function showHealth({ level, reason }) {
  const dot = $('stream-health');
  dot.dataset.level = level;
  const text = { good: 'Connection good', fair: `Connection degraded: ${reason}`, poor: `Connection poor: ${reason}` }[level];
  dot.title = text; dot.setAttribute('aria-label', text);
}
function failConnection(message) {
  stop(true);
  retry.reset();
  $('stream-status').textContent = 'Connection failed';
  $('connecting').textContent = 'Connection failed';
  notify(message, 'error');
}
function reconnect(message, workerFailed = false) {
  if (!target) return;
  if (sleepingHost && target.hostId === sleepingHost) { stop(); return; }
  if (workerFailed) forceMain = true;
  stop(true);
  const consoleBusy = /occupied|still active|in use|wait for it to close/i.test(message);
  // Console-side failures (rejected handshake, no response, reset) need a pause, not an instant retry.
  const consoleFailed = !consoleBusy && /console/i.test(message);
  if (!retry.schedule(consoleBusy ? 4000 : consoleFailed ? 2000 : 0, consoleBusy)) { failConnection(`${message} Automatic reconnection stopped after ${consoleBusy ? 'a minute of waiting' : 'five attempts'}. Disconnect and press Play when ready.`); return; }
  log.event('reconnect', { attempt: retry.count, waiting: consoleBusy, message });
  $('stream-status').textContent = consoleBusy ? 'Waiting for the console to free the previous session…' : `Reconnecting · attempt ${retry.count}/5`;
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
  $('stream-title').textContent = demo && !inputSession ? `${profile.resolution}${profile.fps} · Browser test` : title;
  $('stream-status').textContent = 'Connecting…';
  $('stream-profile').textContent = '';
  $('enable-audio').hidden = false;
}
async function openStream({ hostId, title, demo, inputSession, hostType, profile, codec: preferred, pacing }) {
  stop(true);
  showPlayer({ hostId, title, demo, inputSession, profile });
  const current = ++attempt;
  const codec = inputSession ? 'mpeg1' : await selectVideoCodec(preferred, profile, failedCodecs, hostType);
  const native = codec === 'mpeg1' ? null : await nativeVideoConfig(profile, globalThis, codec);
  const hardwareAcceleration = native?.hardwareAcceleration || 'prefer-hardware';
  if (current !== attempt) return;
  activeCodec = codec;
  const label = { mpeg1: 'Canvas software video', h264: 'H.264', h265: 'H.265' }[codec];
  const automatic = preferred === 'auto';
  $('video-mode-status').textContent = codec === preferred || (automatic && codec !== 'mpeg1')
    ? (codec === 'mpeg1' ? 'Canvas software video selected.' : `${automatic ? 'Automatic · ' : ''}${label} · ${hardwareAcceleration === 'prefer-hardware' ? 'hardware decoding preferred' : 'browser decoding; hardware preference unavailable'}.`)
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
  // Video-element output runs on the main thread: the element is DOM, and its frame callbacks report real screen timing.
  const output = $('video-output').value;
  const wantsVideoSink = output !== 'canvas' && !inputSession && activeCodec !== 'mpeg1';
  const useVideoSink = wantsVideoSink && supportsVideoSink();
  if (output === 'video' && !useVideoSink) $('video-mode-status').textContent += ' Video element output is unavailable in this browser; drawing on canvas.';
  try {
    const useWorker = !inputSession && !forceMain && !useVideoSink && typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function' &&
      typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d') &&
      !new URLSearchParams(location.search).has('mainThread') && await workerAnimationFrames;
    if (useWorker) {
      worker = new Worker('/stream-worker.js');
      worker.onmessage = event => report(event.data);
      worker.onerror = () => { if (attempt === current) reconnect('Switching to the compatibility renderer…', true); };
      const offscreen = canvas.transferControlToOffscreen();
      const audioPort = audio?.workerPort();
      worker.postMessage({ type: 'start', canvas: offscreen, url: url.href, audioPort, videoCodec: activeCodec, hardwareAcceleration,
        presentation: { fps: profile.fps, pacing },
        audioEnabled: audio?.context.state === 'running' },
        audioPort ? [offscreen, audioPort] : [offscreen]);
    } else {
      if (useVideoSink) { videoSink = createVideoSink($('screen-video')); $('screen-video').hidden = false; canvas.hidden = true; }
      const connection = await startStream(inputSession ? null : canvas, url.href, report, activeCodec, hardwareAcceleration, { fps: profile.fps, pacing, sink: videoSink });
      if (attempt !== current) { connection.close(); return; }
      stream = connection;
    }
    playing = true;
    gamepads.reset();
    updateWakeLock();
  } catch (error) { if (attempt === current) { if (activeCodec !== 'mpeg1') failedCodecs.add(activeCodec); else forceMain = true; stop(true); throw error; } }
}
function renderEvents() {
  const recent = log.recent(8);
  $('event-log').replaceChildren(...(recent.length ? recent.map(event => { const item = document.createElement('li'); item.textContent = describeEvent(event); return item; })
    : [Object.assign(document.createElement('li'), { className: 'hint', textContent: 'No stalls, drops or reconnects recorded yet.' })]));
}
function diagnosticsCapture() {
  return log.export({ title: target?.title ?? $('stream-title').textContent, codec: activeCodec, engine: $('engine').textContent, profile: target?.profile,
    pacing: $('frame-pacing').value, audioDelayMs: Number($('audio-delay').value), worker: !!worker, userAgent: navigator.userAgent, secureContext: isSecureContext,
    latest: { video: $('timing-status').dataset.metrics ? JSON.parse($('timing-status').dataset.metrics) : null, audio: $('audio-status').textContent, console: $('console-status').textContent } });
}
function saveJson(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadDiagnostics() { saveJson(diagnosticsCapture(), `remote-play-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`); }
// For browsers that cannot save files (the Tesla): the capture is stored on the server under this account
// and listed in the lobby, where any signed-in device can download it.
async function sendDiagnostics(button) {
  const status = $('diagnostics-status');
  status.textContent = 'Sending…';
  button.disabled = true;
  try {
    const saved = await api('diagnostics', diagnosticsCapture());
    status.textContent = `Saved on the server as ${saved.name}. Download it from Saved diagnostics in the lobby.`;
    if (button.id === 'hud-send') notify(`Diagnostics saved on the server as ${saved.name}.`, 'success');
  } catch (error) { status.textContent = `Could not send diagnostics: ${error.message}`; }
  finally { button.disabled = false; }
}
async function loadDiagnosticsArchive() {
  const list = $('diagnostics-list');
  try {
    const entries = await api('diagnostics');
    list.replaceChildren();
    if (!entries.length) { const empty = document.createElement('li'); empty.className = 'hint'; empty.textContent = 'Nothing saved yet.'; list.append(empty); return; }
    for (const entry of entries) {
      const item = document.createElement('li');
      const link = document.createElement('a'); link.href = '#'; link.textContent = entry.name;
      link.onclick = async event => {
        event.preventDefault();
        try { saveJson(await api(`diagnostics/${entry.name}`), entry.name); } catch (error) { notify(`Could not download ${entry.name}: ${error.message}`, 'error'); }
      };
      item.append(link, ` · ${Math.round(entry.bytes / 1024)} KB · ${new Date(entry.savedAt).toLocaleString()}`);
      list.append(item);
    }
  } catch (error) { list.replaceChildren(); const failed = document.createElement('li'); failed.className = 'hint'; failed.textContent = `Could not load saved diagnostics: ${error.message}`; list.append(failed); }
}
$('diagnostics-archive').addEventListener('toggle', () => { if ($('diagnostics-archive').open) void loadDiagnosticsArchive(); });
$('download-debug').onclick = downloadDiagnostics;
$('hud-download').onclick = downloadDiagnostics;
$('send-debug').onclick = () => sendDiagnostics($('send-debug'));
$('hud-send').onclick = () => sendDiagnostics($('hud-send'));
function onStreamMessage(message) {
  if (message.type === 'console-stats') {
    const delta = log.serverStats(message);
    $('console-status').textContent = `Console → server: ${message.lost} packets lost · ${message.dropped} frames dropped · ${message.frozen} frozen · ${message.recovered} recovered · ${message.idr} keyframe requests · ${message.pending} pending packets · console ${message.consoleFps} fps / ${message.consoleMbps} Mbps`;
    if (delta) updateHud({ type: 'console-stats', ...delta }, activeCodec);
    return;
  }
  if (message.type === 'rumble') { gamepads.rumble(message.left / 255, message.right / 255); return; }
  if (message.type === 'decoder-reset') { log.event('decoder-reset', { message: message.message, resets: message.resets }); return; }
  if (message.type === 'stopped') { log.event('stopped', { message: message.message }); stop(); notify(message.message); }
  else if (message.type === 'audio') audio?.write(message.bytes, message.timestamp);
  else if (message.type === 'sync') audio?.sync(message.timestamp);
  else if (message.type === 'renderer-error') {
    log.event('renderer-error', { message: message.message, codec: activeCodec });
    if (activeCodec !== 'mpeg1') {
      console.warn('Native video decoder fallback:', message.message);
      decoderFailure = message.message;
      failedCodecs.add(activeCodec);
      reconnect('Browser video decoding failed. Trying the next supported video mode…');
      return;
    }
    reconnect('Switching to the compatibility renderer…', true);
  } else if (message.type === 'connected') {
    log.event('connected', { inputOnly: !!message.inputOnly, codec: activeCodec });
    resetInputs(); gamepads.reset();
    if (message.inputOnly) $('stream-status').textContent = 'Controller connected';
  } else if (message.type === 'stats') {
    const sample = log.videoStats(message);
    if ($('debug-telemetry').checked && sample) {
      // Live telemetry: the same per-second sample the diagnostics file holds, plus events since the last one.
      const events = log.events.slice(telemetryEventsSent); telemetryEventsSent = log.events.length;
      sendToServer({ type: 'telemetry', sample, events });
    }
    renderEvents();
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
    if (target && message.totalFrames)
      $('stream-profile').textContent = `${target.profile.resolution}${target.profile.fps} · ${{ mpeg1: 'Canvas', h264: 'H.264', h265: 'H.265' }[activeCodec]} · ${message.mbps.toFixed(1)} Mbps`;
    if (message.totalFrames) {
      $('connecting').hidden = true;
      $('stream-status').textContent = 'Playing';
      $('connection-message').textContent = '';
      showHealth(health.sample({ stalls: message.stalls, underruns: message.underruns, arrivalMaxMs: message.arrivalMaxMs, transportMs: message.transportMs,
        consoleLost: log.server?.lost ?? null, audioUnderruns: log.audio?.underruns ?? null }));
    }
    if (target?.auto && !target.inputSession) {
      const change = quality?.sample(message, performance.now(), !document.hidden);
      if (change) changeProfile(change.profile, change.reason);
    }
  } else if (message.type === 'status') {
    log.event('status', { message: message.message }); $('stream-status').textContent = message.message;
    if (/release the previous session/.test(message.message)) notify(message.message, 'busy');
  }
  else if (message.type === 'error' || message.type === 'closed') {
    log.event(message.type, { message: message.message });
    if (target?.auto && quality && /cannot keep up|falling behind/.test(message.message)) {
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
  videoSink?.close(); videoSink = null; $('screen-video').hidden = true; $('screen').hidden = false;
  if (preserveTarget) return;
  resetFullscreenGestures();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('player').classList.remove('theater');
  leaveConsoleScope();
  $('library-profile').append($('profile-settings'));
  $('apply-profile').hidden = true;
  $('player').hidden = true;
  $('library').hidden = !token;
  if (/^#\/(play\/|test)/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
}
$('demo').onclick = () => run($('demo'), () => play(null, `${$('resolution-profile').value}${$('fps-profile').value} · Browser test`, true));
$('stop').onclick = () => stop();
function updateTouchOverlay() { $('player').classList.toggle('touch', $('show-controls').checked); }
$('show-controls').onchange = () => { resetFullscreenGestures(); resetInputs(); gamepads.reset(); updateTouchOverlay(); };
updateTouchOverlay();
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
  $('telemetry-switch').hidden = !$('debug-mode').checked;
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
    log.audioStats(message);
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
    $('enable-audio').hidden = message.state === 'running';
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
  $('bitrate').value = defaultBitrate[$('resolution-profile').value];
};
$('advanced-settings').open = $('frame-pacing').value !== 'smooth' || $('bitrate').value !== defaultBitrate[$('resolution-profile').value];

// Settings changed during playback are a draft until Apply copies them onto the target.
function sessionChanged() {
  const selected = selectedProfile();
  return $('video-mode').value !== target.codec || $('frame-pacing').value !== target.pacing || Object.keys(selected).some(key => selected[key] !== target.profile[key]);
}
function pendingSettings() { return !!target && !target.inputSession && (sessionChanged() || $('auto-quality').checked !== target.auto); }
function updateQuality(reason = '') {
  const profile = target?.profile || selectedProfile();
  const auto = target ? target.auto : $('auto-quality').checked;
  const mode = auto ? 'Automatic · selected profile is the ceiling' : 'Manual';
  const note = pendingSettings() ? 'press Apply to use the new settings' : reason;
  $('quality-status').textContent = `${mode} · active ${profile.resolution}${profile.fps} · ${profile.bitrateKbps / 1000} Mbps${note ? ` · ${note}` : ''}`;
}
function changeProfile(profile, reason) {
  if (!target || target.inputSession) return;
  log.event('profile-change', { reason, profile });
  target.profile = { ...profile };
  retry.reset();
  reconnect(`${reason}. Reconnecting with ${profile.resolution}${profile.fps}…`);
  updateQuality(reason);
}
$('apply-profile').onclick = () => {
  if (!target || target.inputSession) return;
  const selected = selectedProfile(), changed = sessionChanged();
  Object.assign(target, { codec: $('video-mode').value, pacing: $('frame-pacing').value, auto: $('auto-quality').checked });
  failedCodecs.clear(); decoderFailure = '';
  quality = new AdaptiveQuality(selected);
  if (changed) changeProfile(selected, 'Settings applied');
  else updateQuality('Settings applied');
};

const presets = {
  tesla: { codec: 'mpeg1', resolution: '720p', fps: 60, bitrateKbps: 10000 },
  balanced: { codec: 'auto', resolution: '720p', fps: 60, bitrateKbps: 10000 },
  detail: { codec: 'auto', resolution: '1080p', fps: 60, bitrateKbps: 20000 },
  // Cellular links pay per byte in transfer time and jitter: small frames, a cushion that can grow, short audio priming.
  // Measured over 5G: Responsive stalled several times a second at 37-51 fps; Smooth held 57-60 fps with no stalls.
  cellular: { codec: 'auto', resolution: '720p', fps: 60, bitrateKbps: 6000, pacing: 'smooth', audioDelayMs: 40 }
};
function savePlaybackPreferences() {
  syncChoices();
  if (profileScope) { consoleProfiles[profileScope] = readSettings(); persistConsoleProfiles(); }
  for (const id of preferenceIds) {
    if ((profileScope && Object.values(profileFields).includes(id)) || launchOverrides.has(id)) continue;
    const element = $(id);
    try { localStorage.setItem(`remote-play:${id}`, element.type === 'checkbox' ? element.checked : element.value); } catch {}
  }
  for (const button of document.querySelectorAll('[data-preset]')) {
    const preset = presets[button.dataset.preset], selected = selectedProfile();
    button.setAttribute('aria-pressed', String(preset.codec === $('video-mode').value && preset.resolution === selected.resolution && preset.fps === selected.fps && preset.bitrateKbps === selected.bitrateKbps
      && (preset.pacing ?? 'smooth') === $('frame-pacing').value));
  }
  scheduleSettingsUpload();
}
for (const button of document.querySelectorAll('[data-preset]')) button.onclick = () => {
  const preset = presets[button.dataset.preset];
  $('video-mode').value = preset.codec;
  $('resolution-profile').value = preset.resolution;
  $('fps-profile').value = String(preset.fps);
  $('bitrate').value = String(preset.bitrateKbps);
  $('frame-pacing').value = preset.pacing ?? 'smooth';
  if (preset.audioDelayMs) { $('audio-delay').value = String(preset.audioDelayMs); audio?.setDelay(preset.audioDelayMs); }
  $('advanced-settings').open = $('frame-pacing').value !== 'smooth' || $('bitrate').value !== defaultBitrate[$('resolution-profile').value];
  savePlaybackPreferences();
  updateQuality();
};
document.addEventListener('change', event => { if (preferenceIds.includes(event.target.id)) { savePlaybackPreferences(); updateQuality(); } });
savePlaybackPreferences();
settingsReady = true; // startup restores are not user changes

