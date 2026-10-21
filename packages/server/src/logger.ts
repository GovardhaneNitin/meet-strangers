import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

/**
 * Structured JSON logger.
 *
 * Privacy rule for the whole server: never log raw IP addresses, SDP,
 * ICE candidates (they contain IPs) or chat content. Use the hashed client
 * key from `IpGuard` when a log line must correlate a client.
 */
export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    base: undefined,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'ip', '*.ip', 'payload'],
      censor: '[redacted]',
    },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
