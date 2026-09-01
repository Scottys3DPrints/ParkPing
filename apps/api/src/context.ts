import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { AccountService } from './services/account.js';
import { AbuseService } from './services/abuse.js';
import { AlertService } from './services/alerts.js';
import { AnalyticsService } from './services/analytics.js';
import { AuditService } from './services/audit.js';
import { AuthService, ConsoleOtpDelivery, type OtpDeliveryChannel } from './services/auth.js';
import { MetricsService } from './services/metrics.js';
import { OrganizationService } from './services/organizations.js';
import { PushService, createPushProvider, type PushProvider } from './services/push/index.js';
import { NotificationService, type ChannelTransport } from './services/channels/index.js';
import { RateLimiter } from './services/rateLimit.js';
import { RetentionService } from './services/retention.js';
import { StickerService } from './services/stickers.js';
import { VehicleService } from './services/vehicles.js';

export interface AppContext {
  config: Config;
  db: Db;
  analytics: AnalyticsService;
  audit: AuditService;
  rateLimiter: RateLimiter;
  auth: AuthService;
  vehicles: VehicleService;
  stickers: StickerService;
  alerts: AlertService;
  push: PushService;
  notifications: NotificationService;
  abuse: AbuseService;
  organizations: OrganizationService;
  metrics: MetricsService;
  account: AccountService;
  retention: RetentionService;
}

export interface ContextOverrides {
  /** Swapped in tests to capture codes, and in production for real SMS/email. */
  otpDelivery?: OtpDeliveryChannel;
  pushProvider?: PushProvider;
  /** Swapped in tests to assert on WhatsApp/SMS without a network call. */
  channelTransports?: ChannelTransport[];
}

/**
 * Composition root.
 *
 * Services take their collaborators as constructor arguments rather than
 * importing singletons, which is what makes the whole stack testable against
 * an in-memory database with a fake push provider — no module mocking.
 */
export function createContext(db: Db, config: Config, overrides: ContextOverrides = {}): AppContext {
  const analytics = new AnalyticsService(db);
  const audit = new AuditService(db);
  const rateLimiter = new RateLimiter(db);

  const auth = new AuthService(
    db,
    config,
    rateLimiter,
    analytics,
    audit,
    overrides.otpDelivery ?? new ConsoleOtpDelivery(),
  );

  const vehicles = new VehicleService(db, config, analytics, audit);
  const push = new PushService(
    db,
    overrides.pushProvider ?? createPushProvider(config),
    analytics,
    (vehicleId) => vehicles.labelForNotification(vehicleId),
  );

  const stickers = new StickerService(db, analytics, audit);
  const notifications = new NotificationService(
    db,
    config,
    analytics,
    push,
    overrides.channelTransports,
  );

  const alerts = new AlertService(
    db,
    config,
    vehicles,
    stickers,
    notifications,
    rateLimiter,
    analytics,
    audit,
  );
  const abuse = new AbuseService(db, analytics, audit);
  const organizations = new OrganizationService(db, audit);
  const metrics = new MetricsService(db);
  const account = new AccountService(db, auth, vehicles, alerts, analytics, audit);
  const retention = new RetentionService(db, config, analytics);

  return {
    config,
    db,
    analytics,
    audit,
    rateLimiter,
    auth,
    vehicles,
    stickers,
    alerts,
    push,
    notifications,
    abuse,
    organizations,
    metrics,
    account,
    retention,
  };
}
