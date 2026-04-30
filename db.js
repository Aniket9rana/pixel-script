const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "events.db"));

// WAL mode — allows concurrent reads while writing
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT UNIQUE NOT NULL,
    event_name    TEXT NOT NULL,
    site_id       TEXT,
    anon_id       TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    user_id       TEXT,
    page_url      TEXT,
    page_path     TEXT,
    referrer      TEXT,
    utm_source    TEXT,
    utm_medium    TEXT,
    utm_campaign  TEXT,
    utm_term      TEXT,
    utm_content   TEXT,
    fbclid        TEXT,
    gclid         TEXT,
    properties    TEXT,
    consent       TEXT,
    sdk_version   TEXT,
    sequence      INTEGER NOT NULL,
    received_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_anon_id    ON events(anon_id);
  CREATE INDEX IF NOT EXISTS idx_session_id ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_event_name ON events(event_name);
  CREATE INDEX IF NOT EXISTS idx_received_at ON events(received_at);
`);

// sequence = how many events this anon_id has sent before this one + 1
const getNextSequence = db.prepare(`
  SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
  FROM events
  WHERE anon_id = ?
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (
    event_id, event_name, site_id, anon_id, session_id, user_id,
    page_url, page_path, referrer,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    fbclid, gclid,
    properties, consent, sdk_version, sequence, received_at
  ) VALUES (
    @event_id, @event_name, @site_id, @anon_id, @session_id, @user_id,
    @page_url, @page_path, @referrer,
    @utm_source, @utm_medium, @utm_campaign, @utm_term, @utm_content,
    @fbclid, @gclid,
    @properties, @consent, @sdk_version, @sequence, @received_at
  )
`);

// Run insert + sequence lookup in a single transaction
const saveEvent = db.transaction((payload) => {
  const { next_seq } = getNextSequence.get(payload.anon_id);
  insertEvent.run({ ...payload, sequence: next_seq });
  return next_seq;
});

// ─── QUERY HELPERS ────────────────────────────────────────────────────────────

// Full event journey for one user, in order
const getUserJourney = db.prepare(`
  SELECT * FROM events
  WHERE anon_id = ?
  ORDER BY sequence ASC
`);

// All sessions for a user
const getUserSessions = db.prepare(`
  SELECT
    session_id,
    MIN(received_at) AS session_start,
    MAX(received_at) AS session_end,
    COUNT(*)         AS event_count,
    GROUP_CONCAT(event_name, ' → ') AS event_sequence
  FROM events
  WHERE anon_id = ?
  GROUP BY session_id
  ORDER BY session_start ASC
`);

// Recent events across all users
const getRecentEvents = db.prepare(`
  SELECT * FROM events
  ORDER BY id DESC
  LIMIT ?
`);

// Event counts by name
const getEventSummary = db.prepare(`
  SELECT event_name, COUNT(*) AS count
  FROM events
  GROUP BY event_name
  ORDER BY count DESC
`);

// Unique users
const getUserCount = db.prepare(`
  SELECT COUNT(DISTINCT anon_id) AS users FROM events
`);

// All distinct users with their event count and last seen
const getUsers = db.prepare(`
  SELECT
    anon_id,
    user_id,
    COUNT(*)         AS total_events,
    MIN(received_at) AS first_seen,
    MAX(received_at) AS last_seen
  FROM events
  GROUP BY anon_id
  ORDER BY last_seen DESC
  LIMIT ?
`);

module.exports = {
  saveEvent,
  getUserJourney,
  getUserSessions,
  getRecentEvents,
  getEventSummary,
  getUserCount,
  getUsers,
};
