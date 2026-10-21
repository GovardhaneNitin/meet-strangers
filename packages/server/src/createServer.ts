import { createServer as createHttpServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { createApp } from './http/app.js';
import { Matchmaker } from './matchmaking/matchmaker.js';
import { IpGuard } from './security/ipGuard.js';
import { SignalingServer } from './signaling/signalingServer.js';

export interface MeetStrangersServer {
  httpServer: Server;
  signaling: SignalingServer;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

/** Wire all components together. Kept separate from `index.ts` so tests can start real instances. */
export function createServer(config: Config, logger: Logger): MeetStrangersServer {
  const ipGuard = new IpGuard({
    maxConnectionsPerIp: config.MAX_CONNECTIONS_PER_IP,
    maxConnectionAttemptsPerMinute: config.MAX_CONNECTION_ATTEMPTS_PER_MINUTE,
    reportBanThreshold: config.REPORT_BAN_THRESHOLD,
    reportWindowMs: config.REPORT_WINDOW_MS,
    banDurationMs: config.BAN_DURATION_MS,
    hashSecret: config.IP_HASH_SECRET,
  });
  const matchmaker = new Matchmaker({
    interestMatchTimeoutMs: config.INTEREST_MATCH_TIMEOUT_MS,
    rematchCooldownMs: config.REMATCH_COOLDOWN_MS,
  });
  const signaling = new SignalingServer({ config, logger, ipGuard, matchmaker });
  const app = createApp({ config, logger, isReady: () => signaling.isAccepting });

  const httpServer = createHttpServer(app);
  // Slowloris protection: bound how long a client may take to send headers/body.
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 100;
  signaling.attach(httpServer);

  return {
    httpServer,
    signaling,
    listen: () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.PORT, config.HOST, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          resolve({ port: typeof address === 'object' && address ? address.port : config.PORT });
        });
      }),
    close: async () => {
      await signaling.shutdown(config.SHUTDOWN_GRACE_MS);
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections();
      });
    },
  };
}
