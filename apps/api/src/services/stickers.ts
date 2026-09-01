import { randomBytes, randomUUID } from 'node:crypto';
import {
  ANALYTICS_EVENTS,
  STICKER_CODE_LENGTH,
  type StickerDto,
  type StickerScanDto,
  type StickerStatus,
  formatStickerCode,
  normalizeStickerCode,
} from '@parkping/shared';
import type { Db } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { AnalyticsService } from './analytics.js';
import type { AuditService } from './audit.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface StickerRow {
  id: string;
  code: string;
  status: StickerStatus;
  label: string | null;
  organization_id: string | null;
  claimed_by: string | null;
  vehicle_id: string | null;
  claimed_at: Date | string | null;
  created_at: Date | string;
}

/**
 * Sticker issuance, claiming and resolution (project document v0.2 §3.1).
 *
 * The security model is deliberately physical: a code is unguessable, and
 * reading one requires standing at the car. Claiming is therefore first-come
 * among people who can see the sticker, which is the same guarantee the
 * competing products offer and is appropriate for what is at stake — the power
 * gained by falsely claiming a sticker is the power to receive requests to move
 * someone else's car, which surfaces immediately.
 */
export class StickerService {
  constructor(
    private readonly db: Db,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 10 characters from a 32-symbol alphabet: ~10^15 codes. Rejection sampling
   * on a 256-value byte would bias the last symbols, so bytes outside the
   * largest whole multiple of 32 are discarded rather than folded.
   */
  private generateCode(): string {
    let out = '';
    while (out.length < STICKER_CODE_LENGTH) {
      for (const byte of randomBytes(STICKER_CODE_LENGTH)) {
        if (byte >= 256 - (256 % ALPHABET.length)) continue;
        out += ALPHABET[byte % ALPHABET.length];
        if (out.length === STICKER_CODE_LENGTH) break;
      }
    }
    return out;
  }

  toDto(row: StickerRow & { organization_name?: string | null }): StickerDto {
    return {
      id: row.id,
      code: formatStickerCode(row.code),
      status: row.status,
      label: row.label,
      organizationId: row.organization_id,
      organizationName: row.organization_name ?? null,
      vehicleId: row.vehicle_id,
      claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  /** Issues codes, optionally to an organization for pilot distribution. */
  async issueBatch(input: {
    count: number;
    organizationId: string | null;
    label: string | null;
    actorUserId: string | null;
  }): Promise<StickerDto[]> {
    const created: StickerDto[] = [];
    for (let i = 0; i < input.count; i += 1) {
      // A collision is vanishingly unlikely but cheap to survive: retry rather
      // than fail a 500-sticker batch on one unlucky draw.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = this.generateCode();
        try {
          const { rows } = await this.db.query<StickerRow>(
            `INSERT INTO stickers (id, code, organization_id, label)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [randomUUID(), code, input.organizationId, input.label],
          );
          if (rows[0]) created.push(this.toDto(rows[0]));
          break;
        } catch (error) {
          if (attempt === 4) throw error;
        }
      }
    }

    await this.analytics.track(ANALYTICS_EVENTS.sticker_issued, input.actorUserId, {
      count: created.length,
      organizationId: input.organizationId,
    });
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'sticker.batch_issued',
      subjectType: 'organization',
      subjectId: input.organizationId,
      metadata: { count: created.length },
    });

    return created;
  }

  private async findByCode(rawCode: string): Promise<StickerRow | null> {
    const code = normalizeStickerCode(rawCode);
    if (!code) return null;
    const { rows } = await this.db.query<StickerRow>('SELECT * FROM stickers WHERE code = $1', [code]);
    return rows[0] ?? null;
  }

  /**
   * What a scanner sees. Returns 404 for an unknown code rather than a
   * distinguishing error, so the endpoint cannot be used to test codes at scale
   * — though the code space makes that impractical regardless.
   */
  async scan(rawCode: string, viewerUserId: string | null): Promise<StickerScanDto> {
    const sticker = await this.findByCode(rawCode);
    if (!sticker) throw notFound('That sticker code does not exist.');

    let organizationName: string | null = null;
    if (sticker.organization_id) {
      const { rows } = await this.db.query<{ name: string; verified: boolean }>(
        'SELECT name, verified FROM organizations WHERE id = $1',
        [sticker.organization_id],
      );
      // Only a verified organization may put its name in front of a stranger.
      organizationName = rows[0]?.verified ? rows[0].name : null;
    }

    await this.analytics.track(ANALYTICS_EVENTS.sticker_scanned, viewerUserId, {
      status: sticker.status,
    });

    return {
      code: formatStickerCode(sticker.code),
      status: sticker.status,
      label: sticker.label,
      organizationName,
      ownedByViewer: viewerUserId !== null && sticker.claimed_by === viewerUserId,
    };
  }

  /** Resolves a code to a routable owner, or null. Used by the alert pipeline. */
  async findRoutable(
    rawCode: string,
  ): Promise<{ id: string; ownerUserId: string; organizationId: string | null; label: string | null } | null> {
    const code = normalizeStickerCode(rawCode);
    if (!code) return null;
    const { rows } = await this.db.query<{
      id: string;
      claimed_by: string;
      organization_id: string | null;
      label: string | null;
    }>(
      `SELECT s.id, s.claimed_by, s.organization_id, s.label
         FROM stickers s
         JOIN users u ON u.id = s.claimed_by
        WHERE s.code = $1 AND s.status = 'active' AND u.status = 'active'`,
      [code],
    );
    const row = rows[0];
    return row
      ? { id: row.id, ownerUserId: row.claimed_by, organizationId: row.organization_id, label: row.label }
      : null;
  }

  /** Does this code exist at all? Distinguishes "not a sticker" from "not claimed". */
  async exists(rawCode: string): Promise<boolean> {
    return (await this.findByCode(rawCode)) !== null;
  }

  async claim(userId: string, rawCode: string, label: string | null, ipHash: string): Promise<StickerDto> {
    const normalized = normalizeStickerCode(rawCode);
    if (!normalized) throw badRequest('invalid_code', 'That does not look like a sticker code.');

    const sticker = await this.findByCode(normalized);
    if (!sticker) throw notFound('That sticker code does not exist.');

    if (sticker.claimed_by === userId) {
      // Re-scanning your own sticker is the normal way to reach its settings.
      return this.toDto(sticker);
    }
    if (sticker.claimed_by) {
      throw conflict('already_claimed', 'This sticker is already registered to another account.');
    }

    // Conditional update: two people scanning the same fresh sticker at once
    // cannot both win.
    const { rows } = await this.db.query<StickerRow>(
      `UPDATE stickers
          SET claimed_by = $2, label = $3, status = 'active', claimed_at = now(), updated_at = now()
        WHERE id = $1 AND claimed_by IS NULL
        RETURNING *`,
      [sticker.id, userId, label],
    );
    const claimed = rows[0];
    if (!claimed) throw conflict('already_claimed', 'This sticker was just claimed by someone else.');

    await this.analytics.track(ANALYTICS_EVENTS.sticker_claimed, userId, {
      organizationId: claimed.organization_id,
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'sticker.claimed',
      subjectType: 'sticker',
      subjectId: claimed.id,
      ipHash,
    });

    return this.toDto(claimed);
  }

  async listForUser(userId: string): Promise<StickerDto[]> {
    const { rows } = await this.db.query<StickerRow & { organization_name: string | null }>(
      `SELECT s.*, o.name AS organization_name
         FROM stickers s
         LEFT JOIN organizations o ON o.id = s.organization_id
        WHERE s.claimed_by = $1
        ORDER BY s.claimed_at`,
      [userId],
    );
    return rows.map((row) => this.toDto(row));
  }

  async listForOrganization(organizationId: string): Promise<StickerDto[]> {
    const { rows } = await this.db.query<StickerRow>(
      'SELECT * FROM stickers WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1000',
      [organizationId],
    );
    return rows.map((row) => this.toDto(row));
  }

  async update(
    userId: string,
    stickerId: string,
    changes: { label?: string | null; status?: 'active' | 'disabled' },
  ): Promise<StickerDto> {
    const { rows } = await this.db.query<StickerRow>(
      `UPDATE stickers
          SET label = COALESCE($3, label),
              status = COALESCE($4, status),
              updated_at = now()
        WHERE id = $1 AND claimed_by = $2
        RETURNING *`,
      [stickerId, userId, changes.label ?? null, changes.status ?? null],
    );
    const row = rows[0];
    if (!row) throw notFound('Sticker not found.');
    return this.toDto(row);
  }

  /** Releases a sticker so it can be claimed again — selling the car. */
  async release(userId: string, stickerId: string, ipHash: string): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE stickers
          SET claimed_by = NULL, vehicle_id = NULL, label = NULL,
              status = 'unclaimed', claimed_at = NULL, updated_at = now()
        WHERE id = $1 AND claimed_by = $2`,
      [stickerId, userId],
    );
    if (rowCount === 0) throw notFound('Sticker not found.');
    await this.audit.record({
      actorUserId: userId,
      action: 'sticker.released',
      subjectType: 'sticker',
      subjectId: stickerId,
      ipHash,
    });
  }

  async requireOwnership(stickerId: string, userId: string): Promise<StickerRow> {
    const { rows } = await this.db.query<StickerRow>('SELECT * FROM stickers WHERE id = $1', [stickerId]);
    const row = rows[0];
    if (!row) throw notFound('Sticker not found.');
    if (row.claimed_by !== userId) throw forbidden('That sticker belongs to another account.');
    return row;
  }
}
