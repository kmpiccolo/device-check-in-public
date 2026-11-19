# Device Check-In — Standalone Public Web App

A standalone public web app that kids open in any phone browser — **no Muse app required**.
Rebuilt from the Muse artifact `device-check-in` (v12) so the kids (all under 18, and Muse is
18+ only) can actually use it.

## What it does

- **Devices:** PS5 (60 min/day), Quest 2 (30 min/day), Ale's Laptop (90 min/day).
- **Kids:** Ale, Leo, Gio. **Curfews:** Leo 9:00 PM, Ale 10:00 PM, Gio none.
- **Kid PINs** (one kid can't use another's time): Ale `1111`, Leo `2222`, Gio `3333`.
  The PIN is remembered on the phone; switching kids requires the other kid's PIN.
- **Parent PIN** for the Parent dashboard: default `0000`, changeable in the dashboard.
- **Flow:** Kid opens their per-kid link → enters PIN (first time) → scans the device's
  QR code to start (timer starts at scan) → taps **Check in** to end (no rescan).
  Sessions are **never** auto-ended.
- **Blocked from starting** when: the device is already in use, today's daily limit for
  the device is used up, or the kid is past curfew.
- **Warnings:** 1 beep + banner at 10 min left, 2 beeps + banner at 5 min left
  (before whichever end comes first — daily limit or curfew).
  **Time-up alarm** sounds at the limit/curfew and keeps sounding until check-in.
  **Parent panic button** sounds a *different* alarm (parent-call siren) on the kid's
  phone; it does not end the session; the kid can silence the panic sound or check in.
- **Parent dashboard:** live sessions, per-device/per-kid totals, recent history,
  Alerts list, per-kid **Clear time** buttons + a bulk clear (both with a confirm step),
  parent panic button per active session, set daily limits, change parent PIN, and
  printable/downloadable QR labels for each device.
- **Overdue alerts:** a server-side check (every 60 s and on every state fetch) finds
  active sessions over the daily limit or past curfew and records an overdue alert
  **once per session** (dedupe). Alert names kid, device, amount over
  (e.g. `Leo's PS5 is 0 min over today's 60-minute limit`).
  The parent gets a phone/browser notification **while the parent page is open**
  (background / screen off is fine). If the page is fully closed, no push can reach
  it — that is a hard limit of a web app. The server Alerts list is the backstop:
  alerts are recorded server-side and visible when the parent opens the dashboard.
- **Access control:** the Parent dashboard and each kid link are PIN-gated. Opening a
  link shows **no** session data or controls until the PIN is entered. PINs are
  verified **server-side** (SHA-256 hashes, never sent to the client).
  Pages are non-indexable (`robots.txt` + `noindex` meta + `X-Robots-Tag` header).
- **QR scanning:** client-side `jsQR` via the phone camera, plus a photo-of-label
  fallback button. QR labels encode the device code (e.g. `ps5-c50n`).

## Run it locally

```
npm install           # installs the pg (Postgres) client; only needed for DATABASE_URL mode
node server.js        # listens on PORT (default 3000)
```

**Storage — two modes, same behavior:**
- **No `DATABASE_URL`:** state lives in `data.json` (created on first run with the
  standing limits/PINs above). Delete `data.json` to reset everything to defaults.
  This is fine locally, but on a free host the filesystem is ephemeral, so history
  is lost on restart.
- **`DATABASE_URL` set (e.g. `postgres://user:pass@host:5432/db`):** state lives in
  Postgres, in one `app_state` table (a single JSONB row, id=1). The server creates
  the table on first run and seeds it with the standing defaults. **History survives
  restarts.** If Postgres is unreachable at startup, the server logs the error and
  falls back to `data.json` so the app still runs.

To test the Postgres mode locally, point `DATABASE_URL` at any Postgres
(e.g. a local `postgres` server or a Supabase project) and start the server —
the log line will say `State store: Postgres (DATABASE_URL)`.

## URLs (once deployed)

- Parent: `https://<host>/?view=parent`
- Ale:    `https://<host>/?kid=Ale`
- Leo:    `https://<host>/?kid=Leo`
- Gio:    `https://<host>/?kid=Gio`
- Home:   `https://<host>/` (chooser)

