# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Root — SQLite ingestion server
npm start          # production
npm run dev        # watch mode (Node 18+)

# Run tests
node test-pixel.js              # pixel.js unit tests (14 tests)
node test-tracker-modules.js    # server-events + Meta CAPI + ClickHouse unit tests (9 tests)

# Tracker microservice
node tracker/server.js

# ClickHouse (requires Docker)
cd tracker && docker compose up -d  # start
docker compose down                 # stop
```

All test files are plain Node scripts — no test runner. Run them directly and check exit code (0 = pass).

## Architecture

This is a two-layer marketing event tracking system.

### Layer 1 — Client SDK (`pixel.js`)
A self-contained vanilla JS IIFE. No dependencies, no build step. **Self-initializes** when `window.PIXEL_CONFIG` is set before the script loads — no manual `init()` call needed:

```html
<script>
  window.PIXEL_CONFIG = {
    endpoint: 'https://tracker.yourdomain.com/event',
    siteId: 'my-site',
  };
</script>
<script src="/pixel.js"></script>
```

On parse, `pixel.js` merges `window.PIXEL_CONFIG` into internal config, then calls `PixelScript.init()` on `DOMContentLoaded` (or immediately if DOM is already ready). Manual `PixelScript.init(config)` still works and takes precedence. Responsibilities:
- **Attribution capture**: reads all UTM params + ad-network click IDs (`fbclid`, `gclid`, `ttclid`, `msclkid`, `twclid`, etc.) from the URL on every page load. Stores **first touch** in `localStorage` (permanent) and **last touch** in `sessionStorage` (per visit). Both are attached to every event payload under `attribution.first_touch` / `attribution.last_touch`.
- **Identity**: anonymous UUID in `localStorage` + first-party cookie fallback (Safari ITP). Session UUID in `sessionStorage` with 30-min inactivity expiry.
- **Event tracking**: global click delegation, form submit/focus, scroll depth (25/50/75/100%), SPA route changes via `pushState` patch, `visibilitychange`, `beforeunload`.
- **Event routing**: two dispatch functions with different behaviour:
  - `track(eventName, props)` — internal events only. Sends to endpoint. No fbq call. No Meta CAPI forwarding.
  - `trackMetaEvent(eventName, props)` — Meta events. Sets `meta_event: true` on the payload, sends to endpoint, and fires `fbq("track", ...)` (standard) or `fbq("trackCustom", ...)` (custom) simultaneously. The tracker forwards these to Meta CAPI.
- **Page view**: fires as `page_view` (snake_case) via `track()` — endpoint only, no fbq. URL-based auto-detection (`/product/`, `/cart`, etc.) fires an additional `trackMetaEvent` for the matching standard event.
- **Content detection**: on init, queries `[data-track-content]` element. If found, reads `data-content-name/category/ids/type/value/currency` and fires `trackMetaEvent("ViewContent", props)` automatically.
- **Delivery**: `navigator.sendBeacon()` primary, `fetch` fallback, `localStorage` offline buffer flushed on `online` event. Consent gate buffers events until `PixelScript.setConsent("granted")`.

### Layer 2 — Tracker Microservice (`tracker/`)
Express server on port 3001. Single endpoint `POST /event`. Responds 202 immediately, then:

```
POST /event
  └─ 202 Accepted (immediate)
  └─ if payload.meta_event === true:
       sendToMeta(payload, META_CONFIG)   // tracker/meta.js — await, attach result to payload._meta
  └─ insertEvent(payload)                 // tracker/clickhouse.js — always runs
