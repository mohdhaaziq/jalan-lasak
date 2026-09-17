-- Databases created before routes had endpoints. Apply once:
--   npx wrangler d1 execute jalan-lasak --remote --file=migrations/0003-route-endpoints.sql
ALTER TABLE routes ADD COLUMN from_id TEXT;
ALTER TABLE routes ADD COLUMN to_id TEXT;
