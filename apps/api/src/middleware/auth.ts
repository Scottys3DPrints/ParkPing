import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../errors.js';
import type { GuestRow, UserRow } from '../services/auth.js';

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves the caller into either a full account or an anonymous guest.
 *
 * The row is re-read on every request rather than trusted from the token, so a
 * suspension, a block or a deletion takes effect immediately instead of
 * lingering until the current access token expires.
 */
async function resolveCaller(req: Request): Promise<void> {
  const token = bearerToken(req);
  if (!token) return;

  const claims = req.ctx.auth.verifyAccessToken(token);

  if (claims.role === 'guest') {
    const guest = await req.ctx.auth.loadGuest(claims.sub);
    if (!guest) throw unauthorized();
    if (guest.blocked_at) throw forbidden('This device has been blocked. Contact support.');
    req.guest = guest;
    return;
  }

  const { rows } = await req.ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [claims.sub]);
  const user = rows[0];
  if (!user || user.status === 'deleted') throw unauthorized();
  if (user.status === 'suspended') throw forbidden('This account is suspended. Contact support.');
  req.user = user;
}

/** Requires a full account. Guests are rejected. */
export function requireAuth() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await resolveCaller(req);
      if (!req.user) throw unauthorized();
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Accepts an account or a guest, and requires one of them.
 *
 * Used by the alert endpoint, which then decides per path: a sticker code may
 * come from a guest, a plate may not.
 */
export function requireAccountOrGuest() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await resolveCaller(req);
      if (!req.user && !req.guest) throw unauthorized('Start a session before reporting.');
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Attaches a caller when one is present, but never rejects. */
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await resolveCaller(req);
    } catch {
      // An expired or malformed token on a public endpoint is not an error;
      // the caller is simply treated as anonymous.
    }
    next();
  };
}

export function requirePlatformAdmin() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.user?.role !== 'platform_admin') {
      next(forbidden('Platform administrator access required.'));
      return;
    }
    next();
  };
}

/**
 * Records liveness for the retention KPI. Fire-and-forget: a failed write here
 * must never fail the request it is measuring.
 */
export function touchLastSeen() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.user) {
      void req.ctx.db
        .query('UPDATE users SET last_seen_at = now() WHERE id = $1', [req.user.id])
        .catch(() => undefined);
    }
    next();
  };
}

export type { GuestRow };
