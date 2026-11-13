-- A checkpoint with no marshal: the group's phone opens the next one by
-- itself when GPS puts it at the point. Apply once:
--   npx wrangler d1 execute jalan-lasak --remote --file=migrations/0006-point-unmanned.sql
ALTER TABLE points ADD COLUMN unmanned INTEGER NOT NULL DEFAULT 0;
