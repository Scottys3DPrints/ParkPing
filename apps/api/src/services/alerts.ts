import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_EVENTS,
  INCIDENTS,
  RESPONSES_REQUIRING_REVIEW,
  formatStickerCode,
  normalizeStickerCode,
  type AlertSource,
  type CountryCode,
  type IncidentCategory,
  type ReceivedAlertDto,
  type ResponseCode,
  type SentAlertDto,
  type SubmitAlertInput,
  type TimeframeRequest,
  PlateNormalizationError,
  formatPlateForDisplay,
  normalizePlate,
} from '@parkping/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests, unauthorized } from '../errors.js';
import { decrypt, encrypt, generateAlertReference, reporterHandle } from '../domain/crypto.js';
import type { AnalyticsService } from './analytics.js';
import type { AuditService } from './audit.js';
import type { NotificationService } from './channels/index.js';
import { POLICIES, type RateLimiter } from './rateLimit.js';
import type { GuestRow, UserRow } from './auth.js';
import type { StickerService } from './stickers.js';
import type { VehicleService } from './vehicles.js';

/**
 * Internal routing outcome. Never leaves the server.
 *
 * `unroutable` and `routed` must be indistinguishable to the reporter — that
 * distinction is exactly what a plate-enumeration attack is trying to learn.
 */
type AlertStatus = 'routed' | 'unroutable' | 'blocked' | 'suppressed';

/** Who is sending. A guest may only ever use the sticker path. */
export type Reporter =
  | { kind: 'user'; user: UserRow }
  | { kind: 'guest'; guest: GuestRow };

export interface SubmitAlertResult {
  reference: string;
  id: string;
}

interface AlertRow {
  id: string;
  reference: string;
  reporter_user_id: string | null;
  reporter_guest_id: string | null;
  reporter_org_id: string | null;
  target_vehicle_id: string | null;
  target_sticker_id: string | null;
  target_user_id: string | null;
  category: IncidentCategory;
  timeframe: TimeframeRequest | null;
  status: AlertStatus;
  plate_entered_encrypted: string;
  target_country: CountryCode | null;
  response_code: ResponseCode | null;
  created_at: Date | string;
  responded_at: Date | string | null;
}

function reporterId(reporter: Reporter): string {
  return reporter.kind === 'user' ? reporter.user.id : reporter.guest.id;
}

/** Opaque composite key used for rate limits, handles and block lists. */
function reporterKey(reporter: Reporter): string {
  return `${reporter.kind}:${reporterId(reporter)}`;
}

function throttledUntil(reporter: Reporter): Date | null {
  const raw = reporter.kind === 'user' ? reporter.user.throttled_until : reporter.guest.throttled_until;
  return raw ? new Date(raw) : null;
}

