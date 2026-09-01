import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AppContext } from './context.js';
import { attachContext } from './middleware/context.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { alertRoutes } from './routes/alerts.js';
import { authRoutes } from './routes/auth.js';
import { metaRoutes } from './routes/meta.js';
import { organizationRoutes } from './routes/organizations.js';
import { stickerRoutes } from './routes/stickers.js';
import { vehicleRoutes } from './routes/vehicles.js';
import { demoRoutes } from './routes/demo.js';

export function createApp(ctx: AppContext): Express {
  const app = express();

  // Behind a load balancer, the client IP arrives in X-Forwarded-For. Trusting
  // exactly one hop stops a caller from spoofing the header to dodge IP limits.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; no page is ever rendered from it.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: ctx.config.corsOrigins,
      credentials: false,
      maxAge: 86_400,
    }),
  );
  // Alerts and account updates are small; a low cap limits the damage a
  // malformed or hostile body can do before it is rejected.
  app.use(express.json({ limit: '32kb' }));
  app.use(attachContext(ctx));

  app.use('/v1/meta', metaRoutes());
  app.use('/v1/auth', authRoutes());
  app.use('/v1/vehicles', vehicleRoutes());
  app.use('/v1/stickers', stickerRoutes());
  app.use('/v1/alerts', alertRoutes());
  app.use('/v1/account', accountRoutes());
  app.use('/v1/organizations', organizationRoutes());
  app.use('/v1/admin', adminRoutes());

  /*
   * The demo outbox shows the messages a non-production transport produced, so
   * the whole product can be walked through without a Meta business account.
   * It exposes message bodies, so production must never mount it.
   */
  if (ctx.config.env !== 'production') {
    app.use('/v1/demo', demoRoutes());
  }

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
