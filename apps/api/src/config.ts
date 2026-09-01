import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Environment = 'development' | 'test' | 'production';

export interface Config {
  env: Environment;
  port: number;
  /** Public base URL, used in deep links and invite URLs. */
  publicUrl: string;
  corsOrigins: string[];

  database: {
    /** When set, a real PostgreSQL server is used. Otherwise PGlite (embedded). */
    url: string | null;
    /** Directory for the embedded database. `:memory:` for tests. */
    embeddedPath: string;
  };

  secrets: {
    /** HMAC key for the plate blind index. Rotating it invalidates all routing. */
    plateIndexPepper: Buffer;
    /** AES-256-GCM key used to store plates recoverably for their own owner. */
    plateEncryptionKey: Buffer;
    /** HMAC key deriving per-(reporter, vehicle) pseudonymous handles. */
    handlePepper: Buffer;
    jwtSecret: string;
  };

  auth: {
    accessTokenTtlSeconds: number;
    refreshTokenTtlDays: number;
    otpTtlSeconds: number;
    otpMaxAttempts: number;
    /** Return the OTP in the API response. Never enabled in production. */
    echoOtp: boolean;
  };

  alerts: {
    /**
     * Minimum wall-clock duration of POST /v1/alerts, in milliseconds. Padding
     * every response to the same floor removes the timing side channel that
     * would otherwise reveal whether a plate is registered.
     */
    minResponseMs: number;
    /** Distinct plates a single reporter may target per day before we flag them. */
    enumerationDistinctPlatesPerDay: number;
  };

  retention: {
    alertDays: number;
    auditDays: number;
    analyticsDays: number;
    rateLimitHours: number;
  };

  push: {
    provider: 'console' | 'expo';
    /** Optional access token for the Expo push service. */
    expoAccessToken: string | null;
  };

  /**
   * Outbound message channels. Every one is optional: outside production an
   * unconfigured transport is replaced by a demo transport that records what
   * would have been sent, so the product can be demonstrated end to end
   * without a Meta business account or a Twilio subscription.
   */
  channels: {
    whatsappPhoneNumberId: string | null;
    whatsappAccessToken: string | null;
    whatsappTemplateName: string;
    whatsappTemplateLocale: string;
    twilioAccountSid: string | null;
    twilioAuthToken: string | null;
    twilioFromNumber: string | null;
    emailApiKey: string | null;
    emailFromAddress: string;
  };

  /** Public URL of the web app, used in notification links and QR codes. */
  webUrl: string;

  /** Version string users accept at sign-up; bump to force re-consent. */
  consentVersion: string;
}

