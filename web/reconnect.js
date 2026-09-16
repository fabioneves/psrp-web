export class Reconnect {
  constructor(connect, timers = globalThis) {
    this.connect = connect;
    this.timers = timers;
    this.count = 0;
    this.pending = null;
    this.waitingSince = null;
  }
  schedule(minimumDelay = 0, waiting = false, now = Date.now()) {
    if (this.pending !== null) return true;
    if (waiting) {
      this.waitingSince ??= now;
      if (now - this.waitingSince < 60000) {
        this.pending = this.timers.setTimeout(() => { this.pending = null; this.connect(); }, minimumDelay);
        return true;
      }
    }
    if (this.count >= 5) return false;
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      this.connect();
    }, Math.max(minimumDelay, 500 * 2 ** this.count++));
    return true;
  }
  reset() {
    this.timers.clearTimeout(this.pending);
    this.pending = null;
    this.count = 0;
    this.waitingSince = null;
  }
}
