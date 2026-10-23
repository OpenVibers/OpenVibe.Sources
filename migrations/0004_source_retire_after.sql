-- phase: expand
-- A source may retire what its feed stopped showing (sources.source@1 retire_after_sec, openvibe-contracts 0.211.0; plan
-- 2026-10-22, track F2): once a fetch of the source succeeds, an item not seen for this many seconds is removed with
-- reason gone_from_source. NULL, every existing source's value, keeps every item as before.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS retire_after_sec bigint;

-- The 304 path refreshes the items the endpoint's last good parse saw (server/ingest.js).
CREATE INDEX IF NOT EXISTS idx_items_last_run ON items (source_key, last_fetch_run_id);
