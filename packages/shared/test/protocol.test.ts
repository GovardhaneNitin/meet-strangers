import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  clientMessageSchema,
  normalizeInterests,
  parseMessage,
  peerMessageSchema,
} from '../src/index.js';

let uuidCounter = 0;
const randomUUID = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;

const parseClient = (value: unknown) => parseMessage(clientMessageSchema, JSON.stringify(value));

describe('client message validation', () => {
  it('accepts a valid join and defaults interests', () => {
    expect(parseClient({ type: 'join', mode: 'video', acceptedTerms: true })).toEqual({
      type: 'join',
      mode: 'video',
      interests: [],
      acceptedTerms: true,
    });
  });

  it('rejects a join without accepting the terms', () => {
    expect(parseClient({ type: 'join', mode: 'video', acceptedTerms: false })).toBeNull();
    expect(parseClient({ type: 'join', mode: 'video' })).toBeNull();
  });

  it('rejects unknown message types and unknown keys', () => {
    expect(parseClient({ type: 'admin' })).toBeNull();
    expect(parseClient({ type: 'leave', extra: 1 })).toBeNull();
  });

  it('rejects signals addressed to arbitrary targets', () => {
    expect(
      parseClient({
        type: 'signal',
        matchId: randomUUID(),
        to: randomUUID(),
        payload: { kind: 'offer', sdp: 'v=0' },
      }),
    ).toBeNull();
  });

  it('enforces SDP and candidate size limits', () => {
    const matchId = randomUUID();
    expect(
      parseClient({
        type: 'signal',
        matchId,
        payload: { kind: 'offer', sdp: 'x'.repeat(LIMITS.MAX_SDP_LENGTH + 1) },
      }),
    ).toBeNull();
    expect(
      parseClient({
        type: 'signal',
        matchId,
        payload: {
          kind: 'candidate',
          candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0 },
        },
      }),
    ).not.toBeNull();
  });

  it('never throws on malformed input', () => {
    for (const raw of ['', '{', 'null', '[]', '"join"', '{"__proto__":{"type":"leave"}}']) {
      expect(parseMessage(clientMessageSchema, raw)).toBeNull();
    }
  });
});

describe('peer message validation', () => {
  it('enforces chat length bounds', () => {
    const parse = (text: string) =>
      parseMessage(peerMessageSchema, JSON.stringify({ type: 'chat', text }));
    expect(parse('hi')).toEqual({ type: 'chat', text: 'hi' });
    expect(parse('')).toBeNull();
    expect(parse('a'.repeat(LIMITS.MAX_CHAT_MESSAGE_LENGTH + 1))).toBeNull();
  });
});

describe('normalizeInterests', () => {
  it('canonicalises, de-duplicates and drops invalid tags', () => {
    expect(
      normalizeInterests(['  Music ', 'MUSIC', 'video   games', '<script>', '', '🎉']),
    ).toEqual(['music', 'video games']);
  });

  it('accepts scripts that use combining marks and modifier letters', () => {
    for (const word of [
      'संगीत',
      'क्रिकेट',
      'யோகா',
      'ดนตรี',
      'ラーメン',
      'موسيقى',
      '音楽',
      'футбол',
    ]) {
      expect(normalizeInterests([word])).toEqual([word]);
    }
  });

  it('still rejects a leading combining mark and symbols', () => {
    expect(normalizeInterests(['\u0301abc', 'a+b', 'a_b', '#tag'])).toEqual([]);
  });

  it('caps the number of interests', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    expect(normalizeInterests(many)).toHaveLength(LIMITS.MAX_INTERESTS);
  });
});
