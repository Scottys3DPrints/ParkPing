# Decision record

The project document (§14) lists nine open product decisions and asks for a
"security decision record" as a P0 deliverable. This file records what the MVP
actually does, why, and what is still genuinely open.

A decision marked **Settled** is implemented and tested. A decision marked
**Provisional** is implemented one way so the MVP can exist, but the choice is
cheap to change and should be revisited with pilot data or counsel.

---

## ADR-001 — Plate storage: keyed blind index, not a hash

**Settled.**

The document warns that "plain hashing of license plates" is not sufficient
protection (§8). It is right: the German plate space is on the order of 10^8
possibilities, which a laptop enumerates in seconds, so an unkeyed hash of a
plate is functionally the plate itself.

What we store per vehicle:

| Column | Contents | Purpose |
| --- | --- | --- |
| `plate_index` | `HMAC-SHA256(PLATE_INDEX_PEPPER, "plate:DE " + normalized)` | The only value used for routing |
| `plate_encrypted` | `AES-256-GCM(PLATE_ENCRYPTION_KEY, normalized)` | Showing a plate back to its own owner |

The pepper is a server-side secret that never enters the database. An attacker
holding a full dump cannot build a rainbow table, because the input to the HMAC
is unknown to them. The only remaining oracle is the live API, and that oracle
is rate-limited, flagged for enumeration patterns, and returns identical
responses either way (ADR-003).

*Operational consequence:* the pepper is effectively permanent. Rotating it
invalidates every stored index at once, and there is no rotation path that
avoids re-deriving every vehicle. Back it up separately from the database, and
treat losing it as losing the network.

*Verified by:* `never stores a plate in a form the database alone can reverse`.

---

## ADR-002 — Plate normalization folds umlauts

**Provisional.**

Normalization uppercases, strips every non-alphanumeric character, and folds
umlauts to their base letter (`Ä→A`, `Ö→O`, `Ü→U`). So `LÖ AB 123`, `LO-AB-123`
and `löab123` all reach the same vehicle.

The cost is a theoretical collision between an umlaut district code and its
non-umlaut counterpart. We accept it because the two failure modes are not
symmetric: a normalization *miss* silently breaks the core promise of the
product, with no feedback to either party, whereas a rare *mis-route* delivers
a polite request to move a car to the wrong person — visible, rate-limited,
answerable with "not my vehicle" (which suspends the claim), and reportable.

Revisit if pilot data shows real collisions.

---

## ADR-003 — The reporter learns nothing about registration

