-- phase: expand
-- Merchant opt-in ("List your store on OpenVibe", plan §4.4 channel 1).
--
-- A signed-in merchant claims a domain, proves control of it with a DNS TXT record or a meta tag, and names the
-- sitemap or product feed Sources may read. Nothing is created in `sources` before the proof is present: a pending
-- claim is only this row. On verification the source is created enabled, and its terms_note records who gave the
-- explicit permission, when, and how control was verified. Withdrawal disables that source and keeps the note (and
-- this row) for the audit trail. The crawler and the fetcher still obey robots.txt on every request.
CREATE TABLE IF NOT EXISTS merchant_sources (
    id                  text COLLATE "C" PRIMARY KEY,       -- msrc_<ULID>
    owner_sub           text COLLATE "C" NOT NULL,          -- usr_<ULID>, the signed-in merchant
    owner_name          text COLLATE "C",                   -- display name the token carried, for people reading the note
    store_name          text COLLATE "C",
    domain              text COLLATE "C" NOT NULL,          -- lowercase hostname, no port
    method              text COLLATE "C" NOT NULL CHECK (method IN ('dns', 'meta')),
    token               text COLLATE "C" NOT NULL,          -- verification challenge, shown only to the owner
    listing_url         text COLLATE "C" NOT NULL,          -- the sitemap or product feed the merchant named
    listing_kind        text COLLATE "C" NOT NULL CHECK (listing_kind IN ('sitemap', 'feed')),
    meta_url            text COLLATE "C",                   -- where the meta tag lives (meta method only)
    status              text COLLATE "C" NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'verified', 'withdrawn', 'failed')),
    source_key          text COLLATE "C",                   -- set only when verified
    terms_note          text COLLATE "C",                   -- final explicit-permission note, kept after withdrawal
    verified_at         bigint,
    verified_by         text COLLATE "C",                   -- the actor that completed the check (the merchant or svc:sources)
    verification_detail text COLLATE "C",                   -- how the proof was found, without the challenge value
    last_checked_at     bigint,
    check_count         bigint NOT NULL DEFAULT 0,
    last_error          text COLLATE "C",
    created_at          bigint NOT NULL,
    updated_at          bigint NOT NULL,
    withdrawn_at        bigint,
    withdrawn_by        text COLLATE "C"
);

-- One live claim per domain: a withdrawn or failed claim frees the name for a new opt-in.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_sources_live_domain
    ON merchant_sources (domain) WHERE status IN ('pending', 'verified');
CREATE UNIQUE INDEX IF NOT EXISTS merchant_sources_source_key
    ON merchant_sources (source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS merchant_sources_owner
    ON merchant_sources (owner_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS merchant_sources_pending
    ON merchant_sources (last_checked_at) WHERE status = 'pending';
