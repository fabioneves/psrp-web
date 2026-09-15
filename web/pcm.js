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
  clear() { this.offset = 0; this.length = 0; this.primed = false; this.target = null; this.sinceSync = 0; this.skewMs = null; this.lastLeft = 0; this.lastRight = 0; }
  sync(timestamp) {
    if (!Number.isFinite(timestamp)) return;
    this.target = timestamp - AUDIO_RESERVE_MS;
    this.sinceSync = 0;
  }
  push(sample) {
    const count = Math.floor(sample.left.length * this.rate / sample.rate);
    if (this.length + count > this.capacity) this.clear();
    for (let i = 0; i < Math.min(count, this.capacity); i++) {
      const at = (this.offset + this.length) % this.capacity;
      const position = i * sample.rate / this.rate;
      const index = Math.floor(position), next = Math.min(index + 1, sample.left.length - 1), fraction = position - index;
      this.left[at] = sample.left[index] * (1 - fraction) + sample.left[next] * fraction;
      this.right[at] = sample.right[index] * (1 - fraction) + sample.right[next] * fraction;
      this.timestamps[at] = Number.isFinite(sample.timestamp) ? sample.timestamp + i * 1000 / this.rate : NaN;
      this.length++;
    }
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
      while (this.length > left.length && this.timestamps[this.offset] < target - 20) {
        this.offset = (this.offset + 1) % this.capacity; this.length--; this.trimmed++;
      }
      this.skewMs = this.timestamps[this.offset] - target;
      if (this.skewMs > 20) {
        for (let i = 0; i < Math.min(32, left.length); i++) {
          left[i] = this.lastLeft * (1 - (i + 1) / 32);
          right[i] = this.lastRight * (1 - (i + 1) / 32);
        }
        this.lastLeft = 0; this.lastRight = 0;
        return;
      }
    }
    const count = Math.min(left.length, this.length);
    for (let i = 0; i < count; i++) {
      left[i] = this.left[this.offset]; right[i] = this.right[this.offset];
      this.offset = (this.offset + 1) % this.capacity;
    }
    this.length -= count;
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
