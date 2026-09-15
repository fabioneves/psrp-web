export class FramePresenter {
  constructor(present, timers = globalThis) {
    this.present = present;
    this.timers = timers;
    this.animation = typeof timers.requestAnimationFrame === 'function';
    this.pending = false;
    this.stopped = false;
  }
  request() {
    if (this.pending || this.stopped) return;
    this.pending = true;
    const draw = () => {
      if (!this.pending || this.stopped) return;
      this.cancel();
      this.present();
    };
    if (this.animation) {
      this.frame = this.timers.requestAnimationFrame(draw);
      this.timeout = this.timers.setTimeout(() => {
        this.animation = false;
        draw();
      }, 100);
    } else this.timeout = this.timers.setTimeout(draw, 1000 / 60);
  }
  cancel() {
    this.pending = false;
    if (this.frame != null) this.timers.cancelAnimationFrame(this.frame);
    this.timers.clearTimeout(this.timeout);
    this.frame = this.timeout = null;
  }
  destroy() { this.stopped = true; this.cancel(); }
}
