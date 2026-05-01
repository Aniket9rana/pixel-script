"use strict";

// Meta Conversions API — field name mapping + sender
// Docs: https://developers.facebook.com/docs/marketing-api/conversions-api

const META_CAPI_VERSION = process.env.META_CAPI_VERSION || "v25.0";
const META_CAPI_URL = (pixelId, apiVersion = META_CAPI_VERSION) =>
  `https://graph.facebook.com/${apiVersion}/${pixelId}/events`;

// Meta user_data field names differ from our internal names
// Values must be arrays of hashed strings (Meta accepts multiple signals)
const USER_DATA_MAP = {
  email:         "em",
  phone:         "ph",
  first_name:    "fn",
  last_name:     "ln",
  city:          "ct",
  state:         "st",
  zip:           "zp",
  country:       "country",
  date_of_birth: "db",
  gender:        "ge",
  external_id:   "external_id",
};

// Fields that carry through as-is (not wrapped in arrays)
const USER_DATA_PASSTHROUGH = ["client_ip_address", "client_user_agent", "fbp", "fbc"];

// Meta custom_data fields (conversion-specific)
const CUSTOM_DATA_FIELDS = [
  "value", "currency", "content_ids", "content_name", "content_type",
  "content_category", "contents", "order_id", "num_items",
  "search_string", "status", "predicted_ltv",
];

/**
 * Normalize our internal payload into a Meta CAPI event object.
 * Input user_data values are already SHA-256 hashed (done in server-events.js or ingest).
 */
function buildMetaEvent(payload) {
  const {
    event_id, event_name, page_url, ip,
    user_agent, fbp, fbc, user_data = {}, properties = {},
  } = payload;

  // ── user_data block ────────────────────────────────────────────────────────
  const metaUserData = {};

  // Map hashed PII fields → Meta names, wrap in array
  for (const [ourKey, metaKey] of Object.entries(USER_DATA_MAP)) {
    const val = user_data[ourKey];
    if (val) metaUserData[metaKey] = [val];
  }

  // Passthrough fields (not PII, not wrapped in array)
  metaUserData.client_ip_address  = ip          || user_data.client_ip_address  || null;
  metaUserData.client_user_agent  = user_agent  || user_data.client_user_agent  || null;
  metaUserData.fbp                = fbp         || user_data.fbp                || null;
  metaUserData.fbc                = fbc         || user_data.fbc                || null;

  // Drop nulls from user_data
  for (const k of Object.keys(metaUserData)) {
    if (metaUserData[k] === null || metaUserData[k] === undefined) {
      delete metaUserData[k];
    }
  }

  // ── custom_data block ──────────────────────────────────────────────────────
  const customData = {};
  for (const field of CUSTOM_DATA_FIELDS) {
    if (properties[field] !== undefined && properties[field] !== null) {
      customData[field] = properties[field];
    }
  }

  return {
    event_name,
    event_time:       Math.floor(new Date(payload.timestamp || Date.now()).getTime() / 1000),
    event_id:         event_id,
    event_source_url: page_url || null,
    action_source:    payload.source === "server" ? "website" : "website",
    user_data:        metaUserData,
    ...(Object.keys(customData).length && { custom_data: customData }),
  };
}

/**
 * Send one event to Meta Conversions API.
 * Returns { success, trace_id, status, error? }
 */
async function sendToMeta(payload, { pixelId, accessToken, testEventCode, apiVersion } = {}) {
  if (!pixelId || !accessToken) {
    return { success: false, error: "META_PIXEL_ID or META_ACCESS_TOKEN not configured" };
  }

  const metaEvent = buildMetaEvent(payload);
  const body = {
    data: [metaEvent],
    ...(testEventCode && { test_event_code: testEventCode }),
  };

  const url = `${META_CAPI_URL(pixelId, apiVersion)}?access_token=${accessToken}`;

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        success:  false,
        status:   res.status,
        error:    json?.error?.message || "Meta CAPI error",
        meta_raw: json,
      };
    }

    return {
      success:   true,
      status:    res.status,
      trace_id:  json?.events_received,
      meta_raw:  json,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sendToMeta, buildMetaEvent };
