/**
 * Seeds a demo pilot so the admin console and the mobile app have something to
 * show on a fresh checkout: one organization with locations and an invite, a
 * platform admin, a handful of vehicle users, and a spread of alerts across
 * categories and outcomes.
 *
 * Safe to re-run: it clears the demo rows it owns before inserting.
 */
import { randomUUID } from 'node:crypto';
import { INCIDENT_CATEGORIES, RESPONSE_CODES, normalizePlate, normalizeStickerCode } from '@parkping/shared';
import { getConfig } from '../config.js';
import { createContext } from '../context.js';
import { createDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { blindIndex, encrypt, generateAlertReference, maskContact } from '../domain/crypto.js';
import { logger } from '../logger.js';

const DEMO_ORG_SLUG = 'nordpark-campus';

const DEMO_USERS = [
  { contact: 'admin@parkping.test', channel: 'email' as const, role: 'platform_admin' as const },
  { contact: 'facility@nordpark.test', channel: 'email' as const, role: 'user' as const },
  { contact: 'anna@nordpark.test', channel: 'email' as const, role: 'user' as const },
  { contact: 'ben@nordpark.test', channel: 'email' as const, role: 'user' as const },
  { contact: 'clara@nordpark.test', channel: 'email' as const, role: 'user' as const },
];

const DEMO_PLATES: Array<{ plate: string; owner: number; label: string }> = [
  { plate: 'M AB 1234', owner: 2, label: 'Anna — Golf' },
  { plate: 'M CD 5678', owner: 3, label: 'Ben — Transporter' },
  { plate: 'HH XY 42', owner: 4, label: 'Clara — Kombi' },
];

/**
 * Stickers are the primary entry point in v0.2, so the demo needs some that are
 * claimed (scannable and reachable) and some that are not, so the "not set up
 * yet" path can be shown. Codes are fixed here purely so a walkthrough can be
 * written down; real issuance is random.
 */
const DEMO_STICKERS = [
  { code: 'PARKPNG001', owner: 2, label: 'Anna — Golf' },
  { code: 'PARKPNG002', owner: 3, label: 'Ben — Transporter' },
  { code: 'PARKPNG003', owner: 4, label: 'Clara — Kombi' },
];

const UNCLAIMED_STICKERS = ['PARKPNG004', 'PARKPNG005'];

const ALL_DEMO_STICKER_CODES = [...DEMO_STICKERS.map((s) => s.code), ...UNCLAIMED_STICKERS];

const config = getConfig();
const db = await createDb(config);
await runMigrations(db);
const ctx = createContext(db, config);

/** Same derivation the sign-in path uses, so seeded accounts can log in. */
const contactHash = (channel: 'email' | 'phone', destination: string): string =>
  ctx.auth.contactHash(channel, destination);

logger.info('seed.clearing');
await db.query(`DELETE FROM users WHERE contact_hash = ANY($1::text[])`, [
  DEMO_USERS.map((u) => contactHash(u.channel, u.contact)),
]);
await db.query('DELETE FROM organizations WHERE slug = $1', [DEMO_ORG_SLUG]);
/*
 * Stickers survive both deletions above — their user and organization
 * references are ON DELETE SET NULL, because a sticker is a physical object
 * that outlives the account that claimed it. That is right in production and
 * wrong for a re-runnable seed, so the demo codes are cleared explicitly.
 */
await db.query('DELETE FROM stickers WHERE code = ANY($1::text[])', [ALL_DEMO_STICKER_CODES]);

const userIds: string[] = [];
for (const demo of DEMO_USERS) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, role, contact_channel, contact_hash, contact_encrypted, contact_masked,
                        locale, consent_version, consent_accepted_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'de', $7, now(), now())`,
    [
      id,
      demo.role,
      demo.channel,
      contactHash(demo.channel, demo.contact),
      encrypt(config.secrets.plateEncryptionKey, demo.contact),
      maskContact(demo.channel, demo.contact),
      config.consentVersion,
    ],
  );
  userIds.push(id);
}

const orgId = randomUUID();
await db.query('INSERT INTO organizations (id, name, slug, verified, plan) VALUES ($1, $2, $3, true, $4)', [
  orgId,
  'Nordpark Campus',
  DEMO_ORG_SLUG,
  'large',
]);
await db.query(`INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, [
  orgId,
  userIds[1],
]);

