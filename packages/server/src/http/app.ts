import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Readiness probe: false while shutting down so load balancers drain traffic. */
  isReady: () => boolean;
}

export function createApp({ config, logger, isReady }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  // Only affects req.ip for Express; WebSocket IPs are resolved separately
  // with the same hop count (see security/clientIp.ts).
  app.set('trust proxy', config.TRUST_PROXY_HOPS);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          mediaSrc: ["'self'", 'blob:', 'mediastream:'],
          // Not every browser treats 'self' as covering ws(s):, so list the
          // socket origin explicitly when the page is served by this server.
          connectSrc: ["'self'", (req) => webSocketOrigin(req as Request)],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      // COEP makes every cross-origin subresource opt in via CORP. The app
      // needs no cross-origin isolation (no SharedArrayBuffer), so skip it.
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity:
        config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      xFrameOptions: { action: 'deny' },
    }),
  );

  // Camera and microphone only for our own origin; everything else is off.
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), microphone=(self), display-capture=(), geolocation=(), payment=(), usb=()',
    );
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });

  app.get('/readyz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ready = isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'draining' });
  });

  const clientDir = resolveClientDir(config.CLIENT_DIST_DIR);
  if (clientDir) {
    logger.info({ clientDir }, 'Serving web client');
    app.use(
      '/assets',
      // Vite emits content-hashed file names, so they can be cached forever.
      express.static(path.join(clientDir, 'assets'), {
        immutable: true,
        maxAge: '1y',
        index: false,
        fallthrough: false,
      }),
    );
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));

    // Single-page app: every other GET renders index.html, which must never
    // be cached so new deployments are picked up immediately.
    app.get(/.*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Never leak stack traces or internals to clients.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = isHttpError(error) ? error.status : 500;
    if (status >= 500) logger.error({ err: error }, 'Unhandled HTTP error');
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : 'Request error' });
  });

  return app;
}

function webSocketOrigin(req: Request): string {
  const host = req.headers.host ?? '';
  // Only reflect syntactically valid hosts into the header.
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) && !/^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(host)) {
    return "'self'";
  }
  return `${req.secure ? 'wss' : 'ws'}://${host}`;
}

function resolveClientDir(configured: string | undefined): string | null {
  const candidates = configured
    ? [path.resolve(configured)]
    : [
        path.resolve(import.meta.dirname, '../../client/dist'),
        path.resolve(import.meta.dirname, '../public'),
      ];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
}

function isHttpError(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    (error as { status: number }).status >= 400 &&
    (error as { status: number }).status < 600
  );
}
