import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_EVENTS,
  type AddVehicleInput,
  type CountryCode,
  type VehicleDto,
  PlateNormalizationError,
  formatPlateForDisplay,
  normalizePlate,
} from '@parkping/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { blindIndex, decrypt, encrypt } from '../domain/crypto.js';
import type { AnalyticsService } from './analytics.js';
import type { AuditService } from './audit.js';

export interface VehicleRow {
  id: string;
  user_id: string;
  country: CountryCode;
  plate_index: string;
  plate_encrypted: string;
  label: string | null;
  status: 'active' | 'pending' | 'suspended' | 'removed';
  verification_method: 'self_declared' | 'org_invite' | 'document_review';
  organization_id: string | null;
  invite_id: string | null;
  format_ok: boolean;
  created_at: Date | string;
}

export class VehicleService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  /** HMAC of the normalized plate. The only value used to match an alert. */
  plateIndexFor(country: CountryCode, normalized: string): string {
    return blindIndex(this.config.secrets.plateIndexPepper, `plate:${country}`, normalized);
  }

  decryptPlate(row: Pick<VehicleRow, 'plate_encrypted'>): string {
    return decrypt(this.config.secrets.plateEncryptionKey, row.plate_encrypted);
  }

  toDto(row: VehicleRow & { organization_name?: string | null }): VehicleDto {
    const plate = this.decryptPlate(row);
    return {
      id: row.id,
      plate: formatPlateForDisplay(plate, row.country),
      country: row.country,
      label: row.label,
      status: row.status,
      verificationMethod: row.verification_method,
      organizationId: row.organization_id,
      organizationName: row.organization_name ?? null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  /** Short label for a push notification title: the user's own name for the car. */
  async labelForNotification(vehicleId: string): Promise<string> {
    const { rows } = await this.db.query<Pick<VehicleRow, 'label' | 'plate_encrypted' | 'country'>>(
      'SELECT label, plate_encrypted, country FROM vehicles WHERE id = $1',
      [vehicleId],
    );
    const row = rows[0];
    if (!row) return 'your vehicle';
    if (row.label) return row.label;
    try {
      return formatPlateForDisplay(this.decryptPlate(row), row.country);
    } catch {
      return 'your vehicle';
    }
  }

  async list(userId: string): Promise<VehicleDto[]> {
    const { rows } = await this.db.query<VehicleRow & { organization_name: string | null }>(
      `SELECT v.*, o.name AS organization_name
         FROM vehicles v
         LEFT JOIN organizations o ON o.id = v.organization_id
        WHERE v.user_id = $1 AND v.status <> 'removed'
        ORDER BY v.created_at`,
      [userId],
    );
    return rows.map((row) => this.toDto(row));
  }

  async add(userId: string, input: AddVehicleInput, ipHash: string): Promise<VehicleDto> {
    let normalized;
    try {
      normalized = normalizePlate(input.plate, input.country);
    } catch (error) {
      if (error instanceof PlateNormalizationError) {
        await this.analytics.track(ANALYTICS_EVENTS.vehicle_rejected, userId, {
          country: input.country,
          reason: error.reason,
        });
        throw badRequest('invalid_plate', error.message);
      }
      throw error;
    }

    const plateIndex = this.plateIndexFor(input.country, normalized.normalized);

    const duplicateOwn = await this.db.query<{ id: string }>(
      `SELECT id FROM vehicles
        WHERE user_id = $1 AND country = $2 AND plate_index = $3 AND status <> 'removed'`,
      [userId, input.country, plateIndex],
    );
    if (duplicateOwn.rows[0]) {
      throw conflict('vehicle_exists', 'You have already added this vehicle.');
    }

    const invite = input.inviteCode ? await this.redeemableInvite(input.inviteCode) : null;
    if (input.inviteCode && !invite) {
      throw badRequest('invalid_invite', 'That invite code is not valid or has expired.');
    }

    /*
     * Two accounts can genuinely believe they control the same plate: a sold
     * car, a company pool vehicle, a typo. Rather than let the second claim
     * silently take over routing (which would hand a stranger the previous
     * owner's alerts), the first active claim keeps routing and the second is
     * parked as `pending` for review. The claimant is told plainly.
     */
    const existingActive = await this.db.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM vehicles
        WHERE country = $1 AND plate_index = $2 AND status = 'active'`,
      [input.country, plateIndex],
    );
    const contested = existingActive.rows.length > 0;
    const status = contested ? 'pending' : 'active';

    const id = randomUUID();
    const { rows } = await this.db.query<VehicleRow>(
      `INSERT INTO vehicles
         (id, user_id, country, plate_index, plate_encrypted, label, status,
          verification_method, organization_id, invite_id, format_ok)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        userId,
        input.country,
        plateIndex,
        encrypt(this.config.secrets.plateEncryptionKey, normalized.normalized),
        input.label ?? null,
        status,
        invite ? 'org_invite' : 'self_declared',
        invite?.organization_id ?? null,
        invite?.id ?? null,
        normalized.matchesCountryFormat,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('Failed to insert vehicle');

    if (invite) {
      await this.db.query('UPDATE org_invites SET used_count = used_count + 1 WHERE id = $1', [invite.id]);
      await this.analytics.track(ANALYTICS_EVENTS.invite_redeemed, userId, {
        organizationId: invite.organization_id,
      });
    }

    if (contested) {
      await this.db.query(
        `INSERT INTO abuse_reports (id, reported_by, subject_user_id, subject_vehicle_id, reason, source, status)
         VALUES ($1, NULL, $2, $3, 'wrong_vehicle', 'system', 'open')`,
        [randomUUID(), userId, id],
      );
      await this.analytics.track(ANALYTICS_EVENTS.vehicle_contested, userId, { country: input.country });
    }

    await this.analytics.track(ANALYTICS_EVENTS.vehicle_added, userId, {
      country: input.country,
      status,
      verificationMethod: invite ? 'org_invite' : 'self_declared',
      organizationId: invite?.organization_id ?? null,
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'vehicle.added',
      subjectType: 'vehicle',
      subjectId: id,
      ipHash,
      // Never the plate itself: the audit log is read by support staff.
      metadata: { country: input.country, status, formatOk: normalized.matchesCountryFormat },
    });

    return this.toDto(row);
  }

  private async redeemableInvite(code: string): Promise<{ id: string; organization_id: string } | null> {
    const { rows } = await this.db.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id FROM org_invites
        WHERE upper(code) = upper($1)
          AND used_count < max_uses
          AND (expires_at IS NULL OR expires_at > now())`,
      [code],
    );
    return rows[0] ?? null;
  }

  async remove(userId: string, vehicleId: string, ipHash: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string; country: CountryCode; plate_index: string }>(
      `UPDATE vehicles SET status = 'removed', removed_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status <> 'removed'
        RETURNING id, country, plate_index`,
      [vehicleId, userId],
    );
    const removed = rows[0];
    if (!removed) throw notFound('Vehicle not found.');

    // A pending claim on the same plate can now take over routing. Without
    // this, selling a car would leave the new owner permanently unroutable.
    await this.promoteNextPendingClaim(removed.country, removed.plate_index);

    await this.analytics.track(ANALYTICS_EVENTS.vehicle_removed, userId, { country: removed.country });
    await this.audit.record({
      actorUserId: userId,
      action: 'vehicle.removed',
      subjectType: 'vehicle',
      subjectId: vehicleId,
      ipHash,
    });
  }

  async promoteNextPendingClaim(country: CountryCode, plateIndex: string): Promise<void> {
    const stillActive = await this.db.query<{ id: string }>(
      `SELECT id FROM vehicles WHERE country = $1 AND plate_index = $2 AND status = 'active'`,
      [country, plateIndex],
    );
    if (stillActive.rows.length > 0) return;

    await this.db.query(
      `UPDATE vehicles SET status = 'active', updated_at = now()
        WHERE id = (
          SELECT id FROM vehicles
           WHERE country = $1 AND plate_index = $2 AND status = 'pending'
           ORDER BY created_at
           LIMIT 1
        )`,
      [country, plateIndex],
    );
  }

  /** The single routing lookup. Returns null for anything not actively claimed. */
  async findRoutable(
    country: CountryCode,
    plateIndex: string,
  ): Promise<{ id: string; userId: string; organizationId: string | null } | null> {
    const { rows } = await this.db.query<{ id: string; user_id: string; organization_id: string | null }>(
      `SELECT v.id, v.user_id, v.organization_id
         FROM vehicles v
         JOIN users u ON u.id = v.user_id
        WHERE v.country = $1 AND v.plate_index = $2 AND v.status = 'active' AND u.status = 'active'`,
      [country, plateIndex],
    );
    const row = rows[0];
    return row ? { id: row.id, userId: row.user_id, organizationId: row.organization_id } : null;
  }

  async setStatus(vehicleId: string, status: VehicleRow['status']): Promise<void> {
    await this.db.query('UPDATE vehicles SET status = $2, updated_at = now() WHERE id = $1', [
      vehicleId,
      status,
    ]);
  }
}
