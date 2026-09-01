import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../errors.js';
import type { UserRow } from '../services/auth.js';

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Requires a valid access token and loads the account behind it.
 *
 * The user row is re-read on every request rather than trusted from the token,
 * so a suspension or deletion takes effect immediately instead of lingering
 * until the current access token expires.
 */
export function requireAuth() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = bearerToken(req);
      if (!token) throw unauthorized();

      const claims = req.ctx.auth.verifyAccessToken(token);
      const { rows } = await req.ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [claims.sub]);
      const user = rows[0];
      if (!user || user.status === 'deleted') throw unauthorized();
      if (user.status === 'suspended') throw forbidden('This account is suspended. Contact support.');

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
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
