import { z } from 'zod';
import { SUPPORTED_COUNTRIES } from './plate.js';
import {
  ABUSE_REASONS,
  INCIDENT_CATEGORIES,
  RESPONSE_CODES,
  TIMEFRAME_REQUESTS,
} from './incidents.js';

/** Shared request schemas. The API validates with these; clients reuse them. */

export const countrySchema = z.enum(SUPPORTED_COUNTRIES);
export const localeSchema = z.enum(['en', 'de']);

const emailSchema = z.string().trim().toLowerCase().email().max(254);
/** E.164. Kept strict so the same number cannot be registered in two formats. */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{7,14}$/, 'Use international format, e.g. +4915112345678');

export const requestOtpSchema = z
  .object({
    channel: z.enum(['email', 'phone']),
    destination: z.string().trim().min(3).max(254),
    locale: localeSchema.default('en'),
  })
  .superRefine((value, ctx) => {
    const result =
      value.channel === 'email' ? emailSchema.safeParse(value.destination) : phoneSchema.safeParse(value.destination);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: result.error.issues[0]?.message ?? 'Invalid destination',
      });
    }
  });

export const verifyOtpSchema = z.object({
  channel: z.enum(['email', 'phone']),
  destination: z.string().trim().min(3).max(254),
  code: z.string().trim().regex(/^[0-9]{6}$/, 'Enter the 6-digit code'),
  /** Accepting the current terms version is part of first sign-in. */
  consentVersion: z.string().trim().min(1).max(32).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});

export const addVehicleSchema = z.object({
  plate: z.string().trim().min(1).max(24),
  country: countrySchema,
  label: z.string().trim().min(1).max(40).nullish(),
  /** Optional org invite code; upgrades verification from self-declared. */
  inviteCode: z.string().trim().min(4).max(32).nullish(),
});

export const submitAlertSchema = z.object({
  plate: z.string().trim().min(1).max(24),
  country: countrySchema,
  category: z.enum(INCIDENT_CATEGORIES),
  timeframe: z.enum(TIMEFRAME_REQUESTS).nullish(),
  /** Must reference a location belonging to an org the reporter is a member of. */
  locationId: z.string().uuid().nullish(),
});

export const respondToAlertSchema = z.object({
  response: z.enum(RESPONSE_CODES),
});

export const registerDeviceSchema = z.object({
  token: z.string().trim().min(8).max(512),
  platform: z.enum(['ios', 'android', 'web']),
  /** Opaque, client-generated, stable per install. Used to dedupe tokens. */
  installationId: z.string().trim().min(8).max(128),
});

export const reportAbuseSchema = z.object({
  alertId: z.string().uuid().nullish(),
  reason: z.enum(ABUSE_REASONS),
});

export const blockReporterSchema = z.object({
  alertId: z.string().uuid(),
});

export const notificationPreferencesSchema = z.object({
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  quietHoursEnd: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  timezone: z.string().trim().min(1).max(64),
});

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use lowercase letters, numbers and hyphens'),
});

export const createOrgLocationSchema = z.object({
  label: z.string().trim().min(2).max(80),
});

export const createOrgInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(10000).default(100),
  expiresInDays: z.number().int().min(1).max(365).nullish(),
});

export const resolveAbuseReportSchema = z.object({
  status: z.enum(['reviewing', 'actioned', 'dismissed']),
  /** Optional enforcement applied together with the resolution. */
  action: z.enum(['none', 'throttle_reporter', 'suspend_reporter', 'suspend_vehicle']).default('none'),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type AddVehicleInput = z.infer<typeof addVehicleSchema>;
export type SubmitAlertInput = z.infer<typeof submitAlertSchema>;
export type RespondToAlertInput = z.infer<typeof respondToAlertSchema>;
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export type ReportAbuseInput = z.infer<typeof reportAbuseSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type CreateOrgInviteInput = z.infer<typeof createOrgInviteSchema>;
