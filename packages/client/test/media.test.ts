import { describe, expect, it } from 'vitest';
import { toMediaAccessError } from '../src/lib/media';

const named = (name: string) => Object.assign(new Error(name), { name });

describe('toMediaAccessError', () => {
  it('explains blocked permissions without suggesting voice-only', () => {
    const error = toMediaAccessError(named('NotAllowedError'), 'video');
    expect(error.message).toMatch(/blocked/);
    expect(error.suggestVoiceOnly).toBe(false);
  });

  it('suggests voice-only when no camera is available in video mode', () => {
    expect(toMediaAccessError(named('NotFoundError'), 'video').suggestVoiceOnly).toBe(true);
    expect(toMediaAccessError(named('NotFoundError'), 'audio').suggestVoiceOnly).toBe(false);
  });

  it('handles devices in use and unknown errors', () => {
    expect(toMediaAccessError(named('NotReadableError'), 'audio').message).toMatch(
      /another application/,
    );
    expect(toMediaAccessError('weird', 'audio').message).toMatch(/Could not access/);
  });
});
