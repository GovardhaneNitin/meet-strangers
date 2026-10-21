import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      PORT: 8080,
      TRUST_PROXY_HOPS: 0,
      ALLOWED_ORIGINS: [],
      ICE_TRANSPORT_POLICY: 'all',
      turnEnabled: false,
    });
    expect(config.STUN_URLS.length).toBeGreaterThan(0);
  });

  it('treats empty values (KEY= in .env files) as unset', () => {
    expect(() => loadConfig({ TURN_SECRET: '', IP_HASH_SECRET: '', TURN_URLS: '' })).not.toThrow();
  });

  it('parses comma-separated lists', () => {
    const config = loadConfig({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
    expect(config.ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects invalid or inconsistent configuration', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'https://a.example/path' })).toThrow(/bare origin/);
    expect(() => loadConfig({ TURN_URLS: 'turn:t.example' })).toThrow(/together/);
    expect(() => loadConfig({ ICE_TRANSPORT_POLICY: 'relay' })).toThrow(/requires a TURN/);
    expect(() => loadConfig({ TURN_URLS: 'turn:t.example', TURN_SECRET: 'short' })).toThrow();
  });

  it('enables TURN when URLs and secret are both set', () => {
    const config = loadConfig({ TURN_URLS: 'turn:t.example', TURN_SECRET: 'x'.repeat(32) });
    expect(config.turnEnabled).toBe(true);
  });
});
