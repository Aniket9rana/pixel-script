const express = require("express");
const cors = require("cors");
const {
  saveEvent,
  getUserJourney,
  getUserSessions,
  getRecentEvents,
  getEventSummary,
  getUserCount,
  getUsers,
} = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50kb" }));

// ─── INGEST ───────────────────────────────────────────────────────────────────
app.post("/e", (req, res) => {
  // Respond immediately — never block the client
  res.status(202).end();

  const body = req.body;

  if (!body || !body.event_id || !body.anon_id || !body.session_id) {
    return; // silently drop malformed payloads
  }

  try {
    const payload = {
      event_id:     String(body.event_id).slice(0, 64),
      event_name:   String(body.event_name || "unknown").slice(0, 100),
      site_id:      body.site_id ? String(body.site_id).slice(0, 100) : null,
      anon_id:      String(body.anon_id).slice(0, 64),
      session_id:   String(body.session_id).slice(0, 64),
      user_id:      body.user_id ? String(body.user_id).slice(0, 128) : null,
      page_url:     body.page_url ? String(body.page_url).slice(0, 2048) : null,
      page_path:    body.page_path ? String(body.page_path).slice(0, 1024) : null,
      referrer:     body.referrer ? String(body.referrer).slice(0, 2048) : null,
      utm_source:   body.utm_source || null,
      utm_medium:   body.utm_medium || null,
      utm_campaign: body.utm_campaign || null,
      utm_term:     body.utm_term || null,
      utm_content:  body.utm_content || null,
      fbclid:       body.fbclid || null,
      gclid:        body.gclid || null,
      properties:   body.properties ? JSON.stringify(body.properties) : null,
      consent:      body.consent || null,
      sdk_version:  body.sdk_version || null,
      received_at:  body.timestamp || new Date().toISOString(),
    };

    const seq = saveEvent(payload);
    console.log(`[${payload.received_at}] ${payload.event_name} | user=${payload.anon_id.slice(0, 8)}… seq=${seq}`);
  } catch (err) {
    console.error("Insert error:", err.message);
  }
});

// ─── QUERY API ────────────────────────────────────────────────────────────────

// GET /users — list all users with stats
app.get("/users", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const rows = getUsers.all(limit);
  res.json({ users: rows, total: getUserCount.get().users });
});

// GET /users/:anonId — full event journey for one user
app.get("/users/:anonId", (req, res) => {
  const events = getUserJourney.all(req.params.anonId);
  const sessions = getUserSessions.all(req.params.anonId);

  if (!events.length) return res.status(404).json({ error: "User not found" });

  // Parse properties JSON for readability
  const parsed = events.map((e) => ({
    ...e,
    properties: e.properties ? JSON.parse(e.properties) : null,
  }));

  res.json({
    anon_id: req.params.anonId,
    total_events: events.length,
    sessions,
    journey: parsed,
  });
});

// GET /events — recent events
app.get("/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const rows = getRecentEvents.all(limit).map((e) => ({
    ...e,
    properties: e.properties ? JSON.parse(e.properties) : null,
  }));
  res.json({ events: rows });
});

// GET /summary — event counts + user count
app.get("/summary", (req, res) => {
  res.json({
    users: getUserCount.get().users,
    event_counts: getEventSummary.all(),
  });
});

app.listen(PORT, () => {
  console.log(`PixelScript server running on http://localhost:${PORT}`);
  console.log(`  POST /e          — ingest events`);
  console.log(`  GET  /summary    — event counts + user count`);
  console.log(`  GET  /users      — list all users`);
  console.log(`  GET  /users/:id  — full journey for one user`);
  console.log(`  GET  /events     — recent events`);
});
