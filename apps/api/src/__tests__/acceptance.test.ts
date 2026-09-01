/**
 * The MVP acceptance criteria from project document §13, as executable tests.
 *
 * Each `describe` block names the criterion it covers. If one of these fails,
 * the MVP does not meet its own definition of done.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addVehicle,
  api,
  createHarness,
  makePlatformAdmin,
  registerDevice,
  signIn,
  type TestHarness,
} from './harness.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('§13.1 — a verified user can add and remove a vehicle plate', () => {
  it('signs in with a one-time code and registers a plate', async () => {
    const user = await signIn(harness, 'anna@example.test');
    const vehicle = await addVehicle(harness, user, 'M AB 1234', { label: 'Golf' });

    expect(vehicle.status).toBe('active');

    const list = await api(harness).get('/v1/vehicles').set(user.auth).expect(200);
    expect(list.body.vehicles).toHaveLength(1);
    expect(list.body.vehicles[0].plate).toBe('M-AB 1234');
    expect(list.body.vehicles[0].label).toBe('Golf');
  });

  it('removes a vehicle and stops routing to it', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    const reporter = await signIn(harness, 'reporter@example.test');
    await registerDevice(harness, owner);
    const vehicle = await addVehicle(harness, owner, 'M AB 1234');

    await api(harness).delete(`/v1/vehicles/${vehicle.id}`).set(owner.auth).expect(204);
    expect((await api(harness).get('/v1/vehicles').set(owner.auth).expect(200)).body.vehicles).toHaveLength(0);

    harness.push.reset();
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    expect(harness.push.sent).toHaveLength(0);
  });

  it('rejects a plate that cannot be one', async () => {
    const user = await signIn(harness, 'anna@example.test');
    const response = await api(harness)
      .post('/v1/vehicles')
      .set(user.auth)
      .send({ plate: 'X', country: 'DE' })
      .expect(400);
    expect(response.body.error.code).toBe('invalid_plate');
  });

  it('does not let a second account take over an active plate', async () => {
    const first = await signIn(harness, 'first@example.test');
    const second = await signIn(harness, 'second@example.test');
    await addVehicle(harness, first, 'M AB 1234');

    const claim = await addVehicle(harness, second, 'M AB 1234');
    expect(claim.status).toBe('pending');

    // The incumbent keeps routing.
    await registerDevice(harness, first);
    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'vehicle_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(first.auth).expect(200);
    expect(received.body.alerts).toHaveLength(1);
    expect((await api(harness).get('/v1/alerts/received').set(second.auth).expect(200)).body.alerts).toHaveLength(0);
  });

  it('promotes a waiting claim once the incumbent removes the vehicle', async () => {
    const first = await signIn(harness, 'first@example.test');
    const second = await signIn(harness, 'second@example.test');
    const original = await addVehicle(harness, first, 'M AB 1234');
    await addVehicle(harness, second, 'M AB 1234');

    await api(harness).delete(`/v1/vehicles/${original.id}`).set(first.auth).expect(204);

    const list = await api(harness).get('/v1/vehicles').set(second.auth).expect(200);
    expect(list.body.vehicles[0].status).toBe('active');
  });
});

describe('§13.2 — a reporter can alert a registered vehicle without seeing personal data', () => {
  it('routes the alert and returns nothing identifying', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');

    const reporter = await signIn(harness, 'reporter@example.test');
    const response = await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M-AB 1234', country: 'DE', category: 'entrance_blocked', timeframe: 'within_10_min' })
      .expect(202);

    expect(response.body.reference).toMatch(/^PP-[0-9A-Z]{8}$/);
    expect(response.body.status).toBe('processed');

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('owner@example.test');
    expect(serialized).not.toContain(owner.id);

    expect(harness.push.sent).toHaveLength(1);
    expect(harness.push.sent[0]!.body).toContain('blocking an entrance');
  });

  it('matches however the reporter typed the plate', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');

    // Each variant needs a distinct reporter to avoid the pair cooldown.
    for (const [index, variant] of ['m-ab-1234', 'M AB 1234', 'MAB1234', 'm.ab 1234'].entries()) {
      const reporter = await signIn(harness, `reporter${index}@example.test`);
      await api(harness)
        .post('/v1/alerts')
        .set(reporter.auth)
        .send({ plate: variant, country: 'DE', category: 'please_move' })
        .expect(202);
    }

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    expect(received.body.alerts).toHaveLength(4);
  });

  it('gives a byte-identical response for registered and unregistered plates', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');

    const reporterA = await signIn(harness, 'a@example.test');
    const reporterB = await signIn(harness, 'b@example.test');

    const registered = await api(harness)
      .post('/v1/alerts')
      .set(reporterA.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const unregistered = await api(harness)
      .post('/v1/alerts')
      .set(reporterB.auth)
      .send({ plate: 'M ZZ 9999', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    // Everything except the random reference must be identical — that is what
    // stops this endpoint from being a plate-registration oracle.
    const { reference: _a, ...registeredRest } = registered.body;
    const { reference: _b, ...unregisteredRest } = unregistered.body;
    expect(registeredRest).toEqual(unregisteredRest);
    expect(Object.keys(registered.body).sort()).toEqual(Object.keys(unregistered.body).sort());
  });

  it("never tells the reporter whether their alert was delivered", async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');

    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M ZZ 9999', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const sent = await api(harness).get('/v1/alerts/sent').set(reporter.auth).expect(200);
    expect(sent.body.alerts).toHaveLength(2);
    for (const alert of sent.body.alerts) {
      expect(alert.status).toBe('processed');
      expect(alert.response).toBeNull();
      expect(Object.keys(alert)).not.toContain('targetUserId');
      expect(Object.keys(alert)).not.toContain('delivered');
    }
  });

  it('shows the recipient a pseudonymous handle rather than the sender', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');

    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'vehicle_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    const alert = received.body.alerts[0];
    expect(alert.reporterHandle).toMatch(/^[0-9A-Z]{4}$/);
    expect(JSON.stringify(alert)).not.toContain('reporter@example.test');
    expect(JSON.stringify(alert)).not.toContain(reporter.id);
  });

  it('refuses a timeframe on a courtesy incident', async () => {
    const reporter = await signIn(harness, 'reporter@example.test');
    const response = await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'lights_left_on', timeframe: 'asap' })
      .expect(400);
    expect(response.body.error.code).toBe('timeframe_not_allowed');
  });
});

describe('§13.3 — the recipient receives the alert and can respond', () => {
  it('accepts a predefined response and shows it to the reporter', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');

    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    const alertId = received.body.alerts[0].id;

    await api(harness).post(`/v1/alerts/${alertId}/opened`).set(owner.auth).expect(204);
    await api(harness)
      .post(`/v1/alerts/${alertId}/response`)
      .set(owner.auth)
      .send({ response: 'on_my_way_5' })
      .expect(204);

    const sent = await api(harness).get('/v1/alerts/sent').set(reporter.auth).expect(200);
    expect(sent.body.alerts[0].status).toBe('responded');
    expect(sent.body.alerts[0].response).toBe('on_my_way_5');
    // Still nothing identifying, even now that the recipient has answered.
    expect(JSON.stringify(sent.body)).not.toContain('owner@example.test');
  });

  it('rejects a second response to the same alert', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    const alertId = received.body.alerts[0].id;

    await api(harness).post(`/v1/alerts/${alertId}/response`).set(owner.auth).send({ response: 'acknowledged' }).expect(204);
    const second = await api(harness)
      .post(`/v1/alerts/${alertId}/response`)
      .set(owner.auth)
      .send({ response: 'already_moved' })
      .expect(409);
    expect(second.body.error.code).toBe('already_answered');
  });

  it('suspends routing when the recipient says it is not their vehicle', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    await api(harness)
      .post(`/v1/alerts/${received.body.alerts[0].id}/response`)
      .set(owner.auth)
      .send({ response: 'not_my_vehicle' })
      .expect(204);

    const vehicles = await api(harness).get('/v1/vehicles').set(owner.auth).expect(200);
    expect(vehicles.body.vehicles[0].status).toBe('suspended');

    // And a subsequent alert no longer reaches them.
    harness.push.reset();
    const other = await signIn(harness, 'other@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(other.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);
    expect(harness.push.sent).toHaveLength(0);
  });

  it('records a failed push instead of silently counting it as delivered', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');

    harness.push.failNext = true;
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const { rows } = await harness.db.query<{ status: string }>('SELECT status FROM push_deliveries');
    expect(rows.map((r) => r.status)).toEqual(['failed']);
  });
});

describe('§13.4 — the system prevents obvious repeated spam', () => {
  it('applies a cooldown between alerts to the same plate from the same reporter', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');

    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const second = await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(429);

    expect(second.body.error.retryAfter).toBeGreaterThan(0);
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('caps how many alerts one reporter can send per hour', async () => {
    const reporter = await signIn(harness, 'reporter@example.test');
    for (let i = 0; i < 10; i += 1) {
      await api(harness)
        .post('/v1/alerts')
        .set(reporter.auth)
        .send({ plate: `M AB ${1000 + i}`, country: 'DE', category: 'please_move' })
        .expect(202);
    }
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 9999', country: 'DE', category: 'please_move' })
      .expect(429);
  });

  it('lets a recipient block a sender, silently, without learning who they are', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');

    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);
    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);

    await api(harness)
      .post('/v1/alerts/block')
      .set(owner.auth)
      .send({ alertId: received.body.alerts[0].id })
      .expect(204);

    // Move past the pair cooldown by rewinding this reporter's rate-limit rows.
    await harness.db.query(`UPDATE rate_limit_hits SET created_at = now() - interval '2 days'`);
    harness.push.reset();

    const afterBlock = await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    // The blocked reporter gets the same neutral answer as always.
    expect(afterBlock.body.status).toBe('processed');
    expect(harness.push.sent).toHaveLength(0);
    expect((await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200)).body.alerts).toHaveLength(1);
  });

  it('flags a reporter who works through many distinct plates', async () => {
    const threshold = harness.config.alerts.enumerationDistinctPlatesPerDay;
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M ZZ 4321');

    const reporter = await signIn(harness, 'scanner@example.test');
    /** Keeps the per-hour caps out of the way so the enumeration guard is what fires. */
    const rewindVolumeLimits = () =>
      harness.db.query(
        `UPDATE rate_limit_hits SET created_at = now() - interval '2 hours'
          WHERE bucket LIKE 'alert_reporter%' OR bucket LIKE 'alert_ip%'`,
      );

    // Exactly at the allowance: still permitted, still unflagged.
    for (let i = 0; i < threshold; i += 1) {
      await api(harness)
        .post('/v1/alerts')
        .set(reporter.auth)
        .send({ plate: `M AB ${2000 + i}`, country: 'DE', category: 'please_move' })
        .expect(202);
      await rewindVolumeLimits();
    }
    expect(
      (await harness.db.query('SELECT 1 FROM abuse_reports WHERE subject_user_id = $1', [reporter.id])).rows,
    ).toHaveLength(0);

    // One distinct plate too many: flagged, and silently suppressed. The
    // reporter sees the same 202 they always see.
    harness.push.reset();
    const response = await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M ZZ 4321', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    expect(response.body.status).toBe('processed');
    expect(harness.push.sent).toHaveLength(0);

    const { rows } = await harness.db.query<{ reason: string; source: string }>(
      'SELECT reason, source FROM abuse_reports WHERE subject_user_id = $1',
      [reporter.id],
    );
    expect(rows).toContainEqual({ reason: 'spam', source: 'system' });
  });

  it('accepts an abuse report and puts it in the moderation queue', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);
    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);

    await api(harness)
      .post('/v1/account/abuse-reports')
      .set(owner.auth)
      .send({ alertId: received.body.alerts[0].id, reason: 'harassment' })
      .expect(201);

    const admin = await signIn(harness, 'admin@example.test');
    await makePlatformAdmin(harness, admin.id);
    const refreshed = await signIn(harness, 'admin@example.test');

    const queue = await api(harness).get('/v1/admin/abuse-reports').set(refreshed.auth).expect(200);
    const report = queue.body.reports.find((r: { reason: string }) => r.reason === 'harassment');
    expect(report).toBeDefined();
    expect(report.subjectUserId).toBe(reporter.id);

    await api(harness)
      .post(`/v1/admin/abuse-reports/${report.id}/resolve`)
      .set(refreshed.auth)
      .send({ status: 'actioned', action: 'throttle_reporter' })
      .expect(204);

    // The throttled reporter is stopped before any lookup happens.
    const blocked = await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M CD 5678', country: 'DE', category: 'please_move' })
      .expect(429);
    expect(blocked.body.error.code).toBe('account_throttled');
  });

  it('rate-limits sign-in codes per address', async () => {
    for (let i = 0; i < 5; i += 1) {
      await api(harness)
        .post('/v1/auth/otp/request')
        .send({ channel: 'email', destination: 'spam@example.test' })
        .expect(202);
    }
    await api(harness)
      .post('/v1/auth/otp/request')
      .send({ channel: 'email', destination: 'spam@example.test' })
      .expect(429);
  });

  it('rejects a wrong sign-in code without revealing whether the address exists', async () => {
    await api(harness)
      .post('/v1/auth/otp/request')
      .send({ channel: 'email', destination: 'anna@example.test' })
      .expect(202);

    const wrongCode = await api(harness)
      .post('/v1/auth/otp/verify')
      .send({ channel: 'email', destination: 'anna@example.test', code: '000000' })
      .expect(400);

    const unknownAddress = await api(harness)
      .post('/v1/auth/otp/verify')
      .send({ channel: 'email', destination: 'nobody@example.test', code: '000000' })
      .expect(400);

    expect(wrongCode.body).toEqual(unknownAddress.body);
  });
});

