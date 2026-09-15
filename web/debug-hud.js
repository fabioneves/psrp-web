const $ = id => document.getElementById(id);
const ms = value => Number.isFinite(value) ? `${value.toFixed(1)} ms` : '—';
let history = [], video = null, audio = null;
export function resetHud() {
  history = []; video = audio = null;
  for (const id of ['hud-fps', 'hud-codec', 'hud-size', 'hud-rtt', 'hud-age', 'hud-bitrate', 'hud-pacing', 'hud-decode', 'hud-audio']) $(id).textContent = '—';
  $('fps-history').setAttribute('points', '');
  $('hud-health').textContent = 'Waiting for stream metrics';
}
export function updateHud(message, codec) {
  if (message.type === 'audio-stats') audio = message;
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
    $('hud-rtt').textContent = ms(video.rttMs);
    $('hud-age').textContent = ms(video.videoAgeMs);
    $('hud-bitrate').textContent = `${video.mbps.toFixed(1)} Mbps`;
    $('hud-pacing').textContent = ms(video.frameP95Ms);
    $('hud-decode').textContent = `${(video.nativeDecodeMs ?? video.codecMs).toFixed(1)} / ${video.drawMs.toFixed(1)} ms`;
    $('fps-history').setAttribute('points', history.map((fps, index) => `${index * 180 / 29},${42 - Math.max(0, Math.min(65, fps)) / 65 * 40}`).join(' '));
  }
  if (audio) $('hud-audio').textContent = `${Math.round(audio.bufferedMs)} ms`;
  $('hud-health').textContent = `${video?.engine || 'Measuring'} · ${audio?.underruns ?? 0} audio underruns`;
}
export async function copyDiagnostics() {
  const text = JSON.stringify({ video, audio, recentFps: history, secureContext: isSecureContext }, null, 2);
  if (!navigator.clipboard) throw new Error('Copy diagnostics requires HTTPS.');
  await navigator.clipboard.writeText(text);
  $('copy-debug').textContent = 'Copied!';
  setTimeout(() => $('copy-debug').textContent = 'Copy diagnostics', 2000);
}
