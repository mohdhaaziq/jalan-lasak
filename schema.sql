-- Jalan Lasak — D1 schema. Apply with:
--   npx wrangler d1 execute jalan-lasak --remote --file=schema.sql   (production)
--   npx wrangler d1 execute jalan-lasak --local  --file=schema.sql   (wrangler pages dev)

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '1');

-- Program points: the start and every checkpoint, in display order.
-- eta_min is the schedule: minutes after a group's start it is expected here.
CREATE TABLE IF NOT EXISTS points (
  id      TEXT PRIMARY KEY,
  type    TEXT NOT NULL CHECK (type IN ('start', 'cp')),
  name    TEXT NOT NULL,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL,
  seq     INTEGER NOT NULL,
  eta_min INTEGER
);

-- Suggested routes drawn by the command centre. latlngs is a JSON [[lat,lng],…].
CREATE TABLE IF NOT EXISTS routes (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  latlngs TEXT NOT NULL,
  seq     INTEGER NOT NULL
);

-- One phone per group reports positions under a group id.
-- started_at (ms epoch) is when the group set off; the schedule counts from it.
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  started_at INTEGER
);

-- Every reported fix, kept for the whole event so the trail can be replayed.
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL,
  device      TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  acc         REAL,
  battery     REAL,
  sos         INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'app',   -- 'app' from the phone, 'sms' typed in at the command centre
  recorded_at INTEGER NOT NULL,   -- ms epoch, from the phone's clock
  received_at INTEGER NOT NULL    -- ms epoch, from the server's clock
);
CREATE INDEX IF NOT EXISTS positions_group_time ON positions (group_id, recorded_at DESC);

-- A group confirmed at a point: by the marshal there, or by the command centre
-- relaying a radio call. Independent of GPS and of the phone having signal.
CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL,
  point_id    TEXT NOT NULL,
  source      TEXT NOT NULL,      -- 'marshal' | 'cc'
  device      TEXT,
  note        TEXT,
  recorded_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkins_group ON checkins (group_id, recorded_at);
