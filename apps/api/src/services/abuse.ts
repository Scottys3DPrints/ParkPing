import { randomUUID } from 'node:crypto';
import { ANALYTICS_EVENTS, type AbuseReason, type AbuseReportDto } from '@parkping/shared';
import type { Db } from '../db/index.js';
import { notFound } from '../errors.js';
import type { AnalyticsService } from './analytics.js';
import type { AuditService } from './audit.js';

export type ModerationAction = 'none' | 'throttle_reporter' | 'suspend_reporter' | 'suspend_vehicle';

export interface AbuseQueueItem extends AbuseReportDto {
  source: 'user' | 'system';
  subjectUserId: string | null;
  subjectVehicleId: string | null;
  /** How many alerts the subject sent in the last 24 hours. */
  subjectAlertsLast24h: number;
  /** Distinct plates the subject targeted in the last 24 hours. */
  subjectDistinctTargetsLast24h: number;
}

/** How long a throttled reporter stays limited. */
const THROTTLE_HOURS = 24;

/**
 * Abuse reporting and moderation (project document §5 must-have, §9).
 *
 * Reports arrive from two sources and share one queue: people pressing
 * "report" on an alert, and the system flagging patterns like plate
 * enumeration or a contested plate claim. Reviewers see the same context for
 * both, which is what keeps automated flags from becoming a separate, ignored
 * backlog.
 */
