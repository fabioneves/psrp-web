// Presentation queue between the decoder and the display refresh loop.
//
// Smooth mode keeps a cushion of `target` frames queued behind the one being drawn, so a frame
// that arrives late by up to a refresh interval (or more, as the target grows) is still followed
// by a new picture on every refresh. The cushion is rebuilt when it erodes (one deliberate held
// refresh, at most every two seconds), grown after real underruns, and bounded so latency never
// exceeds target + 2 frames. Sources that deliver fewer frames than the refresh rate are left
// alone: repeats are then inherent and adding cushion would only add latency.
//
// Responsive mode keeps nothing queued and presents the newest frame immediately.
export class FrameQueue {
  constructor(release, fps = 60, smooth = true) {
    this.release = release;
    this.fps = fps;
    this.interval = 1000 / fps;
    this.smooth = smooth;
    this.capacity = smooth ? 6 : 1;
    this.target = smooth ? 1 : 0;
    this.maxTarget = 3;
    this.frames = [];
    this.started = false;
    this.last = null;
    this.dropped = 0; this.underruns = 0; this.rebuilt = 0;
    this.arrivals = []; this.depths = [];
    this.underrunAt = -Infinity; this.rebuiltAt = -Infinity; this.calmSince = null;
  }
  push(frame) {
    while (this.frames.length >= this.capacity) {
      this.release(this.frames.shift());
      this.dropped++;
    }
    this.frames.push(frame);
    if (this.smooth) this.arrivals.push(frame.savedAt);
  }
  take(now) {
    if (!this.smooth) return this.frames.shift() ?? null;
    if (!this.frames.length) {
      if (this.started && this.last != null && now - this.last >= this.interval - 2) this.underrun(now);
      return null;
    }
    if (!this.started) {
      if (this.frames.length <= this.target && now - this.frames[0].savedAt < (this.target + 1) * this.interval) return null;
      this.started = true;
    }
    if (this.last != null && now - this.last < this.interval - 2) return null;
    this.trim(now);
    const depth = this.frames.length;
    this.depths.push({ at: now, depth });
    while (this.depths.length && now - this.depths[0].at > 1500) this.depths.shift();
    if (depth > this.target + 2) { this.release(this.frames.shift()); this.dropped++; }
    if (this.needsRebuild(now)) { this.rebuiltAt = now; this.rebuilt++; return null; }
    this.last = now;
    return this.frames.shift();
  }
  // A refresh passed with nothing to draw: the cushion was empty. Raise the target when the
  // source is keeping up, because the gap then came from delivery jitter that a deeper cushion hides.
  underrun(now) {
    this.underruns++;
    this.calmSince = now;
    if (this.keepingUp(now) && this.target < this.maxTarget && now - this.underrunAt > 5000) {
      this.target++;
      this.underrunAt = now;
    }
  }
  needsRebuild(now) {
    if (now - this.rebuiltAt < 2000 || !this.keepingUp(now)) return false;
    if (this.calmSince == null) this.calmSince = now;
    if (now - this.calmSince > 60000 && this.target > 1) { this.target--; this.calmSince = now; }
    // Momentary dips are what the cushion is for; rebuild only when a whole second never reached it.
    const recent = this.depths.filter(sample => now - sample.at <= 1000);
    if (recent.length < this.fps * 0.8) return false;
    return Math.max(...recent.map(sample => sample.depth)) < this.target + 1;
  }
  keepingUp(now) {
    while (this.arrivals.length && now - this.arrivals[0] > 1000) this.arrivals.shift();
    return this.arrivals.length >= this.fps * 0.97;
  }
  trim(now) {
    const stale = (this.target + 2.5) * this.interval;
    while (this.frames.length > 1 && now - this.frames[0].savedAt > stale) { this.release(this.frames.shift()); this.dropped++; }
  }
  get pending() { return this.frames.length > 0; }
  metrics() {
    const result = { pacingTarget: this.target, underruns: this.underruns, rebuilt: this.rebuilt };
    this.underruns = 0; this.rebuilt = 0;
    return result;
  }
  destroy() { for (const frame of this.frames) this.release(frame); this.frames.length = 0; }
}
