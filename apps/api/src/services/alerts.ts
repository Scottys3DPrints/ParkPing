import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_EVENTS,
  INCIDENTS,
  RESPONSES_REQUIRING_REVIEW,
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
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../errors.js';
import { decrypt, encrypt, generateAlertReference, reporterHandle } from '../domain/crypto.js';
import type { AnalyticsService } from './analytics.js';
import type { AuditService } from './audit.js';
import type { PushService } from './push/index.js';
import { POLICIES, type RateLimiter } from './rateLimit.js';
import type { UserRow } from './auth.js';
import type { VehicleService } from './vehicles.js';

/**
 * Internal routing outcome. Never leaves the server.
 *
 * `unroutable` and `routed` must be indistinguishable to the reporter — that
 * distinction is exactly what a plate-enumeration attack is trying to learn.
 */
type AlertStatus = 'routed' | 'unroutable' | 'blocked' | 'suppressed';

export interface SubmitAlertResult {
  /** The reference is the only thing the reporter gets back. */
  reference: string;
  id: string;
}

interface AlertRow {
  id: string;
  reference: string;
  reporter_user_id: string | null;
  reporter_org_id: string | null;
  target_vehicle_id: string | null;
  target_user_id: string | null;
  category: IncidentCategory;
  timeframe: TimeframeRequest | null;
  status: AlertStatus;
  plate_entered_encrypted: string;
  target_country: CountryCode;
  response_code: ResponseCode | null;
  created_at: Date | string;
  responded_at: Date | string | null;
}

