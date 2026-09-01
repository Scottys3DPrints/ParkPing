import type { Express } from 'express';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { createContext, type AppContext } from '../context.js';
import { createDb, type Db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import type { OtpDeliveryChannel } from '../services/auth.js';
import type { PushMessage, PushProvider, PushSendResult } from '../services/push/index.js';

/** Captures one-time codes instead of sending them anywhere. */
export class CapturingOtpDelivery implements OtpDeliveryChannel {
  readonly codes = new Map<string, string>();

  async deliver(input: { channel: 'email' | 'phone'; destination: string; code: string }): Promise<void> {
    this.codes.set(input.destination, input.code);
  }

  latestFor(destination: string): string {
    const code = this.codes.get(destination);
    if (!code) throw new Error(`No OTP was delivered to ${destination}`);
    return code;
  }
}

/** Records pushes so tests can assert on delivery without a network call. */
export class RecordingPushProvider implements PushProvider {
  readonly name = 'recording';
  readonly sent: PushMessage[] = [];
  /** Set to simulate an unreachable device. */
  failNext = false;

  async send(messages: PushMessage[]): Promise<PushSendResult[]> {
    if (this.failNext) {
      this.failNext = false;
      return messages.map((m) => ({ token: m.token, ok: false, error: 'simulated_failure' }));
    }
    this.sent.push(...messages);
    return messages.map((m) => ({ token: m.token, ok: true }));
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export interface TestHarness {
  app: Express;
  ctx: AppContext;
  db: Db;
  config: Config;
  otp: CapturingOtpDelivery;
  push: RecordingPushProvider;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<TestHarness> {
  const config = loadConfig();
  const db = await createDb(config);
  await runMigrations(db);

  const otp = new CapturingOtpDelivery();
  const push = new RecordingPushProvider();
  const ctx = createContext(db, config, { otpDelivery: otp, pushProvider: push });
  const app = createApp(ctx);

  return { app, ctx, db, config, otp, push, close: () => db.close() };
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
}

/** Completes the full OTP round trip and returns usable credentials. */
export async function signIn(harness: TestHarness, email: string): Promise<TestUser> {
  const agent = supertest(harness.app);

  await agent
    .post('/v1/auth/otp/request')
    .send({ channel: 'email', destination: email, locale: 'en' })
    .expect(202);

  const response = await agent
    .post('/v1/auth/otp/verify')
    .send({
      channel: 'email',
      destination: email,
      code: harness.otp.latestFor(email),
      consentVersion: harness.config.consentVersion,
    })
    .expect((res) => {
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`Sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
      }
    });

  return {
    id: response.body.user.id,
    email,
    accessToken: response.body.tokens.accessToken,
    refreshToken: response.body.tokens.refreshToken,
    auth: { Authorization: `Bearer ${response.body.tokens.accessToken}` },
  };
}

export async function makePlatformAdmin(harness: TestHarness, userId: string): Promise<void> {
  await harness.db.query(`UPDATE users SET role = 'platform_admin' WHERE id = $1`, [userId]);
}

/** Registers a device so the user is actually reachable by push. */
export async function registerDevice(harness: TestHarness, user: TestUser, token = 'ExpoToken[test]'): Promise<void> {
  await supertest(harness.app)
    .post('/v1/account/devices')
    .set(user.auth)
    .send({ token, platform: 'ios', installationId: `install-${user.id}` })
    .expect(204);
}

export async function addVehicle(
  harness: TestHarness,
  user: TestUser,
  plate: string,
  extra: { label?: string; inviteCode?: string } = {},
): Promise<{ id: string; status: string }> {
  const response = await supertest(harness.app)
    .post('/v1/vehicles')
    .set(user.auth)
    .send({ plate, country: 'DE', ...extra })
    .expect(201);
  return { id: response.body.vehicle.id, status: response.body.vehicle.status };
}

export function api(harness: TestHarness) {
  return supertest(harness.app);
}
