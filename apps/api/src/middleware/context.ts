import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../context.js';
import type { GuestRow, UserRow } from '../services/auth.js';
import { hashIp } from '../domain/crypto.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: AppContext;
      /** Salted hash of the caller's IP. The raw address is never stored. */
      ipHash: string;
      user?: UserRow;
      /** Set instead of `user` for an anonymous reporter on the sticker path. */
      guest?: GuestRow;
    }
  }
}

/**
 * Attaches the service container and a hashed client IP to every request.
 *
 * IP addresses are personal data under GDPR, and we only ever need them for
 * rate limiting and abuse review — both of which work fine on a keyed hash.
 * Hashing at the edge means no code path further in can log or store the real
 * address by accident.
 */
export function attachContext(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.ctx = ctx;
    const forwarded = req.headers['x-forwarded-for'];
    const firstHop = Array.isArray(forwarded)
      ? forwarded[0]
      : typeof forwarded === 'string'
        ? forwarded.split(',')[0]
        : undefined;
    const ip = (firstHop ?? req.socket.remoteAddress ?? 'unknown').trim();
    req.ipHash = hashIp(ctx.config.secrets.handlePepper, ip);
    next();
  };
}
