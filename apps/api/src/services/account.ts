import { randomBytes } from 'node:crypto';
import { ANALYTICS_EVENTS, type NotificationPreferences } from '@parkping/shared';
import type { Db } from '../db/index.js';
import { notFound } from '../errors.js';
import type { AnalyticsService } from './analytics.js';
import type { AuditService } from './audit.js';
import type { AlertService } from './alerts.js';
import type { AuthService, UserRow } from './auth.js';
import type { VehicleService } from './vehicles.js';

export interface AccountExport {
  exportedAt: string;
  account: {
    id: string;
    contact: string | null;
    contactChannel: string;
    locale: string;
    createdAt: string;
    consentVersion: string | null;
  };
  notificationPreferences: NotificationPreferences;
  vehicles: unknown[];
  alertsSent: unknown[];
  alertsReceived: unknown[];
  organizations: unknown[];
}

/**
 * Consent, data export and deletion (project document §9 "Retention", §13
 * "Users can revoke consent, delete a vehicle and request account deletion").
 */
export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly vehicles: VehicleService,
    private readonly alerts: AlertService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  async updateNotificationPreferences(
    userId: string,
    prefs: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const { rowCount } = await this.db.query(
      `UPDATE users
          SET quiet_hours_enabled = $2, quiet_hours_start = $3, quiet_hours_end = $4,
              timezone = $5, updated_at = now()
        WHERE id = $1 AND status = 'active'`,
      [userId, prefs.quietHoursEnabled, prefs.quietHoursStart, prefs.quietHoursEnd, prefs.timezone],
    );
    if (rowCount === 0) throw notFound('Account not found.');
    return prefs;
  }

  async setLocale(userId: string, locale: 'en' | 'de'): Promise<void> {
    await this.db.query('UPDATE users SET locale = $2, updated_at = now() WHERE id = $1', [userId, locale]);
  }

  async acceptConsent(userId: string, version: string): Promise<void> {
    await this.db.query(
      'UPDATE users SET consent_version = $2, consent_accepted_at = now(), updated_at = now() WHERE id = $1',
      [userId, version],
    );
    await this.analytics.track(ANALYTICS_EVENTS.consent_accepted, userId, { status: version });
    await this.audit.record({
      actorUserId: userId,
      action: 'consent.accepted',
      subjectType: 'user',
      subjectId: userId,
      metadata: { version },
    });
  }

  /** Everything held about this account, in a portable form (GDPR Art. 20). */
  async export(user: UserRow): Promise<AccountExport> {
    const [vehicles, sent, received, organizations] = await Promise.all([
      this.vehicles.list(user.id),
      this.alerts.listSent({ kind: 'user', user }, 1000),
      this.alerts.listReceived(user.id, 1000),
      this.db
        .query<{ name: string; role: string; joined_at: Date | string }>(
          `SELECT o.name, m.role, m.joined_at
             FROM org_members m JOIN organizations o ON o.id = m.organization_id
            WHERE m.user_id = $1`,
          [user.id],
        )
        .then((r) =>
          r.rows.map((row) => ({
            name: row.name,
            role: row.role,
            joinedAt: new Date(row.joined_at).toISOString(),
          })),
        ),
    ]);

    await this.analytics.track(ANALYTICS_EVENTS.account_export_requested, user.id, {});
    await this.audit.record({
      actorUserId: user.id,
      action: 'account.exported',
      subjectType: 'user',
      subjectId: user.id,
    });

    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        contact: this.auth.decryptContact(user),
        contactChannel: user.contact_channel,
        locale: user.locale,
        createdAt: new Date(user.created_at).toISOString(),
        consentVersion: user.consent_version,
      },
      notificationPreferences: {
        quietHoursEnabled: user.quiet_hours_enabled,
        quietHoursStart: user.quiet_hours_start,
        quietHoursEnd: user.quiet_hours_end,
        timezone: user.timezone,
      },
      vehicles,
      alertsSent: sent,
      alertsReceived: received,
      organizations,
    };
  }

  /**
   * Erasure (GDPR Art. 17), applied immediately rather than queued.
   *
   * What is destroyed: contact details, vehicles and their encrypted plates,
   * devices, sessions, block lists.
   *
   * What survives: alert rows, with every link to this person severed and the
   * plate they were identified by overwritten with an unlinkable random value.
   * The rows remain because they are the denominator of the match-rate KPI and
   * part of the abuse audit trail; after scrubbing they describe an event
   * ("an alert was submitted, it did not route") and no longer a person. The
   * user row itself is kept as a tombstone with no personal data, so audit
   * entries about the deletion still resolve.
   */
  async delete(userId: string, ipHash: string): Promise<void> {
    await this.analytics.track(ANALYTICS_EVENTS.account_deletion_requested, userId, {});

    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE alerts SET reporter_user_id = NULL, reporter_org_id = NULL WHERE reporter_user_id = $1', [
        userId,
      ]);
      // The plate on an alert that targeted this account is *their* plate, so
      // it has to go too. A fresh random index keeps the row unique and
      // permanently unmatchable.
      await tx.query(
        `UPDATE alerts
            SET target_user_id = NULL,
                target_vehicle_id = NULL,
                target_sticker_id = NULL,
                target_plate_index = CASE WHEN target_plate_index IS NULL THEN NULL ELSE $2 END,
                plate_entered_encrypted = ''
          WHERE target_user_id = $1`,
        [userId, `erased:${randomBytes(16).toString('hex')}`],
      );

      // Block lists in both directions: the ones this person created against
      // senders, and the ones others created against them.
      await tx.query(
        `DELETE FROM blocks
          WHERE blocked_key = $1
             OR target_key IN (
               SELECT 'vehicle:' || id FROM vehicles WHERE user_id = $2
               UNION ALL
               SELECT 'sticker:' || id FROM stickers WHERE claimed_by = $2
             )`,
        [`user:${userId}`, userId],
      );

      /*
       * Stickers are physical objects that outlive the account, so they are
       * released rather than destroyed — whoever holds the car can claim the
       * sticker again. Every link to this person is cleared in the process.
       */
      await tx.query(
        `UPDATE stickers
            SET claimed_by = NULL, vehicle_id = NULL, label = NULL,
                status = 'unclaimed', claimed_at = NULL, updated_at = now()
          WHERE claimed_by = $1`,
        [userId],
      );

      await tx.query('DELETE FROM notification_channels WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM vehicles WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM devices WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM org_members WHERE user_id = $1', [userId]);

      await tx.query(
        `UPDATE users
            SET status = 'deleted',
                contact_hash = NULL,
                contact_encrypted = NULL,
                contact_masked = '',
                consent_version = NULL,
                deleted_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [userId],
      );
    });

    await this.analytics.track(ANALYTICS_EVENTS.account_deleted, null, {});
    await this.audit.record({
      actorUserId: null,
      actorType: 'system',
      action: 'account.deleted',
      subjectType: 'user',
      subjectId: userId,
      ipHash,
    });
  }
}
