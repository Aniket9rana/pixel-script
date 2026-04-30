"use strict";

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { sendToMeta }   = require("./meta");
const { insertEvent }  = require("./clickhouse");

const app  = express();
const PORT = process.env.PORT || 3001;

// Meta config — set in .env
const META_CONFIG = {
  pixelId:        process.env.META_PIXEL_ID,
  accessToken:    process.env.META_ACCESS_TOKEN,
  testEventCode:  process.env.META_TEST_EVENT_CODE || null,
};

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50kb" }));

// ─── POST /event ─────────────────────────────────────────────────────────────
app.post("/event", async (req, res) => {
  // Always respond 202 immediately — never block the caller
  res.status(202).json({ received: true });

  const body = req.body;
  if (!body || !body.event_name) {
    console.warn("[tracker] Dropped — missing event_name");
    return;
  }

  // Assign a server-side event_id if the client didn't send one (dedup key for Meta)
  const payload = {
    ...body,
    event_id:    body.event_id    || crypto.randomUUID(),
    received_at: new Date().toISOString(),
  };

  console.log(`[tracker] ${payload.event_name} | source=${payload.source || "client"} | id=${payload.event_id}`);

  // ── Dual write — Meta CAPI + ClickHouse in parallel ───────────────────────
  // Neither write blocks the other. allSettled never throws.
  const [metaOutcome, chOutcome] = await Promise.allSettled([
    sendToMeta(payload, META_CONFIG),
    insertEvent(payload),
  ]);

  // Meta result
  if (metaOutcome.status === "fulfilled") {
    const m = metaOutcome.value;
    if (m.success) {
      console.log(`[tracker] Meta OK — events_received=${m.trace_id}`);
    } else {
      console.error(`[tracker] Meta failed — ${m.error}`);
    }
  } else {
    console.error(`[tracker] Meta threw — ${metaOutcome.reason}`);
  }

  // ClickHouse result
  if (chOutcome.status === "fulfilled") {
    console.log(`[tracker] ClickHouse OK — ${payload.event_name} written`);
  } else {
    console.error(`[tracker] ClickHouse failed — ${chOutcome.reason?.message}`);
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
const { ping } = require("./clickhouse");

app.get("/health", async (_req, res) => {
  const chAlive = await ping();
  res.json({
    status:                "ok",
    meta_pixel_configured: !!META_CONFIG.pixelId && !!META_CONFIG.accessToken,
    test_mode:             !!META_CONFIG.testEventCode,
    test_event_code:       META_CONFIG.testEventCode || null,
    clickhouse:            chAlive ? "up" : "down",
  });
});

app.listen(PORT, () => {
  console.log(`[tracker] Running on http://localhost:${PORT}`);
  console.log(`  POST /event   — ingest + forward to Meta CAPI`);
  console.log(`  GET  /health  — config check`);
  if (!META_CONFIG.pixelId)     console.warn("[tracker] WARNING: META_PIXEL_ID not set");
  if (!META_CONFIG.accessToken) console.warn("[tracker] WARNING: META_ACCESS_TOKEN not set");
  if (META_CONFIG.testEventCode) console.log(`[tracker] Test mode: ${META_CONFIG.testEventCode}`);
});

module.exports = app; // exported for tests
