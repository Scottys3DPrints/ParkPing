import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { ANALYTICS_EVENTS, type UserDto } from '@parkping/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { badRequest, tooManyRequests, unauthorized } from '../errors.js';
import { logger } from '../logger.js';
import {
  blindIndex,
  decrypt,
  encrypt,
  generateOpaqueToken,
  generateOtpCode,
  hashSecret,
  maskContact,
  safeEqual,
} from '../domain/crypto.js';
import type { AnalyticsService } from './analytics.js';
import type { AuditService } from './audit.js';
import { POLICIES, type RateLimiter } from './rateLimit.js';

export interface AccessTokenClaims {
  sub: string;
  role: 'user' | 'platform_admin';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface UserRow {
  id: string;
  role: 'user' | 'platform_admin';
  status: 'active' | 'suspended' | 'deleted';
  contact_channel: 'email' | 'phone';
  contact_encrypted: string | null;
  contact_masked: string;
  locale: 'en' | 'de';
  consent_version: string | null;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
  throttled_until: Date | string | null;
  created_at: Date | string;
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    role: row.role,
    contactMasked: row.contact_masked,
    contactChannel: row.contact_channel,
    locale: row.locale,
    createdAt: new Date(row.created_at).toISOString(),
    consentVersion: row.consent_version,
    notificationPreferences: {
      quietHoursEnabled: row.quiet_hours_enabled,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      timezone: row.timezone,
    },
  };
}

/** How a one-time code reaches the user. Console in dev; SMS/email in production. */
export interface OtpDeliveryChannel {
  deliver(input: { channel: 'email' | 'phone'; destination: string; code: string; locale: 'en' | 'de' }): Promise<void>;
}

export class ConsoleOtpDelivery implements OtpDeliveryChannel {
  async deliver(input: { channel: 'email' | 'phone'; destination: string; code: string }): Promise<void> {
    logger.info('otp.console_delivery', {
      channel: input.channel,
      // The destination is deliberately masked even in development logs.
      destination: maskContact(input.channel, input.destination),
      code: input.code,
    });
  }
}