```

The Meta write runs first (awaited) so its result (`success`, `status`, `error`) is available when ClickHouse writes the row. ClickHouse always runs regardless of Meta outcome — events are never lost.

**What goes to Meta CAPI**: only payloads where `meta_event === true`. This flag is set by:
- `trackMetaEvent()` in `pixel.js` (browser)
- `track()` in `server-events.js` (server-side)

Internal events (`page_view`, `click`, `scroll_depth`, `form_field_focus`, `outbound_click`) never set the flag and go to ClickHouse only.

**`tracker/meta.js`** — normalizes the internal payload to Meta CAPI format:
- Maps internal field names to Meta field names (`email → em`, `phone → ph`, etc.)
- PII fields are wrapped in arrays; passthrough fields (`fbp`, `fbc`, `client_ip_address`, `client_user_agent`) are flat
- `custom_data` block only included when `properties` contains recognized conversion fields
- `buildMetaEvent()` is pure (no I/O) — tested independently of `sendToMeta()`

**`tracker/clickhouse.js`** — thin HTTP client over ClickHouse's native HTTP interface (port 8123). No npm dependency — uses built-in `fetch`. `toRow()` flattens the nested payload (including `attribution.first_touch.*` → `ft_*` columns, `_meta.*` → `meta_success/status/error` columns). Inserts via `FORMAT JSONEachRow`.

### Server-Side Utility (`server-events.js`)
Node module for use inside any Express backend. `track(eventName, props, req, userData)` extracts IP/UA/cookies from `req`, hashes PII fields with SHA-256 (using Node `crypto`), sets `meta_event: true`, then POSTs to the tracker microservice. The `sha256()` export is reused by the tracker for consistency.

### Root SQLite Server (`server.js` + `db.js`)
Separate simpler server (port 3001 by default — conflicts with tracker if both run). Stores raw events in SQLite (`events.db`) with per-user sequence numbers. Used for local-only analytics without Meta forwarding. Query endpoints: `GET /users`, `GET /users/:anonId`, `GET /events`, `GET /summary`.

## Payload Shape

Every event (client or server) carries this envelope:

```js
{
  event_id,      // UUID — dedup key for Meta CAPI
  event_name,    // string — snake_case internal (page_view) or Meta Standard Event (Purchase)
  site_id,
  anon_id,       // UUID — permanent anonymous user ID
  session_id,    // UUID — 30-min session
  source,        // "client" | "server"
  meta_event,    // true if this event should be forwarded to Meta CAPI, absent otherwise
  page_url, page_path, referrer,
  attribution: {
    first_touch: { utm_source, utm_medium, ..., fbclid, _fbc, ... },
    last_touch:  { ... }
  },
  fbp, fbc,      // Meta browser/click ID cookies
  ip, user_agent,
  user_data,     // SHA-256 hashed PII { email→em, phone→ph, ... }
  properties,    // event-specific data { value, currency, order_id, ... }
  sdk_version,
  timestamp
}
```

## Custom Events

Use `trackMetaEvent` for any event you want to reach Meta CAPI (standard or custom). Use `track` for internal-only events.

```js
// Browser — reaches Meta CAPI + fbq("trackCustom", ...)
PixelScript.trackMetaEvent("WatchedDemo", { plan: "pro" });

// Browser — ClickHouse only
PixelScript.track("video_buffered", { seconds: 3 });

// HTML attribute — reaches Meta CAPI + fbq("trackCustom", ...)
// <button data-track="WatchedDemo">Watch Demo</button>

// Server-side — always reaches Meta CAPI
await track("WatchedDemo", { plan: "pro" }, req, { email: user.email });
```

No allowlist to maintain — the `meta_event` flag on the payload controls routing end-to-end.

## Environment Variables (tracker/.env)

```
META_PIXEL_ID
META_ACCESS_TOKEN
META_TEST_EVENT_CODE   # set to TEST... string to use Meta's test event tool
CLICKHOUSE_HOST        # default: http://localhost:8123
CLICKHOUSE_DB          # default: analytics
CLICKHOUSE_USER        # default: default
CLICKHOUSE_PASSWORD
PORT                   # default: 3001
```

## Live Site Testing

### Browser Console (no build needed)
Paste into the browser console on any live site:

```js
// Step 1 — set config
window.PIXEL_CONFIG = {
  endpoint: 'https://your-ngrok-url.ngrok-free.app/event',
  siteId: 'your-site',
  debug: true  // logs every event to console
};

// Step 2 — paste full pixel.js contents

// Step 3 — grant consent to flush buffered events
PixelScript.setConsent('granted');
```

With `debug: true`, every event logs to console as `[PixelScript] ...` regardless of whether delivery succeeds.

### Exposing the local tracker (ngrok)
The tracker runs on `localhost:3001` and needs a public URL for live site testing:

```bash
# Download ngrok binary (WSL — snap doesn't work)
curl -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip
unzip ngrok.zip

# Authenticate (free account at ngrok.com)
./ngrok config add-authtoken YOUR_TOKEN

# Expose tracker
./ngrok http 3001
```

Visit the ngrok URL in your browser once to bypass the warning page, then use it as the endpoint.

### What works without optional services
- **No Meta credentials** — tracker receives events but skips Meta CAPI forwarding
- **No ClickHouse/Docker** — tracker receives events but skips DB storage
- **No tracker running** — pixel buffers events in `localStorage`, retries on `online` event

### Setting up Meta CAPI
Create `tracker/.env`:

```
META_PIXEL_ID=your_pixel_id
META_ACCESS_TOKEN=your_access_token
META_TEST_EVENT_CODE=TEST...  # optional — use Meta's test event tool
```

Find Pixel ID and Access Token in Meta Events Manager → your pixel → Settings.

## ClickHouse Schema Notes

Table `analytics.events` — partitioned by `toYYYYMM(received_at)`, ordered by `(received_at, event_name, anon_id)`, 13-month TTL. Attribution columns are flattened: `ft_*` = first touch, `lt_*` = last touch. `meta_success`, `meta_status`, `meta_error` columns record the Meta CAPI outcome for each event. Schema defined in `tracker/init.sql`, auto-applied via Docker `docker-entrypoint-initdb.d`.

### Querying failed Meta events
```sql
SELECT event_id, event_name, meta_error, received_at
FROM analytics.events
WHERE meta_event = true
  AND meta_success != true
ORDER BY received_at DESC
```
