const $ = id => document.getElementById(id);
const ms = value => Number.isFinite(value) ? value.toFixed(1) : '—';
const set = (id, text) => { const element = $(id); (element.querySelector('.value') || element).textContent = text; };
let history = [], video = null, audio = null, console_ = null;
export function resetHud() {
  history = []; video = audio = console_ = null;
  for (const id of ['hud-fps', 'hud-codec', 'hud-size', 'hud-rtt', 'hud-age', 'hud-bitrate', 'hud-pacing', 'hud-max', 'hud-decode', 'hud-audio', 'hud-loss']) set(id, '—');
  $('fps-history').setAttribute('points', '');
  $('hud-health').textContent = 'Waiting for audio';
}
export function updateHud(message, codec) {
  if (message.type === 'audio-stats') audio = message;
  else if (message.type === 'console-stats') console_ = message;
  else {
    video = message;
    history.push(message.fps);
    if (history.length > 30) history.shift();
  }
  if (!$('debug-mode').checked) return;
  if (video) {
    $('hud-fps').textContent = video.fps.toFixed(1);
    $('hud-codec').textContent = { mpeg1: 'MPEG-1 / CANVAS', h264: 'H.264', h265: 'H.265' }[codec];
    $('hud-size').textContent = `${video.width} × ${video.height}`;
    set('hud-rtt', ms(video.rttMs));
    set('hud-age', ms(video.videoAgeMs));
    $('hud-bitrate').textContent = `${video.mbps.toFixed(1)} Mbps`;
    set('hud-pacing', ms(video.frameP95Ms));
    set('hud-max', ms(video.frameMaxMs));
    set('hud-decode', `${(video.nativeDecodeMs ?? video.codecMs).toFixed(1)} / ${video.drawMs.toFixed(1)}`);
    $('fps-history').setAttribute('points', history.map((fps, index) => `${index * 180 / 29},${42 - Math.max(0, Math.min(65, fps)) / 65 * 40}`).join(' '));
  }
  if (audio) set('hud-audio', String(Math.round(audio.bufferedMs)));
  if (console_) $('hud-loss').textContent = `${console_.lost} pkt · ${console_.dropped + console_.frozen} frm · ${console_.idr} IDR`;
  $('hud-health').textContent = `${audio?.underruns ?? 0} underruns`;
}
export async function copyDiagnostics() {
  const text = JSON.stringify({ video, audio, console: console_, recentFps: history, secureContext: isSecureContext }, null, 2);
  if (!navigator.clipboard) throw new Error('Copy diagnostics requires HTTPS.');
  await navigator.clipboard.writeText(text);
  $('copy-debug').textContent = 'Copied!';
  setTimeout(() => $('copy-debug').textContent = 'Copy diagnostics', 2000);
}