## Deploy it (free, $0) — durable history

Kevin requires history to survive restarts, so the deployed version **must** use a
database. Recommended path (both free, $0 total): **Render** runs the Node server,
**Supabase** (free tier) holds the history in Postgres.

**Accounts needed (all free, email + password signup with kmpiccolo@gmail.com):**
1. **GitHub** — free account; push this folder to a repo (Render deploys from Git).
   (`node_modules/` is gitignored; Render runs `npm install` from `package.json`.)
2. **Supabase** — free account at supabase.com → new project (free tier) → copy the
   Postgres connection string from Project Settings → Database. Use the
   **Transaction Pooler** URI if offered (port 6543, `?sslmode=require`); the direct
   URI (port 5432) also works. This is the `DATABASE_URL`.
3. **Render** — free account at render.com → new **Web Service** (Node) → connect the
   GitHub repo → start command `node server.js` (no build command needed; Render
   runs `npm install` automatically) → add environment variable
   `DATABASE_URL` = the Supabase connection string.
   Render gives a free `https://<name>.onrender.com` URL — that is the public link.

**Caveats:**
- Render's free tier sleeps after inactivity (first load after idle is slow).
- With `DATABASE_URL` set, history lives in Supabase and survives Render restarts.
  Limits, curfews and PINs are stored in the same DB row, so they persist too.
- If `DATABASE_URL` is missing or Postgres is unreachable, the server falls back
  to `data.json` (ephemeral on Render) and logs a warning — history would then be
  lost on restart, so check the Render logs say `State store: Postgres`.

**Alternative (single account, durable history):** Fly.io free tier with a
persistent volume — `data.json` then survives restarts. Fly.io asks for a card
for verification even though it is free, so Render + Supabase is preferred.

## What was verified (local tests, 2026-11-19)

**File mode (no `DATABASE_URL`):**
- Parent PIN `0000` accepted; wrong PIN rejected.
- Leo PIN `2222` accepted.
- Started a Leo session on PS5 by passing the device code `ps5-c50n`
  (exactly what the QR scanner extracts from the label).
- Session ran past a 5-minute test limit; the server recorded the overdue alert
  `Leo's PS5 is 0 min over today's 5-minute limit` and it appeared in the parent
  Alerts list.
- Ended the session via Check in (5 minutes recorded).
- Limits restored to the standing values (PS5 60, Quest 2 30, Laptop 90).
- `robots.txt` serves `Disallow: /`; pages carry `noindex`.

**Postgres mode (`DATABASE_URL` set — the deployed mode, durable history):**
Tested against a local PostgreSQL 16 server. All of the above re-verified, plus:
- Parent PIN `0000` accepted, wrong PIN rejected; Leo PIN `2222` accepted,
  wrong PIN rejected.
- Started a Leo PS5 session; the session row was confirmed in Postgres
  (`app_state` table, JSONB).
- Set the PS5 limit to 5 min, then restarted the server: the active session
  **persisted across the restart**, and the overdue alert fired —
  `Leo's PS5 is 1 min over today's 5-minute limit` — recorded in Postgres and
  shown in the parent Alerts list.
- Ended the session via Check in (6 minutes recorded).
- Restarted the server a second time: the completed session **and** the overdue
  alert were still in the parent history — **history survives restarts**.
- Restored the PS5 limit to 60 and cleared the test data; final state is clean
  with the standing limits (PS5 60, Quest 2 30, Laptop 90).
- The `data.json` fallback path was also re-tested (no `DATABASE_URL`): PINs,
  start, and check-in all work as before.

## Files

- `server.js` — Node server (API + static file serving). Uses `pg` only when
  `DATABASE_URL` is set; otherwise the JSON-file store.
- `package.json` / `package-lock.json` — `pg` dependency; Render runs `npm install`.
- `public/index.html` — the whole frontend (kid view, parent dashboard, scanner,
  labels, PIN gates). Loads `jsQR` and `qrcode` from a CDN.
- `data.json` — the database for local/file mode (auto-created). Delete to reset.
- `.gitignore` — excludes `node_modules/` from the repo.