describe('§13.5 — key events are logged for support, abuse review and KPIs', () => {
  it('writes audit and analytics rows for the core funnel', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    const audit = await harness.db.query<{ action: string }>('SELECT action FROM audit_events');
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('account.created');
    expect(actions).toContain('vehicle.added');
    expect(actions).toContain('alert.submitted');

    const analytics = await harness.db.query<{ name: string }>('SELECT name FROM analytics_events');
    const names = analytics.rows.map((r) => r.name);
    expect(names).toContain('alert_submitted');
    expect(names).toContain('alert_routed');
    expect(names).toContain('push_dispatched');
  });

  it('keeps plates and contact details out of the audit log', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await addVehicle(harness, owner, 'M AB 1234');

    const { rows } = await harness.db.query<{ metadata: unknown }>('SELECT metadata FROM audit_events');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('MAB1234');
    expect(dump).not.toContain('owner@example.test');
  });

  it('drops analytics properties that are not in the taxonomy', async () => {
    await harness.ctx.analytics.track('alert_submitted', null, {
      category: 'please_move',
      // @ts-expect-error deliberately not part of the allowed property list
      plate: 'M AB 1234',
    });

    const { rows } = await harness.db.query<{ properties: Record<string, unknown> }>(
      `SELECT properties FROM analytics_events WHERE name = 'alert_submitted'`,
    );
    expect(rows[0]!.properties).toEqual({ category: 'please_move' });
  });
});

