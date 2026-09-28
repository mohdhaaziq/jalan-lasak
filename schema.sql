-- Jalan Lasak — D1 schema. Apply with:
--   npx wrangler d1 execute jalan-lasak --remote --file=schema.sql   (production)
--   npx wrangler d1 execute jalan-lasak --local  --file=schema.sql   (wrangler pages dev)

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '1');

-- One row per event. Every other table carries program_id; nothing is deleted
-- when the next program starts. meta.active_program names the one phones see.
CREATE TABLE IF NOT EXISTS programs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  place      TEXT,
  event_date TEXT,            -- YYYY-MM-DD
  notes      TEXT,
  created_at INTEGER NOT NULL,
  ended_at   INTEGER,         -- ms epoch; set when the program is closed
  seq        INTEGER NOT NULL,
  series_id  TEXT,            -- the days of one event share this (the first day's id)
  day        INTEGER          -- 1, 2, 3 … within the series
);

-- Program points: the start and every checkpoint, in display order.
-- eta_min is the schedule: minutes after a group's start it is expected here.
-- code is the point's secret 6-character checkpoint code, shown by the
-- marshal there; it unlocks the next point on a participant phone offline.
CREATE TABLE IF NOT EXISTS points (
  program_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('start', 'cp')),
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  seq        INTEGER NOT NULL,
  eta_min    INTEGER,
  code       TEXT,
  PRIMARY KEY (program_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS points_code ON points (program_id, code);

-- Suggested routes drawn by the command centre. latlngs is a JSON [[lat,lng],…].
-- A route runs from one point (MULA or a checkpoint) to a checkpoint; a
-- participant phone only receives it once the checkpoint it ends at is revealed.
CREATE TABLE IF NOT EXISTS routes (
  program_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  latlngs    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  from_id    TEXT,
  to_id      TEXT,
  PRIMARY KEY (program_id, id)
);

-- One phone per group reports positions under a group id.
-- started_at (ms epoch) is when the group set off; the schedule counts from it.
-- pin is the group's own random 6-digit login, minted by the server.
CREATE TABLE IF NOT EXISTS groups (
  program_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  started_at INTEGER,
  pin        TEXT,
  PRIMARY KEY (program_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_program_pin ON groups (program_id, pin);   -- days of one event share PINs

-- Every reported fix, kept for the whole event so the trail can be replayed.
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id  TEXT,
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
CREATE INDEX IF NOT EXISTS positions_program_group_time ON positions (program_id, group_id, recorded_at DESC);

-- A group confirmed at a point: by the marshal there, or by the command centre
-- relaying a radio call. Independent of GPS and of the phone having signal.
CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id  TEXT,
  group_id    TEXT NOT NULL,
  point_id    TEXT NOT NULL,
  source      TEXT NOT NULL,      -- 'marshal' | 'cc' | 'qr' (the group's own phone, with the point's code)
  device      TEXT,
  note        TEXT,
  recorded_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkins_group ON checkins (group_id, recorded_at);
CREATE INDEX IF NOT EXISTS checkins_program_group ON checkins (program_id, group_id, recorded_at);
