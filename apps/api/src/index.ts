import { createApp } from './app.js';
import { getConfig } from './config.js';
import { createContext } from './context.js';
import { createDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './logger.js';

/** Interval between deferred-push flushes and retention passes. */
const PUSH_FLUSH_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = getConfig();
  const db = await createDb(config);

  const applied = await runMigrations(db);
  if (applied.length > 0) logger.info('startup.migrations_applied', { count: applied.length });

  const ctx = createContext(db, config);
  const app = createApp(ctx);

  const server = app.listen(config.port, () => {
    logger.info('startup.listening', {
      port: config.port,
      environment: config.env,
      database: config.database.url ? 'postgres' : 'embedded',
      push: config.push.provider,
    });
    if (config.auth.echoOtp) {
      logger.warn('startup.otp_echo_enabled', {
        note: 'Sign-in codes are returned in API responses. Development only.',
      });
    }
  });

  /*
   * Background work runs in-process for the MVP. At pilot scale (a few
   * thousand vehicles) this is the right amount of machinery; the moment
   * there is more than one API instance, both of these move to a single
   * scheduled worker so they do not run N times over.
   */
  const flushTimer = setInterval(() => {
    void ctx.push.flushDeferred().catch((error: unknown) => {
      logger.error('scheduler.push_flush_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, PUSH_FLUSH_INTERVAL_MS);

  const retentionTimer = setInterval(() => {
    void ctx.retention.purge().catch((error: unknown) => {
      logger.error('scheduler.retention_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, RETENTION_INTERVAL_MS);

  const shutdown = (signal: string) => {
    logger.info('shutdown.started', { signal });
    clearInterval(flushTimer);
    clearInterval(retentionTimer);
    server.close(() => {
      void db.close().finally(() => {
        logger.info('shutdown.complete');
        process.exit(0);
      });
    });
    // Do not let a hung connection block the deploy indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('startup.failed', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
