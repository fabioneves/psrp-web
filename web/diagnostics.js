const EVENT_LIMIT = 400, SAMPLE_LIMIT = 300;

export class StreamLog {
  constructor(clock = () => performance.now(), wall = () => Date.now()) {
    this.clock = clock; this.wall = wall;
    this.reset();
  }
  reset() {
    this.events = []; this.samples = []; this.started = this.clock(); this.startedAt = this.wall();
    this.server = null; this.audio = null; this.dropped = 0;
  }
  at() { return Math.round(this.clock() - this.started); }
  event(type, detail = {}) {
    this.events.push({ t: this.at(), type, ...detail });
    if (this.events.length > EVENT_LIMIT) this.events.shift();
  }
  serverStats(stats) {
    const previous = this.server;
    this.server = stats;
    if (!previous) return null;
    const delta = {};
    for (const key of ['lost', 'timeoutDropped', 'dropped', 'recovered', 'frozen', 'idr', 'fecFailures'])
      delta[key] = Math.max(0, (stats[key] ?? 0) - (previous[key] ?? 0));
    delta.pending = stats.pending;
    if (delta.lost || delta.timeoutDropped || delta.dropped || delta.frozen || delta.idr)
      this.event('server-loss', delta);
    return delta;
  }
  audioStats(stats) {
    const previous = this.audio;
    this.audio = stats;
    if (previous && stats.underruns > previous.underruns) this.event('audio-underrun', { count: stats.underruns - previous.underruns, bufferedMs: Math.round(stats.bufferedMs) });
  }
  videoStats(stats) {
    const dropped = Math.max(0, (stats.droppedFrames ?? 0) - this.dropped);
    this.dropped = stats.droppedFrames ?? 0;
    if (dropped) this.event('superseded', { frames: dropped });
    if (stats.decodeQueue > 8) this.event('decode-backlog', { queued: stats.decodeQueue });
    if (stats.fps < 50 && stats.totalFrames > 120) this.event('low-fps', { fps: Math.round(stats.fps * 10) / 10 });
    if (stats.arrivalMaxMs > 100) this.event('delivery-gap', { maxMs: Math.round(stats.arrivalMaxMs), p95Ms: Math.round(stats.arrivalP95Ms ?? 0) });
    if (stats.stalls > 0) this.event('stall', { count: stats.stalls, ms: stats.stallMs });
    if (stats.underruns > 0) this.event('underrun', { count: stats.underruns, target: stats.pacingTarget });
    this.samples.push({ t: this.at(), fps: round(stats.fps), decodedFps: round(stats.decodedFps), display: round(stats.displayP95Ms), displayMax: round(stats.displayMaxMs), displaySkipped: stats.displaySkipped ?? null, p95: round(stats.frameP95Ms), max: round(stats.frameMaxMs), age: round(stats.videoAgeMs),
      queue: round(stats.queueMs), decode: round(stats.nativeDecodeMs ?? stats.codecMs), rtt: round(stats.rttMs), mbps: round(stats.mbps), dropped,
      decodeQueue: stats.decodeQueue ?? null, arrivalP95: round(stats.arrivalP95Ms), arrivalMax: round(stats.arrivalMaxMs), transportP95: round(stats.transportP95Ms),
      stalls: stats.stalls ?? null, stallMs: stats.stallMs ?? null, refresh: round(stats.refreshMs), target: stats.pacingTarget ?? null, videoUnderruns: stats.underruns ?? null, rebuilt: stats.rebuilt ?? null, consoleFps: this.server?.consoleFps ?? null, pending: this.server?.pending ?? null,
      audioMs: round(this.audio?.bufferedMs), underruns: this.audio?.underruns ?? null,
      lost: this.server?.lost ?? null, serverDropped: this.server?.dropped ?? null, idr: this.server?.idr ?? null });
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
  }
  recent(count = 8) { return this.events.slice(-count); }
  export(extra = {}) {
    return { startedAt: new Date(this.startedAt).toISOString(), durationMs: this.at(), ...extra, events: this.events, samples: this.samples, server: this.server, audio: this.audio };
  }
}
const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

export function describeEvent(event) {
  const labels = {
    'server-loss': e => `console packets lost ${e.lost}, frames dropped ${e.dropped}, frozen ${e.frozen}, keyframe requests ${e.idr}`,
    'audio-underrun': e => `audio underrun ×${e.count} (${e.bufferedMs} ms queued)`,
    superseded: e => `${e.frames} superseded frame${e.frames === 1 ? '' : 's'}`,
    'decode-backlog': e => `decoder backlog ${e.queued} frames`,
    'low-fps': e => `presentation fell to ${e.fps} fps`,
    'delivery-gap': e => `video packets paused ${e.maxMs} ms (arrival p95 ${e.p95Ms} ms)`,
    stall: e => `${e.count} presentation stall${e.count === 1 ? '' : 's'}, ${e.ms} ms late`,
    underrun: e => `${e.count} refresh${e.count === 1 ? '' : 'es'} with no new frame (cushion ${e.target})`,
    'decoder-reset': e => `decoder reset after a corrupt frame (${e.resets} in 30 s) · ${e.message}`
  };
  const seconds = (event.t / 1000).toFixed(1);
  return `${seconds}s · ${labels[event.type] ? labels[event.type](event) : `${event.type}${event.message ? ` · ${event.message}` : ''}`}`;
}
