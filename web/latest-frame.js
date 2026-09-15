export class LatestFrame {
  constructor() { this.pending = false; this.dropped = 0; }
  resize(width, height) {
    this.width = width; this.height = height;
    this.stride = (width + 15) & ~15;
    const size = this.stride * ((height + 15) & ~15);
    this.y = new Uint8Array(size); this.cr = new Uint8Array(size / 4); this.cb = new Uint8Array(size / 4);
    this.pending = false;
  }
  save(y, cr, cb, timestamp) {
    if (this.pending) this.dropped++;
    this.y.set(y); this.cr.set(cr); this.cb.set(cb);
    this.timestamp = timestamp; this.pending = true;
  }
  take() {
    if (!this.pending) return null;
    this.pending = false;
    return this;
  }
}
