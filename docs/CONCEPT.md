# ParkPing — Project Document v0.2

**Status:** supersedes `ParkPing_Projekt_Dokument.docx` (v0.1, 30 August 2026).
**Date:** 1 September 2026.
**Source of truth.** This file is versioned with the code. If a slide, a page or a
conversation disagrees with it, this file wins until it is edited.

---

## 0. What changed since v0.1, and why

v0.1 was right about the problem, the privacy stance and the go-to-market. It
was wrong about one thing, and the mistake was structural rather than
cosmetic: it treated the reporter and the vehicle owner as two roles inside one
app.

Market evidence gathered on 1 September 2026 forced the revision:

| Finding | Consequence |
| --- | --- |
| **AutoSignal** — a plate-scanning app sending anonymous alerts, near-identical to v0.1 — was rejected by Apple under Guideline 1.1.1 as "likely to humiliate, intimidate, or harm a targeted individual". No remediation guidance was given. | The App Store is not a dependable distribution channel for the plate-entry flow. Do not build a plan that requires it. |
| **Alertplates** ships exactly the v0.1 model on iOS today — registered plates, anonymous predefined alerts, no free text, actively maintained. It has two ratings. | The model is legal and approvable, and still does not attract users. Density is the binding constraint, confirming v0.1 §10. |
| **hiddencontact** and at least six competitors sell a QR windscreen sticker: no app on either side, €11.90, anonymous forwarding, paid WhatsApp/SMS channels. | The zero-install model is already commercial in Germany. It is both a competitor and a proof that the mechanism works. |
| **Plext** — plate messaging with free text — is dormant and was reviewed as harassment-enabling. | v0.1's structured-vocabulary decision is the single most valuable thing in the design. Never relax it. |
| iOS web push works in the EU: Apple announced removal of Home Screen web apps for the DMA, then reversed in March 2024. It requires a manual "Add to Home Screen". | Web push is viable for Android, awkward on iOS. Good enough to pilot, not good enough to be the only channel. |

**The revision in one line:** the person reporting must never be asked to
install anything, and the primary way a car joins the network is a sticker its
owner chose to apply — not a plate someone typed.

Everything else in v0.1 survives, including the privacy engineering, which
gets *more* defensible under this model, not less.

---

## 1. Proposition

A privacy-oriented digital doorbell for cars. Someone who needs to reach a
driver — blocked entrance, lights left on, car being towed in ten minutes —
can do so in seconds, without learning who the driver is, and without the
driver's details ever being exposed.

**Positioning stays as v0.1 had it.** Not "report offenders". *Reach the
driver, not the tow truck.* / *Die digitale Klingel für dein Auto.*

**The thing we refuse to be:** a way to find out who owns a car. There is no
endpoint, for any role including our own administrators, that resolves an
identifier to a person. This is not a policy we enforce; it is a capability we
do not have.

---

## 2. The asymmetry, which decides the architecture

Two participants, opposite constraints. Every design decision below follows
from this table.

| | Reporter | Vehicle owner |
| --- | --- | --- |
| Frequency | Once, maybe never again | Ongoing, for years |
| Time available | Seconds, standing in the street | Minutes, at home |
| Motivation | Solving *their* problem, not joining a network | Wants to be reachable |
| Tolerable friction | Almost none | An install is fine |
| Correct surface | **Web page, zero install** | App, PWA, WhatsApp or SMS |

v0.1 put both behind the same install. That install sits precisely on the step
where the funnel is thinnest, and every reporter lost there is lost twice: no
alert is delivered, *and* we never learn that a driver was needed at that
spot — which is the measurement the whole pilot exists to produce.

---

## 3. How a car joins: two paths, different consent, different rules

### 3.1 Sticker (primary)

The owner applies a QR sticker to the windscreen. It carries an opaque code —
never a plate. Scanning opens a web page; the owner is notified on the channel
they chose.

The sticker is doing more work than it appears to:

- **It is affirmative consent, expressed physically.** The owner placed a
  marker on their own property saying "you may contact me about this vehicle".
  That single fact answers the objection that sank AutoSignal — nobody is being
  targeted, they invited it.
- **It removes plate verification entirely.** v0.1 §14 asked how we verify that
  a registrant controls a plate. Under the sticker model the question does not
  arise: possession of the physical sticker is the claim.