**Settled.** *(Answers §14: "Does the reporter learn whether a plate is
registered, or only receive a neutral response?")*

`POST /v1/alerts` returns the same body — a random reference and a fixed
message — for every outcome: routed, no such vehicle, recipient has blocked
this reporter, or suppressed for abuse control. Four internal states, one
external answer.

This is enforced in three places, because any one of them alone leaks:

1. **Body.** `AlertService.submit` funnels every branch to one return.
2. **Timing.** The route pads every response to `ALERT_MIN_RESPONSE_MS`.
   Without this, the extra database and push work on a successful route is
   measurable, and an attacker times the difference to enumerate the network.
3. **History.** `GET /v1/alerts/sent` reports only `processed` or `responded`.
   It never exposes delivery status. `responded` appears only because the
   recipient chose to answer — a disclosure they control.

There is also no endpoint anywhere, for any role including platform admin, that
resolves a plate to an account. Moderation works on alert and report ids
instead, so an internal console cannot be turned into the owner-lookup database
the product promises not to be.

*Verified by:* `gives a byte-identical response for registered and
unregistered plates`, `never tells the reporter whether their alert was
delivered`, `exposes no endpoint that resolves a plate to an account`.

---

## ADR-004 — Reporters need a verified account

**Provisional.** *(Answers §14: "Should reporters need a full verified account,
or can limited anonymous reporting exist?")*

Reporting requires a verified account (email or phone OTP). No anonymous
reporting in the MVP.

Anonymous reporting would make every abuse control in §9 unenforceable: rate
limits, blocks, and the enumeration guard are all keyed to an account, and a
throwaway identity defeats each of them. Verification is the cheapest available
cost to impose on someone working through a list of plates.

The friction is real and it will suppress some legitimate first-time reports.
That trade is worth measuring in the pilot: instrument how many people abandon
at the sign-in step of a report they had already composed. If it is large, the
alternative to evaluate is a device-attested lightweight identity, not
unauthenticated reporting.

---

## ADR-005 — Plate verification is self-declared, with contested-claim handling

**Provisional.** *(Answers §14: "How is a license plate verified as
legitimately controlled by the registering user?")*

Three verification levels exist; the MVP issues the first two:

- `self_declared` — the user typed the plate. No proof.
- `org_invite` — redeemed a pilot site's invite code. The site vouched for them.
- `document_review` — set by an administrator resolving a dispute.

Self-declaration is unavoidable at MVP: ParkPing has no lawful access to a
vehicle registry, and demanding a document upload before the first alert would
destroy activation in exactly the closed pilots the go-to-market depends on.

What makes it tolerable is that a false claim buys the attacker nothing. There
is no lookup, so claiming a plate reveals no information about its real owner.
The only power gained is *receiving* alerts meant for that vehicle — a fairly
useless prize, and one that surfaces immediately:

- Only one account can hold a plate in routing state. A second claim is parked
  as `pending`, and the incumbent keeps routing. The claimant is told plainly.
- A contested claim opens a system abuse report for human review.
- Any recipient can answer `not_my_vehicle`, which suspends the claim, opens a
  review, and promotes the next waiting claim.
- Removing a vehicle promotes the next waiting claim, so selling a car does not
  leave the new owner permanently unroutable.

Before consumer launch, add a stronger signal — a code mailed to the
registration address, or an insurance-document check — for plates that have
ever been contested.

*Verified by:* `does not let a second account take over an active plate`,
`promotes a waiting claim once the incumbent removes the vehicle`, `suspends
routing when the recipient says it is not their vehicle`.

---

## ADR-006 — Rate limits, and which ones are allowed to be visible

**Provisional.** *(Answers §14: "What exact cooldown/rate-limit rules apply per
reporter and target vehicle?")*

The numbers are in `apps/api/src/services/rateLimit.ts` and are a starting
point to tune against pilot data. The structural decision that matters more is
the split:

**Loud limits** reject with `429` and say why. They describe the caller's own
behaviour, so disclosing them reveals nothing about anyone else:
10 alerts/hour and 30/day per reporter, a 15-minute cooldown before the same
reporter may re-alert the same plate, 3/day for that pair, and 20/hour per IP.

**Silent limits** must never be revealed, because hitting one tells you
something about a *third party*. The per-target cap (12 alerts/hour to one
plate from everyone) is silent: a `429` would confirm that other people are
alerting that plate. Exceeding it produces the same neutral `202` as always,
with no routing.

The enumeration guard is silent for the same reason: a reporter who exceeds
`ENUMERATION_DISTINCT_PLATES_PER_DAY` distinct targets in 24 hours is flagged
for review and silently suppressed, and sees an ordinary success response.

Limits are database-backed rather than in-memory, because they are the abuse
controls the acceptance criteria depend on: an in-memory counter resets on
every deploy and does not hold across replicas.

---

## ADR-007 — Retention windows

**Provisional — requires legal sign-off before public launch.**
*(Answers §14: "How long are alert and audit records retained?")*

| Data | Default | Reasoning |
| --- | --- | --- |
| Alerts | 90 days | Long enough to investigate a complaint raised weeks later |
| Audit events | 180 days | Abuse patterns are slower than incidents |
| Analytics events | 365 days | Seasonality in a year of pilot data |
| Rate-limit rows | 48 hours | Only the longest window (24h) is ever read |

All four are environment variables, not constants, because the defensible
answer is a legal question the project document rightly defers to counsel
(§9, §13). The purge runs every six hours and can be triggered manually from
the admin console.

*Verified by:* `purges data past its retention window`.

---

## ADR-008 — Account deletion scrubs, but keeps unlinkable alert rows

**Settled.**

Deletion is immediate, not queued. Destroyed: contact details, vehicles and
their encrypted plates, devices, sessions, block lists, organization
memberships.

Alert rows survive with every link to the person severed — reporter and target
nulled, and the plate they were identified by overwritten with a random,
permanently unmatchable value. They remain because they are the denominator of
the match-rate KPI and part of the abuse audit trail; after scrubbing they
describe an event ("an alert was submitted, it did not route") rather than a
person. The user row is kept as a tombstone carrying no personal data, so audit
entries about the deletion still resolve.

One consequence to be aware of: a reporter's own record of what they typed is
erased when the *recipient* deletes their account, and their sent list shows
`—` for that alert. Two people's rights are in tension there and we resolve it
toward erasure.

*Verified by:* `erases personal data while keeping alert rows unlinkable`.

---

## ADR-009 — Structured vocabulary, served from the API

**Settled.** *(Partially answers §14: "Which incident categories are allowed at
launch and which are too legally sensitive?")*

There is no free text anywhere. Every message either party can send is one of
eight incident categories, four timeframe requests, or six responses. This is
what makes harassment structurally difficult rather than merely prohibited.

The vocabulary is served from `GET /v1/meta/catalog` rather than compiled into
the apps, so a category can be withdrawn without an app-store release — which
matters precisely because *which categories are legally safe* is still open.

Timeframes are attributed in the wire format and in every rendered string: "The
reporter asks if you could come within about 10 minutes." Never a deadline
granted by ParkPing, per §7. Timeframes are only offered on categories where
someone is genuinely blocked.

**Still open for counsel:** `visible_vehicle_issue` and `safety_issue_other`
are the two categories most likely to attract a defamation or harassment
argument, since they assert something about a vehicle's condition. They are
implemented and can be removed from the catalog in one commit.

---

## ADR-010 — Recipients see a scoped pseudonym

**Settled.**

A recipient sees `Sender 7Q2K`, derived as
`HMAC(HANDLE_PEPPER, "handle " + reporterId + " " + vehicleId)`.

They need *some* stable label to recognise a repeat sender and to block them.
Scoping the derivation to the vehicle means the same reporter appears as an
unrelated person to a different vehicle owner, so handles cannot be correlated
across the network to reconstruct one reporter's activity. Blocking works on
the handle; the server resolves it to an account.

A verified organization's name is shown alongside ("via Nordpark Campus") —
but only when verified, because an unverified organization could otherwise
borrow authority it has not earned.

*Verified by:* `shows the recipient a pseudonymous handle rather than the
sender`, `keeps an unverified organization name off the notification`.

---

## Still open — not decided here

These need input this codebase cannot supply:

1. **Which pilot segment to target first** (§14). A go-to-market question for
   the discovery interviews, not an engineering one. The org/invite/location
   model fits any of the listed segments.
2. **What belongs in the first B2B dashboard** (§14). The API exposes the §11
   KPI set scoped per organization; the console renders it. What a paying
   customer actually wants should come from pilot conversations.
3. **Brand, domain and trademark screening** (§14). Untouched.
4. **Legal review** (§9, §13). Retention windows, the processing model,
   category wording, liability language, and law-enforcement request handling
   all need specialist review before public launch. The pieces most likely to
   need changes — retention, the catalog, consent version — are all
   configuration rather than code.
5. **Direct APNs/FCM credentials.** Push currently goes through Expo, which
   fans out to both. `PushProvider` is the seam for swapping in direct
   integrations; nothing in the alert pipeline changes.
