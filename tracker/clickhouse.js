"use strict";

// ClickHouse HTTP interface client — no npm dependency, uses built-in fetch
// Docs: https://clickhouse.com/docs/en/interfaces/http

const CH_CONFIG = {
  host:     process.env.CLICKHOUSE_HOST || "http://localhost:8123",
  db:       process.env.CLICKHOUSE_DB   || "analytics",
  user:     process.env.CLICKHOUSE_USER || "default",
  password: process.env.CLICKHOUSE_PASSWORD || "",
};

// ─── RAW QUERY ────────────────────────────────────────────────────────────────
async function query(sql, params = {}) {
  const url = new URL("/", CH_CONFIG.host);
  url.searchParams.set("database", CH_CONFIG.db);
  url.searchParams.set("user",     CH_CONFIG.user);
  if (CH_CONFIG.password) url.searchParams.set("password", CH_CONFIG.password);

  const res = await fetch(url.toString(), {
    method:  "POST",
    headers: { "Content-Type": "text/plain" },
    body:    sql,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse error ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// ─── PING ─────────────────────────────────────────────────────────────────────
async function ping() {
  try {
    const res = await fetch(new URL("/ping", CH_CONFIG.host).toString());
    return res.ok;
  } catch {
    return false;
  }
}

// ─── NORMALIZE PAYLOAD → FLAT ROW ─────────────────────────────────────────────
function toRow(payload) {
  const ft  = payload.attribution?.first_touch || {};
  const lt  = payload.attribution?.last_touch  || {};

  // ClickHouse UUID fields need non-null valid UUIDs
  const safeUUID = (v) => {
    if (!v) return "00000000-0000-0000-0000-000000000000";
    // basic UUID format check
    return /^[0-9a-f-]{36}$/i.test(v) ? v : "00000000-0000-0000-0000-000000000000";
  };

  return {
    event_id:        safeUUID(payload.event_id),
    event_name:      String(payload.event_name || "unknown").slice(0, 200),
    site_id:         String(payload.site_id    || "").slice(0, 100),
    source:          String(payload.source     || "client").slice(0, 20),

    anon_id:         safeUUID(payload.anon_id),
    session_id:      payload.session_id ? safeUUID(payload.session_id) : null,
    user_id:         payload.user_id  || null,

    page_url:        String(payload.page_url  || "").slice(0, 2048),
    page_path:       String(payload.page_path || "").slice(0, 1024),
    referrer:        payload.referrer || null,

    ft_utm_source:   ft.utm_source   || null,
    ft_utm_medium:   ft.utm_medium   || null,
    ft_utm_campaign: ft.utm_campaign || null,
    ft_fbclid:       ft.fbclid       || null,
    ft_gclid:        ft.gclid        || null,
    ft_ttclid:       ft.ttclid       || null,
    ft_msclkid:      ft.msclkid      || null,

    lt_utm_source:   lt.utm_source   || null,
    lt_utm_medium:   lt.utm_medium   || null,
    lt_utm_campaign: lt.utm_campaign || null,
    lt_fbclid:       lt.fbclid       || null,
    lt_gclid:        lt.gclid        || null,
    lt_ttclid:       lt.ttclid       || null,
    lt_msclkid:      lt.msclkid      || null,

    fbp:             payload.fbp        || null,
    fbc:             payload.fbc        || null,
    ip:              payload.ip         || null,
    user_agent:      payload.user_agent || null,

    meta_success:    payload._meta?.success ?? null,
    meta_status:     payload._meta?.status  ?? null,
    meta_error:      payload._meta?.error   || null,

    properties:      JSON.stringify(payload.properties || {}),
    sdk_version:     payload.sdk_version || null,
    received_at:     payload.received_at || payload.timestamp || new Date().toISOString(),
  };
}

// ─── ESCAPE FOR JSONEachRow FORMAT ────────────────────────────────────────────
// ClickHouse JSONEachRow: send one JSON object per line
function escapeRow(row) {
  // Convert JS null → ClickHouse null handling: just send null as JSON null
  return JSON.stringify(row);
}

// ─── INSERT ONE EVENT ─────────────────────────────────────────────────────────
async function insertEvent(payload) {
  const row  = toRow(payload);
  const json = escapeRow(row);

  await query(
    `INSERT INTO events FORMAT JSONEachRow\n${json}`
  );
}

// ─── INSERT BATCH (for future queue worker use) ───────────────────────────────
async function insertBatch(payloads) {
  if (!payloads.length) return;
  const rows = payloads.map((p) => escapeRow(toRow(p))).join("\n");
  await query(`INSERT INTO events FORMAT JSONEachRow\n${rows}`);
}

module.exports = { insertEvent, insertBatch, ping, query, toRow };
