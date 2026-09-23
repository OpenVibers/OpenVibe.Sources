'use strict';
/**
 * The Sources database (SQLite, WAL). One file owned by this service only; created on boot,
 * idempotently.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const outbox = require('./events/outbox');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
    key                  TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    type                 TEXT NOT NULL,          -- rss | atom | sitemap | jsonld | api | manual
    category             TEXT NOT NULL,          -- news | blog | reviews | deals | coupons | trade
    homepage_url         TEXT,
    endpoints            TEXT NOT NULL DEFAULT '[]',
    auth                 TEXT NOT NULL DEFAULT '{"mode":"none"}',   -- env var NAME only, never a value
    robots_note          TEXT,
    terms_note           TEXT,
    license_note         TEXT,
    min_interval_ms      INTEGER NOT NULL,       -- rate limit: gap between two requests to this source
    poll_interval_sec    INTEGER NOT NULL,
    stale_after_sec      INTEGER NOT NULL,
    max_items            INTEGER NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 0,
    review_required      INTEGER NOT NULL DEFAULT 1,
    sensitivity          TEXT NOT NULL DEFAULT 'none',
    default_indexability TEXT NOT NULL DEFAULT 'noindex',
    search_visibility    TEXT,                   -- null = items are not sent to OpenVibe.Search
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    updated_by           TEXT,
    -- runtime state
    next_due_at          INTEGER NOT NULL DEFAULT 0,
    not_before           INTEGER NOT NULL DEFAULT 0,  -- Retry-After / Crawl-delay
    last_request_at      INTEGER,
    last_run_at          INTEGER,
    last_success_at      INTEGER,
    last_state           TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS endpoint_state (
    source_key    TEXT NOT NULL,
    url           TEXT NOT NULL,
    etag          TEXT,
    last_modified TEXT,
    last_status   INTEGER,
    last_fetch_at INTEGER,
    PRIMARY KEY (source_key, url)
);

-- One row per fetch attempt, whatever happened. state is never empty.
CREATE TABLE IF NOT EXISTS fetch_runs (
    rid             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    source_key      TEXT NOT NULL,
    endpoint_url    TEXT,
    trigger         TEXT NOT NULL,               -- schedule | manual
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('ok','not_modified','http_error','timeout','robots_denied','parse_error','rate_limited','disabled')),
    http_status     INTEGER,
    error_code      TEXT,
    detail          TEXT,
    bytes           INTEGER,
    raw_body_hash   TEXT,
    parser_version  TEXT,
    items_seen      INTEGER NOT NULL DEFAULT 0,
    items_created   INTEGER NOT NULL DEFAULT 0,
    items_updated   INTEGER NOT NULL DEFAULT 0,
    items_unchanged INTEGER NOT NULL DEFAULT 0,
    items_skipped   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fetch_runs_source ON fetch_runs (source_key, rid);

CREATE TABLE IF NOT EXISTS items (
    rid               INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT NOT NULL UNIQUE,
    source_key        TEXT NOT NULL,
    category          TEXT NOT NULL,
    identity          TEXT NOT NULL,             -- guid / @id / url as the source gave it
    kind              TEXT NOT NULL,
    canonical_url     TEXT,
    title             TEXT,
    summary           TEXT,
    authors           TEXT NOT NULL DEFAULT '[]',
    published_at      TEXT,
    source_updated_at TEXT,
    fields            TEXT NOT NULL DEFAULT '{}',
    content_hash      TEXT NOT NULL,
    raw_body_hash     TEXT,
    parser_version    TEXT NOT NULL,
    license_note      TEXT,
    terms_note        TEXT,
    first_seen_at     INTEGER NOT NULL,
    retrieved_at      INTEGER NOT NULL,          -- last successful fetch that contained it
    revision          INTEGER NOT NULL DEFAULT 1,
    last_fetch_run_id TEXT,
    entered_by        TEXT,                      -- manual items: the principal that entered it
    removed_at        INTEGER,
    removed_reason    TEXT,
    change_seq        INTEGER NOT NULL,
    UNIQUE (source_key, identity)
);
CREATE INDEX IF NOT EXISTS idx_items_change ON items (change_seq);
CREATE INDEX IF NOT EXISTS idx_items_source ON items (source_key, change_seq);
CREATE INDEX IF NOT EXISTS idx_items_category ON items (category, change_seq);

CREATE TABLE IF NOT EXISTS item_revisions (
    item_id        TEXT NOT NULL,
    revision       INTEGER NOT NULL,
    content_hash   TEXT NOT NULL,
    raw_body_hash  TEXT,
    parser_version TEXT NOT NULL,
    fetch_run_id   TEXT,
    retrieved_at   INTEGER NOT NULL,
    snapshot       TEXT NOT NULL,
    PRIMARY KEY (item_id, revision)
);

CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS robots_cache (
    origin          TEXT PRIMARY KEY,
    fetched_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    status          INTEGER,
    outcome         TEXT NOT NULL,               -- parsed | unavailable (4xx: allow) | unreachable (deny)
    rules           TEXT NOT NULL DEFAULT '[]',
    crawl_delay_sec REAL,
    detail          TEXT
);
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    outbox.ensureSchema(db);
    return db;
}

/** Next value of a named monotonic counter (call inside a transaction). */
function nextSeq(db, name) {
    db.prepare('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(name);
    return db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
}

module.exports = { openDb, nextSeq };
