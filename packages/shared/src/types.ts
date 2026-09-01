import type { CountryCode } from './plate.js';
import type { AbuseReason, IncidentCategory, ResponseCode, TimeframeRequest } from './incidents.js';

export type VerificationChannel = 'email' | 'phone';

export type UserRole = 'user' | 'platform_admin';

export interface UserDto {
  id: string;
  role: UserRole;
  /** Masked for display, e.g. "s•••@example.com". Never the raw value. */
  contactMasked: string;
  contactChannel: VerificationChannel;
  locale: 'en' | 'de';
  createdAt: string;
  notificationPreferences: NotificationPreferences;
  /** Version of the terms/privacy notice this account has accepted. */
  consentVersion: string | null;
}

export interface NotificationPreferences {
  /** Courtesy-level incidents can be held until quiet hours end. */
  quietHoursEnabled: boolean;
  /** Local time, "HH:MM". */
  quietHoursStart: string;
  quietHoursEnd: string;
  /** IANA timezone used to evaluate quiet hours. */
  timezone: string;
}

/**
 * Vehicle lifecycle.
 *
 * `active`      - routing enabled.
 * `pending`     - claimed while another account already holds the plate; no routing.
 * `suspended`   - routing paused after a `not_my_vehicle` response or admin action.
 * `removed`     - soft-deleted by the user; retained only for audit, no routing.
 */
export type VehicleStatus = 'active' | 'pending' | 'suspended' | 'removed';

export type VehicleVerificationMethod = 'self_declared' | 'org_invite' | 'document_review';

export interface VehicleDto {
  id: string;
  /** Pretty-printed plate. Only ever returned to the account that owns it. */
  plate: string;
  country: CountryCode;
  label: string | null;
  status: VehicleStatus;
  verificationMethod: VehicleVerificationMethod;
  organizationId: string | null;
  organizationName: string | null;
  createdAt: string;
}

/**
 * What the *reporter* is allowed to know about an alert they sent.
 *
 * Deliberately missing: whether the plate was registered, whether a push was
 * delivered, and anything at all about the recipient. `responded` only appears
 * because the recipient chose to disclose it.
 */
export type ReporterVisibleStatus = 'processed' | 'responded';

export interface SentAlertDto {
  id: string;
  /** Short human-quotable reference for support, e.g. "PP-7Q2K4M". */
  reference: string;
  category: IncidentCategory;
  timeframe: TimeframeRequest | null;
  /** Plate as the reporter typed it, echoed back for their own records. */
  plateEntered: string;
  country: CountryCode;
  status: ReporterVisibleStatus;
  response: ResponseCode | null;
  respondedAt: string | null;
  createdAt: string;
}

/** What the *vehicle user* sees. Contains no reporter identity. */
export interface ReceivedAlertDto {
  id: string;
  reference: string;
  vehicleId: string;
  vehiclePlate: string;
  category: IncidentCategory;
  timeframe: TimeframeRequest | null;
  /** Free-form only in the sense of being chosen from an org's location list. */
  locationLabel: string | null;
  /** Stable per (reporter, vehicle) pair so a user can block a repeat sender. */
  reporterHandle: string;
  reporterIsVerifiedOrganization: boolean;
  organizationName: string | null;
  response: ResponseCode | null;
  respondedAt: string | null;
  createdAt: string;
}

export type OrgRole = 'owner' | 'admin' | 'viewer';

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  verified: boolean;
  plan: 'pilot' | 'small' | 'large' | 'enterprise';
  createdAt: string;
}

export interface OrganizationMemberDto {
  userId: string;
  contactMasked: string;
  role: OrgRole;
  joinedAt: string;
}

export interface OrgLocationDto {
  id: string;
  organizationId: string;
  label: string;
  createdAt: string;
}

export interface OrgInviteDto {
  id: string;
  organizationId: string;
  code: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

/** KPI block from project document §11. */
export interface MetricsDto {
  windowDays: number;
  registeredVehicles: number;
  activeVehicles: number;
  alertsSubmitted: number;
  /**
   * Rates are null, not zero, when nothing happened to measure. "0%" and "no
   * data" lead to opposite decisions about a pilot.
   */
  /** Share of submitted alerts that found an eligible vehicle to route to. */
  localMatchRate: number | null;
  /** Share of alerts we attempted to push that reached at least one device. */
  deliveryRate: number | null;
  /** Share of routed alerts that received a response. */
  responseRate: number | null;
  /** Seconds between alert creation and first response. */
  medianResponseTimeSeconds: number | null;
  /** Invited vehicles that completed registration (org pilots only). */
  pilotActivationRate: number | null;
  retention30d: number | null;
  retention90d: number | null;
}

export interface AbuseReportDto {
  id: string;
  alertId: string | null;
  reason: AbuseReason;
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Present for validation failures. */
    details?: Array<{ path: string; message: string }>;
    /** Present on 429. Seconds until the caller may retry. */
    retryAfter?: number;
  };
}
