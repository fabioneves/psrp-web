export const now = () => performance.timeOrigin + performance.now();

export function unpackMedia(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 33 || view.getUint32(0) !== 0x52504d31) throw new Error('Invalid media envelope');
  const kind = view.getUint32(4, true), ready = view.getFloat64(8, true);
  const sent = view.getFloat64(16, true), timestamp = view.getFloat64(24, true);
  if (![1, 2, 3].includes(kind) || ![ready, sent, timestamp].every(Number.isFinite)) throw new Error('Invalid media timestamps');
  return { kind, ready, sent, timestamp, bytes: bytes.slice(32) };
}

export class StreamClock {
  constructor() { this.samples = []; this.offset = null; this.rttMs = null; }
  sample({ clientTime, received, sent }, arrival = now()) {
    const rtt = arrival - clientTime - (sent - received);
    if (![clientTime, received, sent, arrival, rtt].every(Number.isFinite) || rtt < 0 || rtt > 10000 || sent < received) return;
    this.samples.push({ rtt, offset: ((received - clientTime) + (sent - arrival)) / 2 });
    if (this.samples.length > 20) this.samples.shift();
    const best = this.samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
    this.offset = best.offset; this.rttMs = rtt;
  }
  age(timestamp, arrival = now()) { return this.offset == null ? null : Math.max(0, arrival + this.offset - timestamp); }
}
