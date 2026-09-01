import { Router } from 'express';
import { z } from 'zod';
import { addVehicleSchema } from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { requireAuth, touchLastSeen } from '../middleware/auth.js';
import { badRequest } from '../errors.js';

const vehicleIdSchema = z.string().uuid();

export function vehicleRoutes(): Router {
  const router = Router();
  router.use(requireAuth(), touchLastSeen());

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ vehicles: await req.ctx.vehicles.list(req.user!.id) });
    }),
  );

  router.post(
    '/',
    validateBody(addVehicleSchema),
    asyncHandler(async (req, res) => {
      const vehicle = await req.ctx.vehicles.add(req.user!.id, req.body, req.ipHash);
      res.status(201).json({
        vehicle,
        // The client shows this so a contested claim is never a silent failure.
        notice:
          vehicle.status === 'pending'
            ? 'Another account already registered this plate. We have paused routing for your claim while we review it.'
            : null,
      });
    }),
  );

  router.delete(
    '/:vehicleId',
    asyncHandler(async (req, res) => {
      const parsed = vehicleIdSchema.safeParse(req.params.vehicleId);
      if (!parsed.success) throw badRequest('invalid_id', 'That vehicle id is not valid.');
      await req.ctx.vehicles.remove(req.user!.id, parsed.data, req.ipHash);
      res.status(204).end();
    }),
  );

  return router;
}
