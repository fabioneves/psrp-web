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
    this.delayMs = delayMs;
    this.underruns = 0;
    this.clear();
  }
  clear() { this.offset = 0; this.length = 0; this.primed = false; }
  push(sample) {
    const count = Math.floor(sample.left.length * this.rate / sample.rate);
    if (this.length + count > this.capacity) this.clear();
    for (let i = 0; i < Math.min(count, this.capacity); i++) {
      const at = (this.offset + this.length) % this.capacity;
      const position = i * sample.rate / this.rate;
      const index = Math.floor(position), next = Math.min(index + 1, sample.left.length - 1), fraction = position - index;
      this.left[at] = sample.left[index] * (1 - fraction) + sample.left[next] * fraction;
      this.right[at] = sample.right[index] * (1 - fraction) + sample.right[next] * fraction;
      this.length++;
    }
  }
  read(left, right) {
    left.fill(0); right.fill(0);
    if (!this.primed && this.length < this.rate * this.delayMs / 1000) return;
    this.primed = true;
    const count = Math.min(left.length, this.length);
    for (let i = 0; i < count; i++) {
      left[i] = this.left[this.offset]; right[i] = this.right[this.offset];
      this.offset = (this.offset + 1) % this.capacity;
    }
    this.length -= count;
    if (count < left.length) {
      this.underruns++;
      this.primed = false;
      for (let i = Math.max(0, count - 32); i < count; i++) {
        const fade = (count - i) / Math.min(32, count);
        left[i] *= fade; right[i] *= fade;
      }
    }
  }
}
