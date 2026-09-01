# API reference

Base URL `/v1`. JSON in, JSON out. Authenticated endpoints take
`Authorization: Bearer <accessToken>`.

Errors share one shape:

```json
{ "error": { "code": "rate_limited", "message": "…", "retryAfter": 840 } }
```

`details` is present on validation failures (`code: "validation_failed"`) as an
array of `{ path, message }`. A `429` also sets the `Retry-After` header.

---

## Meta

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/meta/health` | — | Liveness |
| GET | `/meta/ready` | — | Readiness; `503` when the database is unreachable |
| GET | `/meta/catalog` | — | Every selectable value, with `en`/`de` labels |

Clients render categories, timeframes, responses, abuse reasons and supported
countries from `/meta/catalog` rather than hardcoding them, so the vocabulary
can change without an app release.

---

## Auth

Passwordless, over a six-digit code.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/auth/otp/request` | — | `{ channel, destination, locale }` |
| POST | `/auth/otp/verify` | — | `{ channel, destination, code, consentVersion? }` |
| POST | `/auth/refresh` | — | `{ refreshToken }` — rotates; the old token is spent |
| POST | `/auth/logout` | — | `{ refreshToken }` |
| GET | `/auth/me` | ✓ | Also reports `consentRequired` |

`/auth/otp/request` always answers `202`, whether or not the address belongs to
an existing account — otherwise it becomes a way to test which addresses are
registered. When `OTP_ECHO` is on (never in production) the response carries
`devCode`.

`/auth/otp/verify` returns one error for a wrong code, an expired code and an
unknown address, for the same reason.

Access tokens last 15 minutes; refresh tokens 30 days and rotate on every use.
A replayed refresh token is rejected. Account state is re-read on every request,
so a suspension takes effect immediately rather than at token expiry.

---

## Vehicles

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/vehicles` | ✓ | The caller's own vehicles only |
| POST | `/vehicles` | ✓ | `{ plate, country, label?, inviteCode? }` |
| DELETE | `/vehicles/:id` | ✓ | Soft delete; promotes any waiting claim |

`POST` returns `{ vehicle, notice }`. `notice` is non-null when the plate was
already claimed: the new vehicle is `pending`, the incumbent keeps routing, and
a review is opened. Redeeming an `inviteCode` upgrades verification from
`self_declared` to `org_invite`.

---

## Alerts

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/alerts` | ✓ | `{ plate, country, category, timeframe?, locationId? }` |
| GET | `/alerts/sent` | ✓ | Alerts the caller submitted |
| GET | `/alerts/received` | ✓ | Alerts about the caller's vehicles |
| POST | `/alerts/:id/opened` | ✓ | Recipient opened it — feeds the funnel |
| POST | `/alerts/:id/response` | ✓ | `{ response }`, one of the catalog codes |
| POST | `/alerts/block` | ✓ | `{ alertId }` — blocks that sender for that vehicle |

### POST /alerts

Always `202`, always the same shape:

```json
{
  "reference": "PP-7Q2K4M8T",
  "status": "processed",
  "message": "Your report has been processed. If this vehicle is in the ParkPing network, its driver has been notified."
}
```

Identical for a registered plate, an unregistered plate, a blocked reporter and
a suppressed alert. The handler is also padded to `ALERT_MIN_RESPONSE_MS` so
response time does not leak the difference. See ADR-003.

`4xx` responses only ever describe the *reporter's own* situation:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_plate` | Structurally cannot be a plate |
| 400 | `timeframe_not_allowed` | Timeframe on a category where nobody is blocked |
| 403 | — | `locationId` belongs to an organization the caller is not in |
| 429 | `rate_limited` | One of the reporter's own limits |
| 429 | `account_throttled` | Moderation applied a temporary limit |

`GET /alerts/sent` reports `status` as `processed` or `responded` only — never
whether the alert was delivered. `responded` appears because the recipient
chose to answer.

`GET /alerts/received` identifies the sender only as `reporterHandle`, a
pseudonym scoped to that vehicle (ADR-010).

---

## Account

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/account` | ✓ | |
| PATCH | `/account/notification-preferences` | ✓ | Quiet hours and timezone |
| PATCH | `/account/locale` | ✓ | |
| POST | `/account/consent` | ✓ | `{ version }` |
| GET | `/account/export` | ✓ | Full portable export (GDPR Art. 20) |
| POST | `/account/delete` | ✓ | `{ confirm: "DELETE" }` — immediate erasure |
| POST | `/account/devices` | ✓ | Upsert a push token by `installationId` |
| DELETE | `/account/devices/:installationId` | ✓ | |
| POST | `/account/abuse-reports` | ✓ | `{ alertId?, reason }` |

Quiet hours only ever defer courtesy notices ("lights left on"). Anything
meaning someone is blocked is always delivered immediately.

Deletion requires the literal string `DELETE` so a mis-tapped button cannot
erase an account. See ADR-008 for what survives.

---

## Organizations

| Method | Path | Min role | Notes |
| --- | --- | --- | --- |
| GET | `/organizations` | — | Organizations the caller belongs to |
| POST | `/organizations` | — | Creator becomes `owner`; starts unverified |
| GET | `/organizations/:id` | viewer | Members and locations |
| GET | `/organizations/:id/metrics` | viewer | §11 KPIs scoped to this site |
| GET | `/organizations/:id/locations` | viewer | |
| POST | `/organizations/:id/locations` | admin | |
| GET | `/organizations/:id/invites` | admin | |
| POST | `/organizations/:id/invites` | admin | Returns a `joinUrl` for QR onboarding |

Roles are `owner` > `admin` > `viewer`.

Set an invite's `maxUses` to the site's expected fleet size: it doubles as the
denominator of the pilot-activation KPI.

Nothing here can look up a plate. A property manager has exactly the same
blindness as any other reporter.

---

## Platform admin

Requires `role: platform_admin`, set directly in the database.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/metrics` | Network-wide KPIs |
| GET | `/admin/abuse-reports` | `?status=open\|reviewing\|actioned\|dismissed\|all` |
| POST | `/admin/abuse-reports/:id/resolve` | `{ status, action }` |
| GET | `/admin/vehicles/contested` | Pending claims |
| POST | `/admin/vehicles/:id/approve-claim` | Activates it, suspends the incumbent |
| GET | `/admin/organizations` | |
| POST | `/admin/organizations/:id/verification` | `{ verified }` |
| GET | `/admin/audit` | `?limit=` |
| POST | `/admin/retention/purge` | Manual purge |

`action` is one of `none`, `throttle_reporter` (24h), `suspend_reporter`
(revokes sessions), `suspend_vehicle` (stops routing). All are reversible;
none delete data.

---

## Rate limits

| Policy | Limit | Window | Visible? |
| --- | --- | --- | --- |
| Sign-in codes per address | 5 | 1 h | yes |
| Sign-in codes per IP | 20 | 1 h | yes |
| Code attempts per address | 10 | 1 h | yes |
| Alerts per reporter | 10 | 1 h | yes |
| Alerts per reporter | 30 | 24 h | yes |
| Same reporter → same plate | 1 | 15 min | yes |
| Same reporter → same plate | 3 | 24 h | yes |
| Alerts per IP | 20 | 1 h | yes |
| **Alerts to one plate (all reporters)** | 12 | 1 h | **no** |
| **Distinct plates per reporter** | 15 | 24 h | **no** |

The two invisible limits describe third parties. Hitting them produces the
normal `202`. See ADR-006.
