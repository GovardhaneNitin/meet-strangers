import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { normalizeIp, rateLimitKey, resolveClientIp } from '../src/security/clientIp.js';
import { IpGuard } from '../src/security/ipGuard.js';
import { TokenBucket } from '../src/security/tokenBucket.js';
import { isOriginAllowed } from '../src/signaling/signalingServer.js';
import { buildIceServers } from '../src/signaling/iceServers.js';
import { createHmac } from 'node:crypto';

const fakeReq = (remoteAddress: string, xff?: string) =>
  ({
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  }) as unknown as IncomingMessage;

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    expect(resolveClientIp(fakeReq('203.0.113.9', '1.1.1.1'), 0)).toBe('203.0.113.9');
  });

  it('uses the entry added by the trusted proxy, not a spoofed left-most one', () => {
    expect(resolveClientIp(fakeReq('10.0.0.1', '6.6.6.6, 198.51.100.7'), 1)).toBe('198.51.100.7');
    expect(resolveClientIp(fakeReq('10.0.0.2', '6.6.6.6, 198.51.100.7, 10.0.0.1'), 2)).toBe(
      '198.51.100.7',
    );
  });

  it('strips source ports that some proxies append to forwarded entries', () => {
    // Regression: "ip:port" failed validation, so every client fell back to
    // the proxy's address and shared one connection limit and ban bucket.
    expect(resolveClientIp(fakeReq('10.0.0.1', '203.0.113.7:51234'), 1)).toBe('203.0.113.7');
    expect(resolveClientIp(fakeReq('10.0.0.1', '[2001:db8::7]:51234'), 1)).toBe('2001:db8::7');
    expect(resolveClientIp(fakeReq('10.0.0.1', '[2001:db8::7]'), 1)).toBe('2001:db8::7');
    expect(resolveClientIp(fakeReq('10.0.0.1', '2001:db8::7'), 1)).toBe('2001:db8::7');
    expect(resolveClientIp(fakeReq('10.0.0.1', '6.6.6.6, 198.51.100.7:443'), 1)).toBe(
      '198.51.100.7',
    );
    expect(resolveClientIp(fakeReq('10.0.0.1', '[::ffff:192.0.2.1]:80'), 1)).toBe('192.0.2.1');
  });

  it('keeps distinct clients behind a port-appending proxy in separate buckets', () => {
    const guard = new IpGuard({
      maxConnectionsPerIp: 1,
      maxConnectionAttemptsPerMinute: 30,
      reportBanThreshold: 3,
      reportWindowMs: 60_000,
      banDurationMs: 60_000,
    });
    const admitted = ['198.51.100.10:40000', '198.51.100.11:41000', '198.51.100.12:42000'].map(
      (xff) => guard.admit(resolveClientIp(fakeReq('10.0.0.1', xff), 1)).ok,
    );
    expect(admitted).toEqual([true, true, true]);
  });

  it('falls back to the socket address for garbage headers', () => {
    expect(resolveClientIp(fakeReq('203.0.113.9', 'not-an-ip'), 1)).toBe('203.0.113.9');
  });

  it('normalises IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(resolveClientIp(fakeReq('::ffff:192.0.2.1'), 0)).toBe('192.0.2.1');
  });
});

describe('rateLimitKey', () => {
  it('aggregates IPv6 by /64 and leaves IPv4 alone', () => {
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe('2001:0db8:0001:0002::/64');
    expect(rateLimitKey('2001:db8:1:2::ffff')).toBe('2001:0db8:0001:0002::/64');
    expect(rateLimitKey('192.0.2.1')).toBe('192.0.2.1');
  });
});

