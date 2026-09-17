-- Databases created before checkpoint codes existed. Apply once:
--   npx wrangler d1 execute jalan-lasak --remote --file=migrations/0002-point-code.sql
ALTER TABLE points ADD COLUMN code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS points_code ON points (code);
