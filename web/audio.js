import { unpackPcm, AUDIO_RESERVE_MS } from './pcm.js';

export class AudioOutput {
  constructor(report) {
    this.report = report;
    this.sources = new Set();
    this.next = 0; this.samples = 0; this.delay = 120; this.closed = false;
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('Web Audio is unavailable in this browser.');
    this.context = new Context({ sampleRate: 48000, latencyHint: 'interactive' });
    this.gain = this.context.createGain();
    this.peaks = this.context.createDynamicsCompressor();
    this.peaks.threshold.value = -3; this.peaks.knee.value = 0; this.peaks.ratio.value = 20;
    this.peaks.attack.value = 0.003; this.peaks.release.value = 0.15;
    this.gain.connect(this.peaks); this.peaks.connect(this.context.destination);
    this.context.onstatechange = () => report({ type: 'audio-state', state: this.context.state });
    this.resume();
    this.ready = this.initialize();
  }
  async initialize() {
    if (!this.context.audioWorklet) return;
    let timeout;
    try {
      await Promise.race([
        this.context.audioWorklet.addModule('/audio-worklet.js'),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Audio initialization timed out')), 5000); })
      ]);
      if (this.closed) return;
      this.node = new AudioWorkletNode(this.context, 'remote-audio', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.port.onmessage = ({ data }) => this.report(data);
      this.node.onprocessorerror = () => { this.node.disconnect(); this.node = null; this.report({ type: 'audio-fallback' }); };
      this.node.connect(this.gain);
      this.node.port.postMessage({ type: 'delay', value: this.delay });
      this.node.port.postMessage({ type: 'output-delay', value: this.outputDelayMs });
    } catch { this.report({ type: 'audio-state', state: 'fallback' }); }
    finally { clearTimeout(timeout); }
  }
  workerPort() {
    if (!this.node) return null;
    const channel = new MessageChannel();
    this.node.port.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
    return channel.port2;
  }
  resume() { this.context.resume().catch(() => {}); }
  volume(value) { this.gain.gain.value = value; }
  setDelay(value) { this.delay = value; this.node?.port.postMessage({ type: 'delay', value }); this.reset(); }
  get outputDelayMs() { return ((this.context.outputLatency || 0) + (this.context.baseLatency || 0)) * 1000; }
  sync(timestamp) {
    if (!Number.isFinite(timestamp)) return;
    this.video = { timestamp, at: this.context.currentTime };
    this.node?.port.postMessage({ type: 'sync', timestamp });
  }
  write(bytes, timestamp) {
    if (this.closed || this.context.state !== 'running') return;
    if (this.node) { this.node.port.postMessage({ type: 'audio', bytes, timestamp }, [bytes]); return; }
    const sample = unpackPcm(bytes);
    const time = this.context.currentTime;
    const synced = this.video && time - this.video.at < 0.5 && Number.isFinite(timestamp);
    const desired = synced ? this.video.at + (timestamp - this.video.timestamp + AUDIO_RESERVE_MS) / 1000 : null;
    const duration = sample.left.length / sample.rate;
    if (desired != null && desired + duration < time - 0.08) return;
    if (this.next - time > 0.5 || (desired != null && Math.abs(this.next - desired) > 0.08)) {
      for (const source of this.sources) source.stop();
      this.sources.clear(); this.next = Math.max(time, desired ?? time + this.delay / 1000);
    }
    const buffer = this.context.createBuffer(2, sample.left.length, sample.rate);
    buffer.copyToChannel(sample.left, 0); buffer.copyToChannel(sample.right, 1);
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.gain);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    this.sources.add(source);
    if (this.next < this.context.currentTime) this.next = this.context.currentTime + this.delay / 1000;
    source.start(this.next); this.next += buffer.duration;
    this.samples += sample.left.length;
    if (this.samples % 48000 < sample.left.length) this.report({ type: 'audio-stats', samples: this.samples,
      rms: Math.sqrt(sample.left.reduce((sum, value) => sum + value * value, 0) / sample.left.length),
      bufferedMs: (this.next - this.context.currentTime) * 1000, underruns: 0, engine: 'Web Audio fallback' });
  }
  reset() {
    this.node?.port.postMessage({ type: 'reset' });
    for (const source of this.sources) source.stop();
    this.sources.clear(); this.next = 0; this.video = null;
  }
  close() {
    this.closed = true; this.reset(); this.node?.disconnect(); this.node?.port.close();
    this.gain.disconnect(); this.peaks.disconnect(); this.context.close().catch(() => {});
  }
}