export class AlertService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly vehicles: VehicleService,
    private readonly push: PushService,
    private readonly rateLimiter: RateLimiter,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Submit an alert.
   *
   * The contract with the caller is the important part: **this method returns
   * the same shape whether or not the plate is registered.** Every branch that
   * could distinguish the two — no vehicle, blocked by the recipient,
   * suppressed for flooding — ends at the same neutral return. The only
   * exceptions are failures caused purely by the *reporter's own* behaviour
   * (malformed plate, their own rate limits), which reveal nothing about a
   * third party.
   */
  async submit(reporter: UserRow, input: SubmitAlertInput, ipHash: string): Promise<SubmitAlertResult> {
    let normalized;
    try {
      normalized = normalizePlate(input.plate, input.country);
    } catch (error) {
      if (error instanceof PlateNormalizationError) throw badRequest('invalid_plate', error.message);
      throw error;
    }

    const incident = INCIDENTS[input.category];
    if (input.timeframe && !incident.allowsTimeframe) {
      throw badRequest(
        'timeframe_not_allowed',
        'A timeframe can only be attached when someone is actually blocked.',
      );
    }

    if (reporter.throttled_until && new Date(reporter.throttled_until).getTime() > Date.now()) {
      const retryAfter = Math.ceil((new Date(reporter.throttled_until).getTime() - Date.now()) / 1000);
      throw tooManyRequests('Your account is temporarily limited after a review.', retryAfter, 'account_throttled');
    }

    const plateIndex = this.vehicles.plateIndexFor(input.country, normalized.normalized);
    const pairSubject = `${reporter.id}:${plateIndex}`;

    // --- Limits about the reporter themselves: safe to report back. ---------
    for (const [policy, subject, message] of [
      [POLICIES.alertsPerIpHour, ipHash, 'Too many alerts from this connection. Try again later.'],
      [POLICIES.alertsPerReporterHour, reporter.id, 'You have sent a lot of alerts in the last hour.'],
      [POLICIES.alertsPerReporterDay, reporter.id, 'You have reached the daily limit for alerts.'],
      [
        POLICIES.alertsPerPairCooldown,
        pairSubject,
        'You already alerted this vehicle a moment ago. Give the driver time to react.',
      ],
      [POLICIES.alertsPerPairDay, pairSubject, 'You have alerted this vehicle several times today.'],
    ] as const) {
      const result = await this.rateLimiter.check(policy, subject);
      if (!result.allowed) {
        await this.analytics.track(ANALYTICS_EVENTS.alert_blocked_by_rate_limit, reporter.id, {
          limitName: policy.name,
          category: input.category,
        });
        throw tooManyRequests(message, result.retryAfter);
      }
    }

    const locationId = await this.resolveLocation(reporter.id, input.locationId ?? null);

    // --- Silent controls: revealing these would leak third-party facts. -----
    let suppressedReason: string | null = null;

    if (await this.looksLikeEnumeration(reporter.id)) {
      suppressedReason = 'enumeration_suspected';
      await this.flagEnumeration(reporter.id, ipHash);
    }

    if (suppressedReason === null) {
      const targetLimit = await this.rateLimiter.check(POLICIES.alertsPerTargetHour, plateIndex);
      if (!targetLimit.allowed) suppressedReason = 'target_flooded';
    }

    // --- Routing -----------------------------------------------------------
    const vehicle = await this.vehicles.findRoutable(input.country, plateIndex);
    let status: AlertStatus = suppressedReason ? 'suppressed' : vehicle ? 'routed' : 'unroutable';

    if (status === 'routed' && vehicle && (await this.isBlocked(vehicle.id, reporter.id))) {
      status = 'blocked';
      await this.analytics.track(ANALYTICS_EVENTS.alert_blocked_by_block_list, reporter.id, {
        category: input.category,
      });
    }

    const reporterOrgId = await this.reportingOrganizationFor(reporter.id, locationId);

    const id = randomUUID();
    const reference = generateAlertReference();
    await this.db.query(
      `INSERT INTO alerts
         (id, reference, reporter_user_id, reporter_org_id, location_id, target_country,
          target_plate_index, target_vehicle_id, target_user_id, category, timeframe, status,
          plate_entered_encrypted, routed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               CASE WHEN $12 = 'routed' THEN now() ELSE NULL END)`,
      [
        id,
        reference,
        reporter.id,
        reporterOrgId,
        locationId,
        input.country,
        plateIndex,
        status === 'routed' ? vehicle?.id ?? null : null,
        status === 'routed' ? vehicle?.userId ?? null : null,
        input.category,
        input.timeframe ?? null,
        status,
        encrypt(this.config.secrets.plateEncryptionKey, normalized.normalized),
      ],
    );

    // Consume the reporter's own quotas now that the alert is recorded.
    await Promise.all([
      this.rateLimiter.hit(POLICIES.alertsPerIpHour, ipHash),
      this.rateLimiter.hit(POLICIES.alertsPerReporterHour, reporter.id),
      this.rateLimiter.hit(POLICIES.alertsPerReporterDay, reporter.id),
      this.rateLimiter.hit(POLICIES.alertsPerPairCooldown, pairSubject),
      this.rateLimiter.hit(POLICIES.alertsPerPairDay, pairSubject),
      this.rateLimiter.hit(POLICIES.alertsPerTargetHour, plateIndex),
    ]);

    await this.analytics.track(ANALYTICS_EVENTS.alert_submitted, reporter.id, {
      category: input.category,
      timeframe: input.timeframe ?? null,
      country: input.country,
      kind: incident.kind,
      urgency: incident.urgency,
      organizationId: reporterOrgId,
    });
    await this.analytics.track(
      status === 'routed' ? ANALYTICS_EVENTS.alert_routed : ANALYTICS_EVENTS.alert_unroutable,
      reporter.id,
      { alertId: id, status, reason: suppressedReason },
    );
    await this.audit.record({
      actorUserId: reporter.id,
      action: 'alert.submitted',
      subjectType: 'alert',
      subjectId: id,
      ipHash,
      metadata: { status, category: input.category, country: input.country, suppressedReason },
    });

    if (status === 'routed' && vehicle) {
      const organizationName = reporterOrgId ? await this.organizationName(reporterOrgId) : null;
      await this.push.sendAlert(
        {
          alertId: id,
          reference,
          recipientUserId: vehicle.userId,
          vehicleId: vehicle.id,
          category: input.category,
          timeframe: input.timeframe ?? null,
          locationLabel: locationId ? await this.locationLabel(locationId) : null,
          organizationName,
        },
        await this.vehicles.labelForNotification(vehicle.id),
      );
    }

    return { reference, id };
  }

  /**
   * A reporter working through a list of plates looks different from one
   * reporting a real incident: many *distinct* targets in a short window. The
   * legitimate ceiling is low — even a parking attendant deals with a handful
   * of vehicles a day — so this threshold can sit well under normal use.
   */
  private async looksLikeEnumeration(reporterId: string): Promise<boolean> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await this.db.query<{ distinct_targets: string }>(
      `SELECT count(DISTINCT target_plate_index)::text AS distinct_targets
         FROM alerts WHERE reporter_user_id = $1 AND created_at > $2`,
      [reporterId, since],
    );
    const distinct = Number.parseInt(rows[0]?.distinct_targets ?? '0', 10);
    return distinct >= this.config.alerts.enumerationDistinctPlatesPerDay;
  }

  private async flagEnumeration(reporterId: string, ipHash: string): Promise<void> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM abuse_reports
        WHERE subject_user_id = $1 AND source = 'system' AND reason = 'spam' AND status = 'open'`,
      [reporterId],
    );
    if (existing.rows.length === 0) {
      await this.db.query(
        `INSERT INTO abuse_reports (id, reported_by, subject_user_id, reason, source, status)
         VALUES ($1, NULL, $2, 'spam', 'system', 'open')`,
        [randomUUID(), reporterId],
      );
    }
    await this.analytics.track(ANALYTICS_EVENTS.enumeration_suspected, reporterId, {});
    await this.audit.record({
      actorType: 'system',
      actorUserId: reporterId,
      action: 'abuse.enumeration_suspected',
      subjectType: 'user',
      subjectId: reporterId,
      ipHash,
    });
  }

  private async isBlocked(vehicleId: string, reporterId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM blocks WHERE vehicle_id = $1 AND blocked_user_id = $2',
      [vehicleId, reporterId],
    );
    return rows.length > 0;
  }

  private async resolveLocation(reporterId: string, locationId: string | null): Promise<string | null> {
    if (!locationId) return null;
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT l.id
         FROM org_locations l
         JOIN org_members m ON m.organization_id = l.organization_id
        WHERE l.id = $1 AND m.user_id = $2`,
      [locationId, reporterId],
    );
    if (!rows[0]) throw forbidden('You cannot report from that location.');
    return rows[0].id;
  }

  private async reportingOrganizationFor(reporterId: string, locationId: string | null): Promise<string | null> {
    if (!locationId) return null;
    const { rows } = await this.db.query<{ organization_id: string }>(
      'SELECT organization_id FROM org_locations WHERE id = $1',
      [locationId],
    );
    void reporterId;
    return rows[0]?.organization_id ?? null;
  }

  private async organizationName(organizationId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ name: string; verified: boolean }>(
      'SELECT name, verified FROM organizations WHERE id = $1',
      [organizationId],
    );
    const row = rows[0];
    // Only a verified organization may put its name in front of a recipient;
    // an unverified one could otherwise borrow authority it has not earned.
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

  async listSent(reporterId: string, limit = 50): Promise<SentAlertDto[]> {
    const { rows } = await this.db.query<AlertRow>(
      `SELECT * FROM alerts WHERE reporter_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [reporterId, limit],
    );
    return rows.map((row) => this.toSentDto(row));
  }

  private toSentDto(row: AlertRow): SentAlertDto {
    // Empty when the recipient later deleted their account and the plate was
    // scrubbed (see AccountService.delete). The alert row survives for KPI and
    // audit purposes; the plate does not.
    const plateEntered =
      row.plate_entered_encrypted === ''
        ? '—'
        : formatPlateForDisplay(
            decrypt(this.config.secrets.plateEncryptionKey, row.plate_entered_encrypted),
            row.target_country,
          );
    return {
      id: row.id,
      reference: row.reference,
      category: row.category,
      timeframe: row.timeframe,
      plateEntered,
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
      }
    >(
      `SELECT a.*, ol.label AS location_label, o.name AS organization_name, o.verified AS organization_verified,
              v.label AS vehicle_label, v.plate_encrypted, v.country AS vehicle_country
         FROM alerts a
         LEFT JOIN org_locations ol ON ol.id = a.location_id
         LEFT JOIN organizations o ON o.id = a.reporter_org_id
         LEFT JOIN vehicles v ON v.id = a.target_vehicle_id
        WHERE a.target_user_id = $1 AND a.status = 'routed'
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [userId, limit],
    );

    return rows.map((row) => {
      const vehiclePlate =
        row.plate_encrypted && row.vehicle_country
          ? formatPlateForDisplay(
              decrypt(this.config.secrets.plateEncryptionKey, row.plate_encrypted),
              row.vehicle_country,
            )
          : '—';
      return {
        id: row.id,
        reference: row.reference,
        vehicleId: row.target_vehicle_id ?? '',
        vehiclePlate: row.vehicle_label ?? vehiclePlate,
        category: row.category,
        timeframe: row.timeframe,
        locationLabel: row.location_label,
        reporterHandle: row.reporter_user_id
          ? reporterHandle(this.config.secrets.handlePepper, row.reporter_user_id, row.target_vehicle_id ?? '')
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
     * "Not my vehicle" is the user telling us the routing is wrong. Treating it
     * as just another reply would leave a stranger receiving alerts about a car
     * that is not theirs, so it suspends the claim and opens a review. The
     * plate becomes available to whoever actually holds it.
     */
    if (RESPONSES_REQUIRING_REVIEW.includes(response) && alert.target_vehicle_id) {
      await this.vehicles.setStatus(alert.target_vehicle_id, 'suspended');
      await this.db.query(
        `INSERT INTO abuse_reports (id, reported_by, alert_id, subject_vehicle_id, reason, source, status)
         VALUES ($1, $2, $3, $4, 'wrong_vehicle', 'system', 'open')`,
        [randomUUID(), userId, alertId, alert.target_vehicle_id],
      );
      const vehicleRow = await this.db.query<{ country: CountryCode; plate_index: string }>(
        'SELECT country, plate_index FROM vehicles WHERE id = $1',
        [alert.target_vehicle_id],
      );
      const vehicle = vehicleRow.rows[0];
      if (vehicle) await this.vehicles.promoteNextPendingClaim(vehicle.country, vehicle.plate_index);
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
   * Blocks the sender of a specific alert from reaching that vehicle again.
   *
   * The recipient never learns who they blocked — they act on the pseudonymous
   * handle, and the server resolves it to an account id.
   */
  async blockReporterOfAlert(userId: string, alertId: string, ipHash: string): Promise<void> {
    const { rows } = await this.db.query<{ reporter_user_id: string | null; target_vehicle_id: string | null }>(
      `SELECT reporter_user_id, target_vehicle_id FROM alerts WHERE id = $1 AND target_user_id = $2`,
      [alertId, userId],
    );
    const alert = rows[0];
    if (!alert || !alert.target_vehicle_id) throw notFound('Alert not found.');
    if (!alert.reporter_user_id) return; // Reporter account is already gone.

    await this.db.query(
      `INSERT INTO blocks (id, vehicle_id, blocked_user_id) VALUES ($1, $2, $3)
       ON CONFLICT (vehicle_id, blocked_user_id) DO NOTHING`,
      [randomUUID(), alert.target_vehicle_id, alert.reporter_user_id],
    );

    await this.analytics.track(ANALYTICS_EVENTS.reporter_blocked, userId, { alertId });
    await this.audit.record({
      actorUserId: userId,
      action: 'reporter.blocked',
      subjectType: 'vehicle',
      subjectId: alert.target_vehicle_id,
      ipHash,
    });
  }
}
