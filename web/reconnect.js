export class Reconnect {
  constructor(connect, timers = globalThis) {
    this.connect = connect;
    this.timers = timers;
    this.count = 0;
    this.pending = null;
  }
  schedule() {
    if (this.pending !== null) return true;
    if (this.count >= 5) return false;
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      this.connect();
    }, 500 * 2 ** this.count++);
    return true;
  }
  reset() {
    this.timers.clearTimeout(this.pending);
    this.pending = null;
    this.count = 0;
  }
}
