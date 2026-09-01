/**
 * The v0.2 additions: the sticker path, anonymous reporting, and delivery
 * across channels other than push.
 *
 * The v0.1 acceptance criteria are covered in `acceptance.test.ts` and still
 * apply unchanged — this file only exercises what the revision added.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createHarness,
  issueSticker,
  registerDevice,
  signIn,
  startGuest,
  type TestHarness,
} from './harness.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('v0.2 §3.1 — a sticker is claimed by whoever holds it', () => {
  it('is unclaimed until someone claims it, and then belongs to them', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');

    const beforeClaim = await api(harness).get(`/v1/stickers/${code}`).expect(200);
    expect(beforeClaim.body.sticker.status).toBe('unclaimed');
    expect(beforeClaim.body.sticker.ownedByViewer).toBe(false);

    const claimed = await api(harness)
      .post('/v1/stickers/claim')
      .set(owner.auth)
      .send({ code, label: 'Blue Golf' })
      .expect(201);
    expect(claimed.body.sticker.status).toBe('active');
    expect(claimed.body.sticker.label).toBe('Blue Golf');

    const afterClaim = await api(harness).get(`/v1/stickers/${code}`).set(owner.auth).expect(200);
    expect(afterClaim.body.sticker.ownedByViewer).toBe(true);
  });

  it('refuses a second claim on the same sticker', async () => {
    const code = await issueSticker(harness);
    const first = await signIn(harness, 'first@example.test');
    const second = await signIn(harness, 'second@example.test');

    await api(harness).post('/v1/stickers/claim').set(first.auth).send({ code }).expect(201);
    const conflict = await api(harness)
      .post('/v1/stickers/claim')
      .set(second.auth)
      .send({ code })
      .expect(409);
    expect(conflict.body.error.code).toBe('already_claimed');
  });

  it('accepts a code read off a windscreen with confusable characters', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code }).expect(201);

    // A person reading through glass types O for 0 and I for 1, and adds their
    // own hyphens. All of it must land on the same sticker.
    const mistyped = code.replace(/0/g, 'O').replace(/1/g, 'I').toLowerCase();
    const scan = await api(harness).get(`/v1/stickers/${encodeURIComponent(mistyped)}`).expect(200);
    expect(scan.body.sticker.code).toBe(code);
  });

  it('releases a sticker so the next owner of the car can claim it', async () => {
    const code = await issueSticker(harness);
    const first = await signIn(harness, 'first@example.test');
    const claimed = await api(harness).post('/v1/stickers/claim').set(first.auth).send({ code }).expect(201);

    await api(harness)
      .delete(`/v1/stickers/${claimed.body.sticker.id}`)
      .set(first.auth)
      .expect(204);

    const second = await signIn(harness, 'second@example.test');
    await api(harness).post('/v1/stickers/claim').set(second.auth).send({ code }).expect(201);
  });
});

describe('v0.2 §3.3 — anonymous reporting on the sticker path', () => {
  it('lets someone with no account alert a claimed sticker', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code, label: 'Kombi' }).expect(201);

    const guest = await startGuest(harness);
    const response = await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'entrance_blocked', timeframe: 'within_10_min' })
      .expect(202);

    expect(response.body.status).toBe('processed');
    expect(response.body.reference).toMatch(/^PP-[0-9A-Z]{8}$/);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    expect(received.body.alerts).toHaveLength(1);
    expect(received.body.alerts[0].source).toBe('sticker');
    expect(received.body.alerts[0].targetLabel).toBe('Kombi');
    // Still nothing identifying about the sender.
    expect(JSON.stringify(received.body)).not.toContain(guest.id);
  });

  it('refuses to let a guest report by plate', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness).post('/v1/vehicles').set(owner.auth).send({ plate: 'M AB 1234', country: 'DE' }).expect(201);

    const guest = await startGuest(harness);
    const denied = await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ plate: 'M AB 1234', country: 'DE', category: 'entrance_blocked' })
      .expect(401);
    expect(denied.body.error.message).toMatch(/sign in/i);
  });

  it('requires a session even for the sticker path, so limits have something to bite on', async () => {
    const code = await issueSticker(harness);
    await api(harness)
      .post('/v1/alerts')
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(401);
  });

  it('gives the same neutral answer for an unclaimed sticker as for a claimed one', async () => {
    const claimedCode = await issueSticker(harness);
    const unclaimedCode = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code: claimedCode }).expect(201);

    const guestA = await startGuest(harness);
    const guestB = await startGuest(harness);

    const claimed = await api(harness)
      .post('/v1/alerts')
      .set(guestA.auth)
      .send({ stickerCode: claimedCode, category: 'lights_left_on' })
      .expect(202);
    const unclaimed = await api(harness)
      .post('/v1/alerts')
      .set(guestB.auth)
      .send({ stickerCode: unclaimedCode, category: 'lights_left_on' })
      .expect(202);

    const { reference: _a, ...claimedRest } = claimed.body;
    const { reference: _b, ...unclaimedRest } = unclaimed.body;
    expect(claimedRest).toEqual(unclaimedRest);
  });

  it('tells an honest scanner that a code does not exist at all', async () => {
    const guest = await startGuest(harness);
    // Distinct from "exists but unclaimed": a wrong code is a typo, and saying
    // so reveals nothing about any person.
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: 'ZZZZZZZZZZ', category: 'lights_left_on' })
      .expect(404);
  });

  it('lets a guest see a reply to their own report, and nothing else', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code }).expect(201);

    const guest = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    await api(harness)
      .post(`/v1/alerts/${received.body.alerts[0].id}/response`)
      .set(owner.auth)
      .send({ response: 'on_my_way_5' })
      .expect(204);

    const sent = await api(harness).get('/v1/alerts/sent').set(guest.auth).expect(200);
    expect(sent.body.alerts[0].status).toBe('responded');
    expect(sent.body.alerts[0].response).toBe('on_my_way_5');
    expect(sent.body.alerts[0].source).toBe('sticker');

    // A guest is not an account and cannot act like one.
    await api(harness).get('/v1/alerts/received').set(guest.auth).expect(401);
    await api(harness).get('/v1/vehicles').set(guest.auth).expect(401);
  });

  it('lets an owner block an anonymous sender, silently', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code }).expect(201);

    const guest = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    await api(harness)
      .post('/v1/alerts/block')
      .set(owner.auth)
      .send({ alertId: received.body.alerts[0].id })
      .expect(204);

    await harness.db.query(`UPDATE rate_limit_hits SET created_at = now() - interval '2 days'`);
    harness.push.reset();

    const afterBlock = await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(202);

    expect(afterBlock.body.status).toBe('processed');
    expect(harness.push.sent).toHaveLength(0);
    expect((await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200)).body.alerts).toHaveLength(1);
  });

  it('does not treat many distinct sticker scans as enumeration', async () => {
    // A porter or a courier legitimately scans many stickers a day. Codes
    // cannot be walked, so the guard that applies to plates must not fire here.
    const guest = await startGuest(harness);
    const threshold = harness.config.alerts.enumerationDistinctPlatesPerDay;

    for (let i = 0; i < threshold + 2; i += 1) {
      const code = await issueSticker(harness);
      await api(harness)
        .post('/v1/alerts')
        .set(guest.auth)
        .send({ stickerCode: code, category: 'lights_left_on' })
        .expect(202);
      await harness.db.query(
        `UPDATE rate_limit_hits SET created_at = now() - interval '2 hours'
          WHERE bucket LIKE 'alert_reporter%' OR bucket LIKE 'alert_ip%'`,
      );
    }

    const { rows } = await harness.db.query(
      `SELECT 1 FROM abuse_reports WHERE source = 'system' AND reason = 'spam'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('v0.2 §4.3 — delivery across channels', () => {
  it('reaches an owner on WhatsApp with no app installed', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code, label: 'Golf' }).expect(201);

    await api(harness)
      .post('/v1/account/channels')
      .set(owner.auth)
      .send({ kind: 'whatsapp', destination: '+4915112345678', priority: 1 })
      .expect(201);

    const guest = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(202);

    expect(harness.whatsapp.sent).toHaveLength(1);
    const sent = harness.whatsapp.sent[0]!;
    expect(sent.destination).toBe('+4915112345678');
    expect(sent.message.title).toContain('Golf');
    expect(sent.message.body).toContain('blocking an entrance');
    // No device was ever registered, and none was needed.
    expect(harness.push.sent).toHaveLength(0);
  });

  it('masks the destination and never returns it', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    const added = await api(harness)
      .post('/v1/account/channels')
      .set(owner.auth)
      .send({ kind: 'sms', destination: '+4915112345678' })
      .expect(201);

    expect(added.body.channel.destinationMasked).not.toContain('1234567');
    expect(JSON.stringify(added.body)).not.toContain('+4915112345678');

    const list = await api(harness).get('/v1/account/channels').set(owner.auth).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('+4915112345678');
  });

  it('stores the destination encrypted rather than in the clear', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness)
      .post('/v1/account/channels')
      .set(owner.auth)
      .send({ kind: 'sms', destination: '+4915112345678' })
      .expect(201);

    const { rows } = await harness.db.query('SELECT * FROM notification_channels');
    expect(JSON.stringify(rows)).not.toContain('+4915112345678');
  });

  it('records a channel failure instead of counting it as delivered', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code }).expect(201);
    await api(harness)
      .post('/v1/account/channels')
      .set(owner.auth)
      .send({ kind: 'whatsapp', destination: '+4915112345678' })
      .expect(201);

    harness.whatsapp.failNext = true;
    const guest = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(202);

    const { rows } = await harness.db.query<{ status: string; provider: string }>(
      'SELECT status, provider FROM push_deliveries',
    );
    expect(rows).toContainEqual({ status: 'failed', provider: 'whatsapp' });
  });

  it('tries every channel the owner configured, not just the first', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code }).expect(201);
    await api(harness)
      .post('/v1/account/channels')
      .set(owner.auth)
      .send({ kind: 'whatsapp', destination: '+4915112345678', priority: 1 })
      .expect(201);
    await api(harness)
      .post('/v1/account/channels')
      .set(owner.auth)
      .send({ kind: 'sms', destination: '+4915199999999', priority: 2 })
      .expect(201);

    const guest = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'vehicle_blocked' })
      .expect(202);

    // Someone who registered two ways asked to be reachable, not reachable once.
    expect(harness.whatsapp.sent).toHaveLength(1);
    expect(harness.sms.sent).toHaveLength(1);
  });

  it('exposes rendered messages in the demo outbox', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code, label: 'Kombi' }).expect(201);
    await api(harness)
      .post('/v1/account/channels')
      .set(owner.auth)
      .send({ kind: 'whatsapp', destination: '+4915112345678' })
      .expect(201);

    const guest = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'window_or_door_open' })
      .expect(202);

    const outbox = await api(harness).get('/v1/demo/outbox').expect(200);
    expect(outbox.body.messages).toHaveLength(1);
    expect(outbox.body.messages[0].kind).toBe('whatsapp');
    expect(outbox.body.messages[0].preview).toContain('Kombi');
  });
});

describe('v0.2 — the sticker path in the owner flow', () => {
  it('disables a mis-claimed sticker when the owner says it is not theirs', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await registerDevice(harness, owner);
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code }).expect(201);

    const guest = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(guest.auth)
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(202);

    const received = await api(harness).get('/v1/alerts/received').set(owner.auth).expect(200);
    await api(harness)
      .post(`/v1/alerts/${received.body.alerts[0].id}/response`)
      .set(owner.auth)
      .send({ response: 'not_my_vehicle' })
      .expect(204);

    const scan = await api(harness).get(`/v1/stickers/${code}`).expect(200);
    expect(scan.body.sticker.status).toBe('disabled');

    // And it stops routing.
    harness.push.reset();
    const other = await startGuest(harness);
    await api(harness)
      .post('/v1/alerts')
      .set(other.auth)
      .send({ stickerCode: code, category: 'entrance_blocked' })
      .expect(202);
    expect(harness.push.sent).toHaveLength(0);
  });

  it('releases stickers back to unclaimed when the owner deletes their account', async () => {
    const code = await issueSticker(harness);
    const owner = await signIn(harness, 'owner@example.test');
    await api(harness).post('/v1/stickers/claim').set(owner.auth).send({ code }).expect(201);

    await api(harness).post('/v1/account/delete').set(owner.auth).send({ confirm: 'DELETE' }).expect(204);

    // The sticker is a physical object that outlives the account.
    const scan = await api(harness).get(`/v1/stickers/${code}`).expect(200);
    expect(scan.body.sticker.status).toBe('unclaimed');
    expect(scan.body.sticker.label).toBeNull();
  });

  it('rejects an alert that names both a sticker and a plate', async () => {
    const owner = await signIn(harness, 'owner@example.test');
    const response = await api(harness)
      .post('/v1/alerts')
      .set(owner.auth)
      .send({ stickerCode: 'ABCDEFGHJK', plate: 'M AB 1234', country: 'DE', category: 'please_move' })
      .expect(400);
    expect(response.body.error.code).toBe('validation_failed');
  });
});
