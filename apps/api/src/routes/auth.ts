import { Router } from 'express';
import { refreshSchema, requestOtpSchema, verifyOtpSchema } from '@parkping/shared';
import { asyncHandler, validateBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { toUserDto } from '../services/auth.js';

export function authRoutes(): Router {
  const router = Router();

  /**
   * Send a one-time code.
   *
   * Always answers 202, whether or not the address belongs to an existing
   * account — otherwise this endpoint becomes a way to test which addresses
   * are registered.
   */
  router.post(
    '/otp/request',
    validateBody(requestOtpSchema),
    asyncHandler(async (req, res) => {
      const result = await req.ctx.auth.requestOtp({
        channel: req.body.channel,
        destination: req.body.destination,
        locale: req.body.locale,
        ipHash: req.ipHash,
      });
      res.status(202).json({
        status: 'sent',
        expiresInSeconds: req.ctx.config.auth.otpTtlSeconds,
        // Present only when OTP echo is enabled, which production forbids.
        ...(result.devCode ? { devCode: result.devCode } : {}),
      });
    }),
  );

  router.post(
    '/otp/verify',
    validateBody(verifyOtpSchema),
    asyncHandler(async (req, res) => {
      const { user, tokens, isNewAccount } = await req.ctx.auth.verifyOtp({
        channel: req.body.channel,
        destination: req.body.destination,
        code: req.body.code,
        consentVersion: req.body.consentVersion,
        ipHash: req.ipHash,
      });
      res.status(isNewAccount ? 201 : 200).json({
        user: toUserDto(user),
        tokens,
        isNewAccount,
        consentRequired: user.consent_version !== req.ctx.config.consentVersion,
      });
    }),
  );

  router.post(
    '/refresh',
    validateBody(refreshSchema),
    asyncHandler(async (req, res) => {
      const { user, tokens } = await req.ctx.auth.refresh(req.body.refreshToken);
      res.json({ user: toUserDto(user), tokens });
    }),
  );

  router.post(
    '/logout',
    validateBody(refreshSchema),
    asyncHandler(async (req, res) => {
      await req.ctx.auth.revokeRefreshToken(req.body.refreshToken);
      res.status(204).end();
    }),
  );

  /**
   * Starts an anonymous reporter session (project document v0.2 §3.3).
   *
   * Granted freely because it grants almost nothing: a guest may alert a
   * sticker and read their own sent alerts. It exists so that someone standing
   * in front of a blocked driveway never sees a sign-up form.
   */
  router.post(
    '/guest',
    asyncHandler(async (req, res) => {
      const session = await req.ctx.auth.createGuestSession(req.ipHash);
      res.status(201).json({ guest: { id: session.guestId }, tokens: {
        accessToken: session.accessToken,
        expiresIn: session.expiresIn,
      } });
    }),
  );

  router.get(
    '/me',
    requireAuth(),
    asyncHandler(async (req, res) => {
      const user = req.user!;
      res.json({
        user: toUserDto(user),
        consentRequired: user.consent_version !== req.ctx.config.consentVersion,
      });
    }),
  );

  return router;
}
