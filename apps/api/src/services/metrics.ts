import type { MetricsDto } from '@parkping/shared';
import type { Db } from '../db/index.js';

/**
 * Null for an empty denominator rather than 0.
 *
 * "0% delivered" and "nothing was attempted" mean very different things to
 * someone deciding whether a pilot is working, and a dashboard that renders
 * the second as the first invites the wrong conclusion.
 */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function int(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number.parseInt(value, 10) || 0;
}

/**
 * The KPI set from project document §11, computed from the operational tables.
 *
 * Everything here is derived rather than incremented into counters, so a
 * backfill or a corrected row is reflected immediately and there is no drift
 * between "what the dashboard says" and "what happened".
 *
 * When `organizationId` is set the numbers are scoped to one pilot site, which
 * is the view a B2B customer sees. Scoping covers both directions of the
 * relationship: alerts *sent from* the organization's locations, and alerts
 * *about* vehicles registered through its invites.
 */
export class MetricsService {
  constructor(private readonly db: Db) {}

  async compute(windowDays: number, organizationId: string | null = null): Promise<MetricsDto> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const orgFilter = organizationId !== null;

    const vehicles = await this.db.query<{ registered: string; active: string }>(
      `SELECT count(*) FILTER (WHERE status <> 'removed')::text AS registered,
              count(*) FILTER (WHERE status = 'active')::text  AS active
         FROM vehicles
        WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)`,
      [organizationId],
    );

    /*
     * Match rate is the headline number in §11 ("Most important measure of
     * network utility"). Its denominator is every alert a human actually
     * submitted, including ones we suppressed for abuse control — excluding
     * those would flatter the number by hiding the cases where the product
     * refused to work.
     */
    const alerts = await this.db.query<{
      submitted: string;
      routed: string;
      responded: string;
      median_seconds: string | number | null;
    }>(
      `SELECT count(*)::text                                        AS submitted,
              count(*) FILTER (WHERE status = 'routed')::text       AS routed,
              count(*) FILTER (WHERE response_code IS NOT NULL)::text AS responded,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (responded_at - created_at))
              ) FILTER (WHERE responded_at IS NOT NULL)             AS median_seconds
         FROM alerts a
        WHERE a.created_at > $1
          AND ($2::uuid IS NULL
               OR a.reporter_org_id = $2::uuid
               OR a.target_vehicle_id IN (SELECT id FROM vehicles WHERE organization_id = $2::uuid))`,
      [since, organizationId],
    );

    const delivery = await this.db.query<{ attempted: string; delivered: string }>(
      `SELECT count(DISTINCT pd.alert_id)::text AS attempted,
              count(DISTINCT pd.alert_id) FILTER (WHERE pd.status IN ('sent', 'delivered'))::text AS delivered
         FROM push_deliveries pd
         JOIN alerts a ON a.id = pd.alert_id
        WHERE a.created_at > $1
          AND ($2::uuid IS NULL
               OR a.reporter_org_id = $2::uuid
               OR a.target_vehicle_id IN (SELECT id FROM vehicles WHERE organization_id = $2::uuid))`,
      [since, organizationId],
    );

    const submitted = int(alerts.rows[0]?.submitted);
    const routed = int(alerts.rows[0]?.routed);
    const responded = int(alerts.rows[0]?.responded);
    const attempted = int(delivery.rows[0]?.attempted);
    const delivered = int(delivery.rows[0]?.delivered);
    const medianRaw = alerts.rows[0]?.median_seconds;

