// Fixed-window limiter: at most `limit` calls per `windowMs`, per key.
class Limiter {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map(); // key -> { start, count }
  }
  allow(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || t - b.start >= this.windowMs) {
      b = { start: t, count: 0 };
      this.buckets.set(key, b);
    }
    if (b.count >= this.limit) return false;
    b.count += 1;
    return true;
  }
}
module.exports = { Limiter };
