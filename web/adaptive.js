const resolutions = ['360p', '540p', '720p', '1080p'];
const bitrates = { '360p': 3000, '540p': 6000, '720p': 10000, '1080p': 20000 };

export class AdaptiveQuality {
  constructor(ceiling, time = performance.now()) {
    this.ceiling = { ...ceiling }; this.current = { ...ceiling };
    this.changedAt = time - 15000; this.restart(time);
  }
  restart(time = performance.now()) { this.startedAt = time; this.bad = 0; this.goodSince = null; }
  lower(cpu) {
    const next = { ...this.current }, level = resolutions.indexOf(next.resolution);
    const floor = Math.min(3000, bitrates[next.resolution]);
    if (!cpu && next.bitrateKbps > floor) next.bitrateKbps = Math.max(floor, Math.floor(next.bitrateKbps * 0.75 / 1000) * 1000);
    else if (level > 0) {
      next.resolution = resolutions[level - 1];
      next.bitrateKbps = Math.min(next.bitrateKbps, bitrates[next.resolution]);
    } else if (next.fps === 60) next.fps = 30;
    return next;
  }
  higher() {
    const next = { ...this.current }, level = resolutions.indexOf(next.resolution);
    if (next.fps < this.ceiling.fps) next.fps = this.ceiling.fps;
    else if (level < resolutions.indexOf(this.ceiling.resolution)) {
      next.resolution = resolutions[level + 1];
      next.bitrateKbps = Math.min(this.ceiling.bitrateKbps, bitrates[next.resolution]);
    } else next.bitrateKbps = Math.min(this.ceiling.bitrateKbps, Math.ceil(next.bitrateKbps * 1.25 / 1000) * 1000);
    return next;
  }
  change(profile, reason, time) {
    if (Object.keys(profile).every(key => profile[key] === this.current[key])) return null;
    this.current = profile; this.changedAt = time; this.restart(time);
    return { profile: { ...profile }, reason };
  }
  sample(stats, time = performance.now(), visible = true) {
    if (!visible) { this.restart(time); return null; }
    if (time - this.startedAt < 6000 || time - this.changedAt < 15000 || !stats.width) return null;
    const budget = 1000 / this.current.fps;
    const cost = stats.codecMs + stats.colorMs + stats.drawMs;
    const network = stats.transportMs > Math.max(100, (stats.rttMs || 0) * 0.85 + 40) || stats.serverQueueMs > 40;
    const cpu = cost > budget * 0.8 || (!network && stats.fps < this.current.fps * 0.8);
    if (cpu || network) {
      this.goodSince = null;
      if (++this.bad >= 3) return this.change(this.lower(cpu), cpu ? 'Browser needs a lighter profile' : 'Connection is queuing video', time);
    } else {
      this.bad = 0;
      if (cost < budget * 0.55 && stats.fps >= this.current.fps * 0.9) this.goodSince ??= time;
      else this.goodSince = null;
      if (this.goodSince != null && time - this.goodSince >= 30000 && time - this.changedAt >= 45000)
        return this.change(this.higher(), 'Playback has been stable', time);
    }
    return null;
  }
}
