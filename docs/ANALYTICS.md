# Measurement plan

The §15 P1 deliverable: an event taxonomy, and how each §11 KPI is derived
from it.

## Rules

1. **No personal data in properties.** Only the properties in
   `ALLOWED_ANALYTICS_PROPERTIES` are ever written; `AnalyticsService` drops
   anything else *and logs that it did*. This is enforced on the write path
   rather than left to call-site discipline, so a debug field added in six
   months cannot quietly start recording plates.
2. **No plates, ever** — not raw, not normalized, not hashed. Vehicles appear
   only as opaque ids.
3. **Names are `object_verb_past_tense`,** so a funnel reads in order.
4. **Every KPI in §11 must be derivable from these events alone.**

## Events

### Onboarding
| Event | Fired when |
| --- | --- |
| `otp_requested` | A sign-in code is sent |
| `otp_verified` | A code is accepted |
| `otp_failed` | A code is rejected |
| `account_created` | First successful verification for an address |
| `consent_accepted` | Terms version accepted |

### Vehicles
| Event | Fired when |
| --- | --- |
| `vehicle_add_started` | Client-side: the add form is opened |
| `vehicle_added` | A vehicle row is created (`status` says `active` or `pending`) |
| `vehicle_rejected` | Plate failed normalization (`reason` says why) |
| `vehicle_contested` | The plate was already actively claimed |
| `vehicle_removed` | User removed a vehicle |
| `invite_redeemed` | An organization invite code was used |

### Reporting
| Event | Fired when |
| --- | --- |
| `alert_compose_started` | Client-side: the report form is opened |
| `alert_submitted` | An alert row is written — **every** submission |
| `alert_routed` | It matched an active vehicle |
| `alert_unroutable` | It did not (or was suppressed; see `reason`) |
| `alert_blocked_by_rate_limit` | Rejected by one of the reporter's limits |
| `alert_blocked_by_block_list` | The recipient had blocked this sender |

### Delivery
| Event | Fired when |
| --- | --- |
| `push_dispatched` | Handed to the push provider |
| `push_delivered` | At least one device accepted it |
| `push_failed` | Every device failed, or there was no active device |
| `alert_opened` | The recipient opened it in the app |
| `alert_responded` | The recipient replied (`durationMs` = time to reply) |

### Trust & safety
`abuse_reported`, `reporter_blocked`, `enumeration_suspected`,
`moderation_action_taken`.

### Lifecycle
`account_export_requested`, `account_deletion_requested`, `account_deleted`,
`retention_purge_completed`.

`account_deleted` is written with a null user id — recording *which* account was
just erased against that erasure would defeat it.

---

## KPI derivations

The dashboard computes these from the operational tables rather than from the
event stream (so a corrected row is reflected immediately), but each is
reproducible from events alone for an external analytics tool.

| KPI (§11) | Derivation |
| --- | --- |
| Registered vehicles | Vehicles not `removed` |
| **Local match rate** | `alert_routed / alert_submitted` |
| Delivery rate | Alerts with ≥1 successful push / alerts with ≥1 push attempt |
| Response rate | `alert_responded / alert_routed` |
| Median response time | Median `durationMs` on `alert_responded` |
| Pilot activation | Vehicles registered via an org / sum of that org's invite `maxUses` |
| B2B conversion | Not instrumented — a CRM number, not a product one |
| 30/90-day retention | Accounts older than N days with activity since |

Two denominator choices are deliberate and worth knowing:

**Match rate counts suppressed alerts.** Alerts we refused to route for abuse
control stay in the denominator. Excluding them would flatter the number by
hiding the cases where the product declined to work.

**Response rate divides by routed, not delivered.** A recipient with
notifications switched off can still open the app and reply, and that reply is
exactly what this KPI observes. Dividing by delivered would score those as
zero. Push reliability is measured separately by delivery rate.

Rates are `null`, never `0`, when the denominator is empty. "0% delivered" and
"nothing was attempted" lead to opposite conclusions about a pilot.

---

## What to watch in the first pilot

The project document names network density as the central commercial risk
(§10). In order of what should worry you:

1. **Local match rate.** The single number that says whether the network is
   worth anything at that site. A perfect delivery rate over a 5% match rate
   still means the product does not work there.
2. **Pilot activation.** Match rate is downstream of it. If invited vehicles do
   not register, nothing else can be fixed by engineering.
3. **Median response time.** The product's actual claim is preventing
   escalation. A reply that arrives after the tow truck did not prevent
   anything — segment this by incident category, since a blocked entrance and
   "lights left on" have very different useful windows.
4. **`alert_unroutable` with `reason: null`.** A genuine miss: someone tried to
   reach a vehicle that was not in the network. This is the demand signal for
   consumer growth, and the most honest measure of the gap.
5. **`vehicle_rejected` reasons.** A spike in `too_short`/`too_long` for one
   country usually means the plate format needs work, not that users are
   careless.
