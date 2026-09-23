# OpenVibe.Sources

> The source registry and the ingestion workers the publication products depend on: every item
> carries where it came from, when it was retrieved and on what terms, and a failed fetch is a
> recorded failure — never replaced by invented content.

**Status:** alpha (roadmap Wave 14). Deployed internally, not launched: it runs on the production host
(127.0.0.1:4720 only, since 2026-09-23) with the six seeded sources **disabled**, so it has made 0 fetch
runs and holds 0 items.  
**Domain:** `sources.openvibe.network` (health only on the public vhost; the API is host-local). The
vhost is not installed yet: the name currently falls through to the admin.openvibe.network placeholder.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 — roadmap §4.2 B, §15.12, §29, anti-goals 13, 26, 27.  
**License:** AGPL-3.0.

## Purpose

News, Reviews, Deals, Coupons, Trade (and AI summarisation) all need outside material. Sources
owns the one place it enters the network: a registry of sources with their terms, and workers that
fetch them politely and record exactly what happened. Products read items with provenance and
decide — under their own review and indexability rules — what, if anything, to publish.

## Running it

```bash
npm install
cp .env.example .env
npm run seed           # six real sources, one per category, all disabled
npm run dev            # http://127.0.0.1:4720
npm test               # every test/*.test.js against local stub sites; no internet
```

Node 22 in production (`fnm exec --using=22.22.1 npm test`). Production: `/opt/openvibe.sources`,
env `/etc/openvibe/sources.env`, unit [deploy/systemd/openvibe-sources.service](deploy/systemd/openvibe-sources.service),
store `/var/lib/openvibe-sources/sources.db`, nginx [deploy/nginx/sources.openvibe.network.conf](deploy/nginx/sources.openvibe.network.conf).

`GET /api/health` is liveness. `GET /api/ready` (openvibe-shared/ready) is 503 only when the
database fails; a Network key that has not loaded and a fetcher that is off, stopped or behind (a
source due for more than 15 minutes) degrade it. It reports source counts by health status, runs in
flight and the outbox backlog. `GET /metrics` (openvibe-shared/metrics) answers direct loopback
callers only: golden signals by route template, `sources_sources{status}`, `sources_items{state}`,
the fetch queue (`sources_fetch_due`, `sources_fetch_oldest_wait_seconds`,
`sources_fetch_in_flight`), `sources_last_fetch_timestamp_seconds` and
`sources_last_success_timestamp_seconds`.

## The registry

A source records: `key`, `name`, `type` (`rss|atom|sitemap|jsonld|api|manual`), `category`
(`news|blog|reviews|deals|coupons|trade`), `endpoints` (for `api`: a field mapping, no code per
provider), `auth` (`none|header|bearer|query` with the **name** of an environment variable —
names must start with `SOURCES_CRED_`, so an entry can never point at this service's own
secrets), `robots_note`, `terms_note`, `license_note`, the rate limit (`min_interval_ms`),
`poll_interval_sec`, `stale_after_sec`, `max_items`, `enabled`, `review_required`,
`sensitivity`, `default_indexability` and `search_visibility`.

A source cannot be enabled without a terms note (and a robots note if it is fetched): an adapter
existing is not permission to ingest (anti-goal 26). A source with items cannot be deleted —
disable it — so provenance stays resolvable. Contract: [`sources.source@1`](docs/contracts-proposal/), released in openvibe-contracts v0.12.0.

## Ingestion

An in-process scheduler starts runs for enabled sources whose poll is due (at most
`SOURCES_MAX_CONCURRENT` at once, never two of one source). A run fetches each endpoint in turn:

1. **Credential** read from the named variable at that moment (missing → `disabled`), sent only
   to the configured origin (dropped on a cross-origin redirect), never stored or logged.
2. **robots.txt** (RFC 9309) for the origin: our `OpenVibeSources` group or `*`, longest match,
   `*`/`$`; 4xx = no restrictions, 429/5xx/unreachable = complete disallow; cached 24 h;
   `Crawl-delay` honoured. Every redirect hop is checked too.
3. **Spacing**: max(`SOURCES_HOST_MIN_INTERVAL_MS`, the source's `min_interval_ms`,
   Crawl-delay) between requests to a host. A trigger before the source's interval has passed,
   or before a `Retry-After`, records `rate_limited` and requests nothing.
