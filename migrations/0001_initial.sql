-- phase: expand
-- OpenVibe.Sources on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE sources (
    key                  text COLLATE "C" PRIMARY KEY,
    name                 text COLLATE "C" NOT NULL,
    type                 text COLLATE "C" NOT NULL,          -- rss | atom | sitemap | jsonld | api | manual
    category             text COLLATE "C" NOT NULL,          -- news | blog | reviews | deals | coupons | trade
    homepage_url         text COLLATE "C",
    endpoints            text COLLATE "C" NOT NULL DEFAULT '[]',
    auth                 text COLLATE "C" NOT NULL DEFAULT '{"mode":"none"}',   -- env var NAME only, never a value
    robots_note          text COLLATE "C",
    terms_note           text COLLATE "C",
    license_note         text COLLATE "C",
    min_interval_ms      bigint NOT NULL,       -- rate limit: gap between two requests to this source
    poll_interval_sec    bigint NOT NULL,
    stale_after_sec      bigint NOT NULL,
    max_items            bigint NOT NULL,
    enabled              bigint NOT NULL DEFAULT 0,
    review_required      bigint NOT NULL DEFAULT 1,
    sensitivity          text COLLATE "C" NOT NULL DEFAULT 'none',
    default_indexability text COLLATE "C" NOT NULL DEFAULT 'noindex',
    search_visibility    text COLLATE "C",                   -- null = items are not sent to OpenVibe.Search
    created_at           bigint NOT NULL,
    updated_at           bigint NOT NULL,
    updated_by           text COLLATE "C",
    -- runtime state
    next_due_at          bigint NOT NULL DEFAULT 0,
    not_before           bigint NOT NULL DEFAULT 0,  -- Retry-After / Crawl-delay
    last_request_at      bigint,
    last_run_at          bigint,
    last_success_at      bigint,
    last_state           text COLLATE "C",
    consecutive_failures bigint NOT NULL DEFAULT 0
);

CREATE TABLE endpoint_state (
    source_key    text COLLATE "C" NOT NULL,
    url           text COLLATE "C" NOT NULL,
    etag          text COLLATE "C",
    last_modified text COLLATE "C",
    last_status   bigint,
    last_fetch_at bigint,
    PRIMARY KEY (source_key, url)
);

-- One row per fetch attempt, whatever happened. state is never empty.
CREATE TABLE fetch_runs (
    rid             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id              text COLLATE "C" NOT NULL UNIQUE,
    source_key      text COLLATE "C" NOT NULL,
    endpoint_url    text COLLATE "C",
    trigger         text COLLATE "C" NOT NULL,               -- schedule | manual
    started_at      bigint NOT NULL,
    finished_at     bigint NOT NULL,
    state           text COLLATE "C" NOT NULL CHECK (state IN ('ok','not_modified','http_error','timeout','robots_denied','parse_error','rate_limited','disabled')),
    http_status     bigint,
    error_code      text COLLATE "C",
    detail          text COLLATE "C",
    bytes           bigint,
    raw_body_hash   text COLLATE "C",
    parser_version  text COLLATE "C",
    items_seen      bigint NOT NULL DEFAULT 0,
    items_created   bigint NOT NULL DEFAULT 0,
    items_updated   bigint NOT NULL DEFAULT 0,
    items_unchanged bigint NOT NULL DEFAULT 0,
    items_skipped   bigint NOT NULL DEFAULT 0
);
CREATE INDEX idx_fetch_runs_source ON fetch_runs (source_key, rid);

CREATE TABLE items (
    rid               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id                text COLLATE "C" NOT NULL UNIQUE,
    source_key        text COLLATE "C" NOT NULL,
    category          text COLLATE "C" NOT NULL,
    identity          text COLLATE "C" NOT NULL,             -- guid / @id / url as the source gave it
    kind              text COLLATE "C" NOT NULL,
    canonical_url     text COLLATE "C",
    title             text COLLATE "C",
    summary           text COLLATE "C",
    authors           text COLLATE "C" NOT NULL DEFAULT '[]',
    published_at      text COLLATE "C",
    source_updated_at text COLLATE "C",
    fields            text COLLATE "C" NOT NULL DEFAULT '{}',
    content_hash      text COLLATE "C" NOT NULL,
    raw_body_hash     text COLLATE "C",
    parser_version    text COLLATE "C" NOT NULL,
    license_note      text COLLATE "C",
    terms_note        text COLLATE "C",
    first_seen_at     bigint NOT NULL,
    retrieved_at      bigint NOT NULL,          -- last successful fetch that contained it
    revision          bigint NOT NULL DEFAULT 1,
    last_fetch_run_id text COLLATE "C",
    entered_by        text COLLATE "C",                      -- manual items: the principal that entered it
    removed_at        bigint,
    removed_reason    text COLLATE "C",
    change_seq        bigint NOT NULL,
    UNIQUE (source_key, identity)
);
CREATE INDEX idx_items_change ON items (change_seq);
CREATE INDEX idx_items_source ON items (source_key, change_seq);
CREATE INDEX idx_items_category ON items (category, change_seq);

CREATE TABLE item_revisions (
    item_id        text COLLATE "C" NOT NULL,
    revision       bigint NOT NULL,
    content_hash   text COLLATE "C" NOT NULL,
    raw_body_hash  text COLLATE "C",
    parser_version text COLLATE "C" NOT NULL,
    fetch_run_id   text COLLATE "C",
    retrieved_at   bigint NOT NULL,
    snapshot       text COLLATE "C" NOT NULL,
    PRIMARY KEY (item_id, revision)
);

CREATE TABLE counters (
    name  text COLLATE "C" PRIMARY KEY,
    value bigint NOT NULL
);

CREATE TABLE robots_cache (
    origin          text COLLATE "C" PRIMARY KEY,
    fetched_at      bigint NOT NULL,
    expires_at      bigint NOT NULL,
    status          bigint,
    outcome         text COLLATE "C" NOT NULL,               -- parsed | unavailable (4xx: allow) | unreachable (deny)
    rules           text COLLATE "C" NOT NULL DEFAULT '[]',
    crawl_delay_sec double precision,
    detail          text COLLATE "C"
);

-- server/events/outbox.js ensureSchema()
CREATE TABLE event_outbox (
    seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text COLLATE "C" NOT NULL UNIQUE,
    event_type      text COLLATE "C" NOT NULL,
    envelope        text COLLATE "C" NOT NULL,
    created_at      bigint NOT NULL,
    attempts        bigint NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    rejected_at     bigint,
    last_error      text COLLATE "C"
);
CREATE INDEX idx_event_outbox_due ON event_outbox(sent_at, rejected_at, next_attempt_at);
