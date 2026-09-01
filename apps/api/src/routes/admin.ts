import { Router } from 'express';
import { z } from 'zod';
import { resolveAbuseReportSchema } from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { requireAuth, requirePlatformAdmin } from '../middleware/auth.js';
import { badRequest } from '../errors.js';

const idSchema = z.string().uuid();
const windowSchema = z.coerce.number().int().min(1).max(365).default(30);
const queueStatusSchema = z.enum(['open', 'reviewing', 'actioned', 'dismissed', 'all']).default('open');

function requireId(value: string | undefined, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw badRequest('invalid_id', `That ${label} id is not valid.`);
  return parsed.data;
}

/**
 * Platform administration (project document §4 "Platform administrator").
 *
 * Note what is absent: there is no endpoint that resolves a plate to an
 * account, for admins or anyone else. Moderation works on alert and report
 * ids, so even an internal console cannot be turned into the owner-lookup
 * database the product promises not to be.
 */
export function adminRoutes(): Router {
  const router = Router();
  router.use(requireAuth(), requirePlatformAdmin());

  router.get(
    '/metrics',
    asyncHandler(async (req, res) => {
      const windowDays = windowSchema.parse(req.query.windowDays ?? 30);
      const [metrics, byDay, categories] = await Promise.all([
        req.ctx.metrics.compute(windowDays),
        req.ctx.metrics.alertsByDay(windowDays),
        req.ctx.metrics.categoryBreakdown(windowDays),
      ]);
      res.json({ metrics, alertsByDay: byDay, categories });
    }),
  );

  router.get(
    '/abuse-reports',
    asyncHandler(async (req, res) => {
      const status = queueStatusSchema.parse(req.query.status ?? 'open');
      res.json({ reports: await req.ctx.abuse.queue(status) });
    }),
  );

  router.post(
    '/abuse-reports/:reportId/resolve',
    validateBody(resolveAbuseReportSchema),
    asyncHandler(async (req, res) => {
      await req.ctx.abuse.resolve({
        reportId: requireId(req.params.reportId, 'report'),
        adminUserId: req.user!.id,
        status: req.body.status,
        action: req.body.action,
      });
      res.status(204).end();
    }),
  );

  router.get(
    '/vehicles/contested',
    asyncHandler(async (req, res) => {
      res.json({ vehicles: await req.ctx.abuse.contestedVehicles() });
    }),
  );

  /** Approve a contested claim: activate this one, park the incumbent. */
  router.post(
    '/vehicles/:vehicleId/approve-claim',
    asyncHandler(async (req, res) => {
      const vehicleId = requireId(req.params.vehicleId, 'vehicle');
      const { rows } = await req.ctx.db.query<{ country: string; plate_index: string }>(
        'SELECT country, plate_index FROM vehicles WHERE id = $1',
        [vehicleId],
      );
      const vehicle = rows[0];
      if (!vehicle) throw badRequest('not_found', 'Vehicle not found.');

      await req.ctx.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE vehicles SET status = 'suspended', updated_at = now()
            WHERE country = $1 AND plate_index = $2 AND status = 'active'`,
          [vehicle.country, vehicle.plate_index],
        );
        await tx.query(
          `UPDATE vehicles SET status = 'active', verification_method = 'document_review', updated_at = now()
            WHERE id = $1`,
          [vehicleId],
        );
      });

      await req.ctx.audit.record({
        actorUserId: req.user!.id,
        actorType: 'admin',
        action: 'vehicle.claim_approved',
        subjectType: 'vehicle',
        subjectId: vehicleId,
      });
      res.status(204).end();
    }),
  );

  router.get(
    '/organizations',
    asyncHandler(async (req, res) => {
      res.json({ organizations: await req.ctx.organizations.listAll() });
    }),
  );

  router.post(
    '/organizations/:organizationId/verification',
    validateBody(z.object({ verified: z.boolean() })),
    asyncHandler(async (req, res) => {
      await req.ctx.organizations.setVerified(
        requireId(req.params.organizationId, 'organization'),
        req.body.verified,
        req.user!.id,
      );
      res.status(204).end();
    }),
  );

  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit ?? 100);
      const { rows } = await req.ctx.db.query(
        `SELECT id, actor_user_id, actor_type, action, subject_type, subject_id, metadata, created_at
           FROM audit_events ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      res.json({ events: rows });
    }),
  );

  /** Manual trigger for the retention purge, for support and for tests. */
  router.post(
    '/retention/purge',
    asyncHandler(async (req, res) => {
      res.json({ purged: await req.ctx.retention.purge() });
    }),
  );

  return router;
}
