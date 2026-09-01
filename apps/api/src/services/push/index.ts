import { randomUUID } from 'node:crypto';
import { ANALYTICS_EVENTS, INCIDENTS, TIMEFRAMES, type IncidentCategory, type TimeframeRequest } from '@parkping/shared';
import type { Db } from '../../db/index.js';
import type { Config } from '../../config.js';
import { logger } from '../../logger.js';
import type { AnalyticsService } from '../analytics.js';
import { ConsolePushProvider, ExpoPushProvider, type PushMessage, type PushProvider } from './provider.js';

export { ConsolePushProvider, ExpoPushProvider } from './provider.js';
export type { PushProvider, PushMessage, PushSendResult } from './provider.js';

export function createPushProvider(config: Config): PushProvider {
  return config.push.provider === 'expo'
    ? new ExpoPushProvider(config.push.expoAccessToken)
    : new ConsolePushProvider();
}

interface DeviceRow {
  id: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
}

interface RecipientPreferences {
  locale: 'en' | 'de';
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
}

/** Local wall-clock "HH:MM" for an instant in a given IANA timezone. */
function localTime(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    // An unknown timezone must not silence a notification.
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  }
}

export function isWithinQuietHours(at: Date, prefs: RecipientPreferences): boolean {
  if (!prefs.quietHoursEnabled) return false;
  const now = localTime(at, prefs.timezone);
  const { quietHoursStart: start, quietHoursEnd: end } = prefs;
  // A window like 22:00–07:00 wraps midnight; 13:00–14:00 does not.
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Next instant at which quiet hours end, in UTC.
 *
 * Walks forward in 5-minute steps and asks the same predicate that decided to
 * defer. Using one predicate for both decisions means DST transitions and
 * midnight-wrapping windows cannot make the two disagree and strand a
 * notification. The 48-hour bound is a safety net, not an expected path.
 */
export function quietHoursEnd(at: Date, prefs: RecipientPreferences): Date {
  const stepMs = 5 * 60 * 1000;
  const maxSteps = (48 * 60) / 5;
  const candidate = new Date(at.getTime());
  for (let step = 0; step < maxSteps; step += 1) {
    candidate.setTime(candidate.getTime() + stepMs);
    if (!isWithinQuietHours(candidate, prefs)) return candidate;
  }
  return new Date(at.getTime() + 8 * 60 * 60 * 1000);
}

export interface AlertPushInput {
  alertId: string;
  reference: string;
  recipientUserId: string;
  vehicleId: string;
  category: IncidentCategory;
  timeframe: TimeframeRequest | null;
  locationLabel: string | null;
  organizationName: string | null;
}

/**
 * Turns a routed alert into push deliveries.
 *
 * Two properties matter here:
 *  - The notification body never contains the reporter's identity, and never
 *    contains the plate. It says what happened and which of the user's vehicles
 *    it concerns, which is all they need to decide whether to walk outside.
 *  - Blocking incidents always go out immediately. Quiet hours only ever defer
 *    courtesy-level notifications ("lights left on"), because deferring
 *    "you are blocking an ambulance bay" would defeat the product.
 */
export class PushService {
  constructor(
    private readonly db: Db,
    private readonly provider: PushProvider,
    private readonly analytics: AnalyticsService,
    /**
     * Resolves the short label shown in the notification title. Injected
     * because plates are stored encrypted and only the vehicle service holds
     * the key — the push layer must not be able to read them.
     */
    private readonly resolveVehicleLabel: (vehicleId: string) => Promise<string>,
  ) {}

  private buildMessage(input: AlertPushInput, device: DeviceRow, prefs: RecipientPreferences, vehicleLabel: string): PushMessage {
    const incident = INCIDENTS[input.category];
    const locale = prefs.locale;
    const lines = [incident.pushBody[locale]];
    if (input.timeframe) lines.push(TIMEFRAMES[input.timeframe][locale]);
    if (input.locationLabel) {
      lines.push(locale === 'de' ? `Ort: ${input.locationLabel}` : `Location: ${input.locationLabel}`);
    }
    if (input.organizationName) {
      lines.push(
        locale === 'de'
          ? `Gemeldet über ${input.organizationName}`
          : `Reported via ${input.organizationName}`,
      );
    }

    return {
      token: device.token,
      platform: device.platform,
      title: `ParkPing · ${vehicleLabel}`,
      body: lines.join(' '),
      data: {
        type: 'alert',
        alertId: input.alertId,
        reference: input.reference,
        category: input.category,
        vehicleId: input.vehicleId,
      },
      priority: incident.urgency >= 2 ? 'high' : 'normal',
    };
  }

  private async loadRecipient(userId: string): Promise<RecipientPreferences | null> {
    const { rows } = await this.db.query<{
      locale: 'en' | 'de';
      quiet_hours_enabled: boolean;
      quiet_hours_start: string;
      quiet_hours_end: string;
      timezone: string;
    }>(
      `SELECT locale, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone
         FROM users WHERE id = $1 AND status = 'active'`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      locale: row.locale,
      quietHoursEnabled: row.quiet_hours_enabled,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      timezone: row.timezone,
    };
  }

  private async loadDevices(userId: string): Promise<DeviceRow[]> {
    const { rows } = await this.db.query<DeviceRow>(
      'SELECT id, token, platform FROM devices WHERE user_id = $1 AND active ORDER BY updated_at DESC',
      [userId],
    );
    return rows;
  }

  async sendAlert(input: AlertPushInput, vehicleLabel: string): Promise<{ dispatched: number; deferred: number }> {
    const prefs = await this.loadRecipient(input.recipientUserId);
    if (!prefs) return { dispatched: 0, deferred: 0 };

    const devices = await this.loadDevices(input.recipientUserId);
    if (devices.length === 0) {
      // Recorded so "registered but never reachable" shows up in delivery-rate
      // reporting instead of silently inflating it.
      await this.db.query(
        `INSERT INTO push_deliveries (id, alert_id, device_id, provider, status, error)
         VALUES ($1, $2, NULL, $3, 'failed', 'no_active_device')`,
        [randomUUID(), input.alertId, this.provider.name],
      );
      await this.analytics.track(ANALYTICS_EVENTS.push_failed, input.recipientUserId, {
        alertId: input.alertId,
        reason: 'no_active_device',
      });
      return { dispatched: 0, deferred: 0 };
    }

    const incident = INCIDENTS[input.category];
    const deferrable = incident.kind === 'courtesy' && incident.urgency <= 1;
    if (deferrable && isWithinQuietHours(new Date(), prefs)) {
      const dueAt = quietHoursEnd(new Date(), prefs);
      for (const device of devices) {
        await this.db.query(
          `INSERT INTO push_deliveries (id, alert_id, device_id, provider, status, scheduled_at)
           VALUES ($1, $2, $3, $4, 'deferred', $5)`,
          [randomUUID(), input.alertId, device.id, this.provider.name, dueAt.toISOString()],
        );
      }
      return { dispatched: 0, deferred: devices.length };
    }

    return { dispatched: await this.dispatch(input, devices, prefs, vehicleLabel), deferred: 0 };
  }

  private async dispatch(
    input: AlertPushInput,
    devices: DeviceRow[],
    prefs: RecipientPreferences,
    vehicleLabel: string,
  ): Promise<number> {
    const messages = devices.map((device) => this.buildMessage(input, device, prefs, vehicleLabel));
    const deliveryIds = new Map<string, string>();
    for (const device of devices) {
      const id = randomUUID();
      deliveryIds.set(device.token, id);
      await this.db.query(
        `INSERT INTO push_deliveries (id, alert_id, device_id, provider, status, dispatched_at)
         VALUES ($1, $2, $3, $4, 'pending', now())`,
        [id, input.alertId, device.id, this.provider.name],
      );
    }

    await this.analytics.track(ANALYTICS_EVENTS.push_dispatched, input.recipientUserId, {
      alertId: input.alertId,
      category: input.category,
      count: devices.length,
    });

    const results = await this.provider.send(messages);
    let delivered = 0;
    for (const result of results) {
      const deliveryId = deliveryIds.get(result.token);
      if (!deliveryId) continue;
      if (result.ok) {
        delivered += 1;
        await this.db.query(
          `UPDATE push_deliveries SET status = 'sent', delivered_at = now() WHERE id = $1`,
          [deliveryId],
        );
      } else {
        await this.db.query(`UPDATE push_deliveries SET status = 'failed', error = $2 WHERE id = $1`, [
          deliveryId,
          result.error?.slice(0, 500) ?? 'unknown',
        ]);
        if (result.tokenInvalid) {
          await this.db.query(
            `UPDATE devices SET active = false, updated_at = now()
              WHERE id = (SELECT device_id FROM push_deliveries WHERE id = $1)`,
            [deliveryId],
          );
        }
        logger.warn('push.delivery_failed', { alertId: input.alertId, error: result.error });
      }
    }

    await this.analytics.track(
      delivered > 0 ? ANALYTICS_EVENTS.push_delivered : ANALYTICS_EVENTS.push_failed,
      input.recipientUserId,
      { alertId: input.alertId, count: delivered },
    );

    return delivered;
  }

  /**
   * Sends deferred courtesy notifications whose quiet-hours window has ended.
   * Called by the scheduler; safe to call concurrently because each row is
   * claimed with a conditional update before it is sent.
   */
  async flushDeferred(limit = 200): Promise<number> {
    const { rows } = await this.db.query<{
      id: string;
      alert_id: string;
      device_id: string | null;
      token: string | null;
      platform: 'ios' | 'android' | 'web' | null;
      user_id: string | null;
      reference: string;
      category: IncidentCategory;
      timeframe: TimeframeRequest | null;
      vehicle_id: string | null;
      location_label: string | null;
      organization_name: string | null;
    }>(
      `SELECT pd.id, pd.alert_id, pd.device_id, d.token, d.platform,
              a.target_user_id AS user_id, a.reference, a.category, a.timeframe,
              a.target_vehicle_id AS vehicle_id,
              ol.label AS location_label, o.name AS organization_name
         FROM push_deliveries pd
         JOIN alerts a ON a.id = pd.alert_id
         LEFT JOIN devices d ON d.id = pd.device_id AND d.active
         LEFT JOIN org_locations ol ON ol.id = a.location_id
         LEFT JOIN organizations o ON o.id = a.reporter_org_id
        WHERE pd.status = 'deferred' AND pd.scheduled_at <= now()
        ORDER BY pd.scheduled_at
        LIMIT $1`,
      [limit],
    );

    let sent = 0;
    for (const row of rows) {
      const claimed = await this.db.query(
        `UPDATE push_deliveries SET status = 'pending', dispatched_at = now()
          WHERE id = $1 AND status = 'deferred'`,
        [row.id],
      );
      if (claimed.rowCount === 0) continue;

      if (!row.token || !row.platform || !row.user_id || !row.vehicle_id) {
        await this.db.query(`UPDATE push_deliveries SET status = 'failed', error = $2 WHERE id = $1`, [
          row.id,
          'device_or_alert_unavailable',
        ]);
        continue;
      }

      const prefs = await this.loadRecipient(row.user_id);
      if (!prefs) {
        await this.db.query(`UPDATE push_deliveries SET status = 'failed', error = $2 WHERE id = $1`, [
          row.id,
          'recipient_unavailable',
        ]);
        continue;
      }

      const message = this.buildMessage(
        {
          alertId: row.alert_id,
          reference: row.reference,
          recipientUserId: row.user_id,
          vehicleId: row.vehicle_id,
          category: row.category,
          timeframe: row.timeframe,
          locationLabel: row.location_label,
          organizationName: row.organization_name,
        },
        { id: row.device_id ?? '', token: row.token, platform: row.platform },
        prefs,
        await this.resolveVehicleLabel(row.vehicle_id),
      );

      const [result] = await this.provider.send([message]);
      if (result?.ok) {
        sent += 1;
        await this.db.query(
          `UPDATE push_deliveries SET status = 'sent', delivered_at = now() WHERE id = $1`,
          [row.id],
        );
      } else {
        await this.db.query(`UPDATE push_deliveries SET status = 'failed', error = $2 WHERE id = $1`, [
          row.id,
          result?.error?.slice(0, 500) ?? 'unknown',
        ]);
      }
    }
    return sent;
  }
}
