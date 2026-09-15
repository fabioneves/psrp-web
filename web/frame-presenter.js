export class FramePresenter {
  constructor(present, timers = globalThis) {
    this.present = present;
    this.timers = timers;
    this.animation = typeof timers.requestAnimationFrame === 'function';
    this.pending = false;
    this.stopped = false;
    this.intervals = [];
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
        this.intervals.push(now - this.lastDraw);
        if (this.intervals.length > 120) this.intervals.shift();
      }
      if (result !== 'waiting') this.lastDraw = now;
      if (result === true || result === 'waiting') this.request();
    };
    if (this.animation) {
      this.frame = this.timers.requestAnimationFrame(() => { if (!this.pending || this.stopped || this.generation !== generation) return; this.recovering = false; draw(); });
      this.timeout = this.timers.setTimeout(() => {
        this.recovering = true;
        draw();
      }, this.recovering ? 1000 / 60 : 100);
    } else this.timeout = this.timers.setTimeout(draw, 1000 / 60);
  }
  metrics() {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return { frameP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      frameMaxMs: sorted.length ? sorted.at(-1) : null };
  }
  cancel() {
    this.pending = false;
    if (this.frame != null) this.timers.cancelAnimationFrame(this.frame);
    this.timers.clearTimeout(this.timeout);
    this.frame = this.timeout = null;
  }
  destroy() { this.stopped = true; this.cancel(); }
}