- **It removes enumeration risk entirely.** There is no plate space to walk.
  Codes are random and sparse.
- **It tells the reporter it will work** before they act. A plate entry is a
  guess; a sticker is a promise.

### 3.2 Plate (secondary)

For cars in the network without a sticker, and for sites that onboard by
fleet list. This is the code that already exists and it stays: normalized
plate, keyed blind index, neutral responses, rate limits, enumeration guard.

It is no longer the front door.

### 3.3 The consequence for reporter identity

v0.1 §14 asked whether reporters need a verified account. The honest answer is
**it depends on the path**, because the risk differs:

| Path | Reporter identity | Why |
| --- | --- | --- |
| Sticker scan | **Anonymous permitted**, rate-limited by device token and IP | Nothing is enumerable. You cannot guess a sticker code, and you must be physically at the car to read it. The abuse ceiling is low and the friction saved is enormous. |
| Plate entry | **Verified account required** | The plate space is enumerable. Identity is the cost we impose to make walking it expensive. |

This is the decision v0.1 could not make because it had only one path. With
two, the right answer is different for each.

---

## 4. What we are building

### 4.1 Reporter surface — mobile web, no install

One page. Reached by scanning a sticker (`/s/<code>`) or by typing a plate.

- Sticker scan pre-fills the target; the reporter only picks a reason.
- Structured reasons only. No free text, ever.
- A timeframe request may be attached to blocking incidents, always attributed
  to the reporter and never presented as a deadline granted by ParkPing.
- The confirmation is deliberately uninformative: a reference number and
  "if this vehicle is in the network, its driver has been notified".
- Anonymous on the sticker path; sign-in required only for plate entry.

### 4.2 Owner surface — registration and channel choice

- Claim a sticker (first scan claims it) or register a plate.
- Choose how to be reached: WhatsApp, SMS, web push, or the app.
- Reply with one of six predefined responses.
- Block a sender, report abuse, set quiet hours, export or delete everything.

### 4.3 Notification channels — the part v0.1 under-specified

v0.1 named APNs + FCM. That is a delivery mechanism, not a channel strategy.
In Germany, an owner is far more reliably reachable on WhatsApp than through an
app they have not installed.

| Channel | Reach | Cost | Use |
| --- | --- | --- | --- |
| WhatsApp Business | Very high in DE | Per conversation, template-gated | Default for consumers |
| SMS | Universal | ~€0.05–0.09/message | Fallback, and for users who decline WhatsApp |
| Web push | Good on Android, requires Add to Home Screen on iOS | Free | Zero-cost default where it works |
| Native app (Expo) | Only installed users | Free | Power users, B2B site staff |
| Email | Universal | Negligible | Non-urgent only; too slow for a blocked entrance |

Our structured vocabulary maps unusually well onto WhatsApp's approved-template
requirement — eight categories become eight templates. That is a genuine
advantage of the no-free-text decision, not a coincidence.

### 4.4 B2B console — web

Already built. Organizations, locations, invite codes, per-site KPIs,
moderation queue, contested claims, audit log. Extend with sticker batch
management (issue 500 codes to a site, track activation).

### 4.5 Platform administration — web

Already built. Abuse queue with system and human reports, contested claims,
organization verification, audit, retention purge.

---

## 5. What already exists

Honest inventory as of commit `83cb580`.

| Component | State |
| --- | --- |
| API — auth, alerts, vehicles, orgs, abuse, metrics, retention, audit | Built, 47 tests passing against real PostgreSQL |
| Privacy engineering — keyed blind index, neutral responses, timing padding, enumeration guard | Built and tested |
| Structured vocabulary, served from `/v1/meta/catalog` | Built |
| Admin console (React) | Built |
| Mobile app (Expo) — both roles | Built, typechecks, Android bundle verified, **never run on a device** |
| CI — tests, APK build, tagged releases | Built, green |
| Push via Expo | Built behind a `PushProvider` interface |
| OTP delivery | Console only. No email or SMS provider wired |
| Sticker model | **Not built** |
| Reporter web flow | **Not built** |
| WhatsApp / SMS channels | **Not built** |

The API is channel-agnostic by construction, which is why the revision is
affordable: the alert pipeline, abuse controls and KPIs do not care whether the
caller is a browser, an app or a WhatsApp webhook.

