import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  localeSchema,
  notificationPreferencesSchema,
  registerDeviceSchema,
  reportAbuseSchema,
} from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { requireAuth, touchLastSeen } from '../middleware/auth.js';
import { toUserDto } from '../services/auth.js';

const deleteConfirmationSchema = z.object({
  /** Typed by the user, so a mis-tapped button cannot erase an account. */
  confirm: z.literal('DELETE'),
});

const consentSchema = z.object({ version: z.string().trim().min(1).max(32) });
const localeBodySchema = z.object({ locale: localeSchema });

export function accountRoutes(): Router {
  const router = Router();
  router.use(requireAuth(), touchLastSeen());

  router.patch(
    '/notification-preferences',
    validateBody(notificationPreferencesSchema),
    asyncHandler(async (req, res) => {
      const prefs = await req.ctx.account.updateNotificationPreferences(req.user!.id, req.body);
      res.json({ notificationPreferences: prefs });
    }),
  );

  router.patch(
    '/locale',
    validateBody(localeBodySchema),
    asyncHandler(async (req, res) => {
      await req.ctx.account.setLocale(req.user!.id, req.body.locale);
      res.status(204).end();
    }),
  );

  router.post(
    '/consent',
    validateBody(consentSchema),
    asyncHandler(async (req, res) => {
      await req.ctx.account.acceptConsent(req.user!.id, req.body.version);
      res.status(204).end();
    }),
  );

  router.get(
    '/export',
    asyncHandler(async (req, res) => {
      const data = await req.ctx.account.export(req.user!);
      res.setHeader('content-disposition', 'attachment; filename="parkping-export.json"');
      res.json(data);
    }),
  );

  router.post(
    '/delete',
    validateBody(deleteConfirmationSchema),
    asyncHandler(async (req, res) => {
      await req.ctx.account.delete(req.user!.id, req.ipHash);
      res.status(204).end();
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ user: toUserDto(req.user!) });
    }),
  );

  // --- Devices ------------------------------------------------------------

  router.post(
    '/devices',
    validateBody(registerDeviceSchema),
    asyncHandler(async (req, res) => {
      // Upsert on (user, installation) so reinstalling the app replaces the
      // old token instead of accumulating dead ones that depress delivery rate.
      await req.ctx.db.query(
        `INSERT INTO devices (id, user_id, installation_id, platform, token, active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (user_id, installation_id)
         DO UPDATE SET token = EXCLUDED.token, platform = EXCLUDED.platform,
                       active = true, updated_at = now()`,
        [randomUUID(), req.user!.id, req.body.installationId, req.body.platform, req.body.token],
      );
      res.status(204).end();
    }),
  );

  router.delete(
    '/devices/:installationId',
    asyncHandler(async (req, res) => {
      await req.ctx.db.query(
        'UPDATE devices SET active = false, updated_at = now() WHERE user_id = $1 AND installation_id = $2',
        [req.user!.id, req.params.installationId],
      );
      res.status(204).end();
    }),
  );

  // --- Abuse --------------------------------------------------------------

  router.post(
    '/abuse-reports',
    validateBody(reportAbuseSchema),
    asyncHandler(async (req, res) => {
      const report = await req.ctx.abuse.report({
        reportedBy: req.user!.id,
        alertId: req.body.alertId ?? null,
        reason: req.body.reason,
        ipHash: req.ipHash,
      });
      res.status(201).json({ report });
    }),
  );

  return router;
}
