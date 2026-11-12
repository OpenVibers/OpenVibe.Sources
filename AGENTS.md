# AGENTS.md — OpenVibe.Sources

## Project overview

OpenVibe.Sources is the one place outside material enters the network: a registry of sources with
their terms and a polite fetcher/ingester that records provenance, retrieval time, content hashes and
explicit failure states. News, Reviews, Deals, Coupons, Trade and AI summarisation read its items;
the products decide what, if anything, to publish.

- **Entry:** `server/index.js` (Express; `start()` is also the test entry); port `4720`,
  service id `sources`, internal host `sources.openvibe.network`.
- **Registry:** `server/registry.js`, `server/settings.js`, contracts `sources.source@1`; seeds in
  `seeds/sources.json`.
- **Fetch pipeline:** `server/net/guard.js` (public-address check), `server/net/fetcher.js`,
  `server/robots.js`, `server/spacer.js`, `server/ingest.js`, `server/scheduler.js`.
- **Adapters:** `server/adapters/` (feed, sitemap, jsonld, api, bulk, crawl, manual); evidence-derived
  adapters in `adapters/<domain>.json`; `server/crawl.js` for the crawl type.
- **Items and runs:** `server/items.js` (identity, revisions, content hash); jobs in
  `server/jobs/`; events in `server/events/`.
- **Merchant opt-in:** `server/merchant.js`, `server/merchant-auth.js`, `server/merchant-pages.js`,
  `server/views/merchant.js`; public pages in `server/views/home.js`.
- **Pages:** server-rendered with `openvibe-shared/shell`; `public/merchant-arrival.js` is the only
  own browser script. No SPA and no build step.

## Owns, does not own

Owns the source registry (`sources`, `endpoint_state`, `robots_cache`), merchant opt-in claims
(`merchant_sources`) and their proof checks, ingestion (`fetch_runs`, `items`, `item_revisions`, the
scheduler, robots and rate-limit state), and the `sources.*` events.

Does not own: publication — what a product shows, summarises, rates or indexes from an item (News,
Reviews, Deals, Coupons, Trade and the publishing packages' indexability gate); AI summarisation
(OpenVibe.AI invokes the adapters' output, it does not fetch here); legal clearance (a terms note
records what a person verified, it does not replace verifying).

**The AI ↔ Sources client does not exist:** Sources never calls AI, and AI never fetches from
Sources. The product is the only client of both, passing Sources items to AI with provenance.

## Who calls it, what it calls

Publication products call the API with a Network client-credentials token for audience
`openvibe.sources`; every route has one capability (`sources.source.read`, item reads, and the
merchant routes). A first-party service may act for a person with `X-OV-Subject`; the merchant API
and pages accept the person's own session (Bearer on the API, the first-party cookie on the pages).
SDK `openvibe-sdk/sources` is the client surface. There is **no public JSON API**: the vhost keeps
`/api/v1/*` loopback-only; only `/merchant*` and `/shared/*` are public.

Sources calls the outside hosts named by its sources (subject to robots, spacing and the address
guard), OpenVibe.Network (JWKS, service token, account export/deletion, merchant identity) and
OpenVibe.Events (outbox). It never fetches a URL a user chose.

## Database and migrations

PostgreSQL `ov_sources` (ADR-035) through `openvibe-sdk/db`: `DATABASE_URL` through PgBouncer,
`DATABASE_DIRECT_URL` for migrations; `server/db.js` opens and migrates at boot under an advisory
lock. `migrations/0001..0012` include crawl, merchant sources, account data, source state, item
retention, config, telemetry and the outbox rejection index; never edit one that has run. A failed
fetch writes a `fetch_runs` row and **never creates or modifies an item**; only the `ok` path touches
items, and validators (ETag/Last-Modified) are stored only after a good parse.

## Auth and exposure

Network RS256 JWTs verified through the SDK JWKS client. Every `/api/v1` route needs a service token
for audience `openvibe.sources` with that route's capability, then passes per-actor limits. The
merchant API/pages are the person-facing exception: a person's session owns their claims, and a
first-party service may act for a person only with `X-OV-Subject`. A source credential is read from
the environment variable it names (`SOURCES_CRED_*` only), sent only to the configured origin
(dropped on a cross-origin redirect), and never stored or logged.

## Deploy

`sudo ovhost deploy sources` (git-checkout: fetch, fast-forward `/opt/openvibe.sources`, install on a
lockfile change, restart, wait for `/api/ready`; rollback `sudo ovhost rollback sources --to <sha>`).
Unit `deploy/systemd/openvibe-sources.service`, env `/etc/openvibe/sources.env`, database `ov_sources`,
nginx `deploy/nginx/sources.openvibe.network.conf` (API loopback-only, merchant + shared public).
The scheduler runs in-process; it starts after migrations in `server/index.js`, never at module load.

## Commands and tests

```bash
npm install
npm run seed                  # create the sources in seeds/sources.json, disabled
npm run dev                   # http://127.0.0.1:4720
npm test                      # every test/*.test.js against local stub sites, no internet
npm test -- crawl robots      # only matching files
npm run test:pg               # the same through PgBouncer
npm run probe -- <domain>     # write evidence/<domain>.json (run from the host's egress)
npm run adapters              # evidence → adapters or compliance/review-queue.yaml
npm run register-adapters     # bring the registry to the adapters
```

`test/run.js` uses `openvibe-shared/test-runner`; tests boot local stub sites and PGlite and never
touch the internet. Coverage includes adapters, extract, crawl, robots/rate limiting, the API
(CSV/TSV/join/map), scheduler, merchant proof, account data/deletion and the service manifest.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; problem+json errors, no raw rows.
- **Provenance is the product:** every item keeps source, fetch time, content hash and parser
  version; a failure stays a recorded failure and is never filled with invented content.
- **ADR 0007 is Accepted and the fixed technique list is not up for discussion.** Read
  `docs/adr/0007-source-access.md`; a probe verdict from `evidence/<domain>.json` decides access —
  probe first, read existing evidence, do not re-derive or re-litigate it.
- **Never enable a source without a terms note** (and a robots note when fetched); an adapter
  existing is not permission. A source with items cannot be deleted, only disabled.
- **Politeness is enforced:** robots.txt (RFC 9309, 4xx = none, 429/5xx = disallow), max request
  spacing (`min_interval_ms`, `Crawl-delay`), conditional GET, one response deadline, byte cap,
  public-address check at connect time, manual re-checked redirects, exponential backoff.
- **Dedupe and classification split:** Sources dedupes within a source (identity + content hash) and
  assigns a coarse category; cross-source dedupe and fine classification are the product's.
- **A failed run does not touch items and does not store validators** — the next pass re-fetches in
  full. Keep the `fetch_runs` state names exact.
