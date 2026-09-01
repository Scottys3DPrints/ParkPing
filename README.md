# ParkPing

**The digital doorbell for cars.** Enter a registered license plate, send a
standardized alert, and let the driver react — without either side learning who
the other is.

This repository implements the MVP scope from `ParkPing_Projekt_Dokument.docx`
(§5 must-have, §13 acceptance criteria).

---

## Quick start

No database to install, no credentials to configure, one command.

```bash
npm ci && npm run demo
```

That seeds a pilot and starts everything:

| | |
| --- | --- |
| **Reporter & owner app** | http://localhost:5174 |
| **Demo console** | http://localhost:5174/demo |
| Admin console | http://localhost:5173 |
| API | http://localhost:4000 |

Use `npm ci` rather than `npm install` — npm's optional-dependency resolution
intermittently drops esbuild's platform binary on Windows, and the lockfile
install is deterministic.

### The 60-second walkthrough

1. Open **http://localhost:5174/s/PARKPNG001** — this is what a stranger sees
   after scanning a windscreen sticker. No account, no install.
2. Pick a reason, send. You get a reference and nothing else.
3. Open **/demo** and read the WhatsApp message the driver actually received.
4. Sign in as `anna@nordpark.test` (the six-digit code appears on screen),
   open **My vehicles**, and reply.
5. Go back to **My reports** — the reply is there. Nothing about either person
   ever crossed over.

Try **/s/PARKPNG004** too: a sticker nobody has claimed, which is the other
half of the story.

| Demo account | Role |
| --- | --- |
| `admin@parkping.test` | Platform administrator |
| `facility@nordpark.test` | Site operator (organization owner) |
| `anna@`, `ben@`, `clara@nordpark.test` | Vehicle users |

Stickers: `PARKPNG001`–`003` claimed, `004`–`005` unclaimed. Org invite code
`NORDPARK1`.

### On a phone

Both dev servers bind to your LAN, so `http://<your-ip>:5174/s/PARKPNG001`
works from a phone on the same Wi-Fi — the QR codes on the owner's sticker page
point there. `npm run demo` prints the address.

The Expo app is a separate, optional surface:

```bash
npm --prefix apps/mobile start
```

---

## What is here

| Path | What it is |
| --- | --- |
| `packages/shared` | Plate and sticker normalization, the incident vocabulary, request schemas, the analytics taxonomy |
| `apps/api` | Node + TypeScript + PostgreSQL. Auth, routing, abuse controls, KPIs, channels |
| `apps/web` | **The reporter and owner surface. Zero install — this is the front door.** |
| `apps/admin` | React console: network health, moderation queue, contested claims, organizations, audit log |
| `apps/mobile` | Expo (React Native) app — one channel among several for vehicle owners |
| `docs/CONCEPT.md` | **Project document v0.2 — the source of truth for what we are building and why** |
| `docs/DECISIONS.md` | Why the security-sensitive things are built the way they are, and the §14 open decisions |
| `docs/API.md` | Endpoint reference |
| `docs/ANALYTICS.md` | Event taxonomy and how each §11 KPI is derived |

The stack follows §8 of the project document. Two notes on it:

**The database.** With no `DATABASE_URL`, the API runs against PGlite — real
PostgreSQL compiled to WebAssembly, embedded in the process. Same SQL, same
engine, nothing to install. Set `DATABASE_URL` and it uses a real server; the
SQL does not change. `docker-compose.yml` is there when you want one.

**Push.** Delivery goes through Expo, which fans out to APNs and FCM behind one
endpoint — the pragmatic choice while the client is an Expo app. `PushProvider`
is the seam for swapping in direct APNs/FCM later; nothing in the alert
pipeline changes.

---

## The privacy model

This is the part worth reading before changing anything.

The product must answer "please tell this driver there is a problem" while
never answering "who owns this plate?". Everything below exists to keep the
second question unanswerable, including by us.