---

## 6. Architecture

### 6.1 Principle

One pipeline, several front doors. A sticker code and a plate index are two
ways of resolving to the same internal thing — a **contact target**. Everything
downstream (rate limits, block lists, routing, push, audit, KPIs) is unchanged.

```
sticker code ─┐
              ├─► resolve to contact target ─► existing alert pipeline ─► channel fan-out
plate index ──┘
```

### 6.2 Data model changes

Additive only. No migration of existing rows.

- **`stickers`** — `id`, `code` (opaque, unique, indexed), `organization_id`
  (nullable, for batch issuance), `claimed_by_user_id` (nullable),
  `vehicle_id` (nullable — a sticker may exist without a plate ever being
  given), `status`, `issued_at`, `claimed_at`.
- **`alerts`** — add `target_sticker_id` (nullable) alongside the existing
  `target_plate_index`. Exactly one of the two is set.
- **`notification_channels`** — `user_id`, `kind` (`whatsapp` | `sms` |
  `web_push` | `expo` | `email`), `destination_encrypted`, `verified_at`,
  `priority`. Replaces the current device-only assumption.

A sticker with no plate attached is a first-class case, and a good one: the
owner never has to tell us their plate at all. That is the most privacy-
preserving configuration the product can offer, and it should be the default.

### 6.3 What stays exactly as it is

- Plate storage as `HMAC(pepper, country + normalized)`, never a bare hash.
- Identical response body **and** identical response timing for every alert
  outcome.
- No lookup endpoint, for any role.
- Structured vocabulary served from the API so a category can be withdrawn
  without an app release.
- Retention windows, deletion semantics, audit trail.

---

## 7. Build sequence

Each phase ends in something demonstrable. Do not start the next until the
previous is real.

### Phase 1 — Reporter on the web
Serve the reporter flow as a page: plate or sticker code, reason, send. Calls
the API that exists. Anonymous for sticker, signed-in for plate.
**Done when:** someone with no account and no app can alert a registered
vehicle from a phone browser.

### Phase 2 — Stickers
`stickers` table, `/s/<code>` route, claim-on-first-scan, batch issuance for
organizations. Order fifty physical stickers and put them on real cars.
**Done when:** a stranger scanning a windscreen sticker notifies its owner, and
no plate was involved anywhere in the flow.

### Phase 3 — Channels that actually reach people
Implement `NotificationChannel` for WhatsApp and SMS. Wire a real OTP sender
while in there — it is the same integration.
**Done when:** an owner with no app installed receives an alert on WhatsApp and
replies with a predefined response.

### Phase 4 — Closed pilot, no app store
One site, 200–500 vehicles, stickers handed out at parking-permit onboarding,
reporting on the web.
**Done when:** we have four weeks of match rate, response rate and median
response time from real incidents.

### Phase 5 — Decide about the app
If pilot owners ask for it, ship the Expo app already built as an owner-side
convenience, with real usage to cite in the App Store review notes.
**Done when:** the decision is made on evidence rather than assumption.

---

## 8. Business model

v0.1's B2B2C instinct was right; the sticker sharpens it.

| Segment | Model | Hypothesis |
| --- | --- | --- |
| Consumer | Free | Registration, receiving and replying stay free. Growth, not revenue. |
| Sticker | One-off, near cost | Competitors sell at €11.90. Treat as customer acquisition, not a margin business — we are not a sticker shop. |
| Small B2B site | Monthly SaaS | €49–99/month, stickers bundled |
| Large B2B site | Monthly SaaS | €199–499/month by locations, users, admin features |
| Enterprise | Contract | SSO, API, SLA, security review |

**Where the money actually is:** the site operator managing hundreds of
vehicles who wants a dashboard, an audit trail and fewer escalations. Not the
sticker. hiddencontact already owns the cheap-sticker position and we should
not fight them there.

Pricing remains an unvalidated hypothesis. Paid trials, not surveys.

---

## 9. Go-to-market

Unchanged from v0.1 in target, changed in mechanism.

Priority environments: corporate campuses and employee parking; residential
developments and property managers; universities and hospitals; parking
operators; hotels and event venues; facility-management providers.

