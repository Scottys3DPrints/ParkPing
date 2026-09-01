import { setTimeout as delay } from 'node:timers/promises';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { blockReporterSchema, respondToAlertSchema, submitAlertSchema } from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { requireAccountOrGuest, requireAuth, touchLastSeen } from '../middleware/auth.js';
import { badRequest, unauthorized } from '../errors.js';
import type { Reporter } from '../services/alerts.js';

const alertIdSchema = z.string().uuid();

function requireAlertId(value: string | undefined): string {
  const parsed = alertIdSchema.safeParse(value);
  if (!parsed.success) throw badRequest('invalid_id', 'That alert id is not valid.');
  return parsed.data;
}

function reporterFrom(req: Request): Reporter {
  if (req.user) return { kind: 'user', user: req.user };
  if (req.guest) return { kind: 'guest', guest: req.guest };
  throw unauthorized('Start a session before reporting.');
}

export function alertRoutes(): Router {
  const router = Router();

  /**
   * Submit an alert.
   *
   * Three things here are load-bearing for the privacy model:
   *
   *  - The response body is identical for every routing outcome. It carries a
   *    reference and nothing else. A reachable target and an unreachable one
   *    produce byte-identical responses.
   *  - The handler is padded to a fixed minimum duration. Without it, the
   *    extra database and delivery work on a successful route would make
   *    routed alerts measurably slower, and an attacker could time the
   *    difference to learn which plates are in the network.
   *  - A guest may send here, but the service rejects the plate path for them.
   *    Anonymity is safe on the sticker path and unsafe on the plate path, and
   *    that decision lives in one place rather than in the routing table.
   */
  router.post(
    '/',
    requireAccountOrGuest(),
    validateBody(submitAlertSchema),
    asyncHandler(async (req, res) => {
      const startedAt = Date.now();
      const result = await req.ctx.alerts.submit(reporterFrom(req), req.body, req.ipHash);

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

  /** A reporter's own history — works for guests too, so they can see replies. */
  router.get(
    '/sent',
    requireAccountOrGuest(),
    asyncHandler(async (req, res) => {
      res.json({ alerts: await req.ctx.alerts.listSent(reporterFrom(req)) });
    }),
  );

  router.get(
    '/received',
    requireAuth(),
    touchLastSeen(),
    asyncHandler(async (req, res) => {
      res.json({ alerts: await req.ctx.alerts.listReceived(req.user!.id) });
    }),
  );

  router.post(
    '/:alertId/opened',
    requireAuth(),
    asyncHandler(async (req, res) => {
      await req.ctx.alerts.markOpened(req.user!.id, requireAlertId(req.params.alertId));
      res.status(204).end();
    }),
  );

  router.post(
    '/:alertId/response',
    requireAuth(),
    touchLastSeen(),
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

  /** Block the sender of an alert from reaching that vehicle or sticker again. */
  router.post(
    '/block',
    requireAuth(),
    validateBody(blockReporterSchema),
    asyncHandler(async (req, res) => {
      await req.ctx.alerts.blockReporterOfAlert(req.user!.id, req.body.alertId, req.ipHash);
      res.status(204).end();
    }),
  );

  return router;
}