**Plates are stored as a keyed blind index.** The routing key is
`HMAC-SHA256(pepper, country + normalized_plate)`, where the pepper never
enters the database. The project document is explicit that plain hashing is not
enough (§8) and it is right — the German plate space is small enough to
enumerate exhaustively in seconds. Keyed, it cannot be attacked offline at all.
A separate AES-256-GCM ciphertext lets us show a plate back to *its own owner*.

**The alert endpoint is not an oracle.** `POST /v1/alerts` returns the same
body for a registered plate, an unregistered one, a blocked sender, and a
suppressed alert. It is also padded to a fixed minimum duration, because
otherwise the extra work on a successful route is measurable and the timing
difference leaks exactly what the identical body was hiding. The reporter's own
history never shows delivery status either.

**There is no lookup endpoint, for anyone.** Not for users, not for verified
organizations, not for platform administrators. Moderation operates on alert
and report ids, so an internal console cannot be turned into the owner database
the product promises not to be. A test asserts this stays true.

**Neither side sees the other.** The reporter never learns anything about the
recipient. The recipient sees only `Sender 7Q2K` — a pseudonym derived per
(reporter, vehicle) pair, so the same person looks unrelated to a different
vehicle owner and handles cannot be correlated across the network.

**There is no free text.** Eight incident categories, four timeframe requests,
six responses, all served from `/v1/meta/catalog`. Harassment is structurally
hard rather than merely against the rules — and a category can be withdrawn
without an app-store release.

**Timeframes are attributed, never granted.** "The reporter asks if you could
come within about 10 minutes." Never a deadline from ParkPing (§7).

Full reasoning, including the trade-offs accepted, is in
[docs/DECISIONS.md](docs/DECISIONS.md).

---

## Tests

```bash
npm test
```

68 tests. The API suite is organised by the §13 acceptance criteria — each
`describe` block names the criterion it covers, so a failure tells you which
part of the MVP definition is broken. It also asserts the privacy invariants:
identical responses for registered and unregistered plates, no plate recoverable
from a database dump, no plate or contact address in the audit log, and no
lookup endpoint.

The suite runs against a real embedded PostgreSQL with a recording push
provider — no mocked database, no stubbed SQL.

---

## Deploying

1. Provision PostgreSQL in the EU (§8) and set `DATABASE_URL`.
2. Generate the four secrets in `apps/api/.env.example` and set them. **Back up
   `PLATE_INDEX_PEPPER` separately from the database** — rotating it makes every
   registered vehicle unroutable, and there is no migration that avoids that.
3. Set `PUSH_PROVIDER=expo` and `EXPO_ACCESS_TOKEN`.
4. Replace `ConsoleOtpDelivery` with a real email/SMS sender (one interface,
   one method).
5. `npm run build && npm run migrate --workspace @parkping/api`, then
   `node apps/api/dist/index.js`.

Migrations run automatically at startup and are idempotent. Background jobs
(deferred quiet-hours pushes, retention purges) run in-process, which is right
at pilot scale; move them to a single scheduled worker before running more than
one API instance.

---

## Known gaps

Honest about what is not done:

- **The mobile app is typechecked but not run on a device.** It has no simulator
  or device build in this environment. Treat the first `expo start` as the real
  smoke test.
- **OTP delivery is console-only.** No email or SMS provider is wired up.
- **Push is unverified against real APNs/FCM.** The Expo provider is written
  against their documented API but has not been exercised against live
  endpoints.
- **`document_review` verification has no operator flow** beyond an admin
  approving a contested claim. The stronger plate-verification signal discussed
  in ADR-005 is not built.
- **No German UI translation.** The catalog carries `de` strings for every
  incident, timeframe and response; the app screens are English and do not yet
  select on locale.
- **Legal review has not happened** (§13 acceptance criterion 8). Retention
  windows, category wording and consent copy are all placeholders pending
  counsel — deliberately configuration rather than code, so changing them is
  not an engineering task.
