export class FramePresenter {
  constructor(present, timers = globalThis, expectedInterval = 1000 / 60) {
    this.present = present;
    this.timers = timers;
    this.expected = expectedInterval;
    this.stalls = 0; this.stallMs = 0;
    this.animation = typeof timers.requestAnimationFrame === 'function';
    this.pending = false;
    this.stopped = false;
    this.intervals = [];
    this.ticks = [];
    this.lastTick = null;
    this.lastDraw = null;
    this.recovering = false;
    this.generation = 0;
  }
  request() {
    if (this.pending || this.stopped) return;
    this.pending = true;
    const generation = ++this.generation;
    const draw = () => {
      if (!this.pending || this.stopped || this.generation !== generation) return;
      this.cancel();
      const now = this.timers.performance?.now() ?? performance.now();
      const result = this.present();
      if (result !== 'waiting' && this.lastDraw != null) {
        const interval = now - this.lastDraw;
        this.intervals.push(interval);
        if (this.intervals.length > 120) this.intervals.shift();
        if (interval > this.expected * 2.5) { this.stalls++; this.stallMs += interval - this.expected; }
      }
      if (result !== 'waiting') this.lastDraw = now;
      if (result === true || result === 'waiting') this.request();
    };
    if (this.animation) {
      this.frame = this.timers.requestAnimationFrame(() => {
        if (!this.pending || this.stopped || this.generation !== generation) return;
        this.recovering = false;
        const at = this.timers.performance?.now() ?? performance.now();
        if (this.lastTick != null && at - this.lastTick < 100) { this.ticks.push(at - this.lastTick); if (this.ticks.length > 120) this.ticks.shift(); }
        this.lastTick = at;
        draw();
      });
      this.timeout = this.timers.setTimeout(() => {
        this.recovering = true;
        draw();
      }, this.recovering ? 1000 / 60 : 100);
    } else this.timeout = this.timers.setTimeout(draw, 1000 / 60);
  }
  metrics() {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const ticks = [...this.ticks].sort((a, b) => a - b);
    const result = { frameP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      frameMaxMs: sorted.length ? sorted.at(-1) : null, stalls: this.stalls, stallMs: Math.round(this.stallMs),
      refreshMs: ticks.length ? ticks[Math.floor(ticks.length / 2)] : null };
    this.stalls = 0; this.stallMs = 0;
    return result;
  }
  cancel() {
    this.pending = false;
    if (this.frame != null) this.timers.cancelAnimationFrame(this.frame);
    this.timers.clearTimeout(this.timeout);
    this.frame = this.timeout = null;
  }
  destroy() { this.stopped = true; this.cancel(); }
}
