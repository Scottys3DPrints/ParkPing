/**
 * Analytics event taxonomy (project document §15, P1 "Define analytics event
 * taxonomy").
 *
 * Rules for every event in this file:
 *  1. No personal data, no plates, no contact details in properties. Plates are
 *     referenced only via the vehicle's opaque id, and only where the KPI needs it.
 *  2. Names are `object_verb_past_tense`, so funnels read in order.
 *  3. Every KPI in §11 must be derivable from these events alone.
 */

export const ANALYTICS_EVENTS = {
  // Onboarding funnel -> KPI "pilot activation"
  otp_requested: 'otp_requested',
  otp_verified: 'otp_verified',
  otp_failed: 'otp_failed',
  account_created: 'account_created',
  consent_accepted: 'consent_accepted',

  // Vehicle funnel -> KPI "registered vehicles"
  vehicle_add_started: 'vehicle_add_started',
  vehicle_added: 'vehicle_added',
  vehicle_rejected: 'vehicle_rejected',
  vehicle_contested: 'vehicle_contested',
  vehicle_removed: 'vehicle_removed',
  invite_redeemed: 'invite_redeemed',

  // Sticker funnel -> KPI "pilot activation", "sticker delivery rate"
  sticker_issued: 'sticker_issued',
  sticker_scanned: 'sticker_scanned',
  sticker_claimed: 'sticker_claimed',
  guest_session_started: 'guest_session_started',

  // Reporting funnel -> KPI "local match rate"
  alert_compose_started: 'alert_compose_started',
  alert_submitted: 'alert_submitted',
  alert_routed: 'alert_routed',
  alert_unroutable: 'alert_unroutable',
  alert_blocked_by_rate_limit: 'alert_blocked_by_rate_limit',
  alert_blocked_by_block_list: 'alert_blocked_by_block_list',

  // Delivery -> KPI "delivery rate", "response rate", "median response time"
  push_dispatched: 'push_dispatched',
  push_delivered: 'push_delivered',
  push_failed: 'push_failed',
  alert_opened: 'alert_opened',
  alert_responded: 'alert_responded',

  // Trust & safety
  abuse_reported: 'abuse_reported',
  reporter_blocked: 'reporter_blocked',
  enumeration_suspected: 'enumeration_suspected',
  moderation_action_taken: 'moderation_action_taken',

  // Lifecycle -> KPI "retention", GDPR obligations
  account_export_requested: 'account_export_requested',
  account_deletion_requested: 'account_deletion_requested',
  account_deleted: 'account_deleted',
  retention_purge_completed: 'retention_purge_completed',
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/**
 * Properties permitted on analytics events. The API drops anything not listed
 * here before writing, so a careless call site cannot leak identifiers.
 */
export const ALLOWED_ANALYTICS_PROPERTIES = [
  'category',
  'timeframe',
  'country',
  'kind',
  'urgency',
  'platform',
  'channel',
  'reason',
  'status',
  'verificationMethod',
  'organizationId',
  'vehicleId',
  'alertId',
  'responseCode',
  'limitName',
  'durationMs',
  'success',
  'count',
  'source',
] as const;

export type AnalyticsProperty = (typeof ALLOWED_ANALYTICS_PROPERTIES)[number];

export type AnalyticsProperties = Partial<Record<AnalyticsProperty, string | number | boolean | null>>;
