export function parseCandidate(line) {
  const match = /^candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/.exec(line || '');
  return match ? { protocol: match[1].toLowerCase(), address: match[2], port: Number(match[3]), type: match[4] } : null;
}

// A server-reflexive candidate only exists when a STUN server answered over UDP, which is the proof WebRTC needs.
export function summarizeStun(candidates) {
  const publicEndpoints = [...new Set(candidates.filter(candidate => candidate.protocol === 'udp' && candidate.type === 'srflx')
    .map(candidate => `${candidate.address}:${candidate.port}`))];
  const udp = publicEndpoints.length > 0;
  const verdict = !udp ? 'No STUN answer over UDP: outbound UDP looks blocked, so WebRTC would fall back to WebSocket.'
    : publicEndpoints.length > 1 ? 'Outbound UDP works. The public address changes per destination (or there are several network interfaces); a server with a forwarded port still connects.'
      : 'Outbound UDP works.';
  return { udp, publicEndpoints, verdict };
}

export function summarizeLoopback({ sent, received, bytes, seconds }) {
  const mbps = count => Math.round(count * bytes * 8 / seconds / 1e4) / 100;
  return { sentMbps: mbps(sent), receivedMbps: mbps(received), lossPercent: sent ? Math.round((sent - received) / sent * 1000) / 10 : 0 };
}
