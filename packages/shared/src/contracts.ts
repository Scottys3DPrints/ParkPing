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

/**
 * An alert names its target one of two ways, never both.
 *
 * A sticker code may be sent by an anonymous guest, because a code cannot be
 * guessed and you must be standing at the car to read it. A plate requires a
 * verified account, because the plate space is enumerable and identity is the
 * cost we impose for walking it (project document v0.2 §3.3).
 */
export const submitAlertSchema = z
  .object({
    stickerCode: z.string().trim().min(1).max(24).nullish(),
    plate: z.string().trim().min(1).max(24).nullish(),
    country: countrySchema.nullish(),
    category: z.enum(INCIDENT_CATEGORIES),
    timeframe: z.enum(TIMEFRAME_REQUESTS).nullish(),
    /** Must reference a location belonging to an org the reporter is a member of. */
    locationId: z.string().uuid().nullish(),
  })
  .superRefine((value, ctx) => {
    const hasSticker = typeof value.stickerCode === 'string' && value.stickerCode !== '';
    const hasPlate = typeof value.plate === 'string' && value.plate !== '';
    if (hasSticker === hasPlate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stickerCode'],
        message: 'Send either a sticker code or a plate, not both.',
      });
      return;
    }
    if (hasPlate && !value.country) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['country'],
        message: 'A plate needs a country.',
      });
    }
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

export const claimStickerSchema = z.object({
  code: z.string().trim().min(1).max(24),
  label: z.string().trim().min(1).max(40).nullish(),
});

export const updateStickerSchema = z.object({
  label: z.string().trim().min(1).max(40).nullish(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const issueStickerBatchSchema = z.object({
  count: z.number().int().min(1).max(1000),
  label: z.string().trim().min(1).max(40).nullish(),
});

/**
 * Channels an owner can be reached on. `destination` is the address for that
 * channel — a phone number for SMS and WhatsApp, a push token otherwise.
 */
export const addChannelSchema = z.object({
  kind: z.enum(['whatsapp', 'sms', 'web_push', 'expo', 'email']),
  destination: z.string().trim().min(4).max(2048),
  /** Lower runs first. Ties break on creation order. */
  priority: z.number().int().min(0).max(100).default(10),
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
export type ClaimStickerInput = z.infer<typeof claimStickerSchema>;
export type UpdateStickerInput = z.infer<typeof updateStickerSchema>;
export type IssueStickerBatchInput = z.infer<typeof issueStickerBatchSchema>;
export type AddChannelInput = z.infer<typeof addChannelSchema>;