The mechanism is now concrete: **stickers are the onboarding artifact.** They
are handed out with the parking permit, at the front desk, in the welcome pack.
A site can onboard hundreds of vehicles in a week without anyone installing
anything, and without us ever holding a plate.

This also routes around the App Store risk for as long as it takes to learn
whether the product works.

---

## 10. Metrics

v0.1 §11 stands, with one important refinement: **match rate must be split by
path**, because the two numbers mean different things.

| KPI | Definition | Reads as |
| --- | --- | --- |
| Sticker delivery rate | Scans that reached an owner | Should approach 100%. Anything less is a bug. |
| **Plate match rate** | Plate entries that found a registered vehicle | The true network-density measure. The number that decides the business. |
| Response rate | Routed alerts answered | Communication works |
| Median response time | Alert to first reply | Escalation actually prevented. Segment by category — a blocked entrance and "lights left on" have different useful windows. |
| Pilot activation | Stickers issued that were claimed | Onboarding quality |
| Unroutable plate entries | Someone needed a driver we could not reach | Demand signal for growth; the most honest measure of the gap |
| 30/90-day retention | Accounts still active | Durability |

The event taxonomy in `docs/ANALYTICS.md` already supports all of these; the
sticker path adds `sticker_issued`, `sticker_claimed`, `sticker_scanned`.

---

## 11. Open decisions

Closed by this revision:

- ~~How is a plate verified?~~ Sticker path: possession. Plate path: self-declared
  with contested-claim handling, and it is no longer the primary route.
- ~~Do reporters need an account?~~ Anonymous on sticker, verified on plate (§3.3).
- ~~Does the reporter learn whether a plate is registered?~~ No. Never did, never will.

Still open:

1. **Sticker economics.** Unit cost, durability, adhesive, whether it must
   survive a windscreen in August. Needs a physical prototype.
2. **WhatsApp unit economics.** Per-conversation pricing against expected alert
   volume per site. Check before promising it to a pilot.
3. **Which categories survive legal review.** `visible_vehicle_issue` and
   `safety_issue_other` assert something about a vehicle's condition and are
   the two most likely to attract a defamation argument.
4. **Retention windows.** 90/180/365 days are placeholders pending counsel.
5. **What the first B2B dashboard must contain.** Comes from pilot
   conversations, not from us.
6. **Name, domain, trademark.** Untouched.

---

## 12. Legal

A licence plate is personal data under the GDPR wherever it can reasonably be
linked to a person; the ECJ's 2023 reasoning on vehicle identification numbers
points that way. The sticker path largely sidesteps this — an opaque code tied
to a self-registered contact is ordinary account data. The plate path does not.

Before any public launch, counsel must review: the plate processing model,
retention windows, category wording, the timeframe-attribution language,
liability, towing-related copy, and law-enforcement request handling.

The pieces most likely to change — retention, categories, consent version — are
all configuration rather than code, deliberately.

---

## 13. Non-goals

We are not building, and should refuse to build:

- Free text between parties, in any form, at any stage.
- A public or private owner lookup.
- Access to official vehicle registries.
- A towing marketplace, payments, fines, or automated legal notices.
- Location tracking, geofencing, or any record of where a vehicle was seen
  beyond what a single alert requires.
- Social features. There is no feed, no profile, no reputation score.

Each of these has been proposed by someone building something adjacent, and
each is a way to turn a useful utility into a surveillance product.

---

## 14. Immediate next actions

| Priority | Task | Output |
| --- | --- | --- |
| P0 | Build the reporter web flow (Phase 1) | A working zero-install report |
| P0 | Order sticker prototypes | Physical samples on real cars |
| P0 | Price WhatsApp Business against expected volume | Go / no-go on the default channel |
| P1 | Sticker data model and `/s/<code>` route | Phase 2 foundation |
| P1 | Identify the first pilot site and its decision maker | Named target |
| P1 | Legal brief for counsel | Reviewed launch wording |
| P2 | Name, domain and trademark screening | Shortlist |

---

## 15. Vision

ParkPing should become a secure communication layer between vehicles and the
people around them — starting with parking conflicts, expanding to broader
vehicle-related alerts, and at no point turning a licence plate into a public
identity directory.

The sticker is how that starts, because it is the version where the driver
chooses to be reachable and everyone can see that they did.