4. **Fetch**: address guard (http(s) only, ports 80/443, every resolved address must be public —
   checked at connect time, so DNS rebinding cannot slip through; loopback, RFC 1918, link-local,
   CGNAT, metadata and v4-mapped/NAT64/6to4 forms are refused), manual redirects (≤ 5, each
   re-checked), conditional GET (`If-None-Match`/`If-Modified-Since`), one deadline for the whole
   response (`SOURCES_FETCH_TIMEOUT_MS`), a byte cap on the decoded body (`SOURCES_MAX_BYTES`).
5. **Parse** with the adapter; on success, in one transaction: the run row, the items (created /
   new revision if the content hash changed / retrieval time refreshed if unchanged), the
   validators, and the events.

Every attempt writes a `fetch_runs` row with an explicit state: `ok`, `not_modified`,
`http_error`, `timeout`, `robots_denied`, `parse_error`, `rate_limited` or `disabled`, plus the
HTTP status, an error code, the raw-body hash and item counts. **A failed run never creates or
modifies an item** (only the `ok` path touches items), and ETag/Last-Modified are stored only after
a good parse, so an unreadable body is re-fetched in full next time. Failing sources back off
exponentially (capped at `SOURCES_MAX_BACKOFF_MS`).

**Staleness** is computed: a fetched source is stale when its last success (`ok` or
`not_modified`) is older than `stale_after_sec` (default 3 × the poll interval) or it never
succeeded. Health status: `healthy | stale | failing | never_fetched | disabled | manual`.

### Adapters (parser versions recorded on every item)

| Type | Reads | Notes |
|---|---|---|
| `rss`, `atom` (`feed@1`) | RSS 2.0, RSS 1.0/RDF, Atom 1.0 | guid/id identity, else link; text-only summary capped at 1000 chars |
| `sitemap` (`sitemap@1`) | `<urlset>` (+ Google News extension), `<sitemapindex>` | index children are listed, not followed |
| `jsonld` (`jsonld@1`) | schema.org Product, Offer/AggregateOffer, Review, NewsArticle, BlogPosting (+ Article) | prices, ratings and availability exactly as the page states; missing = null; embedded review text not kept; a page without JSON-LD is a `parse_error` |
| `api` (`api@1`) | JSON or XML official APIs via a registry mapping | `items_path`, `fields`, `extra`; epoch fields only where mapped as such |
| `manual` (`manual@1`) | items entered through the API with an evidence URL | no fetcher |

XML with DTD entity declarations is refused; the parser expands no entities (values are decoded
per field). Fixtures and expectations: `test/adapters.test.js`.

### Items

Each item: `source_key`, `category`, `kind`, `identity`, `canonical_url` (tracking parameters and
fragments removed), `title`, `summary`, `authors`, `published_at`, `source_updated_at`, `fields`,
`revision`, and `provenance` (`retrieved_at`, `first_seen_at`, `content_hash`, `raw_body_hash`,
`parser_version`, `fetch_run_id`, `license_note`, `terms_note`, `entered_by`). Earlier revisions
are kept in `item_revisions`. Removal (takedown, licence) is explicit, needs a reason, and is
sticky: a later fetch that still lists the item does not bring it back. Contract (released in openvibe-contracts v0.12.0):
[`sources.item@1`](docs/contracts-proposal/).

## API (service tokens, one capability per route)

Callers use an OpenVibe.Network client-credentials token for audience `openvibe.sources`.

| Capability | Routes |
|---|---|
| `sources.source.read` | `GET /api/v1/sources`, `/api/v1/sources/:key`, `/api/v1/sources/:key/runs?before=`, `/api/v1/runs?state=failed&after=`, `/api/v1/health` |
| `sources.item.read` | `GET /api/v1/items?source=&category=&after=<change_seq>&include_removed=1`, `GET /api/v1/items/:id?revisions=1` |
| `sources.source.manage` | `POST /api/v1/sources`, `PATCH`/`DELETE /api/v1/sources/:key`, `POST /api/v1/sources/:key/fetch`, `POST /api/v1/sources/:key/items` (manual), `DELETE /api/v1/items/:id` `{reason}` |

`GET /api/v1/items` pages in change order (creations, revisions and — with `include_removed=1` —
removals); resume from `next_after`. Every page carries the status and staleness of the sources
it contains. The capability ids (first proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/))
are released in `openvibe-contracts` v0.12.0 (this repo pins v0.13.0); [server/auth.js](server/auth.js)
decides them with the contracts grant rule.

## Events (transactional outbox → OpenVibe.Events when `EVENTS_URL` is set)

