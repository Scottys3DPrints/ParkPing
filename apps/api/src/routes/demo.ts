import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';

/**
 * Demo-only endpoints. Mounted by `createApp` outside production.
 *
 * The outbox exists because the most important thing to see when evaluating
 * ParkPing is the message a driver actually receives, and that message
 * normally leaves through WhatsApp or SMS where a reviewer cannot follow it.
 * Rendering it here makes the whole loop inspectable without credentials.
 *
 * It reveals notification bodies, which is precisely why it must never be
 * mounted in production — a fact enforced in `app.ts`, not by convention.
 */
export function demoRoutes(): Router {
  const router = Router();

  router.get(
    '/outbox',
    asyncHandler(async (req, res) => {
      res.json({ messages: await req.ctx.notifications.outbox(60) });
    }),
  );

  /** Everything a walkthrough needs to start: seeded accounts and stickers. */
  router.get(
    '/state',
    asyncHandler(async (req, res) => {
      const [stickers, users, orgs] = await Promise.all([
        req.ctx.db.query<{ code: string; status: string; label: string | null }>(
          `SELECT code, status, label FROM stickers ORDER BY created_at LIMIT 20`,
        ),
        req.ctx.db.query<{ contact_masked: string; role: string }>(
          `SELECT contact_masked, role FROM users WHERE status = 'active' ORDER BY created_at LIMIT 10`,
        ),
        req.ctx.db.query<{ name: string; slug: string; verified: boolean }>(
          'SELECT name, slug, verified FROM organizations ORDER BY created_at LIMIT 5',
        ),
      ]);

      res.json({
        webUrl: req.ctx.config.webUrl,
        stickers: stickers.rows,
        users: users.rows,
        organizations: orgs.rows,
        note: 'Sign-in codes are returned by /v1/auth/otp/request while OTP echo is on.',
      });
    }),
  );

  return router;
}