describe('§13.6 — users can revoke consent, delete a vehicle and delete their account', () => {
  it('erases personal data while keeping alert rows unlinkable', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    await api(harness).post('/v1/account/delete').set(owner.auth).send({ confirm: 'DELETE' }).expect(204);

    // The session is dead immediately.
    await api(harness).get('/v1/vehicles').set(owner.auth).expect(401);

    const user = await harness.db.query<{ status: string; contact_hash: string | null; contact_encrypted: string | null }>(
      'SELECT status, contact_hash, contact_encrypted FROM users WHERE id = $1',
      [owner.id],
    );
    expect(user.rows[0]).toMatchObject({ status: 'deleted', contact_hash: null, contact_encrypted: null });

    expect((await harness.db.query('SELECT 1 FROM vehicles WHERE user_id = $1', [owner.id])).rows).toHaveLength(0);
    expect((await harness.db.query('SELECT 1 FROM devices WHERE user_id = $1', [owner.id])).rows).toHaveLength(0);

    // The alert survives for KPI purposes but points at nobody, and the plate
    // it carried has been overwritten.
    const alerts = await harness.db.query<{ target_user_id: string | null; plate_entered_encrypted: string }>(
      'SELECT target_user_id, plate_entered_encrypted FROM alerts',
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]!.target_user_id).toBeNull();
    expect(alerts.rows[0]!.plate_entered_encrypted).toBe('');

    const sent = await api(harness).get('/v1/alerts/sent').set(reporter.auth).expect(200);
    expect(sent.body.alerts[0].plateEntered).toBe('—');
  });

  it('requires an explicit confirmation to delete', async () => {
    const user = await signIn(harness, 'anna@example.test');
    await api(harness).post('/v1/account/delete').set(user.auth).send({ confirm: 'yes' }).expect(400);
    await api(harness).get('/v1/vehicles').set(user.auth).expect(200);
  });

  it('exports the account in a portable form', async () => {
    const user = await signIn(harness, 'anna@example.test');
    await addVehicle(harness, user, 'M AB 1234', { label: 'Golf' });

    const response = await api(harness).get('/v1/account/export').set(user.auth).expect(200);
    expect(response.body.account.contact).toBe('anna@example.test');
    expect(response.body.vehicles).toHaveLength(1);
    expect(response.body.vehicles[0].plate).toBe('M-AB 1234');
    expect(response.headers['content-disposition']).toContain('parkping-export.json');
  });

  it('records a consent version and reports when re-consent is needed', async () => {
    const user = await signIn(harness, 'anna@example.test');
    const me = await api(harness).get('/v1/auth/me').set(user.auth).expect(200);
    expect(me.body.consentRequired).toBe(false);

    await harness.db.query(`UPDATE users SET consent_version = '2020-01-01' WHERE id = $1`, [user.id]);
    const stale = await api(harness).get('/v1/auth/me').set(user.auth).expect(200);
    expect(stale.body.consentRequired).toBe(true);

    await api(harness)
      .post('/v1/account/consent')
      .set(user.auth)
      .send({ version: harness.config.consentVersion })
      .expect(204);
    expect((await api(harness).get('/v1/auth/me').set(user.auth).expect(200)).body.consentRequired).toBe(false);
  });
});

