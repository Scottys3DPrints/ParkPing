import { setTimeout as delay } from 'node:timers/promises';
import { Router } from 'express';
import { z } from 'zod';
import { blockReporterSchema, respondToAlertSchema, submitAlertSchema } from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { requireAuth, touchLastSeen } from '../middleware/auth.js';
import { badRequest } from '../errors.js';

const alertIdSchema = z.string().uuid();

function requireAlertId(value: string | undefined): string {
  const parsed = alertIdSchema.safeParse(value);
  if (!parsed.success) throw badRequest('invalid_id', 'That alert id is not valid.');
  return parsed.data;
}

export function alertRoutes(): Router {
  const router = Router();
  router.use(requireAuth(), touchLastSeen());

  /**
   * Submit an alert.
   *
   * Two things here are load-bearing for the privacy model:
   *
   *  - The response body is identical for every routing outcome. It carries a
   *    reference and nothing else. A registered plate and an unregistered one
   *    produce byte-identical responses.
   *  - The handler is padded to a fixed minimum duration. Without it, the
   *    extra database and push work on a successful route would make routed
   *    alerts measurably slower, and an attacker could time the difference to
   *    learn which plates are in the network — defeating the whole design.
   */
  router.post(
    '/',
    validateBody(submitAlertSchema),
    asyncHandler(async (req, res) => {
      const startedAt = Date.now();
      const result = await req.ctx.alerts.submit(req.user!, req.body, req.ipHash);

      const elapsed = Date.now() - startedAt;
      const floor = req.ctx.config.alerts.minResponseMs;
      if (elapsed < floor) await delay(floor - elapsed);

      res.status(202).json({
        reference: result.reference,
        status: 'processed',
        message:
          'Your report has been processed. If this vehicle is in the ParkPing network, its driver has been notified.',
      });
    }),
  );

  router.get(
    '/sent',
    asyncHandler(async (req, res) => {
      res.json({ alerts: await req.ctx.alerts.listSent(req.user!.id) });
    }),
  );

  router.get(
    '/received',
    asyncHandler(async (req, res) => {
      res.json({ alerts: await req.ctx.alerts.listReceived(req.user!.id) });
    }),
  );

  router.post(
    '/:alertId/opened',
    asyncHandler(async (req, res) => {
      await req.ctx.alerts.markOpened(req.user!.id, requireAlertId(req.params.alertId));
      res.status(204).end();
    }),
  );

  router.post(
    '/:alertId/response',
    validateBody(respondToAlertSchema),
    asyncHandler(async (req, res) => {
      await req.ctx.alerts.respond(
        req.user!.id,
        requireAlertId(req.params.alertId),
        req.body.response,
        req.ipHash,
      );
      res.status(204).end();
    }),
  );

  /** Block the sender of an alert from reaching that vehicle again. */
  router.post(
    '/block',
    validateBody(blockReporterSchema),
    asyncHandler(async (req, res) => {
      await req.ctx.alerts.blockReporterOfAlert(req.user!.id, req.body.alertId, req.ipHash);
      res.status(204).end();
    }),
  );

  return router;
}
