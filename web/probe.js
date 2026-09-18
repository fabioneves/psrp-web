import { parseCandidate, summarizeStun, summarizeLoopback } from './probe-results.js';

const $ = id => document.getElementById(id);
const stunServers = (new URLSearchParams(location.search).get('stun') || 'stun.l.google.com:19302,stun.cloudflare.com:3478').split(',').filter(Boolean);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function show(id, text, tone) { $(id).textContent = text; if (tone) $(id).dataset.tone = tone; else delete $(id).dataset.tone; }

async function gatherStun() {
  const peer = new RTCPeerConnection({ iceServers: [{ urls: stunServers.map(server => `stun:${server}`) }] });
  try {
    const candidates = [];
    const done = new Promise(resolve => {
      peer.onicecandidate = event => { if (!event.candidate) return resolve(); const parsed = parseCandidate(event.candidate.candidate); if (parsed) candidates.push(parsed); };
    });
    peer.createDataChannel('probe');
    await peer.setLocalDescription(await peer.createOffer());
    await Promise.race([done, wait(8000)]);
    return { servers: stunServers, ...summarizeStun(candidates), candidateTypes: candidates.map(candidate => `${candidate.protocol}/${candidate.type}`) };
  } finally { peer.close(); }
}

// Two peers in this page exchange video-sized unreliable messages at the top stream bitrate:
// what arrives is the most this browser's data channel stack can take, before any network.
async function loopback({ mbps = 30, bytes = 1100, seconds = 3 } = {}) {
  const sender = new RTCPeerConnection(), receiver = new RTCPeerConnection();
  try {
    sender.onicecandidate = event => event.candidate && receiver.addIceCandidate(event.candidate);
    receiver.onicecandidate = event => event.candidate && sender.addIceCandidate(event.candidate);
    let received = 0;
    receiver.ondatachannel = event => { event.channel.onmessage = () => received++; };
    const channel = sender.createDataChannel('load', { ordered: false, maxRetransmits: 0 });
    const open = new Promise((resolve, reject) => { channel.onopen = resolve; channel.onerror = () => reject(new Error('The data channel failed to open.')); });
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    await Promise.race([open, wait(8000).then(() => { throw new Error('Two peers in this page could not connect within 8 seconds.'); })]);
    const payload = new Uint8Array(bytes), perSecond = mbps * 1e6 / 8 / bytes, started = performance.now();
    let sent = 0;
    while (performance.now() - started < seconds * 1000) {
      const due = Math.floor((performance.now() - started) / 1000 * perSecond);
      while (sent < due && channel.bufferedAmount < 1 << 20) { channel.send(payload); sent++; }
      await wait(4);
    }
    await wait(500);
    return { targetMbps: mbps, messageBytes: bytes, ...summarizeLoopback({ sent, received, bytes, seconds }) };
  } finally { sender.close(); receiver.close(); }
}

async function save(result) {
  const headers = { 'Content-Type': 'application/json', 'X-Remote-Play-Session': '1' };
  const session = await (await fetch('/api/auth/session', { headers })).json();
  if (!session.token) return show('save-result', 'Not saved. Sign in to Player One in this browser first, then come back and send the result again.');
  const response = await fetch('/api/diagnostics', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${session.token}` }, body: JSON.stringify(result) });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  show('save-result', `Saved to the server as ${(await response.json()).name}. It is listed under Saved diagnostics in the lobby.`, 'ok');
}

// Saving is a button, not automatic: the server keeps a user's newest 20 captures, and a page that saved on
// every load could push real stream captures out.
let latest;
async function run() {
  $('run-again').disabled = $('send').disabled = true;
  for (const id of ['stun-result', 'loopback-result']) show(id, 'Waiting…');
  show('save-result', 'Send the result to the server when the checks finish.');
  const result = { kind: 'webrtc-probe', at: new Date().toISOString(), userAgent: navigator.userAgent, page: location.origin };
  try {
    result.api = { dataChannel: typeof RTCPeerConnection === 'function' && 'createDataChannel' in RTCPeerConnection.prototype };
    show('api-result', result.api.dataChannel ? 'WebRTC data channels are supported.' : 'This browser has no WebRTC data channels; only WebSocket can work here.', result.api.dataChannel ? 'ok' : 'bad');
    if (result.api.dataChannel) {
      show('stun-result', `Asking ${stunServers.join(' and ')}…`);
      try {
        result.stun = await gatherStun();
        show('stun-result', `${result.stun.verdict}${result.stun.udp ? ` Seen from outside as ${result.stun.publicEndpoints.join(', ')}.` : ''} Asked ${stunServers.join(' and ')}.`, result.stun.udp ? 'ok' : 'bad');
      } catch (error) { result.stun = { error: error.message }; show('stun-result', `The UDP check failed: ${error.message}`, 'bad'); }
      show('loopback-result', 'Sending 30 Mbps between two peers in this page…');
      try {
        result.loopback = await loopback();
        const enough = result.loopback.receivedMbps >= result.loopback.targetMbps * 0.95;
        show('loopback-result', `Received ${result.loopback.receivedMbps} of ${result.loopback.sentMbps} Mbps sent (${result.loopback.lossPercent}% lost). ${enough ? 'Enough for 1080p.' : 'Below the 30 Mbps a 1080p stream can reach; 720p at 10 Mbps needs a third of that.'}`, enough ? 'ok' : 'bad');
      } catch (error) { result.loopback = { error: error.message }; show('loopback-result', error.message, 'bad'); }
    }
  } finally { latest = result; $('run-again').disabled = $('send').disabled = false; }
}
$('run-again').onclick = run;
$('send').onclick = async () => {
  $('send').disabled = true;
  try { await save(latest); } catch (error) { show('save-result', `Could not save the result: ${error.message}`, 'bad'); }
  finally { $('send').disabled = false; }
};
run();
