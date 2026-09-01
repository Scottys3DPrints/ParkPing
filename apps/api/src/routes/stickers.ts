import { Router } from 'express';
import { z } from 'zod';
import { claimStickerSchema, updateStickerSchema } from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { optionalAuth, requireAuth, touchLastSeen } from '../middleware/auth.js';
import { badRequest } from '../errors.js';

const idSchema = z.string().uuid();

function requireStickerId(value: string | undefined): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw badRequest('invalid_id', 'That sticker id is not valid.');
  return parsed.data;
}

export function stickerRoutes(): Router {
  const router = Router();

  /**
   * What a scanner sees. Public on purpose — this is the first thing that
   * happens when a stranger points a camera at a windscreen, and requiring a
   * session before we can even say "yes, this car is reachable" would defeat
   * the point of the sticker.
   */
  router.get(
    '/:code',
    optionalAuth(),
    asyncHandler(async (req, res) => {
      const scan = await req.ctx.stickers.scan(req.params.code ?? '', req.user?.id ?? null);
      res.json({ sticker: scan });
    }),
  );

  router.post(
    '/claim',
    requireAuth(),
    touchLastSeen(),
    validateBody(claimStickerSchema),
    asyncHandler(async (req, res) => {
      const sticker = await req.ctx.stickers.claim(
        req.user!.id,
        req.body.code,
        req.body.label ?? null,
        req.ipHash,
      );
      res.status(201).json({ sticker });
    }),
  );

  router.get(
    '/',
    requireAuth(),
    asyncHandler(async (req, res) => {
      res.json({ stickers: await req.ctx.stickers.listForUser(req.user!.id) });
    }),
  );

  router.patch(
    '/:stickerId',
    requireAuth(),
    validateBody(updateStickerSchema),
    asyncHandler(async (req, res) => {
      const sticker = await req.ctx.stickers.update(req.user!.id, requireStickerId(req.params.stickerId), {
        label: req.body.label ?? null,
        ...(req.body.status ? { status: req.body.status } : {}),
      });
      res.json({ sticker });
    }),
  );

  /** Releases a sticker so a new owner can claim it — selling the car. */
  router.delete(
    '/:stickerId',
    requireAuth(),
    asyncHandler(async (req, res) => {
      await req.ctx.stickers.release(req.user!.id, requireStickerId(req.params.stickerId), req.ipHash);
      res.status(204).end();
    }),
  );

  return router;
}
