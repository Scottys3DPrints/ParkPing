import { getConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { logger } from '../logger.js';

const config = getConfig();
const db = await createDb(config);
const applied = await runMigrations(db);
logger.info('migrate.done', { applied: applied.length, ids: applied.join(',') || 'none' });
await db.close();