- `sources.item.created`, `sources.item.updated` (with the previous content hash), `sources.item.removed` (with the reason)
- `sources.fetch.failed` for `http_error`, `timeout`, `robots_denied`, `parse_error` and upstream 429 (with the state, error code, HTTP status and consecutive failures). Our own rate limiter and disabled sources are not failures.
- `sources.index_document.upserted|deleted` for sources with `search_visibility: "members"`: raw items indexed in OpenVibe.Search for staff only (`acl.groups: role:admin, role:global_mod`), always `noindex` (`third_party_content`).

All with `visibility: "internal"`. Envelopes validate as `events.event-envelope@1`.

## Seeds

[seeds/sources.json](seeds/sources.json) — one real source per category, **all disabled**, robots
checked by hand on 2026-09-22 (the fetcher re-checks on every run), terms to be re-verified by a
person before enabling:

| Key | Category | Type | Endpoint |
|---|---|---|---|
| `nasa-news-releases` | news | rss | nasa.gov news-release feed |
| `nodejs-blog` | blog | rss | nodejs.org blog feed |
| `steam-reviews-portal-2` | reviews | api | Steam `appreviews` for app 620 — signals only, review text not mapped |
| `dealnews-daily` | deals | rss | dealnews.com RSS (Crawl-delay 2) |
| `staff-coupon-codes` | coupons | manual | codes a merchant published itself, entered with the evidence URL |
| `sec-xbrl-filings` | trade | rss | SEC EDGAR XBRL filings RSS (`/cgi-bin` is robots-disallowed, so the getcurrent feed is not used) |

Candidates rejected on 2026-09-22: CheapShark's API (`/api/1.0/` is disallowed in its
robots.txt) and EDGAR's `getcurrent` Atom feed (`/cgi-bin` disallowed). The seeded feeds were
downloaded once by hand and parsed offline with these adapters (NASA 10 items, Node.js 50,
Steam 20, DealNews 50, SEC 200); that check is not part of the test suite and proves nothing about
the terms.

## Owns

- the source registry (`sources`, `endpoint_state`, `robots_cache`) and the source/item contracts
- ingestion: `fetch_runs`, `items`, `item_revisions`, the scheduler, robots and rate-limit state
- `sources.*` events

## Does not own

- publication: what a product shows, summarises, rates or indexes from an item (News, Reviews,
  Deals, Coupons, Trade, the publishing packages' indexability gate)
- AI summarisation (OpenVibe.AI invokes adapters' output; it does not fetch here)
- legal clearance: a terms note records what a person verified; it does not replace verifying

## Depends on

- OpenVibe.Contracts (service tokens, problem details, ids, the event envelope)
- OpenVibe.Network (signing key; service principal `sources`)
- OpenVibe.Events (outbound events)

## Acceptance (tests)

- failure never fabricates: HTTP errors, timeouts, parse errors, oversize bodies and 429s leave
  every item byte-for-byte unchanged, each recorded with its state (`test/ingest.test.js`)
- robots.txt respected, including redirects, unreachable = deny, Crawl-delay (`test/robots-ssrf.test.js`)
- rate limit spacing and early triggers recorded as `rate_limited` without a request (`test/ingest.test.js`)
- conditional GET with ETag and Last-Modified (`test/ingest.test.js`)
- loopback/private/metadata addresses, DNS answers and redirects into them refused (`test/robots-ssrf.test.js`)
- credentials by variable name, never stored, not forwarded cross-origin (`test/ingest.test.js`)
- parsers against fixtures (`test/adapters.test.js`); API, registry rules, paging, manual items,
  removal (`test/api.test.js`); scheduler, backoff, relay to Events (`test/scheduler-events.test.js`);
  proposals and seeds (`test/proposals.test.js`)

Not yet demonstrated: a run against a real source from the deployed service (every seed is disabled
until a person verifies its terms), and a consuming product using real items. News and Reviews run
loopback-only on the host and are subscribed to `sources.item.*` through Events (Deals, Coupons and
Trade also run loopback-only and have Sources import clients), but with no enabled source none of them has
received an item.

Restore drill: `ovhost drill sources` passed on the production host on 2026-09-23 (integrity check,
readiness, row counts; see OpenVibe.Host `docs/restore-drills.md`).

## Launch rule

The domain keeps its placeholder page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites)
until the plan's launch rule holds (owning runtime with health/readiness, identity and service
principals, real persistence and workflows, capabilities and events registered in
OpenVibe.Contracts, a security review, acceptance tests). Sources has no public pages by design;
its public vhost answers health and a `Disallow: /` robots.txt.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