describe('TokenBucket', () => {
  it('allows bursts up to capacity then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(bucket.msUntilAvailable()).toBe(1000);
    now += 1000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});

describe('IpGuard', () => {
  const options = {
    maxConnectionsPerIp: 2,
    maxConnectionAttemptsPerMinute: 5,
    reportBanThreshold: 2,
    reportWindowMs: 60_000,
    banDurationMs: 300_000,
  };

  it('never exposes the raw IP in client keys', () => {
    const guard = new IpGuard(options);
    const key = guard.keyFor('192.0.2.1');
    expect(key).not.toContain('192');
    expect(guard.keyFor('192.0.2.1')).toBe(key);
  });

  it('limits concurrent connections per IP and releases slots', () => {
    const guard = new IpGuard(options);
    const a = guard.admit('192.0.2.1');
    const b = guard.admit('192.0.2.1');
    expect(a.ok && b.ok).toBe(true);
    expect(guard.admit('192.0.2.1')).toMatchObject({ ok: false, reason: 'too_many_connections' });
    if (a.ok) guard.release(a.clientKey);
    expect(guard.admit('192.0.2.1').ok).toBe(true);
  });

  it('limits connection attempts per minute', () => {
    let now = 0;
    const guard = new IpGuard({ ...options, maxConnectionsPerIp: 100, now: () => now });
    for (let i = 0; i < 5; i++) expect(guard.admit('192.0.2.1').ok).toBe(true);
    expect(guard.admit('192.0.2.1')).toMatchObject({ ok: false, reason: 'too_many_attempts' });
    now += 60_000;
    expect(guard.admit('192.0.2.1').ok).toBe(true);
  });

  it('bans only after reports from distinct reporters, and the ban expires', () => {
    let now = 0;
    const guard = new IpGuard({ ...options, now: () => now });
    const abuser = guard.keyFor('192.0.2.66');
    const reporterA = guard.keyFor('198.51.100.1');
    const reporterB = guard.keyFor('198.51.100.2');

    expect(guard.recordReport(abuser, reporterA)).toBe(false);
    expect(guard.recordReport(abuser, reporterA)).toBe(false); // same reporter again
    expect(guard.recordReport(abuser, abuser)).toBe(false); // self-report
    expect(guard.isBanned(abuser)).toBe(false);

    expect(guard.recordReport(abuser, reporterB)).toBe(true);
    expect(guard.admit('192.0.2.66')).toMatchObject({ ok: false, reason: 'banned' });

    now += 300_000;
    expect(guard.isBanned(abuser)).toBe(false);
  });

  it('forgets reports outside the window', () => {
    let now = 0;
    const guard = new IpGuard({ ...options, now: () => now });
    guard.recordReport('abuser', 'r1');
    now += 60_000;
    expect(guard.recordReport('abuser', 'r2')).toBe(false);
  });

  it('prunes idle state', () => {
    let now = 0;
    const guard = new IpGuard({ ...options, now: () => now });
    const result = guard.admit('192.0.2.1');
    if (result.ok) guard.release(result.clientKey);
    now += 60_000;
    guard.prune();
    expect(guard.trackedClients).toBe(0);
  });
});

describe('isOriginAllowed', () => {
  it('requires an origin and matches the allow-list exactly', () => {
    const allowed = ['https://meet.example.com'];
    expect(isOriginAllowed(undefined, 'meet.example.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://meet.example.com', 'x', allowed)).toBe(true);
    expect(isOriginAllowed('https://meet.example.com.evil.com', 'x', allowed)).toBe(false);
    expect(isOriginAllowed('http://meet.example.com', 'x', allowed)).toBe(false);
    expect(isOriginAllowed('null', 'x', allowed)).toBe(false);
  });

  it('falls back to same-origin when no allow-list is configured', () => {
    expect(isOriginAllowed('http://localhost:8080', 'localhost:8080', [])).toBe(true);
    expect(isOriginAllowed('https://evil.com', 'localhost:8080', [])).toBe(false);
  });
});

describe('buildIceServers', () => {
  it('issues expiring TURN REST credentials signed with the shared secret', () => {
    const servers = buildIceServers(
      {
        STUN_URLS: ['stun:stun.example.com:3478'],
        TURN_URLS: ['turn:turn.example.com:3478'],
        TURN_SECRET: 'a-very-secret-value',
        TURN_CREDENTIAL_TTL_SECONDS: 600,
      },
      1_000_000_000,
    );
    expect(servers).toHaveLength(2);
    const turn = servers[1]!;
    expect(turn.username).toMatch(/^1000600:[0-9a-f]{16}$/);
    expect(turn.credential).toBe(
      createHmac('sha1', 'a-very-secret-value').update(turn.username!).digest('base64'),
    );
    expect(JSON.stringify(servers)).not.toContain('a-very-secret-value');
  });

  it('omits TURN when not configured', () => {
    const servers = buildIceServers({
      STUN_URLS: ['stun:stun.example.com:3478'],
      TURN_URLS: [],
      TURN_SECRET: undefined,
      TURN_CREDENTIAL_TTL_SECONDS: 600,
    });
    expect(servers).toEqual([{ urls: ['stun:stun.example.com:3478'] }]);
  });
});
