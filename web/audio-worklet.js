import { PcmQueue, unpackPcm, AUDIO_RESERVE_MS } from './pcm.js';

class RemoteAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = new PcmQueue(sampleRate);
    this.samples = 0; this.energy = 0; this.frames = 0;
    this.inputPort = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'port') {
        this.inputPort?.close();
        this.inputPort = data.port;
        this.inputPort.onmessage = ({ data: packet }) => this.receive(packet);
      } else this.receive(data);
    };
  }
  receive(data) {
    if (data instanceof ArrayBuffer) this.queue.push(unpackPcm(data));
    else if (data.type === 'audio') this.queue.push({ ...unpackPcm(data.bytes), timestamp: data.timestamp });
    else if (data.type === 'sync') this.queue.sync(data.timestamp);
    else if (data.type === 'output-delay') this.queue.outputDelayMs = data.value;
    else if (data.type === 'reset') this.queue.clear();
    else if (data.type === 'delay') { this.queue.delayMs = data.value; this.queue.clear(); }
  }
  process(inputs, outputs) {
    const [left, right] = outputs[0];
    this.queue.read(left, right);
    for (const value of left) this.energy += value * value;
    this.samples += left.length; this.frames += left.length;
    if (this.frames >= sampleRate) {
      this.port.postMessage({ type: 'audio-stats', samples: this.samples, rms: Math.sqrt(this.energy / this.frames),
        bufferedMs: this.queue.length / sampleRate * 1000, skewMs: this.queue.skewMs, lagMs: this.queue.skewMs == null ? null : AUDIO_RESERVE_MS - this.queue.skewMs + this.queue.outputDelayMs, trimmedSamples: this.queue.trimmed, underruns: this.queue.underruns, engine: 'AudioWorklet' });
      this.frames = 0; this.energy = 0;
    }
    return true;
  }
}
registerProcessor('remote-audio', RemoteAudio);
