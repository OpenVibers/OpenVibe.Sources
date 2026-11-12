-- phase: expand
-- A GitHub repository's star count per day (server/adapters/github.js, server/github.js). The code API computes
-- "stars gained over 1 day / 7 days" from these snapshots, so a repository's age in the tracked set is visible:
-- a repository first seen yesterday has a 1-day gain and a null 7-day gain, never a fabricated zero.
-- One row per source, repository and UTC day; a later sighting the same day replaces the count.
CREATE TABLE IF NOT EXISTS github_stars (
    source_key  text COLLATE "C" NOT NULL,
    full_name   text COLLATE "C" NOT NULL,
    day         text COLLATE "C" NOT NULL,
    stars       integer NOT NULL CHECK (stars >= 0),
    captured_at bigint NOT NULL,
    PRIMARY KEY (source_key, full_name, day)
);
CREATE INDEX IF NOT EXISTS idx_github_stars_day ON github_stars (source_key, day);
