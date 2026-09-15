export const AUDIO_RESERVE_MS = 40;

export function unpackPcm(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 12 || view.getUint32(0) !== 0x50434d31) throw new Error('Invalid audio packet');
  const rate = view.getUint32(4, true), channels = view.getUint32(8, true);
  if (![8000, 12000, 16000, 24000, 48000].includes(rate) || ![1, 2].includes(channels) ||
    (bytes.byteLength - 12) % (2 * channels) || bytes.byteLength > 24000) throw new Error('Invalid audio format');
  const count = (bytes.byteLength - 12) / (2 * channels);
  const left = new Float32Array(count), right = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    left[i] = view.getInt16(12 + i * channels * 2, true) / 32768;
    right[i] = view.getInt16(12 + (i * channels + channels - 1) * 2, true) / 32768;
  }
  return { rate, left, right };
}

export class PcmQueue {
  constructor(rate, delayMs = 120) {
    this.rate = rate;
    this.capacity = Math.ceil(rate / 2);
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.timestamps = new Float64Array(this.capacity);
    this.trimmed = 0; this.outputDelayMs = 0;
    this.delayMs = delayMs;
    this.underruns = 0;
    this.clear();
  }
  clear() {
    this.offset = 0; this.length = 0; this.primed = false;
    this.target = null; this.sinceSync = 0; this.skewMs = null;
    this.lastLeft = 0; this.lastRight = 0;
    this.phase = 0; this.speed = 1; this.nextTimestamp = null; this.aligned = false;
  }
  sync(timestamp) {
    if (!Number.isFinite(timestamp)) return;
    const desired = timestamp - AUDIO_RESERVE_MS;
    if (this.target == null || Math.abs(desired - this.target) > 250) this.target = desired;
    else this.target += Math.max(-1, Math.min(1, (desired - this.target) * 0.05));
    this.sinceSync = 0;
  }
  push(sample) {
    const count = Math.floor(sample.left.length * this.rate / sample.rate);
    if (this.length + count > this.capacity) this.clear();
    if (Number.isFinite(sample.timestamp) && (this.nextTimestamp == null || Math.abs(sample.timestamp - this.nextTimestamp) > 250))
      this.nextTimestamp = sample.timestamp;
    for (let i = 0; i < Math.min(count, this.capacity); i++) {
      const at = (this.offset + this.length) % this.capacity;
      const position = i * sample.rate / this.rate;
      const index = Math.floor(position), next = Math.min(index + 1, sample.left.length - 1), fraction = position - index;
      this.left[at] = sample.left[index] * (1 - fraction) + sample.left[next] * fraction;
      this.right[at] = sample.right[index] * (1 - fraction) + sample.right[next] * fraction;
      this.timestamps[at] = this.nextTimestamp == null ? NaN : this.nextTimestamp + i * 1000 / this.rate;
      this.length++;
    }
    if (this.nextTimestamp != null) this.nextTimestamp += count * 1000 / this.rate;
  }
  read(left, right) {
    left.fill(0); right.fill(0);
    const target = this.target;
    if (this.target != null) {
      this.target += left.length * 1000 / this.rate;
      this.sinceSync += left.length * 1000 / this.rate;
      if (this.sinceSync > 500) this.target = null;
    }
    if (!this.primed && this.length < this.rate * this.delayMs / 1000) return;
    this.primed = true;
    this.skewMs = null;
    const trimmedBefore = this.trimmed;
    if (target != null && Number.isFinite(this.timestamps[this.offset]) && this.length) {
      const difference = this.timestamps[this.offset] - target;
      while ((!this.aligned || difference < -150) && this.length > left.length && this.timestamps[this.offset] < target - 20) {
        this.offset = (this.offset + 1) % this.capacity; this.length--; this.trimmed++;
      }
      this.skewMs = this.timestamps[this.offset] - target;
      if (this.skewMs > (this.aligned ? 150 : 20)) {
        for (let i = 0; i < Math.min(32, left.length); i++) {
          left[i] = this.lastLeft * (1 - (i + 1) / 32);
          right[i] = this.lastRight * (1 - (i + 1) / 32);
        }
        this.lastLeft = 0; this.lastRight = 0;
        return;
      }
    }
    this.aligned = true;
    const correction = this.skewMs == null ? 0 : Math.max(-0.01, Math.min(0.01, -this.skewMs / 2500));
    this.speed += (1 + correction - this.speed) * 0.02;
    let count = 0;
    while (count < left.length && this.length > 1) {
      const next = (this.offset + 1) % this.capacity;
      left[count] = this.left[this.offset] + (this.left[next] - this.left[this.offset]) * this.phase;
      right[count] = this.right[this.offset] + (this.right[next] - this.right[this.offset]) * this.phase;
      this.phase += this.speed;
      const consumed = Math.min(Math.floor(this.phase), this.length);
      this.phase -= consumed;
      this.offset = (this.offset + consumed) % this.capacity;
      this.length -= consumed;
      count++;
    }
    if (this.trimmed > trimmedBefore) {
      const fade = Math.min(32, count);
      for (let i = 0; i < fade; i++) {
        const blend = (i + 1) / fade;
        left[i] = this.lastLeft * (1 - blend) + left[i] * blend;
        right[i] = this.lastRight * (1 - blend) + right[i] * blend;
      }
    }
    if (count < left.length) {
      this.underruns++;
      this.primed = false;
      for (let i = Math.max(0, count - 32); i < count; i++) {
        const fade = (count - i) / Math.min(32, count);
        left[i] *= fade; right[i] *= fade;
      }
    }
    this.lastLeft = left[left.length - 1]; this.lastRight = right[right.length - 1];
  }
}
