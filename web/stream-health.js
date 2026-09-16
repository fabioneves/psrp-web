// Rates each second of playback so the player bar can show a green, amber or red dot without the HUD.
// Degraded levels are held for three seconds so a one-second blip stays visible.
export class StreamHealth {
  constructor() { this.reset(); }
  reset() { this.level = 'good'; this.reason = ''; this.holdUntil = 0; this.lastLost = null; this.lastAudio = null; }
  sample({ stalls = 0, underruns = 0, arrivalMaxMs = 0, transportMs = 0, consoleLost = null, audioUnderruns = null } = {}, now = performance.now()) {
    const lost = consoleLost != null && this.lastLost != null ? Math.max(0, consoleLost - this.lastLost) : 0;
    if (consoleLost != null) this.lastLost = consoleLost;
    const audio = audioUnderruns != null && this.lastAudio != null ? Math.max(0, audioUnderruns - this.lastAudio) : 0;
    if (audioUnderruns != null) this.lastAudio = audioUnderruns;
    let level = 'good', reason = '';
    if (stalls >= 2 || underruns >= 6 || lost >= 10 || transportMs > 100) {
      level = 'poor';
      reason = transportMs > 100 ? 'video is queuing on the network' : lost >= 10 ? 'the console is losing packets' : 'frames are arriving too late to keep up';
    } else if (stalls >= 1 || underruns >= 2 || lost > 0 || audio > 0 || arrivalMaxMs > 50 || transportMs > 50) {
      level = 'fair';
      reason = audio > 0 ? 'audio ran short' : lost > 0 ? 'a few console packets were lost' : 'a frame arrived late';
    }
    const rank = { good: 0, fair: 1, poor: 2 };
    if (rank[level] >= rank[this.level] || now >= this.holdUntil) {
      this.level = level; this.reason = reason;
      if (level !== 'good') this.holdUntil = now + 3000;
    }
    return { level: this.level, reason: this.reason };
  }
}
