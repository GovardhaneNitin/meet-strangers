import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

/**
 * Resolve the real client IP of a request.
 *
 * X-Forwarded-For is a client-controlled header: a client can send
 * `X-Forwarded-For: 1.2.3.4` and every proxy appends to it. The only
 * trustworthy entries are the ones appended by *our own* proxies, i.e. the
 * last `trustedHops` entries. The client address is therefore the entry
 * immediately before those, never the left-most one.
 *
 * With `trustedHops = 0` the header is ignored entirely.
 */
export function resolveClientIp(req: IncomingMessage, trustedHops: number): string {
  const socketIp = normalizeIp(req.socket.remoteAddress ?? '');

  if (trustedHops <= 0) return socketIp;

  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const chain = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // The socket peer is the closest proxy (hop 1); XFF holds the hops before it.
  // With N trusted proxies, the client is at index length - N of the XFF chain.
  const index = chain.length - trustedHops;
  if (index < 0) {
    // Fewer entries than proxies: the request did not traverse all of our
    // proxies (misconfiguration or direct access). Use the left-most entry
    // we have, which was added by our outermost proxy, or the socket.
    const fallback = parseForwardedEntry(chain[0] ?? '');
    return isIP(fallback) ? fallback : socketIp;
  }

  const candidate = parseForwardedEntry(chain[index] ?? '');
  return isIP(candidate) ? candidate : socketIp;
}

/**
 * Some proxies (e.g. Azure App Service) append the client's source port to
 * X-Forwarded-For entries: "203.0.113.7:51234" or "[2001:db8::7]:51234".
 * Strip it; otherwise the entry is not a valid IP and every client would
 * fall back to the proxy's own address and share one rate-limit/ban bucket.
 */
export function parseForwardedEntry(entry: string): string {
  const value = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed?.[1]) return normalizeIp(bracketed[1]);
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (ipv4WithPort?.[1]) return ipv4WithPort[1];
  // Anything else, including bare IPv6 (whose colons are not a port).
  return normalizeIp(value);
}

/** Collapse IPv4-mapped IPv6 addresses ("::ffff:1.2.3.4") to plain IPv4. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.toLowerCase().startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4
    ? trimmed.slice(7)
    : trimmed;
}

/**
 * Key used for per-IP limits. IPv6 users typically control a whole /64, so
 * limiting individual IPv6 addresses is trivially bypassed; aggregate by /64.
 */
export function rateLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const expanded = expandIpv6(ip);
  return expanded === null ? ip : `${expanded.slice(0, 4).join(':')}::/64`;
}

function expandIpv6(ip: string): string[] | null {
  const withoutZone = ip.split('%')[0] ?? ip;
  const [head = '', tail] = withoutZone.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');
  // Embedded IPv4 suffix (e.g. ::1.2.3.4) is irrelevant to the /64 prefix.
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined && headParts.length !== 8) return null;
  if (missing < 0) return null;
  const parts = [
    ...headParts,
    ...Array<string>(tail === undefined ? 0 : missing).fill('0'),
    ...tailParts,
  ];
  return parts.map((part) => part.padStart(4, '0'));
}
