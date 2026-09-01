import { Router } from 'express';
import { z } from 'zod';
import {
  createOrgInviteSchema,
  createOrgLocationSchema,
  createOrganizationSchema,
} from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { requireAuth, touchLastSeen } from '../middleware/auth.js';
import { badRequest } from '../errors.js';

const orgIdSchema = z.string().uuid();

function requireOrgId(value: string | undefined): string {
  const parsed = orgIdSchema.safeParse(value);
  if (!parsed.success) throw badRequest('invalid_id', 'That organization id is not valid.');
  return parsed.data;
}

const windowSchema = z.coerce.number().int().min(1).max(365).default(30);

export function organizationRoutes(): Router {
  const router = Router();
  router.use(requireAuth(), touchLastSeen());

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ organizations: await req.ctx.organizations.listForUser(req.user!.id) });
    }),
  );

  router.post(
    '/',
    validateBody(createOrganizationSchema),
    asyncHandler(async (req, res) => {
      const organization = await req.ctx.organizations.create(req.user!.id, req.body, req.ipHash);
      res.status(201).json({
        organization,
        // Verification is a manual trust decision, not a self-service toggle:
        // a verified name appears on notifications sent to strangers.
        notice: 'Your organization is pending verification before its name appears on alerts.',
      });
    }),
  );

  router.get(
    '/:organizationId',
    asyncHandler(async (req, res) => {
      const organizationId = requireOrgId(req.params.organizationId);
      const role = await req.ctx.organizations.requireMembership(organizationId, req.user!.id);
      const [organizations, members, locations] = await Promise.all([
        req.ctx.organizations.listForUser(req.user!.id),
        req.ctx.organizations.listMembers(organizationId),
        req.ctx.organizations.listLocations(organizationId),
      ]);
      res.json({
        organization: organizations.find((o) => o.id === organizationId) ?? null,
        role,
        members,
        locations,
      });
    }),
  );

  router.get(
    '/:organizationId/metrics',
    asyncHandler(async (req, res) => {
      const organizationId = requireOrgId(req.params.organizationId);
      await req.ctx.organizations.requireMembership(organizationId, req.user!.id);
      const windowDays = windowSchema.parse(req.query.windowDays ?? 30);
      const [metrics, byDay, categories] = await Promise.all([
        req.ctx.metrics.compute(windowDays, organizationId),
        req.ctx.metrics.alertsByDay(windowDays, organizationId),
        req.ctx.metrics.categoryBreakdown(windowDays, organizationId),
      ]);
      res.json({ metrics, alertsByDay: byDay, categories });
    }),
  );

  router.get(
    '/:organizationId/locations',
    asyncHandler(async (req, res) => {
      const organizationId = requireOrgId(req.params.organizationId);
      await req.ctx.organizations.requireMembership(organizationId, req.user!.id);
      res.json({ locations: await req.ctx.organizations.listLocations(organizationId) });
    }),
  );

  router.post(
    '/:organizationId/locations',
    validateBody(createOrgLocationSchema),
    asyncHandler(async (req, res) => {
      const organizationId = requireOrgId(req.params.organizationId);
      await req.ctx.organizations.requireMembership(organizationId, req.user!.id, 'admin');
      const location = await req.ctx.organizations.createLocation(organizationId, req.body.label);
      res.status(201).json({ location });
    }),
  );

  router.get(
    '/:organizationId/invites',
    asyncHandler(async (req, res) => {
      const organizationId = requireOrgId(req.params.organizationId);
      await req.ctx.organizations.requireMembership(organizationId, req.user!.id, 'admin');
      res.json({ invites: await req.ctx.organizations.listInvites(organizationId) });
    }),
  );

  router.post(
    '/:organizationId/invites',
    validateBody(createOrgInviteSchema),
    asyncHandler(async (req, res) => {
      const organizationId = requireOrgId(req.params.organizationId);
      await req.ctx.organizations.requireMembership(organizationId, req.user!.id, 'admin');
      const invite = await req.ctx.organizations.createInvite(organizationId, req.user!.id, req.body);
      res.status(201).json({
        invite,
        // Deep link for the QR-code onboarding path in the pilot playbook.
        joinUrl: `${req.ctx.config.publicUrl}/join/${invite.code}`,
      });
    }),
  );

  return router;
}
