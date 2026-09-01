import type { Db } from './index.js';
import { MIGRATIONS } from './migrations.js';
import { logger } from '../logger.js';

export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  const newlyApplied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    // Each migration is one transaction: a failure halfway leaves no partial schema.
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    });
    newlyApplied.push(migration.id);
    logger.info('migration.applied', { id: migration.id });
  }

  // Surface the case where the database is ahead of this build, which usually
  // means a rollback deployed an older image against a migrated database.
  const unknown = [...applied].filter((id) => !MIGRATIONS.some((m) => m.id === id));
  if (unknown.length > 0) {
    logger.warn('migration.unknown_applied', { ids: unknown.join(','), count: unknown.length });
  }

  return newlyApplied;
}

/** Test helper: drop everything so a suite can start from a clean schema. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(db);
}
