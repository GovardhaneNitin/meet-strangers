import { LIMITS } from './limits.js';

/**
 * Allowed characters after normalization: lowercase, other and modifier
 * letters, digits, space and dash, plus combining marks after the first
 * character. Marks are required for many scripts: vowel signs in Devanagari
 * ("संगीत"), Tamil or Thai are combining marks, and "ー" in Japanese
 * ("ラーメン") is a modifier letter. The length limit bounds stacked marks.
 */
const INTEREST_PATTERN = /^[\p{Ll}\p{Lo}\p{Lm}\p{N}][\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N} -]*$/u;

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