describe('§13.7 — a pilot administrator can onboard an organization and see usage', () => {
  it('creates an organization, invites vehicles and reports metrics', async () => {
    const operator = await signIn(harness, 'facility@example.test');
    const created = await api(harness)
      .post('/v1/organizations')
      .set(operator.auth)
      .send({ name: 'Nordpark Campus', slug: 'nordpark-campus' })
      .expect(201);
    const orgId = created.body.organization.id;
    expect(created.body.organization.verified).toBe(false);

    const location = await api(harness)
      .post(`/v1/organizations/${orgId}/locations`)
      .set(operator.auth)
      .send({ label: 'Building A — underground' })
      .expect(201);

    const invite = await api(harness)
      .post(`/v1/organizations/${orgId}/invites`)
      .set(operator.auth)
      .send({ maxUses: 4 })
      .expect(201);
    expect(invite.body.joinUrl).toContain(invite.body.invite.code);

    const employee = await signIn(harness, 'employee@example.test');
    await registerDevice(harness, employee);
    const vehicle = await addVehicle(harness, employee, 'M AB 1234', {
      inviteCode: invite.body.invite.code,
    });
    expect(vehicle.status).toBe('active');

    const vehicles = await api(harness).get('/v1/vehicles').set(employee.auth).expect(200);
    expect(vehicles.body.vehicles[0].verificationMethod).toBe('org_invite');
    expect(vehicles.body.vehicles[0].organizationName).toBe('Nordpark Campus');

    await api(harness)
      .post('/v1/alerts')
      .set(operator.auth)
      .send({
        plate: 'M AB 1234',
        country: 'DE',
        category: 'entrance_blocked',
        locationId: location.body.location.id,
      })
      .expect(202);

    const metrics = await api(harness)
      .get(`/v1/organizations/${orgId}/metrics?windowDays=30`)
      .set(operator.auth)
      .expect(200);

    expect(metrics.body.metrics.registeredVehicles).toBe(1);
    expect(metrics.body.metrics.alertsSubmitted).toBe(1);
    expect(metrics.body.metrics.localMatchRate).toBe(1);
    expect(metrics.body.metrics.deliveryRate).toBe(1);
    expect(metrics.body.metrics.pilotActivationRate).toBe(0.25);
    expect(metrics.body.categories).toContainEqual({ category: 'entrance_blocked', count: 1 });
  });

  it('keeps an unverified organization name off the notification', async () => {
    const operator = await signIn(harness, 'facility@example.test');
    const created = await api(harness)
      .post('/v1/organizations')
      .set(operator.auth)
      .send({ name: 'Unverified Ltd', slug: 'unverified-ltd' })
      .expect(201);
    const location = await api(harness)
      .post(`/v1/organizations/${created.body.organization.id}/locations`)
      .set(operator.auth)
      .send({ label: 'Gate 1' })
      .expect(201);

    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');

    await api(harness)
      .post('/v1/alerts')
      .set(operator.auth)
      .send({
        plate: 'M AB 1234',
        country: 'DE',
        category: 'entrance_blocked',
        locationId: location.body.location.id,
      })
      .expect(202);

    expect(harness.push.sent[0]!.body).not.toContain('Unverified Ltd');
    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    expect(received.body.alerts[0].organizationName).toBeNull();
    expect(received.body.alerts[0].locationLabel).toBe('Gate 1');
  });

  it('refuses to report from a location the reporter does not belong to', async () => {
    const operator = await signIn(harness, 'facility@example.test');
    const created = await api(harness)
      .post('/v1/organizations')
      .set(operator.auth)
      .send({ name: 'Nordpark', slug: 'nordpark' })
      .expect(201);
    const location = await api(harness)
      .post(`/v1/organizations/${created.body.organization.id}/locations`)
      .set(operator.auth)
      .send({ label: 'Gate 1' })
      .expect(201);

    const outsider = await signIn(harness, 'outsider@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(outsider.auth)
      .send({
        plate: 'M AB 1234',
        country: 'DE',
        category: 'entrance_blocked',
        locationId: location.body.location.id,
      })
      .expect(403);
  });

  it('denies platform-admin endpoints to ordinary accounts', async () => {
    const user = await signIn(harness, 'anna@example.test');
    await api(harness).get('/v1/admin/metrics').set(user.auth).expect(403);
    await api(harness).get('/v1/admin/abuse-reports').set(user.auth).expect(403);
  });
});

describe('platform invariants', () => {
  it('exposes no endpoint that resolves a plate to an account', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await addVehicle(harness, owner, 'M AB 1234');
    const snooper = await signIn(harness, 'snooper@example.test');

    // The obvious shapes an attacker would try.
    await api(harness).get('/v1/vehicles?plate=M+AB+1234').set(snooper.auth).expect(200);
    const list = await api(harness).get('/v1/vehicles').set(snooper.auth).expect(200);
    expect(list.body.vehicles).toHaveLength(0);

    // No such route exists, by design — there is nowhere to ask the question.
    await api(harness).get('/v1/vehicles/lookup?plate=MAB1234').set(snooper.auth).expect(404);
    await api(harness).get('/v1/plates/MAB1234').set(snooper.auth).expect(404);
  });

  it('never stores a plate in a form the database alone can reverse', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await addVehicle(harness, owner, 'M AB 1234');

    const { rows } = await harness.db.query<Record<string, unknown>>('SELECT * FROM vehicles');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('MAB1234');
    expect(dump).not.toContain('M AB 1234');
  });

  it('serves the catalog so clients need no hardcoded vocabulary', async () => {
    const response = await api(harness).get('/v1/meta/catalog').expect(200);
    expect(response.body.categories).toHaveLength(8);
    expect(response.body.responses.map((r: { id: string }) => r.id)).toContain('already_moved');
    expect(response.body.consentVersion).toBe(harness.config.consentVersion);
  });

  it('rotates the refresh token when it is used', async () => {
    const user = await signIn(harness, 'anna@example.test');
    const refreshed = await api(harness)
      .post('/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(200);
    expect(refreshed.body.tokens.refreshToken).not.toBe(user.refreshToken);

    // The spent token cannot be replayed.
    await api(harness).post('/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
  });

  it('purges data past its retention window', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await addVehicle(harness, owner, 'M AB 1234');
    const reporter = await signIn(harness, 'reporter@example.test');
    await api(harness)
      .post('/v1/alerts')
      .set(reporter.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(202);

    await harness.db.query(`UPDATE alerts SET created_at = now() - interval '200 days'`);
    const summary = await harness.ctx.retention.purge();

    expect(summary.alerts).toBe(1);
    expect((await harness.db.query('SELECT 1 FROM alerts')).rows).toHaveLength(0);
    // Cascade removed the delivery rows with it.
    expect((await harness.db.query('SELECT 1 FROM push_deliveries')).rows).toHaveLength(0);
  });
});
