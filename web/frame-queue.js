// Presentation queue between the decoder and the display refresh loop.
//
// Smooth mode keeps a cushion of `target` frames queued behind the one being drawn, so a frame
// that arrives late by up to a refresh interval (or more, as the target grows) is still followed
// by a new picture on every refresh. When the cushion runs low the queue waits one refresh so the
// cadence re-aligns to arrivals, grows the target after real underruns, and bounds latency so it
// never exceeds target + 2 frames. Sources that deliver fewer frames than the refresh rate are left
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
    this.arrivals = []; this.lowTicks = 0; this.waitAt = []; this.timeline = [];
    this.underrunAt = -Infinity; this.calmSince = null;
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
      this.started = true; this.calmSince = now;
    }
    if (this.last != null && now - this.last < this.interval - 2) return null;
    if (this.calmSince != null && now - this.calmSince > 60000 && this.target > 1) { this.target--; this.calmSince = now; }
    this.trim(now);
    // Cellular links deliver frames in pairs ~33 ms apart, which lifts the queue by one; the latency bound
    // sits one frame above that so a pair costs no skip. Bound: target + 3 frames.
    if (this.frames.length > this.target + 3) { this.release(this.frames.shift()); this.dropped++; }
    // A momentary dip below the cushion is jitter, and drawing the cushion frame is what it is for. A
    // cushion that stays low at three consecutive refreshes is cadence drift: wait one more refresh so
    // presentation re-aligns to arrivals (8 ms at 120 Hz, one frame at 60 Hz) instead of draining and
    // repeating a picture later.
    this.lowTicks = this.frames.length <= this.target ? this.lowTicks + 1 : 0;
    if (this.lowTicks >= 3 && this.last != null && now - this.last < this.interval * 1.5 && this.keepingUp(now)) { this.lowTicks = 0; this.rebuilt++; this.waited(now); return null; }
    this.last = now;
    const frame = this.frames.shift();
    // Timeline of arrival and presentation moments (last ten seconds at 60 fps) for offline analysis of a capture.
    this.timeline.push([Math.round(frame.savedAt * 10) / 10, Math.round(now * 10) / 10, this.frames.length]);
    if (this.timeline.length > 600) this.timeline.shift();
    return frame;
  }
  // Drift waits recurring several times in ten seconds mean the cushion keeps running down on this link;
  // one more frame of cushion (16.7 ms) hides them. Observed at 0.3-1 waits a second on 5G.
  waited(now) {
    this.calmSince = now;
    this.waitAt.push(now);
    while (this.waitAt.length && now - this.waitAt[0] > 10000) this.waitAt.shift();
    if (this.waitAt.length >= 5 && this.keepingUp(now) && this.target < this.maxTarget && now - this.underrunAt > 5000) { this.target++; this.underrunAt = now; this.waitAt = []; }
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
  keepingUp(now) {
    while (this.arrivals.length && now - this.arrivals[0] > 1000) this.arrivals.shift();
    return this.arrivals.length >= this.fps * 0.97;
  }
  trim(now) {
    const stale = (this.target + 3.5) * this.interval;
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
