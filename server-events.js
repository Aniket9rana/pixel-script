"use strict";

const crypto = require("crypto");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
let _config = {
  endpoint: process.env.TRACKER_ENDPOINT || "http://localhost:3001/event",
  siteId:   process.env.SITE_ID          || "",
  timeout:  5000,
  debug:    process.env.NODE_ENV !== "production",
};

// ─── PII HASHING ──────────────────────────────────────────────────────────────
// Meta requires SHA-256, lowercased, trimmed — no raw PII ever leaves the server
function sha256(value) {
  if (!value) return null;
  return crypto
    .createHash("sha256")
    .update(String(value).toLowerCase().trim())
    .digest("hex");
}

// Fields that must be hashed before forwarding to Meta CAPI
const PII_FIELDS = ["email", "phone", "first_name", "last_name", "city", "state", "zip", "country", "date_of_birth", "gender"];

function hashPii(userData) {
  if (!userData || typeof userData !== "object") return {};
  const hashed = {};
  for (const [key, value] of Object.entries(userData)) {
    if (value == null) continue;
    hashed[key] = PII_FIELDS.includes(key) ? sha256(value) : value;
  }
  return hashed;
}

// ─── REQUEST CONTEXT EXTRACTION ───────────────────────────────────────────────
// Pass an Express req object — everything is pulled automatically
function extractRequestContext(req) {
  if (!req) return {};

  // Real IP — respect proxy headers (set trust proxy in Express)
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    null;

  const userAgent = req.headers["user-agent"] || null;

  // Meta browser cookies (set by fbevents.js on the client)
  const cookies = req.cookies || parseCookieHeader(req.headers["cookie"] || "");
  const fbp = cookies["_fbp"] || null;

  // _fbc: prefer cookie, fall back to building from fbclid query param
  let fbc = cookies["_fbc"] || null;
  if (!fbc && req.query?.fbclid) {
    fbc = `fb.1.${Date.now()}.${req.query.fbclid}`;
  }

  // UTM params from query string (server-side landing page hits)
  const q = req.query || {};
  const attribution = {
    utm_source:   q.utm_source   || null,
    utm_medium:   q.utm_medium   || null,
    utm_campaign: q.utm_campaign || null,
    utm_term:     q.utm_term     || null,
    utm_content:  q.utm_content  || null,
    fbclid:       q.fbclid       || null,
    gclid:        q.gclid        || null,
    ttclid:       q.ttclid       || null,
    msclkid:      q.msclkid      || null,
  };

  // Drop null attribution fields
  const cleanAttribution = Object.fromEntries(
    Object.entries(attribution).filter(([, v]) => v !== null)
  );

  return {
    ip,
    user_agent: userAgent,
    fbp,
    fbc,
    attribution: Object.keys(cleanAttribution).length ? cleanAttribution : null,
  };
}

// Minimal cookie header parser (used when req.cookies middleware isn't set up)
function parseCookieHeader(cookieStr) {
  return Object.fromEntries(
    cookieStr.split(";").map((c) => {
      const [k, ...rest] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(rest.join("="))];
    }).filter(([k]) => k)
  );
}

// ─── CORE TRACK FUNCTION ──────────────────────────────────────────────────────
/**
 * Track a server-side event.
 *
 * @param {string} eventName   - Meta Standard Event or custom name
 * @param {object} properties  - Event-specific data (value, currency, order_id…)
 * @param {object} [req]       - Express request object (optional but recommended)
 * @param {object} [userData]  - Raw PII: { email, phone, first_name, … } — hashed before sending
 *
 * @example
 * await tracker.track("Purchase", { value: 99, currency: "USD" }, req, { email: req.user.email });
 */
async function track(eventName, properties = {}, req = null, userData = {}) {
  const reqCtx   = extractRequestContext(req);
  const hashedPii = hashPii(userData);

  const payload = {
    event_id:    crypto.randomUUID(),
    event_name:  eventName,
    site_id:     _config.siteId,
    source:      "server",
    ip:          reqCtx.ip          ?? null,
    user_agent:  reqCtx.user_agent  ?? null,
    fbp:         reqCtx.fbp         ?? null,
    fbc:         reqCtx.fbc         ?? null,
    attribution: reqCtx.attribution ?? null,
    user_data:   Object.keys(hashedPii).length ? hashedPii : null,
    properties,
    timestamp:   new Date().toISOString(),
  };

  if (_config.debug) {
    console.log("[server-events] track:", eventName, {
      ip: reqCtx.ip,
      user_data_keys: Object.keys(hashedPii),
      properties,
    });
  }

  return post(_config.endpoint, payload);
}

// ─── HTTP POST ────────────────────────────────────────────────────────────────
async function post(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), _config.timeout);

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
    return { ok: true, status: res.status };
  } catch (err) {
    // Non-blocking — log but never crash the caller
    console.error("[server-events] delivery failed:", err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
function configure(opts = {}) {
  _config = { ..._config, ...opts };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = {
  configure,
  track,
  sha256,   // exported so Task 5 microservice can reuse it
};
