-- Programs become first-class: every table carries program_id, nothing is
-- deleted between events. Points, routes and groups are rebuilt so their
-- ids are unique per program rather than globally. Apply once:
--   npx wrangler d1 execute jalan-lasak --remote --file=migrations/0004-programs.sql
-- The existing rows become the first program; its closing time moves from
-- meta.ended_at into the program row.

CREATE TABLE IF NOT EXISTS programs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  place      TEXT,
  event_date TEXT,            -- YYYY-MM-DD
  notes      TEXT,
  created_at INTEGER NOT NULL,
  ended_at   INTEGER,         -- ms epoch; set when the program is closed
  seq        INTEGER NOT NULL
);

INSERT OR IGNORE INTO programs (id, name, place, event_date, notes, created_at, ended_at, seq)
VALUES ('p_kkb_2026', 'Jalan Lasak Kuala Kubu Bharu', 'Kuala Kubu Bharu', '2026-09-25', '', 1758153473000,
        (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'ended_at'), 1);

CREATE TABLE points_v4 (
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
INSERT INTO points_v4 (program_id, id, type, name, lat, lng, seq, eta_min, code)
  SELECT 'p_kkb_2026', id, type, name, lat, lng, seq, eta_min, code FROM points;
DROP TABLE points;
ALTER TABLE points_v4 RENAME TO points;
CREATE UNIQUE INDEX IF NOT EXISTS points_code ON points (program_id, code);

CREATE TABLE routes_v4 (
  program_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  latlngs    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  from_id    TEXT,
  to_id      TEXT,
  PRIMARY KEY (program_id, id)
);
INSERT INTO routes_v4 (program_id, id, name, latlngs, seq, from_id, to_id)
  SELECT 'p_kkb_2026', id, name, latlngs, seq, from_id, to_id FROM routes;
DROP TABLE routes;
ALTER TABLE routes_v4 RENAME TO routes;

CREATE TABLE groups_v4 (
  program_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  started_at INTEGER,
  pin        TEXT,
  PRIMARY KEY (program_id, id)
);
INSERT INTO groups_v4 (program_id, id, name, seq, started_at, pin)
  SELECT 'p_kkb_2026', id, name, seq, started_at, pin FROM groups;
DROP TABLE groups;
ALTER TABLE groups_v4 RENAME TO groups;
CREATE UNIQUE INDEX IF NOT EXISTS groups_pin ON groups (pin);   -- unique across programs: an old sheet never opens a new one

ALTER TABLE positions ADD COLUMN program_id TEXT;
UPDATE positions SET program_id = 'p_kkb_2026' WHERE program_id IS NULL;
CREATE INDEX IF NOT EXISTS positions_program_group_time ON positions (program_id, group_id, recorded_at DESC);

ALTER TABLE checkins ADD COLUMN program_id TEXT;
UPDATE checkins SET program_id = 'p_kkb_2026' WHERE program_id IS NULL;
CREATE INDEX IF NOT EXISTS checkins_program_group ON checkins (program_id, group_id, recorded_at);

INSERT OR IGNORE INTO meta (key, value) VALUES ('active_program', 'p_kkb_2026');
DELETE FROM meta WHERE key IN ('event_name', 'ended_at');
