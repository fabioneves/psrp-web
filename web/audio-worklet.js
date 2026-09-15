import { PcmQueue, unpackPcm } from './pcm.js';

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
        bufferedMs: this.queue.length / sampleRate * 1000, underruns: this.queue.underruns, engine: 'AudioWorklet' });
      this.frames = 0; this.energy = 0;
    }
    return true;
  }
}
registerProcessor('remote-audio', RemoteAudio);
