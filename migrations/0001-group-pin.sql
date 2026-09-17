-- Databases created before group PINs existed. Apply once:
--   npx wrangler d1 execute jalan-lasak --remote --file=migrations/0001-group-pin.sql
ALTER TABLE groups ADD COLUMN pin TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS groups_pin ON groups (pin);
