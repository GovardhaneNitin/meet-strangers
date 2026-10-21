import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Browser origins allowed to open a WebSocket, e.g. "https://meet.example.com".
   * When empty, only same-origin connections (Origin host === Host header) are allowed.
   */
  ALLOWED_ORIGINS: csv,
  /**
   * Number of reverse proxies in front of the server whose X-Forwarded-For
   * entries are trusted. 0 = use the socket address and ignore the header,
   * which is the only safe default: otherwise any client can spoof its IP and
   * bypass per-IP limits and bans.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /** Directory with the built web client. Served when it exists. */
  CLIENT_DIST_DIR: z.string().optional(),

  STUN_URLS: csv.transform((urls) =>
    urls.length > 0 ? urls : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  ),
  /** TURN server URLs, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349". */
  TURN_URLS: csv,
  /** Shared secret configured as `static-auth-secret` in coturn (`use-auth-secret`). */
  TURN_SECRET: z.string().min(16).optional(),
  TURN_CREDENTIAL_TTL_SECONDS: positiveInt(3600),
  /**
   * "relay" forces all media through TURN so peers never learn each other's
   * IP address. Requires TURN. "all" allows direct peer-to-peer connections.
   */
  ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).default('all'),

  /** Secret for hashing IP addresses. Random per process when unset. */
  IP_HASH_SECRET: z.string().min(16).optional(),
  MAX_CONNECTIONS_PER_IP: positiveInt(4),
  MAX_CONNECTION_ATTEMPTS_PER_MINUTE: positiveInt(30),
  MAX_TOTAL_CONNECTIONS: positiveInt(10_000),

  /** Distinct reporters within the window needed to trigger a temporary ban. */
  REPORT_BAN_THRESHOLD: positiveInt(3),
  REPORT_WINDOW_MS: positiveInt(15 * 60_000),
  BAN_DURATION_MS: positiveInt(60 * 60_000),

  /** How long a user with interests waits for a shared-interest match before matching anyone. */
  INTEREST_MATCH_TIMEOUT_MS: positiveInt(10_000),
  /** After skipping someone, the same pair is not re-matched for this long. */
  REMATCH_COOLDOWN_MS: positiveInt(60_000),
  HEARTBEAT_INTERVAL_MS: positiveInt(15_000),
  SHUTDOWN_GRACE_MS: positiveInt(10_000),
});

export type Config = z.infer<typeof envSchema> & { turnEnabled: boolean };

/**
 * Parse and validate configuration from the environment. Fails fast with a
 * readable error instead of starting a half-configured server.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in an env file means "not set", not "set to an empty string".
  const defined = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = envSchema.safeParse(defined);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }

  const config = parsed.data;
  const turnEnabled = config.TURN_URLS.length > 0 && config.TURN_SECRET !== undefined;

  if (config.TURN_URLS.length > 0 !== (config.TURN_SECRET !== undefined)) {
    throw new Error('Invalid configuration: TURN_URLS and TURN_SECRET must be set together.');
  }
  if (config.ICE_TRANSPORT_POLICY === 'relay' && !turnEnabled) {
    throw new Error('Invalid configuration: ICE_TRANSPORT_POLICY=relay requires a TURN server.');
  }
  for (const origin of config.ALLOWED_ORIGINS) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
      throw new Error(
        `Invalid configuration: ALLOWED_ORIGINS entry "${origin}" must be a bare origin like https://example.com`,
      );
    }
  }

  return { ...config, turnEnabled };
}
