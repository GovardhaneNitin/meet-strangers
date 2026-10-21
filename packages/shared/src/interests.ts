import { LIMITS } from './limits.js';

/** Allowed characters after normalization: lowercase letters, digits, space, dash. */
const INTEREST_PATTERN = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N} -]*$/u;

/**
 * Canonicalise a single interest tag so that "  Music ", "music" and "MUSIC"
 * are treated as the same interest. Returns `null` for anything that is not a
 * valid tag after normalisation.
 */
export function normalizeInterest(raw: string): string | null {
  const value = raw.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  if (value.length === 0 || value.length > LIMITS.MAX_INTEREST_LENGTH) return null;
  if (!INTEREST_PATTERN.test(value)) return null;
  return value;
}

/** Normalise, drop invalid entries, de-duplicate and cap the list. */
export function normalizeInterests(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = normalizeInterest(entry);
    if (value !== null) seen.add(value);
    if (seen.size >= LIMITS.MAX_INTERESTS) break;
  }
  return [...seen];
}
