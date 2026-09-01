import { randomUUID } from 'node:crypto';
import type {
  CreateOrganizationInput,
  CreateOrgInviteInput,
  OrgInviteDto,
  OrgLocationDto,
  OrgRole,
  OrganizationDto,
  OrganizationMemberDto,
} from '@parkping/shared';
import type { Db } from '../db/index.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { generateInviteCode } from '../domain/crypto.js';
import type { AuditService } from './audit.js';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  verified: boolean;
  plan: 'pilot' | 'small' | 'large' | 'enterprise';
  created_at: Date | string;
}

const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, admin: 2, owner: 3 };

/**
 * B2B organization accounts (project document §4, §5 "should have").
 *
 * An organization is the unit that a pilot is sold to: it owns locations,
 * issues invite codes that pre-verify employee vehicles, and gets a dashboard.
 * It deliberately does *not* get any ability to look up plates or see who
 * owns a vehicle — a property manager has the same blindness as anyone else.
 */
export class OrganizationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private toDto(row: OrganizationRow): OrganizationDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      verified: row.verified,
      plan: row.plan,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async requireMembership(organizationId: string, userId: string, minimumRole: OrgRole = 'viewer'): Promise<OrgRole> {
    const { rows } = await this.db.query<{ role: OrgRole }>(
      'SELECT role FROM org_members WHERE organization_id = $1 AND user_id = $2',
      [organizationId, userId],
    );
    const role = rows[0]?.role;
    if (!role) throw notFound('Organization not found.');
    if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
      throw forbidden('You do not have permission to do that in this organization.');
    }
    return role;
  }

  async listForUser(userId: string): Promise<Array<OrganizationDto & { role: OrgRole }>> {
    const { rows } = await this.db.query<OrganizationRow & { role: OrgRole }>(
      `SELECT o.*, m.role
         FROM organizations o
         JOIN org_members m ON m.organization_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.name`,
      [userId],
    );
    return rows.map((row) => ({ ...this.toDto(row), role: row.role }));
  }

  async create(userId: string, input: CreateOrganizationInput, ipHash: string): Promise<OrganizationDto> {
    const existing = await this.db.query<{ id: string }>('SELECT id FROM organizations WHERE slug = $1', [
      input.slug,
    ]);
    if (existing.rows[0]) throw conflict('slug_taken', 'That organization address is already in use.');

    const id = randomUUID();
    const organization = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<OrganizationRow>(
        'INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) RETURNING *',
        [id, input.name, input.slug],
      );
      await tx.query(`INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        id,
        userId,
      ]);
      const row = rows[0];
      if (!row) throw new Error('Failed to create organization');
      return row;
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'organization.created',
      subjectType: 'organization',
      subjectId: id,
      ipHash,
      metadata: { slug: input.slug },
    });

    return this.toDto(organization);
  }

  async listMembers(organizationId: string): Promise<OrganizationMemberDto[]> {
    const { rows } = await this.db.query<{
      user_id: string;
      contact_masked: string;
      role: OrgRole;
      joined_at: Date | string;
    }>(
      `SELECT m.user_id, u.contact_masked, m.role, m.joined_at
         FROM org_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY m.joined_at`,
      [organizationId],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      contactMasked: row.contact_masked,
      role: row.role,
      joinedAt: new Date(row.joined_at).toISOString(),
    }));
  }

  async listLocations(organizationId: string): Promise<OrgLocationDto[]> {
    const { rows } = await this.db.query<{
      id: string;
      organization_id: string;
      label: string;
      created_at: Date | string;
    }>('SELECT id, organization_id, label, created_at FROM org_locations WHERE organization_id = $1 ORDER BY label', [
      organizationId,
    ]);
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      label: row.label,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async createLocation(organizationId: string, label: string): Promise<OrgLocationDto> {
    const id = randomUUID();
    const { rows } = await this.db.query<{ created_at: Date | string }>(
      'INSERT INTO org_locations (id, organization_id, label) VALUES ($1, $2, $3) RETURNING created_at',
      [id, organizationId, label],
    );
    return {
      id,
      organizationId,
      label,
      createdAt: new Date(rows[0]?.created_at ?? Date.now()).toISOString(),
    };
  }

  /**
   * Invite codes are the pilot onboarding mechanism: a site distributes one
   * code, every employee who redeems it gets a vehicle marked `org_invite`
   * rather than `self_declared`. That is a meaningfully stronger claim — the
   * site vouched for the person — without ParkPing touching a vehicle registry.
   */
  async listInvites(organizationId: string): Promise<OrgInviteDto[]> {
    const { rows } = await this.db.query<{
      id: string;
      organization_id: string;
      code: string;
      max_uses: number;
      used_count: number;
      expires_at: Date | string | null;
      created_at: Date | string;
    }>(
      `SELECT id, organization_id, code, max_uses, used_count, expires_at, created_at
         FROM org_invites WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      code: row.code,
      maxUses: row.max_uses,
      usedCount: row.used_count,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async createInvite(
    organizationId: string,
    userId: string,
    input: CreateOrgInviteInput,
  ): Promise<OrgInviteDto> {
    const id = randomUUID();
    const code = generateInviteCode();
    const expiresAt =
      input.expiresInDays == null
        ? null
        : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const { rows } = await this.db.query<{ created_at: Date | string }>(
      `INSERT INTO org_invites (id, organization_id, code, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
      [id, organizationId, code, input.maxUses, expiresAt, userId],
    );

    await this.audit.record({
      actorUserId: userId,
      action: 'organization.invite_created',
      subjectType: 'organization',
      subjectId: organizationId,
      metadata: { maxUses: input.maxUses },
    });

    return {
      id,
      organizationId,
      code,
      maxUses: input.maxUses,
      usedCount: 0,
      expiresAt,
      createdAt: new Date(rows[0]?.created_at ?? Date.now()).toISOString(),
    };
  }

  async setVerified(organizationId: string, verified: boolean, adminUserId: string): Promise<void> {
    const { rowCount } = await this.db.query('UPDATE organizations SET verified = $2 WHERE id = $1', [
      organizationId,
      verified,
    ]);
    if (rowCount === 0) throw notFound('Organization not found.');
    await this.audit.record({
      actorUserId: adminUserId,
      actorType: 'admin',
      action: verified ? 'organization.verified' : 'organization.unverified',
      subjectType: 'organization',
      subjectId: organizationId,
    });
  }

  async listAll(): Promise<OrganizationDto[]> {
    const { rows } = await this.db.query<OrganizationRow>('SELECT * FROM organizations ORDER BY created_at DESC');
    return rows.map((row) => this.toDto(row));
  }
}
