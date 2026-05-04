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
const EXTRA_ATTRIBUTION_KEYS = new Set([
  "dclid",
  "gbraid",
  "igshid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "sccid",
  "wbraid",
  "yclid",
]);

function hashPii(userData) {
  if (!userData || typeof userData !== "object") return {};
  const hashed = {};
  for (const [key, value] of Object.entries(userData)) {
    if (value == null) continue;
    hashed[key] = PII_FIELDS.includes(key) ? sha256(value) : value;
  }
  return hashed;
}

function normalizeAttributionKey(key) {
  return String(key || "").toLowerCase();
}

function isAttributionKey(key) {
  const normalized = normalizeAttributionKey(key);
  return normalized.startsWith("utm") ||
    normalized.includes("clid") ||
    normalized.includes("click_id") ||
    EXTRA_ATTRIBUTION_KEYS.has(normalized);
}

function captureAttributionFromQuery(query = {}) {
  const captured = {};

  for (const [key, value] of Object.entries(query)) {
    if (!isAttributionKey(key)) continue;

    const firstValue = Array.isArray(value) ? value[0] : value;
    if (firstValue == null || firstValue === "") continue;

    captured[normalizeAttributionKey(key)] = String(firstValue);
  }

  return captured;
}

function getProvidedEventId(properties = {}, options = {}) {
  if (typeof options === "string") return options;
  if (options && (options.eventId || options.event_id)) {
    return options.eventId || options.event_id;
  }
  if (properties && typeof properties === "object" && (properties.event_id || properties.eventId)) {
    return properties.event_id || properties.eventId;
  }
  return crypto.randomUUID();
}

function cleanEventProperties(properties = {}) {
  if (!properties || typeof properties !== "object") return {};

  const cleaned = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === "event_id" || key === "eventId") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

// ─── REQUEST CONTEXT EXTRACTION ───────────────────────────────────────────────
// Pass an Express req object — everything is pulled automatically
function extractRequestContext(req) {
  if (!req) return {};

  const headers = req.headers || {};
  const cleanAttribution = captureAttributionFromQuery(req.query || {});

  // Real IP — respect proxy headers (set trust proxy in Express)
  const ip =
    (headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    null;

  const userAgent = headers["user-agent"] || null;

  // Meta browser cookies (set by fbevents.js on the client)
  const cookies = req.cookies || parseCookieHeader(headers["cookie"] || "");
  const fbp = cookies["_fbp"] || null;

  // _fbc: prefer cookie, fall back to building from fbclid query param
  let fbc = cookies["_fbc"] || null;
  if (!fbc && cleanAttribution.fbclid) {
    fbc = `fb.1.${Date.now()}.${cleanAttribution.fbclid}`;
  }

  const attributionEnvelope = Object.keys(cleanAttribution).length
    ? {
        first_touch: cleanAttribution,
        last_touch:  cleanAttribution,
      }
    : null;

  return {
    ip,
    user_agent: userAgent,
    fbp,
    fbc,
    attribution: attributionEnvelope,
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
async function track(eventName, properties = {}, req = null, userData = {}, options = {}) {
  const reqCtx   = extractRequestContext(req);
  const hashedPii = hashPii(userData);
  const cleanProperties = cleanEventProperties(properties);

  const payload = {
    event_id:    getProvidedEventId(properties, options),
    event_name:  eventName,
    site_id:     _config.siteId,
    source:      "server",
    meta_event:  true,
    ip:          reqCtx.ip          ?? null,
    user_agent:  reqCtx.user_agent  ?? null,
    fbp:         reqCtx.fbp         ?? null,
    fbc:         reqCtx.fbc         ?? null,
    attribution: reqCtx.attribution ?? null,
    user_data:   Object.keys(hashedPii).length ? hashedPii : null,
    properties:   cleanProperties,
    timestamp:   new Date().toISOString(),
  };

  if (_config.debug) {
    console.log("[server-events] track:", eventName, {
      ip: reqCtx.ip,
      user_data_keys: Object.keys(hashedPii),
      properties: cleanProperties,
    });
  }

  const result = await post(_config.endpoint, payload);
  return { ...result, event_id: payload.event_id, payload };
}

// ─── HTTP POST ────────────────────────────────────────────────────────────────
// Client pixel bridge helpers for rendering the matching browser-side event.
function buildClientPixelEvent(eventName, properties = {}, options = {}) {
  return {
    event_name: eventName,
    event_id: getProvidedEventId(properties, options),
    properties: cleanEventProperties(properties),
  };
}

function toScriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderClientPixelSnippet(event) {
  return [
    "<script>",
    "(function(){",
    "if(window.PixelScript&&typeof window.PixelScript.trackMetaEvent==='function'){",
    "window.PixelScript.trackMetaEvent(",
    toScriptSafeJson(event.event_name),
    ",",
    toScriptSafeJson(event.properties),
    ",{eventId:",
    toScriptSafeJson(event.event_id),
    "});",
    "}",
    "})();",
    "</script>",
  ].join("");
}

function buildClientPixelSnippet(eventName, properties = {}, options = {}) {
  return renderClientPixelSnippet(buildClientPixelEvent(eventName, properties, options));
}

async function trackBoth(eventName, properties = {}, req = null, userData = {}, options = {}) {
  const clientPixel = buildClientPixelEvent(eventName, properties, options);
  const server = await track(
    eventName,
    clientPixel.properties,
    req,
    userData,
    { ...options, eventId: clientPixel.event_id }
  );

  return {
    event_id: clientPixel.event_id,
    server,
    client_pixel: clientPixel,
    client_pixel_snippet: renderClientPixelSnippet(clientPixel),
  };
}

// Low-level HTTP delivery to the tracker microservice.
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
  trackBoth,
  buildClientPixelEvent,
  buildClientPixelSnippet,
  sha256,   // exported so Task 5 microservice can reuse it
};
