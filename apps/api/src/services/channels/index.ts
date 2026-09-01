import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_EVENTS,
  INCIDENTS,
  TIMEFRAMES,
  type AddChannelInput,
  type ChannelKind,
  type IncidentCategory,
  type NotificationChannelDto,
  type TimeframeRequest,
} from '@parkping/shared';
import type { Config } from '../../config.js';
import type { Db } from '../../db/index.js';
import { conflict, notFound } from '../../errors.js';
import { blindIndex, decrypt, encrypt, maskContact } from '../../domain/crypto.js';
import { logger } from '../../logger.js';
import type { AnalyticsService } from '../analytics.js';
import type { PushService } from '../push/index.js';
import {
  DemoTransport,
  EmailTransport,
  SmsTransport,
  WhatsAppTransport,
  type ChannelTransport,
  type OutboundMessage,
} from './transports.js';

export * from './transports.js';

export interface AlertNotification {
  alertId: string;
  reference: string;
  recipientUserId: string;
  /** The owner's own label for what was alerted — plate or sticker name. */
  targetLabel: string;
  category: IncidentCategory;
  timeframe: TimeframeRequest | null;
  locationLabel: string | null;
  organizationName: string | null;
  /** Set on the plate path, so push can deep-link to the vehicle. */
  vehicleId: string | null;
  stickerId: string | null;
}

interface ChannelRow {
  id: string;
  kind: ChannelKind;
  destination_encrypted: string;
  destination_masked: string;
  priority: number;
  verified_at: Date | string | null;
  created_at: Date | string;
}

/**
 * Delivery across every channel an owner has chosen (project document v0.2 §4.3).
 *
 * The ordering rule is deliberate: all configured channels are tried, not just
 * the first. A blocked entrance is time-critical and an owner who registered
 * both WhatsApp and SMS asked to be reachable, not to be reachable once.
 */
