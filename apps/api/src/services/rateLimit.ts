import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowSeconds: number;
  /**
   * `loud` limits reject with 429 and tell the caller. Correct when the limit
   * describes the caller's own behaviour.
   *
   * `silent` limits must never be revealed, because knowing you hit one tells
   * you something about a *third party* — chiefly that a given plate is
   * receiving alerts from other people. Callers of a silent limit are expected
   * to keep returning the neutral success response.
   */
  visibility: 'loud' | 'silent';
}

/**
 * Rate-limit policy for the MVP (project document §9, §14).
 *
 * These numbers are a starting point to be tuned against pilot data — the
 * document lists "What exact cooldown/rate-limit rules apply" as an open
 * decision. They are centralized here so tuning is a one-file change.
 */
export const POLICIES = {
  /** Sign-in codes to one address. Blunts both spam and SMS pumping. */
  otpRequestPerDestination: {
    name: 'otp_request_destination',
    limit: 5,
    windowSeconds: 60 * 60,
    visibility: 'loud',
  },
  otpRequestPerIp: { name: 'otp_request_ip', limit: 20, windowSeconds: 60 * 60, visibility: 'loud' },
  otpVerifyPerDestination: {
    name: 'otp_verify_destination',
    limit: 10,
    windowSeconds: 60 * 60,
    visibility: 'loud',
  },

  /** A reporter's own volume. Safe to disclose: it is about them. */
  alertsPerReporterHour: {
    name: 'alert_reporter_hour',
    limit: 10,
    windowSeconds: 60 * 60,
    visibility: 'loud',
  },
  alertsPerReporterDay: {
    name: 'alert_reporter_day',
    limit: 30,
    windowSeconds: 24 * 60 * 60,
    visibility: 'loud',
  },
  /** Cooldown before the same reporter may ping the same plate again. */
  alertsPerPairCooldown: {
    name: 'alert_pair_cooldown',
    limit: 1,
    windowSeconds: 15 * 60,
    visibility: 'loud',
  },
  alertsPerPairDay: { name: 'alert_pair_day', limit: 3, windowSeconds: 24 * 60 * 60, visibility: 'loud' },

  /**
   * Total alerts a single plate may receive from everyone. Prevents a crowd
   * piling onto one vehicle. Silent: telling the reporter would confirm that
   * other people are alerting that plate, which is not theirs to know.
   */
  alertsPerTargetHour: {
    name: 'alert_target_hour',
    limit: 12,
    windowSeconds: 60 * 60,
    visibility: 'silent',
  },

  alertsPerIpHour: { name: 'alert_ip_hour', limit: 20, windowSeconds: 60 * 60, visibility: 'loud' },
} as const satisfies Record<string, RateLimitPolicy>;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests already counted in the window, excluding the current one. */
  used: number;
  limit: number;
  /** Seconds until the oldest hit in the window falls out of it. */
  retryAfter: number;
}

/**
 * Fixed-window-per-event counter backed by the database.
 *
 * Every accepted request writes one row; a check counts rows inside the
 * window. This is a sliding window rather than a fixed bucket, so a caller
 * cannot burst across a bucket boundary. Rows are purged by the retention job.
 *
 * Database-backed rather than in-memory on purpose: the limits below are the
 * abuse controls the MVP acceptance criteria depend on, and an in-memory
 * counter would reset on every deploy and would not hold across replicas.
 */
export class RateLimiter {
  constructor(private readonly db: Db) {}

  private bucketKey(policy: RateLimitPolicy, subject: string): string {
    return `${policy.name}:${subject}`;
  }

  async check(policy: RateLimitPolicy, subject: string): Promise<RateLimitResult> {
    const bucket = this.bucketKey(policy, subject);
    const since = new Date(Date.now() - policy.windowSeconds * 1000);
    const { rows } = await this.db.query<{ used: string; oldest: Date | string | null }>(
      `SELECT count(*)::text AS used, min(created_at) AS oldest
         FROM rate_limit_hits
        WHERE bucket = $1 AND created_at > $2`,
      [bucket, since.toISOString()],
    );

    const used = Number.parseInt(rows[0]?.used ?? '0', 10);
    const oldestRaw = rows[0]?.oldest ?? null;
    const oldest = oldestRaw === null ? null : new Date(oldestRaw);
    const retryAfter =
      oldest === null
        ? policy.windowSeconds
        : Math.max(1, Math.ceil((oldest.getTime() + policy.windowSeconds * 1000 - Date.now()) / 1000));

    return { allowed: used < policy.limit, used, limit: policy.limit, retryAfter };
  }

  /** Record one use. Call only for requests that were actually served. */
  async hit(policy: RateLimitPolicy, subject: string): Promise<void> {
    await this.db.query('INSERT INTO rate_limit_hits (id, bucket) VALUES ($1, $2)', [
      randomUUID(),
      this.bucketKey(policy, subject),
    ]);
  }

  /** Check and, if allowed, immediately consume. */
  async consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitResult> {
    const result = await this.check(policy, subject);
    if (result.allowed) await this.hit(policy, subject);
    return result;
  }
}