const locationIds: string[] = [];
for (const label of ['Gebäude A — Tiefgarage', 'Gebäude B — Besucherparkplatz', 'Anlieferung Nord']) {
  const id = randomUUID();
  await db.query('INSERT INTO org_locations (id, organization_id, label) VALUES ($1, $2, $3)', [
    id,
    orgId,
    label,
  ]);
  locationIds.push(id);
}

const inviteId = randomUUID();
await db.query(
  'INSERT INTO org_invites (id, organization_id, code, max_uses, created_by) VALUES ($1, $2, $3, $4, $5)',
  [inviteId, orgId, 'NORDPARK1', 500, userIds[1]],
);

const vehicleIds: string[] = [];
for (const demo of DEMO_PLATES) {
  const normalized = normalizePlate(demo.plate, 'DE');
  const id = randomUUID();
  await db.query(
    `INSERT INTO vehicles (id, user_id, country, plate_index, plate_encrypted, label, status,
                           verification_method, organization_id, invite_id)
     VALUES ($1, $2, 'DE', $3, $4, $5, 'active', 'org_invite', $6, $7)`,
    [
      id,
      userIds[demo.owner],
      ctx.vehicles.plateIndexFor('DE', normalized.normalized),
      encrypt(config.secrets.plateEncryptionKey, normalized.normalized),
      demo.label,
      orgId,
      inviteId,
    ],
  );
  vehicleIds.push(id);
}
await db.query('UPDATE org_invites SET used_count = $2 WHERE id = $1', [inviteId, DEMO_PLATES.length]);

/*
 * Alerts are spread over the last 30 days with a realistic mix: most route,
 * some do not (the plate was never registered), and about half get a reply.
 * That gives the dashboard a match rate and a response time that look like a
 * pilot rather than a demo where everything works.
 */
// Each vehicle user has a device, so routed alerts produce delivery rows and
// the dashboard's delivery/response rates have a real denominator.
for (const [index, userId] of userIds.slice(2).entries()) {
  await db.query(
    `INSERT INTO devices (id, user_id, installation_id, platform, token, active)
     VALUES ($1, $2, $3, 'ios', $4, true)`,
    [randomUUID(), userId, `seed-install-${index}`, `ExpoPushToken[seed-${index}]`],
  );
}

