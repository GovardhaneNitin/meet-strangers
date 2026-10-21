import { loadConfig } from './config.js';
import { createServer } from './createServer.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config);

if (config.NODE_ENV === 'production' && config.ALLOWED_ORIGINS.length === 0) {
  logger.warn('ALLOWED_ORIGINS is empty: only same-origin WebSocket connections will be accepted.');
}
if (config.NODE_ENV === 'production' && !config.turnEnabled) {
  logger.warn(
    'No TURN server configured: users behind symmetric NATs or strict firewalls will fail to connect.',
  );
}

const server = createServer(config, logger);
const { port } = await server.listen();
logger.info({ port, host: config.HOST, env: config.NODE_ENV }, 'Meet Strangers server listening');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // Hard stop in case something hangs during the graceful phase.
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; exiting');
    process.exit(1);
  }, config.SHUTDOWN_GRACE_MS + 5_000);
  forceExit.unref();

  try {
    await server.close();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  // State may be corrupt after an uncaught exception: log and exit so the
  // orchestrator restarts a clean process.
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});