/**
 * Passwordless authentication over a one-time code (project document §8:
 * "Email/phone OTP or passkeys — strong verification without unnecessary
 * friction").
 *
 * The contact address is never stored in the clear: `contact_hash` is a keyed
 * HMAC used as the lookup key, and `contact_encrypted` is the AES-GCM
 * ciphertext used only when we need to actually send something.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly rateLimiter: RateLimiter,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    private readonly otpDelivery: OtpDeliveryChannel,
  ) {}

  /**
   * Lookup key for an account. Public because seeding and tests need to create
   * accounts that can subsequently sign in through the normal OTP flow.
   */
  contactHash(channel: 'email' | 'phone', destination: string): string {
    return blindIndex(this.config.secrets.handlePepper, `contact:${channel}`, destination.toLowerCase());
  }

  async requestOtp(input: {
    channel: 'email' | 'phone';
    destination: string;
    locale: 'en' | 'de';
    ipHash: string;
  }): Promise<{ devCode?: string }> {
    const perIp = await this.rateLimiter.consume(POLICIES.otpRequestPerIp, input.ipHash);
    if (!perIp.allowed) {
      throw tooManyRequests('Too many sign-in attempts. Try again later.', perIp.retryAfter);
    }

    const contactHash = this.contactHash(input.channel, input.destination);
    const perDestination = await this.rateLimiter.consume(POLICIES.otpRequestPerDestination, contactHash);
    if (!perDestination.allowed) {
      throw tooManyRequests(
        'You have requested several codes recently. Please wait before requesting another.',
        perDestination.retryAfter,
      );
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + this.config.auth.otpTtlSeconds * 1000);

    // Invalidate outstanding codes so only the newest one works. Without this,
    // an attacker who saw an older code keeps a valid window open.
    await this.db.query(
      `UPDATE otp_codes SET consumed_at = now()
        WHERE contact_hash = $1 AND consumed_at IS NULL`,
      [contactHash],
    );
    await this.db.query(
      `INSERT INTO otp_codes (id, contact_hash, channel, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        contactHash,
        input.channel,
        hashSecret(this.config.secrets.plateIndexPepper, code),
        expiresAt.toISOString(),
      ],
    );

    await this.otpDelivery.deliver({
      channel: input.channel,
      destination: input.destination,
      code,
      locale: input.locale,
    });
    await this.analytics.track(ANALYTICS_EVENTS.otp_requested, null, { channel: input.channel });

    return this.config.auth.echoOtp ? { devCode: code } : {};
  }

  async verifyOtp(input: {
    channel: 'email' | 'phone';
    destination: string;
    code: string;
    consentVersion?: string;
    ipHash: string;
  }): Promise<{ user: UserRow; tokens: TokenPair; isNewAccount: boolean }> {
    const contactHash = this.contactHash(input.channel, input.destination);
    const perDestination = await this.rateLimiter.consume(POLICIES.otpVerifyPerDestination, contactHash);
    if (!perDestination.allowed) {
      throw tooManyRequests('Too many attempts. Request a new code.', perDestination.retryAfter);
    }

    const { rows } = await this.db.query<{
      id: string;
      code_hash: string;
      attempts: number;
      expires_at: Date | string;
    }>(
      `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
        WHERE contact_hash = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [contactHash],
    );

    const record = rows[0];
    const invalid = () => {
      void this.analytics.track(ANALYTICS_EVENTS.otp_failed, null, { channel: input.channel });
      // One message for "no code", "wrong code" and "expired code": a specific
      // message would tell an attacker whether the address is registered.
      return badRequest('invalid_code', 'That code is not valid. Request a new one.');
    };

    if (!record) throw invalid();
    if (new Date(record.expires_at).getTime() < Date.now()) throw invalid();
    if (record.attempts >= this.config.auth.otpMaxAttempts) {
      await this.db.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [record.id]);
      throw invalid();
    }

    const expected = hashSecret(this.config.secrets.plateIndexPepper, input.code);
    if (!safeEqual(expected, record.code_hash)) {
      await this.db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [record.id]);
      throw invalid();
    }

    await this.db.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [record.id]);

    const { user, isNewAccount } = await this.findOrCreateUser({
      channel: input.channel,
      destination: input.destination,
      contactHash,
      consentVersion: input.consentVersion ?? null,
    });

    if (user.status === 'suspended') {
      throw unauthorized('This account is suspended. Contact support.');
    }

    const tokens = await this.issueTokens(user);
    await this.db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
    await this.analytics.track(ANALYTICS_EVENTS.otp_verified, user.id, { channel: input.channel });
    await this.audit.record({
      actorUserId: user.id,
      action: isNewAccount ? 'account.created' : 'auth.signed_in',
      subjectType: 'user',
      subjectId: user.id,
      ipHash: input.ipHash,
      metadata: { channel: input.channel },
    });

    return { user, tokens, isNewAccount };
  }

  private async findOrCreateUser(input: {
    channel: 'email' | 'phone';
    destination: string;
    contactHash: string;
    consentVersion: string | null;
  }): Promise<{ user: UserRow; isNewAccount: boolean }> {
    const existing = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE contact_hash = $1 AND status <> 'deleted'`,
      [input.contactHash],
    );
    if (existing.rows[0]) {
      const user = existing.rows[0];
      if (input.consentVersion && input.consentVersion !== user.consent_version) {
        await this.db.query(
          'UPDATE users SET consent_version = $2, consent_accepted_at = now(), updated_at = now() WHERE id = $1',
          [user.id, input.consentVersion],
        );
        user.consent_version = input.consentVersion;
        await this.analytics.track(ANALYTICS_EVENTS.consent_accepted, user.id, {
          status: input.consentVersion,
        });
      }
      return { user, isNewAccount: false };
    }

    const id = randomUUID();
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (id, contact_channel, contact_hash, contact_encrypted, contact_masked,
                          consent_version, consent_accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
       RETURNING *`,
      [
        id,
        input.channel,
        input.contactHash,
        encrypt(this.config.secrets.plateEncryptionKey, input.destination),
        maskContact(input.channel, input.destination),
        input.consentVersion,
      ],
    );

    const user = rows[0];
    if (!user) throw new Error('Failed to create user');
    await this.analytics.track(ANALYTICS_EVENTS.account_created, user.id, { channel: input.channel });
    if (input.consentVersion) {
      await this.analytics.track(ANALYTICS_EVENTS.consent_accepted, user.id, {
        status: input.consentVersion,
      });
    }
    return { user, isNewAccount: true };
  }

  async issueTokens(user: UserRow): Promise<TokenPair> {
    const claims: AccessTokenClaims = { sub: user.id, role: user.role };
    const accessToken = jwt.sign(claims, this.config.secrets.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: this.config.auth.accessTokenTtlSeconds,
      issuer: 'parkping',
      audience: 'parkping-app',
    });

    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.config.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
    await this.db.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [
        randomUUID(),
        user.id,
        hashSecret(this.config.secrets.plateIndexPepper, refreshToken),
        expiresAt.toISOString(),
      ],
    );

    return { accessToken, refreshToken, expiresIn: this.config.auth.accessTokenTtlSeconds };
  }

  /** Rotates the refresh token: the presented one is revoked as it is spent. */
  async refresh(refreshToken: string): Promise<{ user: UserRow; tokens: TokenPair }> {
    const tokenHash = hashSecret(this.config.secrets.plateIndexPepper, refreshToken);
    const { rows } = await this.db.query<{ id: string; user_id: string; expires_at: Date | string; revoked_at: Date | string | null }>(
      'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    const record = rows[0];
    if (!record || record.revoked_at || new Date(record.expires_at).getTime() < Date.now()) {
      throw unauthorized('Your session has expired. Sign in again.');
    }

    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [record.id]);

    const users = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [
      record.user_id,
    ]);
    const user = users.rows[0];
    if (!user) throw unauthorized('Your session has expired. Sign in again.');

    return { user, tokens: await this.issueTokens(user) };
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
      hashSecret(this.config.secrets.plateIndexPepper, refreshToken),
    ]);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ]);
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    try {
      const payload = jwt.verify(token, this.config.secrets.jwtSecret, {
        algorithms: ['HS256'],
        issuer: 'parkping',
        audience: 'parkping-app',
      });
      if (typeof payload === 'string' || !payload.sub) throw new Error('malformed');
      return { sub: payload.sub, role: (payload as { role?: 'user' | 'platform_admin' }).role ?? 'user' };
    } catch {
      throw unauthorized('Your session has expired. Sign in again.');
    }
  }

  /** Decrypts a contact address. Only for delivering notifications to that user. */
  decryptContact(user: UserRow): string | null {
    if (!user.contact_encrypted) return null;
    try {
      return decrypt(this.config.secrets.plateEncryptionKey, user.contact_encrypted);
    } catch {
      logger.error('auth.contact_decrypt_failed', { userId: user.id });
      return null;
    }
  }
}