let created = 0;
for (let day = 0; day < 30; day += 1) {
  const alertsToday = (day % 3) + 1;
  for (let n = 0; n < alertsToday; n += 1) {
    const routed = (day + n) % 4 !== 0;
    const vehicleIndex = (day + n) % vehicleIds.length;
    const category = INCIDENT_CATEGORIES[(day + n) % INCIDENT_CATEGORIES.length]!;
    const createdAt = new Date(Date.now() - day * 24 * 60 * 60 * 1000 - n * 3 * 60 * 60 * 1000);
    const responded = routed && (day + n) % 2 === 0;
    const respondedAt = responded
      ? new Date(createdAt.getTime() + (3 + ((day * 7 + n * 13) % 25)) * 60 * 1000)
      : null;
    const plate = normalizePlate(routed ? DEMO_PLATES[vehicleIndex]!.plate : `M ZZ ${1000 + day}`, 'DE');
    const alertId = randomUUID();

    await db.query(
      `INSERT INTO alerts (id, reference, reporter_user_id, reporter_org_id, location_id,
                           target_country, target_plate_index, target_vehicle_id, target_user_id,
                           category, status, plate_entered_encrypted, response_code,
                           created_at, routed_at, responded_at)
       VALUES ($1, $2, $3, $4, $5, 'DE', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        alertId,
        generateAlertReference(),
        userIds[1],
        orgId,
        locationIds[(day + n) % locationIds.length],
        ctx.vehicles.plateIndexFor('DE', plate.normalized),
        routed ? vehicleIds[vehicleIndex] : null,
        routed ? userIds[DEMO_PLATES[vehicleIndex]!.owner] : null,
        category,
        routed ? 'routed' : 'unroutable',
        encrypt(config.secrets.plateEncryptionKey, plate.normalized),
        responded ? RESPONSE_CODES[(day + n) % 4]! : null,
        createdAt.toISOString(),
        routed ? createdAt.toISOString() : null,
        respondedAt?.toISOString() ?? null,
      ],
    );

    if (routed) {
      // A small share fail, so the delivery-rate KPI is not a flat 100%.
      const deliveryFailed = (day + n) % 11 === 0;
      const device = await db.query<{ id: string }>(
        'SELECT id FROM devices WHERE user_id = $1 LIMIT 1',
        [userIds[DEMO_PLATES[vehicleIndex]!.owner]],
      );
      await db.query(
        `INSERT INTO push_deliveries
           (id, alert_id, device_id, provider, status, dispatched_at, delivered_at, error, created_at)
         VALUES ($1, $2, $3, 'seed', $4, $5, $6, $7, $5)`,
        [
          randomUUID(),
          alertId,
          device.rows[0]?.id ?? null,
          deliveryFailed ? 'failed' : 'sent',
          createdAt.toISOString(),
          deliveryFailed ? null : createdAt.toISOString(),
          deliveryFailed ? 'DeviceNotRegistered' : null,
        ],
      );
    }

    created += 1;
  }
}

/**
 * Stored codes must survive normalization, or the sticker is unreachable: the
 * lookup normalizes what the scanner typed, so a code containing O, I, L or U
 * would fold to something that never matches the stored value. Asserting here
 * makes that impossible to introduce by choosing a nice-looking demo code.
 */
function storableCode(code: string): string {
  const normalized = normalizeStickerCode(code);
  if (normalized !== code) {
    throw new Error(
      `Sticker code ${code} is not storable — it normalizes to ${normalized}. ` +
        'Use only the Crockford alphabet (no O, I, L or U).',
    );
  }
  return normalized;
}

for (const demo of DEMO_STICKERS) {
  await db.query(
    `INSERT INTO stickers (id, code, status, label, organization_id, claimed_by, claimed_at)
     VALUES ($1, $2, 'active', $3, $4, $5, now())`,
    [randomUUID(), storableCode(demo.code), demo.label, orgId, userIds[demo.owner]],
  );
}

// Two unclaimed, so the "this sticker is not set up yet" path is demonstrable.
for (const code of UNCLAIMED_STICKERS) {
  await db.query(
    `INSERT INTO stickers (id, code, status, organization_id) VALUES ($1, $2, 'unclaimed', $3)`,
    [randomUUID(), storableCode(code), orgId],
  );
}

/*
 * Give the vehicle users a WhatsApp channel each. Without one the demo would
 * only ever exercise push, which is exactly the assumption v0.2 set out to
 * remove.
 */
for (const [index, demo] of DEMO_PLATES.entries()) {
  const destination = `+49151000000${index + 1}`;
  await db.query(
    `INSERT INTO notification_channels
       (id, user_id, kind, destination_encrypted, destination_hash, destination_masked, priority, verified_at)
     VALUES ($1, $2, 'whatsapp', $3, $4, $5, 1, now())`,
    [
      randomUUID(),
      userIds[demo.owner],
      encrypt(config.secrets.plateEncryptionKey, destination),
      // Same derivation NotificationService uses, so a duplicate would be
      // detected exactly as it would for a channel added through the API.
      blindIndex(config.secrets.handlePepper, 'channel:whatsapp', destination.toLowerCase()),
      maskContact('phone', destination),
    ],
  );
}

logger.info('seed.done', {
  users: userIds.length,
  vehicles: vehicleIds.length,
  alerts: created,
  organization: DEMO_ORG_SLUG,
});

// eslint-disable-next-line no-console
console.log(
  [
    '',
    'Demo data ready.',
    '',
    `  Platform admin : ${DEMO_USERS[0]!.contact}`,
    `  Site operator  : ${DEMO_USERS[1]!.contact}`,
    `  Vehicle users  : ${DEMO_USERS.slice(2).map((u) => u.contact).join(', ')}`,
    '  Invite code    : NORDPARK1',
    '',
    '  Stickers (claimed)  : PARKPNG001, PARKPNG002, PARKPNG003',
    '  Stickers (unclaimed): PARKPNG004, PARKPNG005',
    '',
    'Sign in with any of these addresses; the one-time code is printed by the API',
    'in development (look for the "otp.console_delivery" log line).',
    '',
  ].join('\n'),
);

await db.close();
