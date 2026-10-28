-- phase: expand
-- A crawl source (sources.source@1 type crawl, openvibe-contracts 0.224.0; the owner, 2026-10-28: aggregate every site, "the
-- open source Google") walks one site from its seeds. Its settings are the source's crawl column (JSON, null for every other
-- type); the pages and sitemaps it knows are its frontier (server/crawl.js). robots.txt's Sitemap lines are kept with its
-- rules, so a crawl finds a site's sitemaps without asking for robots.txt twice.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS crawl text COLLATE "C";

ALTER TABLE robots_cache ADD COLUMN IF NOT EXISTS sitemaps text COLLATE "C" NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS crawl_frontier (
    source_key     text COLLATE "C" NOT NULL,
    url            text COLLATE "C" NOT NULL,
    kind           text COLLATE "C" NOT NULL,          -- page | sitemap
    depth          bigint NOT NULL DEFAULT 0,          -- links away from a seed or sitemap page
    found_via      text COLLATE "C" NOT NULL,          -- seed | robots | guess | sitemap | link | canonical
    state          text COLLATE "C" NOT NULL DEFAULT 'new',
    first_seen_at  bigint NOT NULL,
    next_fetch_at  bigint,                             -- null: not fetched again
    last_fetch_at  bigint,
    interval_sec   bigint,                             -- grows while the page stays the same, back to recrawl_sec when it changes
    lastmod_at     bigint,                             -- the sitemap's lastmod for it
    last_status    bigint,
    etag           text COLLATE "C",
    last_modified  text COLLATE "C",
    body_hash      text COLLATE "C",
    last_ok_run_id text COLLATE "C",                   -- the fetch run its items were last read in
    items          bigint NOT NULL DEFAULT 0,
    fails          bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (source_key, url)
);
CREATE INDEX IF NOT EXISTS idx_crawl_frontier_due ON crawl_frontier (source_key, kind, next_fetch_at);