export class AbuseService {
  constructor(
    private readonly db: Db,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  async report(input: {
    reportedBy: string;
    alertId: string | null;
    reason: AbuseReason;
    ipHash: string;
  }): Promise<AbuseReportDto> {
    // Resolve the subject from the alert so a reporting user never has to
    // name — or be able to name — the account they are reporting.
    let subjectUserId: string | null = null;
    let subjectVehicleId: string | null = null;
    if (input.alertId) {
      const { rows } = await this.db.query<{
        reporter_user_id: string | null;
        target_user_id: string | null;
        target_vehicle_id: string | null;
      }>('SELECT reporter_user_id, target_user_id, target_vehicle_id FROM alerts WHERE id = $1', [
        input.alertId,
      ]);
      const alert = rows[0];
      if (!alert) throw notFound('Alert not found.');
      // If the person reporting is the recipient, the subject is the sender,
      // and vice versa.
      subjectUserId =
        alert.target_user_id === input.reportedBy ? alert.reporter_user_id : alert.target_user_id;
      subjectVehicleId = alert.target_vehicle_id;
    }

    const id = randomUUID();
    const { rows } = await this.db.query<{ created_at: Date | string }>(
      `INSERT INTO abuse_reports
         (id, reported_by, alert_id, subject_user_id, subject_vehicle_id, reason, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'user', 'open')
       RETURNING created_at`,
      [id, input.reportedBy, input.alertId, subjectUserId, subjectVehicleId, input.reason],
    );

    await this.analytics.track(ANALYTICS_EVENTS.abuse_reported, input.reportedBy, { reason: input.reason });
    await this.audit.record({
      actorUserId: input.reportedBy,
      action: 'abuse.reported',
      subjectType: 'abuse_report',
      subjectId: id,
      ipHash: input.ipHash,
      metadata: { reason: input.reason },
    });

    return {
      id,
      alertId: input.alertId,
      reason: input.reason,
      status: 'open',
      createdAt: new Date(rows[0]?.created_at ?? Date.now()).toISOString(),
      resolvedAt: null,
    };
  }

  async queue(status: 'open' | 'reviewing' | 'actioned' | 'dismissed' | 'all' = 'open'): Promise<AbuseQueueItem[]> {
    const { rows } = await this.db.query<{
      id: string;
      alert_id: string | null;
      reason: AbuseReason;
      status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
      source: 'user' | 'system';
      subject_user_id: string | null;
      subject_vehicle_id: string | null;
      created_at: Date | string;
      resolved_at: Date | string | null;
      subject_alerts_24h: string | null;
      subject_targets_24h: string | null;
    }>(
      `SELECT r.id, r.alert_id, r.reason, r.status, r.source, r.subject_user_id, r.subject_vehicle_id,
              r.created_at, r.resolved_at,
              (SELECT count(*)::text FROM alerts a
                WHERE a.reporter_user_id = r.subject_user_id
                  AND a.created_at > now() - interval '24 hours')            AS subject_alerts_24h,
              (SELECT count(DISTINCT a.target_plate_index)::text FROM alerts a
                WHERE a.reporter_user_id = r.subject_user_id
                  AND a.created_at > now() - interval '24 hours')            AS subject_targets_24h
         FROM abuse_reports r
        WHERE ($1 = 'all' OR r.status = $1)
        ORDER BY (r.status = 'open') DESC, r.created_at DESC
        LIMIT 200`,
      [status],
    );

    return rows.map((row) => ({
      id: row.id,
      alertId: row.alert_id,
      reason: row.reason,
      status: row.status,
      source: row.source,
      subjectUserId: row.subject_user_id,
      subjectVehicleId: row.subject_vehicle_id,
      subjectAlertsLast24h: Number.parseInt(row.subject_alerts_24h ?? '0', 10) || 0,
      subjectDistinctTargetsLast24h: Number.parseInt(row.subject_targets_24h ?? '0', 10) || 0,
      createdAt: new Date(row.created_at).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    }));
  }

  /**
   * Resolve a report, optionally applying an enforcement action.
   *
   * Enforcement is deliberately reversible and proportionate: a throttle slows
   * a reporter for a day, suspension stops them entirely, and suspending a
   * vehicle stops routing without deleting the user's data. Nothing here
   * deletes anything — deletion is the user's own right, not a punishment.
   */
  async resolve(input: {
    reportId: string;
    adminUserId: string;
    status: 'reviewing' | 'actioned' | 'dismissed';
    action: ModerationAction;
  }): Promise<void> {
    const { rows } = await this.db.query<{ subject_user_id: string | null; subject_vehicle_id: string | null }>(
      'SELECT subject_user_id, subject_vehicle_id FROM abuse_reports WHERE id = $1',
      [input.reportId],
    );
    const report = rows[0];
    if (!report) throw notFound('Report not found.');

    await this.db.query(
      `UPDATE abuse_reports
          SET status = $2,
              resolution_action = $3,
              resolved_by = $4,
              resolved_at = CASE WHEN $2 = 'reviewing' THEN NULL ELSE now() END
        WHERE id = $1`,
      [input.reportId, input.status, input.action, input.adminUserId],
    );

    switch (input.action) {
      case 'throttle_reporter':
        if (report.subject_user_id) {
          await this.db.query(
            `UPDATE users SET throttled_until = now() + ($2 || ' hours')::interval, updated_at = now()
              WHERE id = $1`,
            [report.subject_user_id, String(THROTTLE_HOURS)],
          );
        }
        break;
      case 'suspend_reporter':
        if (report.subject_user_id) {
          await this.db.query(
            `UPDATE users SET status = 'suspended', suspended_reason = 'abuse', updated_at = now()
              WHERE id = $1`,
            [report.subject_user_id],
          );
          await this.db.query(
            'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [report.subject_user_id],
          );
        }
        break;
      case 'suspend_vehicle':
        if (report.subject_vehicle_id) {
          await this.db.query(
            `UPDATE vehicles SET status = 'suspended', updated_at = now() WHERE id = $1`,
            [report.subject_vehicle_id],
          );
        }
        break;
      case 'none':
        break;
    }

    await this.analytics.track(ANALYTICS_EVENTS.moderation_action_taken, input.adminUserId, {
      status: input.status,
      reason: input.action,
    });
    await this.audit.record({
      actorUserId: input.adminUserId,
      actorType: 'admin',
      action: 'abuse.resolved',
      subjectType: 'abuse_report',
      subjectId: input.reportId,
      metadata: { status: input.status, action: input.action },
    });
  }

  /** Contested plate claims awaiting a human decision. */
  async contestedVehicles(): Promise<
    Array<{ vehicleId: string; userId: string; country: string; createdAt: string; competingClaims: number }>
  > {
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      country: string;
      created_at: Date | string;
      competing: string;
    }>(
      `SELECT v.id, v.user_id, v.country, v.created_at,
              (SELECT count(*)::text FROM vehicles o
                WHERE o.country = v.country AND o.plate_index = v.plate_index
                  AND o.status <> 'removed') AS competing
         FROM vehicles v
        WHERE v.status = 'pending'
        ORDER BY v.created_at`,
    );
    return rows.map((row) => ({
      vehicleId: row.id,
      userId: row.user_id,
      country: row.country,
      createdAt: new Date(row.created_at).toISOString(),
      competingClaims: Number.parseInt(row.competing ?? '0', 10) || 0,
    }));
  }
}
