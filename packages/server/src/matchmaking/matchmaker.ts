import { randomUUID } from 'node:crypto';
import type { ChatMode } from '@meet-strangers/shared';

export interface MatchPreferences {
  mode: ChatMode;
  /** Already normalised interests. */
  interests: readonly string[];
}

/** Side effects the transport layer must perform after a matchmaker call. */
export type MatchEvent =
  | { type: 'queued'; sessionId: string; mode: ChatMode }
  | {
      type: 'matched';
      matchId: string;
      offerer: string;
      answerer: string;
      mode: ChatMode;
      commonInterests: string[];
    }
  | { type: 'partner_left'; sessionId: string; matchId: string }
  | { type: 'idle'; sessionId: string };

interface Waiting {
  prefs: MatchPreferences;
  since: number;
  /** True once the user has waited long enough to accept non-interest matches. */
  relaxed: boolean;
}

interface Match {
  matchId: string;
  a: string;
  b: string;
}

export interface MatchmakerOptions {
  interestMatchTimeoutMs: number;
  rematchCooldownMs: number;
  now?: () => number;
  createId?: () => string;
}

/**
 * Pure in-memory matchmaking state machine. It knows nothing about sockets:
 * every operation returns the events the caller must deliver, which keeps the
 * logic deterministic and easy to test.
 *
 * Each session is in exactly one state: unknown/idle, waiting, or matched.
 *
 * Scaling note: this is single-process state. Running several instances
 * requires moving the queue and match table to shared storage (e.g. Redis)
 * and routing signals between instances; the event-based interface is
 * designed so that the transport layer would not need to change.
 */
export class Matchmaker {
  /** Insertion-ordered, so iteration yields the longest-waiting session first (FIFO fairness). */
  private readonly waiting = new Map<string, Waiting>();
  private readonly matchBySession = new Map<string, Match>();
  /** Pairs that recently ended a chat, so "next" does not immediately reconnect them. */
  private readonly recentPairs = new Map<string, number>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: MatchmakerOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  /**
   * Enter the queue. If the session is currently in a chat, that chat ends
   * first (this is how "next" works), so state changes are atomic and the
   * partner is always notified.
   */
  join(sessionId: string, prefs: MatchPreferences): MatchEvent[] {
    const events = this.endMatch(sessionId);
    this.waiting.delete(sessionId);

    this.waiting.set(sessionId, {
      prefs,
      since: this.now(),
      relaxed: prefs.interests.length === 0,
    });
    events.push({ type: 'queued', sessionId, mode: prefs.mode });

    const match = this.tryMatch(sessionId);
    if (match) events.push(match);
    return events;
  }

  /** Leave the queue or the current chat and become idle. */
  leave(sessionId: string): MatchEvent[] {
    const events = this.endMatch(sessionId);
    this.waiting.delete(sessionId);
    events.push({ type: 'idle', sessionId });
    return events;
  }

  /** The session disconnected: clean up silently, notify the partner if any. */
  remove(sessionId: string): MatchEvent[] {
    this.waiting.delete(sessionId);
    return this.endMatch(sessionId);
  }

  /**
   * Resolve the partner for a signal. Returns null when the sender is not in
   * the referenced match, e.g. a late ICE candidate from a chat that the
   * sender already skipped. Such messages must be dropped, never delivered
   * to whoever the sender is talking to now.
   */
  partnerOf(sessionId: string, matchId: string): string | null {
    const match = this.matchBySession.get(sessionId);
    if (!match || match.matchId !== matchId) return null;
    return match.a === sessionId ? match.b : match.a;
  }

  /**
   * Periodic maintenance: relax interest requirements for sessions that have
   * waited long enough, then try to match them; expire cooldown entries.
   */
  tick(): MatchEvent[] {
    const now = this.now();
    const events: MatchEvent[] = [];

    for (const [pair, expires] of this.recentPairs) {
      if (expires <= now) this.recentPairs.delete(pair);
    }

    const newlyRelaxed: string[] = [];
    for (const [sessionId, entry] of this.waiting) {
      if (!entry.relaxed && now - entry.since >= this.options.interestMatchTimeoutMs) {
        entry.relaxed = true;
        newlyRelaxed.push(sessionId);
      }
    }
    // Sessions that were blocked only by the rematch cooldown also need a
    // retry once it expires; retrying every waiting session is O(n²) though,
    // so only do it when the queue is small, which is exactly when cooldowns
    // are what prevents matches.
    const retry = this.waiting.size <= 200 ? [...this.waiting.keys()] : newlyRelaxed;
    for (const sessionId of retry) {
      if (!this.waiting.has(sessionId)) continue;
      const match = this.tryMatch(sessionId);
      if (match) events.push(match);
    }
    return events;
  }

  stats(): { waiting: number; activeMatches: number } {
    return { waiting: this.waiting.size, activeMatches: this.matchBySession.size / 2 };
  }

  private tryMatch(sessionId: string): MatchEvent | null {
    const self = this.waiting.get(sessionId);
    if (!self) return null;

    let fallback: { id: string } | null = null;
    for (const [candidateId, candidate] of this.waiting) {
      if (candidateId === sessionId) continue;
      if (candidate.prefs.mode !== self.prefs.mode) continue;
      if (this.recentPairs.has(pairKey(sessionId, candidateId))) continue;

      const common = intersect(self.prefs.interests, candidate.prefs.interests);
      if (common.length > 0)
        return this.createMatch(candidateId, sessionId, self.prefs.mode, common);
      if (fallback === null && self.relaxed && candidate.relaxed) {
        fallback = { id: candidateId };
      }
    }
    return fallback ? this.createMatch(fallback.id, sessionId, self.prefs.mode, []) : null;
  }

  /** The session that waited longer becomes the offerer; arbitrary but deterministic. */
  private createMatch(x: string, y: string, mode: ChatMode, commonInterests: string[]): MatchEvent {
    const xSince = this.waiting.get(x)?.since ?? 0;
    const ySince = this.waiting.get(y)?.since ?? 0;
    const [waitedLonger, newcomer] = xSince <= ySince ? [x, y] : [y, x];
    this.waiting.delete(x);
    this.waiting.delete(y);

    const match: Match = { matchId: this.createId(), a: waitedLonger, b: newcomer };
    this.matchBySession.set(waitedLonger, match);
    this.matchBySession.set(newcomer, match);

    return {
      type: 'matched',
      matchId: match.matchId,
      offerer: waitedLonger,
      answerer: newcomer,
      mode,
      commonInterests,
    };
  }

  private endMatch(sessionId: string): MatchEvent[] {
    const match = this.matchBySession.get(sessionId);
    if (!match) return [];

    const partner = match.a === sessionId ? match.b : match.a;
    this.matchBySession.delete(match.a);
    this.matchBySession.delete(match.b);
    this.recentPairs.set(pairKey(match.a, match.b), this.now() + this.options.rematchCooldownMs);

    return [{ type: 'partner_left', sessionId: partner, matchId: match.matchId }];
  }
}

function pairKey(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const set = new Set(b);
  return a.filter((item) => set.has(item));
}
