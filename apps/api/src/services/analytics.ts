import { randomUUID } from 'node:crypto';
import {
  ALLOWED_ANALYTICS_PROPERTIES,
  type AnalyticsEvent,
  type AnalyticsProperties,
} from '@parkping/shared';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';

const ALLOWED = new Set<string>(ALLOWED_ANALYTICS_PROPERTIES);

/**
 * Product analytics with an allow-list on the way in.
 *
 * The taxonomy in @parkping/shared defines which properties may ever be
 * recorded; anything else is dropped here rather than trusted to call-site
 * discipline. That is what stops a plate or a contact address ending up in the
 * analytics store six months from now when someone adds a debug field.
 */
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  async track(name: AnalyticsEvent, userId: string | null, properties: AnalyticsProperties = {}): Promise<void> {
    const clean: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(properties)) {
      if (ALLOWED.has(key)) clean[key] = value;
      else dropped.push(key);
    }
    if (dropped.length > 0) {
      logger.warn('analytics.property_dropped', { event: name, keys: dropped.join(',') });
    }

    try {
      await this.db.query(
        'INSERT INTO analytics_events (id, name, user_id, properties) VALUES ($1, $2, $3, $4)',
        [randomUUID(), name, userId, JSON.stringify(clean)],
      );
    } catch (error) {
      logger.error('analytics.write_failed', {
        event: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