    return {
      windowDays,
      registeredVehicles: int(vehicles.rows[0]?.registered),
      activeVehicles: int(vehicles.rows[0]?.active),
      alertsSubmitted: submitted,
      localMatchRate: ratio(routed, submitted),
      deliveryRate: ratio(delivered, attempted),
      /*
       * Denominator is *routed* alerts, not delivered ones. A recipient with
       * notifications switched off can still open the app and reply, and that
       * reply is exactly the thing this KPI is trying to observe — dividing by
       * delivered would report those as a zero response rate. Push reliability
       * is measured separately by deliveryRate.
       */
      responseRate: ratio(responded, routed),
      medianResponseTimeSeconds:
        medianRaw === null || medianRaw === undefined ? null : Math.round(Number(medianRaw)),
      pilotActivationRate: orgFilter ? await this.pilotActivation(organizationId as string) : null,
      retention30d: await this.retention(30, organizationId),
      retention90d: await this.retention(90, organizationId),
    };
  }

  /**
   * Share of the seats a pilot bought that turned into a registered vehicle.
   *
   * `max_uses` on an invite doubles as the site's expected fleet size — the
   * dashboard tells operators to set it that way, so this reads as
   * "vehicles onboarded / vehicles we were told to expect".
   */
  private async pilotActivation(organizationId: string): Promise<number | null> {
    const { rows } = await this.db.query<{ invited: string | null; registered: string }>(
      `SELECT (SELECT sum(max_uses)::text FROM org_invites WHERE organization_id = $1) AS invited,
              (SELECT count(*)::text FROM vehicles
                WHERE organization_id = $1 AND status <> 'removed')                    AS registered`,
      [organizationId],
    );
    const invited = int(rows[0]?.invited);
    if (invited === 0) return null;
    return ratio(int(rows[0]?.registered), invited);
  }

  /**
   * Share of accounts that existed `days` ago and have been seen since.
   *
   * "Seen" means a token refresh or any API call that touches `last_seen_at`,
   * which is a lower bound on real usage — a user who only receives pushes and
   * never opens the app will not count. That is the conservative direction.
   */
  private async retention(days: number, organizationId: string | null): Promise<number | null> {
    const cohortBefore = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await this.db.query<{ cohort: string; retained: string }>(
      `SELECT count(*)::text AS cohort,
              count(*) FILTER (WHERE u.last_seen_at > $1)::text AS retained
         FROM users u
        WHERE u.created_at <= $1
          AND u.status = 'active'
          AND ($2::uuid IS NULL
               OR EXISTS (SELECT 1 FROM vehicles v
                           WHERE v.user_id = u.id AND v.organization_id = $2::uuid))`,
      [cohortBefore, organizationId],
    );
    const cohort = int(rows[0]?.cohort);
    if (cohort === 0) return null;
    return ratio(int(rows[0]?.retained), cohort);
  }

  /** Daily counts for the dashboard sparkline. */
  async alertsByDay(days: number, organizationId: string | null = null): Promise<Array<{ day: string; submitted: number; routed: number }>> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await this.db.query<{ day: Date | string; submitted: string; routed: string }>(
      `SELECT date_trunc('day', a.created_at) AS day,
              count(*)::text AS submitted,
              count(*) FILTER (WHERE a.status = 'routed')::text AS routed
         FROM alerts a
        WHERE a.created_at > $1
          AND ($2::uuid IS NULL
               OR a.reporter_org_id = $2::uuid
               OR a.target_vehicle_id IN (SELECT id FROM vehicles WHERE organization_id = $2::uuid))
        GROUP BY 1
        ORDER BY 1`,
      [since, organizationId],
    );
    return rows.map((row) => ({
      day: new Date(row.day).toISOString().slice(0, 10),
      submitted: int(row.submitted),
      routed: int(row.routed),
    }));
  }

  /** Incident mix, used to decide which categories earn their place at launch. */
  async categoryBreakdown(days: number, organizationId: string | null = null): Promise<Array<{ category: string; count: number }>> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await this.db.query<{ category: string; count: string }>(
      `SELECT category, count(*)::text AS count
         FROM alerts a
        WHERE a.created_at > $1
          AND ($2::uuid IS NULL
               OR a.reporter_org_id = $2::uuid
               OR a.target_vehicle_id IN (SELECT id FROM vehicles WHERE organization_id = $2::uuid))
        GROUP BY category
        ORDER BY count(*) DESC`,
      [since, organizationId],
    );
    return rows.map((row) => ({ category: row.category, count: int(row.count) }));
  }
}
