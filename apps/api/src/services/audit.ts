import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'admin';
  action: string;
  subjectType?: string | null;
  subjectId?: string | null;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

/**
 * Append-only record of security-relevant actions (project document §13: "The
 * system logs key events needed for support, abuse review and KPI measurement").
 *
 * Audit writes must never break the request they describe: if the insert fails
 * we log loudly and continue, because failing a legitimate account deletion
 * because its audit row could not be written is the worse outcome.
 */
export class AuditService {
  constructor(private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit_events
           (id, actor_user_id, actor_type, action, subject_type, subject_id, metadata, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          entry.actorUserId ?? null,
          entry.actorType ?? 'user',
          entry.action,
          entry.subjectType ?? null,
          entry.subjectId ?? null,
          JSON.stringify(entry.metadata ?? {}),
          entry.ipHash ?? null,
        ],
      );
    } catch (error) {
      logger.error('audit.write_failed', {
        action: entry.action,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
