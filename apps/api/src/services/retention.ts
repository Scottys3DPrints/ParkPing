import { ANALYTICS_EVENTS } from '@parkping/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';
import type { AnalyticsService } from './analytics.js';

export interface PurgeSummary {
  alerts: number;
  auditEvents: number;
  analyticsEvents: number;
  rateLimitHits: number;
  otpCodes: number;
  refreshTokens: number;
}

/**
 * Retention enforcement (project document §9: "Define retention windows for
 * alerts and audit events").
 *
 * Windows are configuration, not constants in code, because the right values
 * are a legal question the document defers to counsel. The defaults are 90
 * days for alerts and 180 for audit — long enough to investigate a complaint
 * raised weeks later, short enough that the store is not a standing archive of
 * who was parked where.
 */
export class RetentionService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly analytics: AnalyticsService,
  ) {}

  private cutoff(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  async purge(): Promise<PurgeSummary> {
    const { retention } = this.config;

    // Alerts cascade to push_deliveries; the FK handles that.
    const alerts = await this.db.query('DELETE FROM alerts WHERE created_at < $1', [
      this.cutoff(retention.alertDays),
    ]);
    const auditEvents = await this.db.query('DELETE FROM audit_events WHERE created_at < $1', [
      this.cutoff(retention.auditDays),
    ]);
    const analyticsEvents = await this.db.query('DELETE FROM analytics_events WHERE created_at < $1', [
      this.cutoff(retention.analyticsDays),
    ]);
    const rateLimitHits = await this.db.query('DELETE FROM rate_limit_hits WHERE created_at < $1', [
      new Date(Date.now() - retention.rateLimitHours * 60 * 60 * 1000).toISOString(),
    ]);
    // Consumed or expired codes have no further purpose.
    const otpCodes = await this.db.query(
      'DELETE FROM otp_codes WHERE expires_at < now() - interval \'1 day\' OR consumed_at < now() - interval \'1 day\'',
    );
    const refreshTokens = await this.db.query(
      'DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at < now() - interval \'30 days\'',
    );

    const summary: PurgeSummary = {
      alerts: alerts.rowCount,
      auditEvents: auditEvents.rowCount,
      analyticsEvents: analyticsEvents.rowCount,
      rateLimitHits: rateLimitHits.rowCount,
      otpCodes: otpCodes.rowCount,
      refreshTokens: refreshTokens.rowCount,
    };

    logger.info('retention.purge_completed', { ...summary });
    await this.analytics.track(ANALYTICS_EVENTS.retention_purge_completed, null, {
      count: summary.alerts + summary.auditEvents + summary.analyticsEvents,
    });

    return summary;
  }
}
