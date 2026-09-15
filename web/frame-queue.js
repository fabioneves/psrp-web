export class FrameQueue {
  constructor(release, fps = 60, smooth = true) {
    this.release = release;
    this.interval = 1000 / fps;
    this.capacity = smooth ? 3 : 1;
    this.reserve = smooth ? this.interval * 1.5 : 0;
    this.frames = [];
    this.started = false;
    this.last = null;
    this.dropped = 0;
  }
  push(frame) {
    while (this.frames.length >= this.capacity) {
      this.release(this.frames.shift());
      this.dropped++;
    }
    this.frames.push(frame);
  }
  take(now) {
    if (!this.frames.length) return null;
    if (!this.started && now - this.frames[0].savedAt < this.reserve) return null;
    if (this.capacity > 1 && this.last != null && now - this.last < this.interval - 2) return null;
    this.started = true;
    this.last = now;
    return this.frames.shift();
  }
  get pending() { return this.frames.length > 0; }
  destroy() { for (const frame of this.frames) this.release(frame); this.frames.length = 0; }
}
