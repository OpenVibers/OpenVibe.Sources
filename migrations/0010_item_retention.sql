-- phase: expand
-- Item retention (plan 2026-10-22, track F): the daily prune (server/retention.js, server/jobs/) deletes
-- items older than their category's window. Two partial indexes serve the two age expressions: a live
-- item ages from retrieved_at, a removed one from removed_at (its removal is the change consumers follow).
-- The keep-latest categories use the existing unique (source_key, identity) index.
CREATE INDEX IF NOT EXISTS idx_items_retention_live ON items (category, retrieved_at) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_retention_removed ON items (category, removed_at) WHERE removed_at IS NOT NULL;
