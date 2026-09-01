import { Router } from 'express';
import {
  ABUSE_REASONS,
  ABUSE_REASON_LABELS,
  INCIDENTS,
  INCIDENT_CATEGORIES,
  PLATE_FORMATS,
  RESPONSES,
  RESPONSE_CODES,
  SUPPORTED_COUNTRIES,
  TIMEFRAMES,
  TIMEFRAME_REQUESTS,
} from '@parkping/shared';
import { asyncHandler } from '../middleware/errors.js';

/**
 * The client's source of truth for every selectable value.
 *
 * Serving the catalog rather than hardcoding it in the app means a category
 * can be withdrawn — which §14 lists as an open legal question — without
 * waiting for an app-store release.
 */
export function metaRoutes(): Router {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({ status: 'ok', environment: req.ctx.config.env });
  });

  router.get(
    '/ready',
    asyncHandler(async (req, res) => {
      try {
        await req.ctx.db.query('SELECT 1');
        res.json({ status: 'ready' });
      } catch {
        res.status(503).json({ status: 'unavailable' });
      }
    }),
  );

  router.get('/catalog', (req, res) => {
    res.json({
      consentVersion: req.ctx.config.consentVersion,
      countries: SUPPORTED_COUNTRIES.map((code) => ({
        code,
        example: PLATE_FORMATS[code].example,
      })),
      categories: INCIDENT_CATEGORIES.map((id) => ({
        id,
        kind: INCIDENTS[id].kind,
        urgency: INCIDENTS[id].urgency,
        allowsTimeframe: INCIDENTS[id].allowsTimeframe,
        label: INCIDENTS[id].label,
      })),
      timeframes: TIMEFRAME_REQUESTS.map((id) => ({ id, label: TIMEFRAMES[id] })),
      responses: RESPONSE_CODES.map((id) => ({ id, label: RESPONSES[id] })),
      abuseReasons: ABUSE_REASONS.map((id) => ({ id, label: ABUSE_REASON_LABELS[id] })),
    });
  });

  return router;
}
