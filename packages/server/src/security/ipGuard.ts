import { createHmac, randomBytes } from 'node:crypto';
import { rateLimitKey } from './clientIp.js';

export interface IpGuardOptions {
  maxConnectionsPerIp: number;
  maxConnectionAttemptsPerMinute: number;
  reportBanThreshold: number;
  reportWindowMs: number;
  banDurationMs: number;
  /** Secret for hashing IPs. A random one is generated when omitted. */
  hashSecret?: string | undefined;
  now?: () => number;
}

export type AdmissionResult =
  | { ok: true; clientKey: string }
  | {
      ok: false;
      reason: 'banned' | 'too_many_connections' | 'too_many_attempts';
      retryAfterMs: number;
    };

interface IpState {
  activeConnections: number;
  /** Timestamps of recent connection attempts (sliding one-minute window). */
  attempts: number[];
  /** Report timestamps keyed by the reporter's client key (distinct reporters). */
  reports: Map<string, number>;
  bannedUntil: number;
}

const ATTEMPT_WINDOW_MS = 60_000;

/**
 * Per-client abuse protection without storing personal data.
 *
 * IP addresses are only ever held as an HMAC ("client key"), and IPv6
 * addresses are aggregated per /64 first. With the default per-process
 * random secret, keys cannot be linked across restarts and the raw IP cannot
 * be recovered from memory dumps or logs.
 *
 * All state is in memory and pruned periodically, so its size is bounded by
 * recent activity rather than growing forever.
 */
export class IpGuard {
  private readonly states = new Map<string, IpState>();
  private readonly secret: string;
  private readonly now: () => number;

  constructor(private readonly options: IpGuardOptions) {
    this.secret = options.hashSecret ?? randomBytes(32).toString('hex');
    this.now = options.now ?? Date.now;
  }

  keyFor(ip: string): string {
    return createHmac('sha256', this.secret)
      .update(rateLimitKey(ip))
      .digest('base64url')
      .slice(0, 22);
  }

  /** Check whether a new connection from `ip` is allowed and, if so, register it. */
  admit(ip: string): AdmissionResult {
    const clientKey = this.keyFor(ip);
    const state = this.getState(clientKey);
    const now = this.now();

    if (state.bannedUntil > now) {
      return { ok: false, reason: 'banned', retryAfterMs: state.bannedUntil - now };
    }

    state.attempts = state.attempts.filter((t) => now - t < ATTEMPT_WINDOW_MS);
    if (state.attempts.length >= this.options.maxConnectionAttemptsPerMinute) {
      const oldest = state.attempts[0] ?? now;
      return {
        ok: false,
        reason: 'too_many_attempts',
        retryAfterMs: ATTEMPT_WINDOW_MS - (now - oldest),
      };
    }
    state.attempts.push(now);

    if (state.activeConnections >= this.options.maxConnectionsPerIp) {
      return { ok: false, reason: 'too_many_connections', retryAfterMs: 5_000 };
    }

    state.activeConnections += 1;
    return { ok: true, clientKey };
  }

  release(clientKey: string): void {
    const state = this.states.get(clientKey);
    if (state && state.activeConnections > 0) state.activeConnections -= 1;
  }

  isBanned(clientKey: string): boolean {
    const state = this.states.get(clientKey);
    return state !== undefined && state.bannedUntil > this.now();
  }

  /**
   * Record that `reporterKey` reported `reportedKey`. Only distinct reporters
   * count, so one person cannot ban someone by reporting repeatedly, and a
   * reporter cannot report themselves (e.g. two tabs on the same network).
   *
   * Returns true when this report caused a ban.
   */
  recordReport(reportedKey: string, reporterKey: string): boolean {
    if (reportedKey === reporterKey) return false;

    const now = this.now();
    const state = this.getState(reportedKey);
    for (const [key, at] of state.reports) {
      if (now - at >= this.options.reportWindowMs) state.reports.delete(key);
    }
    state.reports.set(reporterKey, now);

    if (state.reports.size >= this.options.reportBanThreshold && state.bannedUntil <= now) {
      state.bannedUntil = now + this.options.banDurationMs;
      state.reports.clear();
      return true;
    }
    return false;
  }

  /** Drop state that no longer affects any decision. Call periodically. */
  prune(): void {
    const now = this.now();
    for (const [key, state] of this.states) {
      state.attempts = state.attempts.filter((t) => now - t < ATTEMPT_WINDOW_MS);
      for (const [reporter, at] of state.reports) {
        if (now - at >= this.options.reportWindowMs) state.reports.delete(reporter);
      }
      const idle =
        state.activeConnections === 0 &&
        state.attempts.length === 0 &&
        state.reports.size === 0 &&
        state.bannedUntil <= now;
      if (idle) this.states.delete(key);
    }
  }

  get trackedClients(): number {
    return this.states.size;
  }

  private getState(clientKey: string): IpState {
    let state = this.states.get(clientKey);
    if (!state) {
      state = { activeConnections: 0, attempts: [], reports: new Map(), bannedUntil: 0 };
      this.states.set(clientKey, state);
    }
    return state;
  }
}
