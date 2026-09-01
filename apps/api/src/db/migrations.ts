/**
 * Migrations are embedded as strings rather than read from .sql files so the
 * compiled `dist/` bundle is self-contained and the migration runner works
 * identically under tsx, node and vitest.
 *
 * Append-only: never edit an applied migration, add a new one.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: /* sql */ `
      CREATE TABLE users (
        id                  uuid PRIMARY KEY,
        role                text NOT NULL DEFAULT 'user',
        status              text NOT NULL DEFAULT 'active',
        contact_channel     text NOT NULL,
        -- Keyed hash of the normalized contact. The login lookup key; a stolen
        -- database dump cannot be reversed into an address list without the pepper.
        contact_hash        text UNIQUE,
        -- AES-256-GCM ciphertext. Needed because we must actually deliver the OTP.
        contact_encrypted   text,
        contact_masked      text NOT NULL DEFAULT '',
        locale              text NOT NULL DEFAULT 'en',
        consent_version     text,
        consent_accepted_at timestamptz,
        quiet_hours_enabled boolean NOT NULL DEFAULT true,
        quiet_hours_start   text NOT NULL DEFAULT '22:00',
        quiet_hours_end     text NOT NULL DEFAULT '07:00',
        timezone            text NOT NULL DEFAULT 'Europe/Berlin',
        -- Set by moderation to slow a reporter without removing their account.
        throttled_until     timestamptz,
        suspended_reason    text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        last_seen_at        timestamptz,
        deleted_at          timestamptz,
        CONSTRAINT users_role_check CHECK (role IN ('user', 'platform_admin')),
        CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'deleted')),
        CONSTRAINT users_channel_check CHECK (contact_channel IN ('email', 'phone'))
      );

      CREATE TABLE otp_codes (
        id            uuid PRIMARY KEY,
        contact_hash  text NOT NULL,
        channel       text NOT NULL,
        code_hash     text NOT NULL,
        attempts      integer NOT NULL DEFAULT 0,
        expires_at    timestamptz NOT NULL,
        consumed_at   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX otp_codes_lookup ON otp_codes (contact_hash, created_at DESC);

      CREATE TABLE refresh_tokens (
        id          uuid PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash  text NOT NULL UNIQUE,
        expires_at  timestamptz NOT NULL,
        revoked_at  timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

      CREATE TABLE organizations (
        id          uuid PRIMARY KEY,
        name        text NOT NULL,
        slug        text NOT NULL UNIQUE,
        verified    boolean NOT NULL DEFAULT false,
        plan        text NOT NULL DEFAULT 'pilot',
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organizations_plan_check CHECK (plan IN ('pilot', 'small', 'large', 'enterprise'))
      );

      CREATE TABLE org_members (
        organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role            text NOT NULL DEFAULT 'viewer',
        joined_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (organization_id, user_id),
        CONSTRAINT org_members_role_check CHECK (role IN ('owner', 'admin', 'viewer'))
      );

      CREATE TABLE org_locations (
        id              uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        label           text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX org_locations_org ON org_locations (organization_id);

      CREATE TABLE org_invites (
        id              uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        code            text NOT NULL UNIQUE,
        max_uses        integer NOT NULL DEFAULT 100,
        used_count      integer NOT NULL DEFAULT 0,
        expires_at      timestamptz,
        created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX org_invites_org ON org_invites (organization_id);

      CREATE TABLE vehicles (
        id                  uuid PRIMARY KEY,
        user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        country             text NOT NULL,
        -- HMAC(pepper, country + normalized plate). The only value used for routing.
        plate_index         text NOT NULL,
        -- AES-256-GCM of the normalized plate, so the owner can be shown their
        -- own plate. Never decrypted for anyone else.
        plate_encrypted     text NOT NULL,
        label               text,
        status              text NOT NULL DEFAULT 'active',
        verification_method text NOT NULL DEFAULT 'self_declared',
        organization_id     uuid REFERENCES organizations (id) ON DELETE SET NULL,
        invite_id           uuid REFERENCES org_invites (id) ON DELETE SET NULL,
        format_ok           boolean NOT NULL DEFAULT true,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        removed_at          timestamptz,
        CONSTRAINT vehicles_status_check CHECK (status IN ('active', 'pending', 'suspended', 'removed')),
        CONSTRAINT vehicles_method_check
          CHECK (verification_method IN ('self_declared', 'org_invite', 'document_review'))
      );
      -- At most one account may hold a given plate in routing state. A second
      -- claim lands as 'pending' and is reviewed rather than silently ignored.
      CREATE UNIQUE INDEX vehicles_active_plate
        ON vehicles (country, plate_index) WHERE status = 'active';
      CREATE INDEX vehicles_user ON vehicles (user_id) WHERE status <> 'removed';
      CREATE INDEX vehicles_org ON vehicles (organization_id) WHERE organization_id IS NOT NULL;
      CREATE INDEX vehicles_plate_lookup ON vehicles (country, plate_index);

      CREATE TABLE alerts (
        id                      uuid PRIMARY KEY,
        reference               text NOT NULL UNIQUE,
        reporter_user_id        uuid REFERENCES users (id) ON DELETE SET NULL,
        reporter_org_id         uuid REFERENCES organizations (id) ON DELETE SET NULL,
        location_id             uuid REFERENCES org_locations (id) ON DELETE SET NULL,
        target_country          text NOT NULL,
        target_plate_index      text NOT NULL,
        -- Null when nothing was registered. Kept nullable rather than omitting
        -- the row, because unroutable alerts are the denominator of match rate.
        target_vehicle_id       uuid REFERENCES vehicles (id) ON DELETE SET NULL,
        target_user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
        category                text NOT NULL,
        timeframe               text,
        status                  text NOT NULL,
        plate_entered_encrypted text NOT NULL,
        response_code           text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        routed_at               timestamptz,
        opened_at               timestamptz,
        responded_at            timestamptz,
        CONSTRAINT alerts_status_check
          CHECK (status IN ('routed', 'unroutable', 'blocked', 'suppressed'))
      );
      CREATE INDEX alerts_reporter ON alerts (reporter_user_id, created_at DESC);
      CREATE INDEX alerts_target_user ON alerts (target_user_id, created_at DESC);
      CREATE INDEX alerts_target_plate ON alerts (target_country, target_plate_index, created_at DESC);
      CREATE INDEX alerts_created ON alerts (created_at DESC);

      CREATE TABLE devices (
        id              uuid PRIMARY KEY,
        user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        installation_id text NOT NULL,
        platform        text NOT NULL,
        token           text NOT NULL,
        active          boolean NOT NULL DEFAULT true,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, installation_id),
        CONSTRAINT devices_platform_check CHECK (platform IN ('ios', 'android', 'web'))
      );
      CREATE INDEX devices_user_active ON devices (user_id) WHERE active;

      CREATE TABLE push_deliveries (
        id            uuid PRIMARY KEY,
        alert_id      uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
        device_id     uuid REFERENCES devices (id) ON DELETE SET NULL,
        provider      text NOT NULL,
        status        text NOT NULL,
        scheduled_at  timestamptz,
        dispatched_at timestamptz,
        delivered_at  timestamptz,
        error         text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT push_deliveries_status_check
          CHECK (status IN ('pending', 'deferred', 'sent', 'delivered', 'failed'))
      );
      CREATE INDEX push_deliveries_alert ON push_deliveries (alert_id);
      CREATE INDEX push_deliveries_due ON push_deliveries (scheduled_at) WHERE status = 'deferred';

      CREATE TABLE blocks (
        id              uuid PRIMARY KEY,
        vehicle_id      uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
        blocked_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (vehicle_id, blocked_user_id)
      );

      CREATE TABLE abuse_reports (
        id                uuid PRIMARY KEY,
        reported_by       uuid REFERENCES users (id) ON DELETE SET NULL,
        alert_id          uuid REFERENCES alerts (id) ON DELETE SET NULL,
        subject_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
        subject_vehicle_id uuid REFERENCES vehicles (id) ON DELETE SET NULL,
        reason            text NOT NULL,
        source            text NOT NULL DEFAULT 'user',
        status            text NOT NULL DEFAULT 'open',
        resolution_action text,
        resolved_by       uuid REFERENCES users (id) ON DELETE SET NULL,
        resolved_at       timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT abuse_reports_status_check
          CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
        CONSTRAINT abuse_reports_source_check CHECK (source IN ('user', 'system'))
      );
      CREATE INDEX abuse_reports_status ON abuse_reports (status, created_at DESC);

      CREATE TABLE audit_events (
        id            uuid PRIMARY KEY,
        actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        actor_type    text NOT NULL DEFAULT 'user',
        action        text NOT NULL,
        subject_type  text,
        subject_id    text,
        metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip_hash       text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX audit_events_actor ON audit_events (actor_user_id, created_at DESC);
      CREATE INDEX audit_events_created ON audit_events (created_at DESC);

      CREATE TABLE analytics_events (
        id          uuid PRIMARY KEY,
        name        text NOT NULL,
        user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
        properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX analytics_events_name ON analytics_events (name, created_at DESC);

      CREATE TABLE rate_limit_hits (
        id          uuid PRIMARY KEY,
        bucket      text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX rate_limit_hits_bucket ON rate_limit_hits (bucket, created_at DESC);
    `,
  },

  {
    id: '002_stickers_guests_channels',
    sql: /* sql */ `
      /*
       * Project document v0.2. Three additions and one reshaping.
       *
       * Stickers become the primary way a car joins the network. A sticker
       * carries an opaque code and, deliberately, need never be linked to a
       * plate at all — that is the most privacy-preserving configuration the
       * product can offer and it is the default.
       */
      CREATE TABLE stickers (
        id              uuid PRIMARY KEY,
        code            text NOT NULL UNIQUE,
        status          text NOT NULL DEFAULT 'unclaimed',
        label           text,
        organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
        claimed_by      uuid REFERENCES users (id) ON DELETE SET NULL,
        -- Optional. A sticker works perfectly well with no plate attached.
        vehicle_id      uuid REFERENCES vehicles (id) ON DELETE SET NULL,
        claimed_at      timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stickers_status_check CHECK (status IN ('unclaimed', 'active', 'disabled'))
      );
      CREATE INDEX stickers_owner ON stickers (claimed_by) WHERE claimed_by IS NOT NULL;
      CREATE INDEX stickers_org ON stickers (organization_id) WHERE organization_id IS NOT NULL;

      /*
       * Guests are anonymous reporters on the sticker path. They are safe to
       * allow because a sticker code cannot be enumerated and you must be
       * standing at the car to read one. They still carry a stable identity so
       * rate limits and block lists work on them exactly as they do on accounts.
       */
      CREATE TABLE guests (
        id           uuid PRIMARY KEY,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz,
        -- Set by moderation, same semantics as users.throttled_until.
        throttled_until timestamptz,
        blocked_at   timestamptz
      );

      /*
       * How an owner is actually reachable. Replaces the assumption that every
       * recipient has the app installed — in Germany far more drivers are
       * reachable on WhatsApp than through an app they never downloaded.
       */
      CREATE TABLE notification_channels (
        id                    uuid PRIMARY KEY,
        user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind                  text NOT NULL,
        -- AES-GCM. A phone number is personal data even when it is ours to send to.
        destination_encrypted text NOT NULL,
        -- Keyed hash, so a duplicate can be detected without decrypting.
        destination_hash      text NOT NULL,
        destination_masked    text NOT NULL,
        priority              integer NOT NULL DEFAULT 10,
        verified_at           timestamptz,
        active                boolean NOT NULL DEFAULT true,
        created_at            timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, kind, destination_hash),
        CONSTRAINT channels_kind_check
          CHECK (kind IN ('whatsapp', 'sms', 'web_push', 'expo', 'email'))
      );
      CREATE INDEX channels_user ON notification_channels (user_id) WHERE active;

      -- Alerts can now target a sticker instead of a plate, and can come from a
      -- guest instead of an account. Exactly one of each pair is ever set.
      ALTER TABLE alerts ADD COLUMN target_sticker_id uuid REFERENCES stickers (id) ON DELETE SET NULL;
      ALTER TABLE alerts ADD COLUMN reporter_guest_id uuid REFERENCES guests (id) ON DELETE SET NULL;
      ALTER TABLE alerts ALTER COLUMN target_plate_index DROP NOT NULL;
      ALTER TABLE alerts ALTER COLUMN target_country DROP NOT NULL;
      CREATE INDEX alerts_target_sticker ON alerts (target_sticker_id, created_at DESC);
      CREATE INDEX alerts_reporter_guest ON alerts (reporter_guest_id, created_at DESC);

      /*
       * Blocks are reshaped rather than extended. There are now two kinds of
       * target (vehicle, sticker) and two kinds of sender (account, guest), and
       * four nullable columns with four partial unique indexes would be a
       * standing invitation to get one of them wrong. Opaque composite keys give
       * one index and one code path.
       *
       * Safe to recreate: the product has no production data, and blocks are
       * regenerated by users rather than derived from anything.
       */
      /*
       * The rendered message, kept only when a non-production transport was
       * used. It is what makes a demo inspectable — you can read the WhatsApp
       * message that would have been sent. Never written by a real transport,
       * because storing the body of every delivered notification would be a
       * retention liability with no operational purpose.
       */
      ALTER TABLE push_deliveries ADD COLUMN preview text;
      ALTER TABLE push_deliveries ADD COLUMN channel_id uuid
        REFERENCES notification_channels (id) ON DELETE SET NULL;

      DROP TABLE blocks;
      CREATE TABLE blocks (
        id          uuid PRIMARY KEY,
        -- 'vehicle:<uuid>' or 'sticker:<uuid>'
        target_key  text NOT NULL,
        -- 'user:<uuid>' or 'guest:<uuid>'
        blocked_key text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (target_key, blocked_key)
      );
      CREATE INDEX blocks_target ON blocks (target_key);
    `,
  },
];