function envOrNull(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function intFromEnv(name: string, fallback: number): number {
  const raw = envOrNull(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * Secrets are required in production and generated-and-persisted in
 * development. Persisting matters: the plate pepper is baked into every stored
 * blind index, so a fresh random value on each restart would orphan every
 * registered vehicle.
 */
function loadSecrets(env: Environment): Config['secrets'] {
  const names = ['PLATE_INDEX_PEPPER', 'PLATE_ENCRYPTION_KEY', 'HANDLE_PEPPER', 'JWT_SECRET'] as const;
  const fromEnv = Object.fromEntries(names.map((n) => [n, envOrNull(n)])) as Record<
    (typeof names)[number],
    string | null
  >;

  if (env === 'production') {
    const missing = names.filter((n) => fromEnv[n] === null);
    if (missing.length > 0) {
      throw new Error(
        `Missing required secrets in production: ${missing.join(', ')}. ` +
          'Generate them with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }
  }

  if (env === 'test') {
    // Deterministic across runs so tests can restart the app against the same data.
    const derive = (label: string) => createHash('sha256').update(`parkping-test:${label}`).digest();
    return {
      plateIndexPepper: derive('plate-index'),
      plateEncryptionKey: derive('plate-encryption'),
      handlePepper: derive('handle'),
      jwtSecret: derive('jwt').toString('base64'),
    };
  }

  const resolved: Record<string, string> = {};
  const devFile = resolve(process.cwd(), '.parkping-dev-secrets.json');
  let devStore: Record<string, string> = {};
  if (env === 'development' && existsSync(devFile)) {
    try {
      devStore = JSON.parse(readFileSync(devFile, 'utf8')) as Record<string, string>;
    } catch {
      devStore = {};
    }
  }

  let generatedAny = false;
  for (const name of names) {
    const value = fromEnv[name] ?? devStore[name];
    if (value) {
      resolved[name] = value;
      continue;
    }
    resolved[name] = randomBytes(32).toString('base64');
    devStore[name] = resolved[name];
    generatedAny = true;
  }

  if (env === 'development' && generatedAny) {
    mkdirSync(dirname(devFile), { recursive: true });
    writeFileSync(devFile, JSON.stringify(devStore, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.warn(
      `[config] Generated development secrets in ${devFile}. ` +
        'This file is git-ignored and must never be used in production.',
    );
  }

  const asKey = (value: string): Buffer => {
    const buf = Buffer.from(value, 'base64');
    // Accept any secret material but derive a fixed-length key from it, so a
    // short or non-base64 value from a .env file still yields a valid AES key.
    return buf.length === 32 ? buf : createHash('sha256').update(value, 'utf8').digest();
  };

  return {
    plateIndexPepper: asKey(resolved.PLATE_INDEX_PEPPER as string),
    plateEncryptionKey: asKey(resolved.PLATE_ENCRYPTION_KEY as string),
    handlePepper: asKey(resolved.HANDLE_PEPPER as string),
    jwtSecret: resolved.JWT_SECRET as string,
  };
}

export function loadConfig(): Config {
  const rawEnv = envOrNull('NODE_ENV') ?? 'development';
  const env: Environment =
    rawEnv === 'production' ? 'production' : rawEnv === 'test' ? 'test' : 'development';

  const echoOtpRequested = envOrNull('OTP_ECHO') === 'true' || env !== 'production';

  return {
    env,
    port: intFromEnv('PORT', 4000),
    publicUrl: envOrNull('PUBLIC_URL') ?? `http://localhost:${intFromEnv('PORT', 4000)}`,
    corsOrigins: (envOrNull('CORS_ORIGINS') ??
      'http://localhost:5173,http://localhost:5174,http://localhost:8081')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),

    database: {
      url: envOrNull('DATABASE_URL'),
      embeddedPath: env === 'test' ? 'memory://' : envOrNull('EMBEDDED_DB_PATH') ?? './.pgdata',
    },

    secrets: loadSecrets(env),

    auth: {
      accessTokenTtlSeconds: intFromEnv('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
      refreshTokenTtlDays: intFromEnv('REFRESH_TOKEN_TTL_DAYS', 30),
      otpTtlSeconds: intFromEnv('OTP_TTL_SECONDS', 10 * 60),
      otpMaxAttempts: intFromEnv('OTP_MAX_ATTEMPTS', 5),
      echoOtp: env === 'production' ? false : echoOtpRequested,
    },

    alerts: {
      minResponseMs: intFromEnv('ALERT_MIN_RESPONSE_MS', env === 'test' ? 0 : 250),
      enumerationDistinctPlatesPerDay: intFromEnv('ENUMERATION_DISTINCT_PLATES_PER_DAY', 15),
    },

    retention: {
      alertDays: intFromEnv('RETENTION_ALERT_DAYS', 90),
      auditDays: intFromEnv('RETENTION_AUDIT_DAYS', 180),
      analyticsDays: intFromEnv('RETENTION_ANALYTICS_DAYS', 365),
      rateLimitHours: intFromEnv('RETENTION_RATE_LIMIT_HOURS', 48),
    },

    push: {
      provider: (envOrNull('PUSH_PROVIDER') as Config['push']['provider'] | null) ?? 'console',
      expoAccessToken: envOrNull('EXPO_ACCESS_TOKEN'),
    },

    channels: {
      whatsappPhoneNumberId: envOrNull('WHATSAPP_PHONE_NUMBER_ID'),
      whatsappAccessToken: envOrNull('WHATSAPP_ACCESS_TOKEN'),
      whatsappTemplateName: envOrNull('WHATSAPP_TEMPLATE_NAME') ?? 'parkping_alert',
      whatsappTemplateLocale: envOrNull('WHATSAPP_TEMPLATE_LOCALE') ?? 'de',
      twilioAccountSid: envOrNull('TWILIO_ACCOUNT_SID'),
      twilioAuthToken: envOrNull('TWILIO_AUTH_TOKEN'),
      twilioFromNumber: envOrNull('TWILIO_FROM_NUMBER'),
      emailApiKey: envOrNull('EMAIL_API_KEY'),
      emailFromAddress: envOrNull('EMAIL_FROM_ADDRESS') ?? 'ParkPing <noreply@parkping.test>',
    },

    webUrl: envOrNull('WEB_URL') ?? 'http://localhost:5174',

    consentVersion: envOrNull('CONSENT_VERSION') ?? '2026-08-30',
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: forget the memoized config so env changes take effect. */
export function resetConfig(): void {
  cached = null;
}
