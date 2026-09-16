// Video-element output: decoded frames go to the browser's own video pipeline through a MediaStream
// instead of a 2D canvas. Besides taking the canvas path out of the picture, the element reports when
// each frame actually reached the screen (requestVideoFrameCallback), which a canvas never can.
export function supportsVideoSink(platform = globalThis) {
  return typeof platform.MediaStreamTrackGenerator === 'function' &&
    typeof platform.HTMLVideoElement?.prototype?.requestVideoFrameCallback === 'function';
}

// Turns requestVideoFrameCallback metadata into per-report display metrics: the interval between
// screen presentations (p95 and longest) and frames the pipeline skipped between callbacks.
export class DisplayTiming {
  constructor() { this.intervals = []; this.lastPresentation = null; this.lastCount = null; this.skipped = 0; this.presented = 0; }
  note({ presentationTime, presentedFrames }) {
    if (this.lastPresentation != null) {
      const interval = presentationTime - this.lastPresentation;
      if (interval < 500) { this.intervals.push(interval); if (this.intervals.length > 240) this.intervals.shift(); }
    }
    if (this.lastCount != null && presentedFrames > this.lastCount + 1) this.skipped += presentedFrames - this.lastCount - 1;
    this.lastPresentation = presentationTime; this.lastCount = presentedFrames; this.presented++;
  }
  metrics() {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const result = { displayP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      displayMaxMs: sorted.length ? sorted.at(-1) : null, displaySkipped: this.skipped, displayedFrames: this.presented };
    this.intervals = []; this.skipped = 0; this.presented = 0;
    return result;
  }
}

export function createVideoSink(video, platform = globalThis) {
  const generator = new platform.MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const timing = new DisplayTiming();
  let stopped = false;
  video.srcObject = new platform.MediaStream([generator]);
  video.play().catch(() => {});
  const watch = (now, metadata) => { if (stopped) return; timing.note(metadata); video.requestVideoFrameCallback(watch); };
  video.requestVideoFrameCallback(watch);
  return {
    // Takes ownership of the frame: the generator closes it once it has been handed to the pipeline.
    draw(frame) { writer.write(frame).catch(() => {}); },
    metrics: () => timing.metrics(),
    close() {
      stopped = true;
      writer.close().catch(() => {});
      generator.stop();
      video.srcObject = null;
    }
  };
}