export class AlertService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly vehicles: VehicleService,
    private readonly stickers: StickerService,
    private readonly notifications: NotificationService,
    private readonly rateLimiter: RateLimiter,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Submit an alert.
   *
   * The contract with the caller is the important part: **this returns the
   * same shape whether or not the target is reachable.** Every branch that
   * could distinguish the two — no vehicle, no claimed sticker, blocked by the
   * recipient, suppressed for flooding — ends at the same neutral return. The
   * only exceptions are failures caused purely by the *reporter's own*
   * behaviour, which reveal nothing about a third party.
   */
  async submit(reporter: Reporter, input: SubmitAlertInput, ipHash: string): Promise<SubmitAlertResult> {
    const incident = INCIDENTS[input.category];
    if (input.timeframe && !incident.allowsTimeframe) {
      throw badRequest(
        'timeframe_not_allowed',
        'A timeframe can only be attached when someone is actually blocked.',
      );
    }

    const throttle = throttledUntil(reporter);
    if (throttle && throttle.getTime() > Date.now()) {
      throw tooManyRequests(
        'Your reporting is temporarily limited after a review.',
        Math.ceil((throttle.getTime() - Date.now()) / 1000),
        'account_throttled',
      );
    }

    const target = await this.resolveTarget(reporter, input);
    const rateKey = reporterKey(reporter);
    const pairSubject = `${rateKey}:${target.pairKey}`;

    // --- Limits about the reporter themselves: safe to report back. ---------
    for (const [policy, subject, message] of [
      [POLICIES.alertsPerIpHour, ipHash, 'Too many alerts from this connection. Try again later.'],
      [POLICIES.alertsPerReporterHour, rateKey, 'You have sent a lot of alerts in the last hour.'],
      [POLICIES.alertsPerReporterDay, rateKey, 'You have reached the daily limit for alerts.'],
      [
        POLICIES.alertsPerPairCooldown,
        pairSubject,
        'You already alerted this vehicle a moment ago. Give the driver time to react.',
      ],
      [POLICIES.alertsPerPairDay, pairSubject, 'You have alerted this vehicle several times today.'],
    ] as const) {
      const result = await this.rateLimiter.check(policy, subject);
      if (!result.allowed) {
        await this.analytics.track(ANALYTICS_EVENTS.alert_blocked_by_rate_limit, target.analyticsActor, {
          limitName: policy.name,
          category: input.category,
        });
        throw tooManyRequests(message, result.retryAfter);
      }
    }

    const locationId = await this.resolveLocation(reporter, input.locationId ?? null);

    // --- Silent controls: revealing these would leak third-party facts. -----
    let suppressedReason: string | null = null;

    // Enumeration only makes sense on the plate path; sticker codes cannot be
    // walked, so a courier scanning twenty stickers a day is legitimate.
    if (target.source === 'plate' && (await this.looksLikeEnumeration(rateKey))) {
      suppressedReason = 'enumeration_suspected';
      await this.flagEnumeration(reporter, ipHash);
    }

    if (suppressedReason === null) {
      const targetLimit = await this.rateLimiter.check(POLICIES.alertsPerTargetHour, target.pairKey);
      if (!targetLimit.allowed) suppressedReason = 'target_flooded';
    }

    // --- Routing -----------------------------------------------------------
    let status: AlertStatus = suppressedReason ? 'suppressed' : target.routable ? 'routed' : 'unroutable';

    if (status === 'routed' && target.routable) {
      const blocked = await this.isBlocked(target.routable.targetKey, rateKey);
      if (blocked) {
        status = 'blocked';
        await this.analytics.track(ANALYTICS_EVENTS.alert_blocked_by_block_list, target.analyticsActor, {
          category: input.category,
        });
      }
    }

    const reporterOrgId = await this.reportingOrganizationFor(locationId);
    const routed = status === 'routed' ? target.routable : null;

    const id = randomUUID();
    const reference = generateAlertReference();
    await this.db.query(
      `INSERT INTO alerts
         (id, reference, reporter_user_id, reporter_guest_id, reporter_org_id, location_id,
          target_country, target_plate_index, target_sticker_id, target_vehicle_id, target_user_id,
          category, timeframe, status, plate_entered_encrypted, routed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               CASE WHEN $14 = 'routed' THEN now() ELSE NULL END)`,
      [
        id,
        reference,
        reporter.kind === 'user' ? reporter.user.id : null,
        reporter.kind === 'guest' ? reporter.guest.id : null,
        reporterOrgId,
        locationId,
        target.country,
        target.plateIndex,
        target.stickerId,
        routed?.vehicleId ?? null,
        routed?.ownerUserId ?? null,
        input.category,
        input.timeframe ?? null,
        status,
        encrypt(this.config.secrets.plateEncryptionKey, target.echo),
      ],
    );

    // Consume the reporter's own quotas now that the alert is recorded.
    await Promise.all([
      this.rateLimiter.hit(POLICIES.alertsPerIpHour, ipHash),
      this.rateLimiter.hit(POLICIES.alertsPerReporterHour, rateKey),
      this.rateLimiter.hit(POLICIES.alertsPerReporterDay, rateKey),
      this.rateLimiter.hit(POLICIES.alertsPerPairCooldown, pairSubject),
      this.rateLimiter.hit(POLICIES.alertsPerPairDay, pairSubject),
      this.rateLimiter.hit(POLICIES.alertsPerTargetHour, target.pairKey),
    ]);

    await this.analytics.track(ANALYTICS_EVENTS.alert_submitted, target.analyticsActor, {
      category: input.category,
      timeframe: input.timeframe ?? null,
      country: target.country,
      kind: incident.kind,
      urgency: incident.urgency,
      source: target.source,
      organizationId: reporterOrgId,
    });
    await this.analytics.track(
      status === 'routed' ? ANALYTICS_EVENTS.alert_routed : ANALYTICS_EVENTS.alert_unroutable,
      target.analyticsActor,
      { alertId: id, status, reason: suppressedReason, source: target.source },
    );
    await this.audit.record({
      actorUserId: reporter.kind === 'user' ? reporter.user.id : null,
      actorType: reporter.kind === 'guest' ? 'system' : 'user',
      action: 'alert.submitted',
      subjectType: 'alert',
      subjectId: id,
      ipHash,
      metadata: { status, category: input.category, source: target.source, suppressedReason },
    });

    if (routed) {
      await this.notifications.deliverAlert({
        alertId: id,
        reference,
        recipientUserId: routed.ownerUserId,
        targetLabel: routed.label,
        category: input.category,
        timeframe: input.timeframe ?? null,
        locationLabel: locationId ? await this.locationLabel(locationId) : null,
        organizationName: reporterOrgId ? await this.organizationName(reporterOrgId) : null,
        vehicleId: routed.vehicleId,
        stickerId: routed.stickerId,
      });
    }

    return { reference, id };
  }

  /**
   * Turns the request into a target, enforcing the identity rule per path:
   * a sticker code may come from anyone, a plate may not.
   */
  private async resolveTarget(
    reporter: Reporter,
    input: SubmitAlertInput,
  ): Promise<{
    source: AlertSource;
    /** Subject for target-scoped rate limits. Opaque. */
    pairKey: string;
    /** Echoed back to the reporter as what they aimed at. */
    echo: string;
    country: CountryCode | null;
    plateIndex: string | null;
    stickerId: string | null;
    analyticsActor: string | null;
    routable: {
      targetKey: string;
      ownerUserId: string;
      vehicleId: string | null;
      stickerId: string | null;
      label: string;
    } | null;
  }> {
    const analyticsActor = reporter.kind === 'user' ? reporter.user.id : null;

    if (input.stickerCode) {
      const code = normalizeStickerCode(input.stickerCode);
      if (!code) throw badRequest('invalid_code', 'That does not look like a sticker code.');

      const sticker = await this.stickers.findRoutable(code);
      /*
       * A code that exists but is unclaimed is told apart from one that never
       * existed, because they mean different things to an honest scanner and
       * neither reveals anything about a person. A stranger learning "this
       * sticker is not set up yet" is the product working correctly.
       */
      if (!sticker && !(await this.stickers.exists(code))) {
        throw notFound('That sticker code does not exist.');
      }

      return {
        source: 'sticker',
        pairKey: `sticker:${code}`,
        echo: code,
        country: null,
        plateIndex: null,
        stickerId: sticker?.id ?? null,
        analyticsActor,
        routable: sticker
          ? {
              targetKey: `sticker:${sticker.id}`,
              ownerUserId: sticker.ownerUserId,
              vehicleId: null,
              stickerId: sticker.id,
              label: sticker.label ?? 'your vehicle',
            }
          : null,
      };
    }

    // Plate path. Enumerable, so it costs an account.
    if (reporter.kind !== 'user') {
      throw unauthorized('Sign in to report by license plate.');
    }

    const country = input.country as CountryCode;
    let normalized;
    try {
      normalized = normalizePlate(input.plate as string, country);
    } catch (error) {
      if (error instanceof PlateNormalizationError) throw badRequest('invalid_plate', error.message);
      throw error;
    }

    const plateIndex = this.vehicles.plateIndexFor(country, normalized.normalized);
    const vehicle = await this.vehicles.findRoutable(country, plateIndex);

    return {
      source: 'plate',
      pairKey: plateIndex,
      echo: normalized.normalized,
      country,
      plateIndex,
      stickerId: null,
      analyticsActor,
      routable: vehicle
        ? {
            targetKey: `vehicle:${vehicle.id}`,
            ownerUserId: vehicle.userId,
            vehicleId: vehicle.id,
            stickerId: null,
            label: await this.vehicles.labelForNotification(vehicle.id),
          }
        : null,
    };
  }

  private async looksLikeEnumeration(rateKey: string): Promise<boolean> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [kind, id] = rateKey.split(':') as ['user' | 'guest', string];
    const column = kind === 'user' ? 'reporter_user_id' : 'reporter_guest_id';
    const { rows } = await this.db.query<{ distinct_targets: string }>(
      `SELECT count(DISTINCT target_plate_index)::text AS distinct_targets
         FROM alerts
        WHERE ${column} = $1 AND target_plate_index IS NOT NULL AND created_at > $2`,
      [id, since],
    );
    const distinct = Number.parseInt(rows[0]?.distinct_targets ?? '0', 10);
    return distinct >= this.config.alerts.enumerationDistinctPlatesPerDay;
  }

  private async flagEnumeration(reporter: Reporter, ipHash: string): Promise<void> {
    const subjectUserId = reporter.kind === 'user' ? reporter.user.id : null;
    if (subjectUserId) {
      const existing = await this.db.query<{ id: string }>(
        `SELECT id FROM abuse_reports
          WHERE subject_user_id = $1 AND source = 'system' AND reason = 'spam' AND status = 'open'`,
        [subjectUserId],
      );
      if (existing.rows.length === 0) {
        await this.db.query(
          `INSERT INTO abuse_reports (id, reported_by, subject_user_id, reason, source, status)
           VALUES ($1, NULL, $2, 'spam', 'system', 'open')`,
          [randomUUID(), subjectUserId],
        );
      }
    }
    await this.analytics.track(ANALYTICS_EVENTS.enumeration_suspected, subjectUserId, {});
    await this.audit.record({
      actorType: 'system',
      actorUserId: subjectUserId,
      action: 'abuse.enumeration_suspected',
      subjectType: reporter.kind === 'user' ? 'user' : 'guest',
      subjectId: reporterId(reporter),
      ipHash,
    });
  }

  private async isBlocked(targetKey: string, blockedKey: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM blocks WHERE target_key = $1 AND blocked_key = $2',
      [targetKey, blockedKey],
    );
    return rows.length > 0;
  }

  private async resolveLocation(reporter: Reporter, locationId: string | null): Promise<string | null> {
    if (!locationId) return null;
    if (reporter.kind !== 'user') throw forbidden('You cannot report from that location.');
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT l.id
         FROM org_locations l
         JOIN org_members m ON m.organization_id = l.organization_id
        WHERE l.id = $1 AND m.user_id = $2`,
      [locationId, reporter.user.id],
    );
    if (!rows[0]) throw forbidden('You cannot report from that location.');
    return rows[0].id;
  }

  private async reportingOrganizationFor(locationId: string | null): Promise<string | null> {
    if (!locationId) return null;
    const { rows } = await this.db.query<{ organization_id: string }>(
      'SELECT organization_id FROM org_locations WHERE id = $1',
      [locationId],
    );
    return rows[0]?.organization_id ?? null;
  }

  private async organizationName(organizationId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ name: string; verified: boolean }>(
      'SELECT name, verified FROM organizations WHERE id = $1',
      [organizationId],
    );
    const row = rows[0];
    // Only a verified organization may put its name in front of a recipient.
    return row?.verified ? row.name : null;
  }

  private async locationLabel(locationId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ label: string }>(
      'SELECT label FROM org_locations WHERE id = $1',
      [locationId],
    );
    return rows[0]?.label ?? null;
  }

  // --- Reading -------------------------------------------------------------

  async listSent(reporter: Reporter, limit = 50): Promise<SentAlertDto[]> {
    const column = reporter.kind === 'user' ? 'reporter_user_id' : 'reporter_guest_id';
    const { rows } = await this.db.query<AlertRow>(
      `SELECT * FROM alerts WHERE ${column} = $1 ORDER BY created_at DESC LIMIT $2`,
      [reporterId(reporter), limit],
    );
    return rows.map((row) => this.toSentDto(row));
  }

  private toSentDto(row: AlertRow): SentAlertDto {
    const source: AlertSource = row.target_sticker_id !== null || row.target_country === null ? 'sticker' : 'plate';
    // Empty when the recipient later deleted their account and the value was
    // scrubbed. The alert row survives for KPI and audit purposes; the plate
    // does not.
    let target = '—';
    if (row.plate_entered_encrypted !== '') {
      const plain = decrypt(this.config.secrets.plateEncryptionKey, row.plate_entered_encrypted);
      target =
        source === 'sticker'
          ? formatStickerCode(plain)
          : formatPlateForDisplay(plain, row.target_country as CountryCode);
    }

    return {
      id: row.id,
      reference: row.reference,
      source,
      category: row.category,
      timeframe: row.timeframe,
      target,
      country: row.target_country,
      // Collapsing four internal states into one is the whole point: the
      // reporter learns nothing beyond "we handled it", unless the recipient
      // chose to answer.
      status: row.response_code ? 'responded' : 'processed',
      response: row.response_code,
      respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async listReceived(userId: string, limit = 50): Promise<ReceivedAlertDto[]> {
    const { rows } = await this.db.query<
      AlertRow & {
        location_label: string | null;
        organization_name: string | null;
        organization_verified: boolean | null;
        vehicle_label: string | null;
        plate_encrypted: string | null;
        vehicle_country: CountryCode | null;
        sticker_label: string | null;
        sticker_code: string | null;
      }
    >(
      `SELECT a.*, ol.label AS location_label, o.name AS organization_name, o.verified AS organization_verified,
              v.label AS vehicle_label, v.plate_encrypted, v.country AS vehicle_country,
              s.label AS sticker_label, s.code AS sticker_code
         FROM alerts a
         LEFT JOIN org_locations ol ON ol.id = a.location_id
         LEFT JOIN organizations o ON o.id = a.reporter_org_id
         LEFT JOIN vehicles v ON v.id = a.target_vehicle_id
         LEFT JOIN stickers s ON s.id = a.target_sticker_id
        WHERE a.target_user_id = $1 AND a.status = 'routed'
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [userId, limit],
    );

    return rows.map((row) => {
      const source: AlertSource = row.target_sticker_id !== null ? 'sticker' : 'plate';
      const targetKey = source === 'sticker' ? `sticker:${row.target_sticker_id}` : `vehicle:${row.target_vehicle_id}`;

      let targetLabel = 'your vehicle';
      if (source === 'sticker') {
        targetLabel = row.sticker_label ?? (row.sticker_code ? formatStickerCode(row.sticker_code) : 'your sticker');
      } else if (row.vehicle_label) {
        targetLabel = row.vehicle_label;
      } else if (row.plate_encrypted && row.vehicle_country) {
        targetLabel = formatPlateForDisplay(
          decrypt(this.config.secrets.plateEncryptionKey, row.plate_encrypted),
          row.vehicle_country,
        );
      }

      const blockedKey = row.reporter_user_id
        ? `user:${row.reporter_user_id}`
        : row.reporter_guest_id
          ? `guest:${row.reporter_guest_id}`
          : null;

      return {
        id: row.id,
        reference: row.reference,
        source,
        stickerId: row.target_sticker_id,
        vehicleId: row.target_vehicle_id,
        targetLabel,
        category: row.category,
        timeframe: row.timeframe,
        locationLabel: row.location_label,
        reporterHandle: blockedKey
          ? reporterHandle(this.config.secrets.handlePepper, blockedKey, targetKey)
          : 'GONE',
        reporterIsVerifiedOrganization: row.organization_verified === true,
        organizationName: row.organization_verified ? row.organization_name : null,
        response: row.response_code,
        respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
      };
    });
  }

  async markOpened(userId: string, alertId: string): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE alerts SET opened_at = COALESCE(opened_at, now())
        WHERE id = $1 AND target_user_id = $2`,
      [alertId, userId],
    );
    if (rowCount > 0) {
      await this.analytics.track(ANALYTICS_EVENTS.alert_opened, userId, { alertId });
    }
  }

  async respond(userId: string, alertId: string, response: ResponseCode, ipHash: string): Promise<void> {
    const { rows } = await this.db.query<AlertRow>(
      `SELECT * FROM alerts WHERE id = $1 AND target_user_id = $2 AND status = 'routed'`,
      [alertId, userId],
    );
    const alert = rows[0];
    if (!alert) throw notFound('Alert not found.');
    if (alert.response_code) throw conflict('already_answered', 'You have already answered this alert.');

    await this.db.query('UPDATE alerts SET response_code = $2, responded_at = now() WHERE id = $1', [
      alertId,
      response,
    ]);

    /*
     * "Not my vehicle" is the user telling us the routing is wrong. On the
     * plate path it suspends the claim and frees the plate. On the sticker
     * path it means the sticker was mis-claimed, so it is disabled rather than
     * silently continuing to deliver someone else's alerts.
     */
    if (RESPONSES_REQUIRING_REVIEW.includes(response)) {
      if (alert.target_vehicle_id) {
        await this.vehicles.setStatus(alert.target_vehicle_id, 'suspended');
        const vehicleRow = await this.db.query<{ country: CountryCode; plate_index: string }>(
          'SELECT country, plate_index FROM vehicles WHERE id = $1',
          [alert.target_vehicle_id],
        );
        const vehicle = vehicleRow.rows[0];
        if (vehicle) await this.vehicles.promoteNextPendingClaim(vehicle.country, vehicle.plate_index);
      }
      if (alert.target_sticker_id) {
        await this.db.query(`UPDATE stickers SET status = 'disabled', updated_at = now() WHERE id = $1`, [
          alert.target_sticker_id,
        ]);
      }
      await this.db.query(
        `INSERT INTO abuse_reports (id, reported_by, alert_id, subject_vehicle_id, reason, source, status)
         VALUES ($1, $2, $3, $4, 'wrong_vehicle', 'system', 'open')`,
        [randomUUID(), userId, alertId, alert.target_vehicle_id],
      );
    }

    await this.analytics.track(ANALYTICS_EVENTS.alert_responded, userId, {
      alertId,
      responseCode: response,
      category: alert.category,
      durationMs: Date.now() - new Date(alert.created_at).getTime(),
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'alert.responded',
      subjectType: 'alert',
      subjectId: alertId,
      ipHash,
      metadata: { responseCode: response },
    });
  }

  /**
   * Blocks the sender of a specific alert from reaching that target again.
   *
   * The recipient never learns who they blocked — they act on the pseudonymous
   * handle, and the server resolves it to an account or a guest.
   */
  async blockReporterOfAlert(userId: string, alertId: string, ipHash: string): Promise<void> {
    const { rows } = await this.db.query<{
      reporter_user_id: string | null;
      reporter_guest_id: string | null;
      target_vehicle_id: string | null;
      target_sticker_id: string | null;
    }>(
      `SELECT reporter_user_id, reporter_guest_id, target_vehicle_id, target_sticker_id
         FROM alerts WHERE id = $1 AND target_user_id = $2`,
      [alertId, userId],
    );
    const alert = rows[0];
    if (!alert) throw notFound('Alert not found.');

    const targetKey = alert.target_sticker_id
      ? `sticker:${alert.target_sticker_id}`
      : alert.target_vehicle_id
        ? `vehicle:${alert.target_vehicle_id}`
        : null;
    const blockedKey = alert.reporter_user_id
      ? `user:${alert.reporter_user_id}`
      : alert.reporter_guest_id
        ? `guest:${alert.reporter_guest_id}`
        : null;

    if (!targetKey || !blockedKey) return; // Sender or target is already gone.

    await this.db.query(
      `INSERT INTO blocks (id, target_key, blocked_key) VALUES ($1, $2, $3)
       ON CONFLICT (target_key, blocked_key) DO NOTHING`,
      [randomUUID(), targetKey, blockedKey],
    );

    await this.analytics.track(ANALYTICS_EVENTS.reporter_blocked, userId, { alertId });
    await this.audit.record({
      actorUserId: userId,
      action: 'reporter.blocked',
      subjectType: 'alert',
      subjectId: alertId,
      ipHash,
    });
  }
}
