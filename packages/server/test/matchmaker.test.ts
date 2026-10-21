import { describe, expect, it } from 'vitest';
import { Matchmaker, type MatchEvent } from '../src/matchmaking/matchmaker.js';

function setup() {
  let now = 0;
  let id = 0;
  const mm = new Matchmaker({
    interestMatchTimeoutMs: 10_000,
    rematchCooldownMs: 60_000,
    now: () => now,
    createId: () => `match-${++id}`,
  });
  return {
    mm,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const matches = (events: MatchEvent[]) => events.filter((e) => e.type === 'matched');
const video = { mode: 'video' as const, interests: [] };

describe('Matchmaker', () => {
  it('matches two waiting users and makes the longer-waiting one the offerer', () => {
    const { mm } = setup();
    expect(matches(mm.join('a', video))).toHaveLength(0);
    const [match] = matches(mm.join('b', video));
    expect(match).toMatchObject({ offerer: 'a', answerer: 'b', mode: 'video' });
  });

  it('never matches a user with themselves', () => {
    const { mm } = setup();
    mm.join('a', video);
    expect(matches(mm.join('a', video))).toHaveLength(0);
    expect(mm.stats().waiting).toBe(1);
  });

  it('keeps video and audio queues separate', () => {
    const { mm } = setup();
    mm.join('a', video);
    expect(matches(mm.join('b', { mode: 'audio', interests: [] }))).toHaveLength(0);
  });

  it('prefers shared interests, then falls back to anyone after the timeout', () => {
    const { mm, advance } = setup();
    mm.join('plain', video);
    // Has interests: does not immediately match someone without them.
    expect(matches(mm.join('gamer', { mode: 'video', interests: ['games'] }))).toHaveLength(0);
    const [match] = matches(mm.join('gamer2', { mode: 'video', interests: ['games', 'music'] }));
    expect(match).toMatchObject({
      offerer: 'gamer',
      answerer: 'gamer2',
      commonInterests: ['games'],
    });

    advance(1);
    mm.join('reader', { mode: 'video', interests: ['books'] });
    expect(matches(mm.tick())).toHaveLength(0);
    advance(10_000);
    expect(matches(mm.tick())).toMatchObject([{ offerer: 'plain', answerer: 'reader' }]);
  });

  it('"next" ends the chat, notifies the partner and does not re-pair them immediately', () => {
    const { mm, advance } = setup();
    mm.join('a', video);
    mm.join('b', video);

    const events = mm.join('a', video);
    expect(events).toContainEqual({ type: 'partner_left', sessionId: 'b', matchId: 'match-1' });
    expect(matches(events)).toHaveLength(0);

    // b also presses next: same pair must not be re-matched during the cooldown.
    expect(matches(mm.join('b', video))).toHaveLength(0);
    // A third user gets matched right away.
    expect(matches(mm.join('c', video))).toHaveLength(1);

    mm.leave('c');
    advance(60_000);
    // Whoever is left waiting can be paired again once the cooldown expires.
    const waiting = mm.stats().waiting;
    expect(waiting).toBe(1);
  });

  it('re-matches a pair after the cooldown via tick', () => {
    const { mm, advance } = setup();
    mm.join('a', video);
    mm.join('b', video);
    mm.join('a', video);
    mm.join('b', video);
    expect(matches(mm.tick())).toHaveLength(0);
    advance(60_000);
    expect(matches(mm.tick())).toHaveLength(1);
  });

  it('only resolves partners for the current match id', () => {
    const { mm } = setup();
    mm.join('a', video);
    mm.join('b', video);
    expect(mm.partnerOf('a', 'match-1')).toBe('b');
    expect(mm.partnerOf('a', 'match-999')).toBeNull();
    expect(mm.partnerOf('c', 'match-1')).toBeNull();

    mm.join('a', video); // next
    expect(mm.partnerOf('a', 'match-1')).toBeNull();
    expect(mm.partnerOf('b', 'match-1')).toBeNull();
  });

  it('cleans up on disconnect and notifies the partner', () => {
    const { mm } = setup();
    mm.join('a', video);
    mm.join('b', video);
    expect(mm.remove('a')).toEqual([{ type: 'partner_left', sessionId: 'b', matchId: 'match-1' }]);
    expect(mm.stats()).toEqual({ waiting: 0, activeMatches: 0 });
    expect(mm.remove('a')).toEqual([]);
  });

  it('serves the queue in FIFO order', () => {
    const { mm } = setup();
    mm.join('first', { mode: 'video', interests: ['x'] });
    mm.join('second', { mode: 'video', interests: ['y'] });
    const [match] = matches(mm.join('third', { mode: 'video', interests: ['x', 'y'] }));
    expect(match).toMatchObject({ offerer: 'first' });
  });
});
