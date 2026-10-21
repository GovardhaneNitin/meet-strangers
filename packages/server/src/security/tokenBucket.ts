/**
 * Classic token bucket: allows short bursts up to `capacity` while enforcing a
 * long-run average of `refillPerSecond`. Bursts matter here because a WebRTC
 * handshake legitimately sends an offer plus a dozen ICE candidates at once.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Consume `cost` tokens if available. Returns false when rate limited. */
  take(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Milliseconds until `cost` tokens will be available. */
  msUntilAvailable(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = current;
  }
}
