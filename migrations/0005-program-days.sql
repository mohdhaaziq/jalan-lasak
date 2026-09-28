-- Multi-day events: the days of one event form a series, each day a program
-- of its own. Group PINs are unique within a program (days share them), no
-- longer across every program. Apply once:
--   npx wrangler d1 execute jalan-lasak --remote --file=migrations/0005-program-days.sql
ALTER TABLE programs ADD COLUMN series_id TEXT;
ALTER TABLE programs ADD COLUMN day INTEGER;
UPDATE programs SET series_id = id WHERE series_id IS NULL;
UPDATE programs SET day = 1 WHERE day IS NULL;
DROP INDEX IF EXISTS groups_pin;
CREATE UNIQUE INDEX IF NOT EXISTS groups_program_pin ON groups (program_id, pin);