export class NotificationService {
  private readonly transports: Map<ChannelKind, ChannelTransport>;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly analytics: AnalyticsService,
    /** Handles the two push kinds, which already have their own machinery. */
    private readonly push: PushService,
    transports?: ChannelTransport[],
  ) {
    const configured =
      transports ??
      [
        new WhatsAppTransport(
          config.channels.whatsappPhoneNumberId,
          config.channels.whatsappAccessToken,
          config.channels.whatsappTemplateName,
          config.channels.whatsappTemplateLocale,
        ),
        new SmsTransport(
          config.channels.twilioAccountSid,
          config.channels.twilioAuthToken,
          config.channels.twilioFromNumber,
        ),
        new EmailTransport(config.channels.emailApiKey, config.channels.emailFromAddress),
      ];

    this.transports = new Map();
    for (const transport of configured) {
      /*
       * An unconfigured transport is replaced by the demo one outside
       * production. That is what lets the whole product be demonstrated end to
       * end without a Meta business account — and it must never happen in
       * production, where silently "delivering" to nobody would be far worse
       * than a visible failure.
       */
      if (!transport.configured && config.env !== 'production') {
        this.transports.set(transport.kind, new DemoTransport(transport.kind));
      } else {
        this.transports.set(transport.kind, transport);
      }
    }
  }

  private destinationHash(kind: ChannelKind, destination: string): string {
    return blindIndex(this.config.secrets.handlePepper, `channel:${kind}`, destination.toLowerCase());
  }

  private toDto(row: ChannelRow): NotificationChannelDto {
    return {
      id: row.id,
      kind: row.kind,
      destinationMasked: row.destination_masked,
      priority: row.priority,
      verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async list(userId: string): Promise<NotificationChannelDto[]> {
    const { rows } = await this.db.query<ChannelRow>(
      `SELECT id, kind, destination_encrypted, destination_masked, priority, verified_at, created_at
         FROM notification_channels
        WHERE user_id = $1 AND active
        ORDER BY priority, created_at`,
      [userId],
    );
    return rows.map((row) => this.toDto(row));
  }

  async add(userId: string, input: AddChannelInput): Promise<NotificationChannelDto> {
    const masked =
      input.kind === 'sms' || input.kind === 'whatsapp'
        ? maskContact('phone', input.destination)
        : input.kind === 'email'
          ? maskContact('email', input.destination)
          : `${input.destination.slice(0, 8)}…`;

    const id = randomUUID();
    try {
      const { rows } = await this.db.query<ChannelRow>(
        `INSERT INTO notification_channels
           (id, user_id, kind, destination_encrypted, destination_hash, destination_masked, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, kind, destination_encrypted, destination_masked, priority, verified_at, created_at`,
        [
          id,
          userId,
          input.kind,
          encrypt(this.config.secrets.plateEncryptionKey, input.destination),
          this.destinationHash(input.kind, input.destination),
          masked,
          input.priority,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('Failed to add channel');
      return this.toDto(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('duplicate') || message.includes('unique')) {
        throw conflict('channel_exists', 'You have already added that.');
      }
      throw error;
    }
  }

  async remove(userId: string, channelId: string): Promise<void> {
    const { rowCount } = await this.db.query(
      'UPDATE notification_channels SET active = false WHERE id = $1 AND user_id = $2',
      [channelId, userId],
    );
    if (rowCount === 0) throw notFound('Channel not found.');
  }

  private buildMessage(input: AlertNotification, locale: 'en' | 'de'): OutboundMessage {
    const incident = INCIDENTS[input.category];
    const lines = [incident.pushBody[locale]];
    if (input.timeframe) lines.push(TIMEFRAMES[input.timeframe][locale]);
    if (input.locationLabel) {
      lines.push(locale === 'de' ? `Ort: ${input.locationLabel}` : `Location: ${input.locationLabel}`);
    }
    if (input.organizationName) {
      lines.push(
        locale === 'de' ? `Gemeldet über ${input.organizationName}` : `Reported via ${input.organizationName}`,
      );
    }

    return {
      title: `ParkPing · ${input.targetLabel}`,
      body: lines.join(' '),
      data: {
        type: 'alert',
        alertId: input.alertId,
        reference: input.reference,
        category: input.category,
      },
      priority: incident.urgency >= 2 ? 'high' : 'normal',
      actionUrl: `${this.config.webUrl}/alerts/${input.alertId}`,
    };
  }

  /**
   * Delivers one alert to its recipient.
   *
   * Push channels are delegated to the existing push machinery, which already
   * handles quiet hours, deferral and token invalidation. Text channels are
   * sent here. If the owner has configured nothing at all, we fall back to any
   * registered device, so an app-only user keeps working.
   */
  async deliverAlert(input: AlertNotification): Promise<{ delivered: number; attempted: number }> {
    const { rows: userRows } = await this.db.query<{ locale: 'en' | 'de' }>(
      `SELECT locale FROM users WHERE id = $1 AND status = 'active'`,
      [input.recipientUserId],
    );
    const locale = userRows[0]?.locale ?? 'en';

    const { rows: channels } = await this.db.query<ChannelRow>(
      `SELECT id, kind, destination_encrypted, destination_masked, priority, verified_at, created_at
         FROM notification_channels
        WHERE user_id = $1 AND active
        ORDER BY priority, created_at`,
      [input.recipientUserId],
    );

    const pushKinds = new Set<ChannelKind>(['expo', 'web_push']);
    const textChannels = channels.filter((c) => !pushKinds.has(c.kind));
    const wantsPush = channels.length === 0 || channels.some((c) => pushKinds.has(c.kind));

    let delivered = 0;
    let attempted = 0;

    if (wantsPush && input.vehicleId !== null) {
      // The existing device path, unchanged — quiet hours and deferral included.
      const result = await this.push.sendAlert(
        {
          alertId: input.alertId,
          reference: input.reference,
          recipientUserId: input.recipientUserId,
          vehicleId: input.vehicleId,
          category: input.category,
          timeframe: input.timeframe,
          locationLabel: input.locationLabel,
          organizationName: input.organizationName,
        },
        input.targetLabel,
      );
      delivered += result.dispatched;
      attempted += result.dispatched + result.deferred;
    }

    const message = this.buildMessage(input, locale);

    for (const channel of textChannels) {
      const transport = this.transports.get(channel.kind);
      if (!transport) continue;
      attempted += 1;

      let destination: string;
      try {
        destination = decrypt(this.config.secrets.plateEncryptionKey, channel.destination_encrypted);
      } catch {
        logger.error('channel.destination_decrypt_failed', { channelId: channel.id });
        continue;
      }

      const deliveryId = randomUUID();
      await this.db.query(
        `INSERT INTO push_deliveries (id, alert_id, device_id, channel_id, provider, status, dispatched_at)
         VALUES ($1, $2, NULL, $3, $4, 'pending', now())`,
        [deliveryId, input.alertId, channel.id, channel.kind],
      );

      const result = await transport.send(destination, message);
      if (result.ok) {
        delivered += 1;
        await this.db.query(
          `UPDATE push_deliveries SET status = 'sent', delivered_at = now(), preview = $2 WHERE id = $1`,
          [deliveryId, result.preview ?? null],
        );
      } else {
        await this.db.query(`UPDATE push_deliveries SET status = 'failed', error = $2 WHERE id = $1`, [
          deliveryId,
          result.error?.slice(0, 500) ?? 'unknown',
        ]);
        if (result.destinationInvalid) {
          await this.db.query('UPDATE notification_channels SET active = false WHERE id = $1', [channel.id]);
        }
        logger.warn('channel.delivery_failed', { kind: channel.kind, error: result.error });
      }
    }

    await this.analytics.track(
      delivered > 0 ? ANALYTICS_EVENTS.push_delivered : ANALYTICS_EVENTS.push_failed,
      input.recipientUserId,
      { alertId: input.alertId, count: delivered, category: input.category },
    );

    return { delivered, attempted };
  }

  /** Demo affordance: the rendered messages a non-production transport produced. */
  async outbox(limit = 50): Promise<
    Array<{
      id: string;
      kind: string;
      status: string;
      preview: string | null;
      reference: string;
      createdAt: string;
    }>
  > {
    const { rows } = await this.db.query<{
      id: string;
      provider: string;
      status: string;
      preview: string | null;
      reference: string;
      created_at: Date | string;
    }>(
      `SELECT d.id, d.provider, d.status, d.preview, a.reference, d.created_at
         FROM push_deliveries d
         JOIN alerts a ON a.id = d.alert_id
        WHERE d.preview IS NOT NULL
        ORDER BY d.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.provider,
      status: row.status,
      preview: row.preview,
      reference: row.reference,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }
}
