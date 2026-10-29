# OpenVibe.Sources

> The source registry and the ingestion workers the publication products depend on: every item
> carries where it came from, when it was retrieved and on what terms, and a failed fetch is a
> recorded failure — never replaced by invented content.

**Status:** alpha (roadmap Wave 14). Deployed internally: the API runs on the production host (127.0.0.1:4720 only,
since 2026-09-23). On 2026-10-22, 43 of its 47 sources were enabled and it held 55,683 items from 4,762 fetch runs
(the first on 2026-10-07; 431 in the last 24 hours), and none of the enabled sources was failing. The counts by category
are under [Acceptance](#acceptance-tests).  
**Domain:** `sources.openvibe.network` (a short "internal service" page and health on this
repository's vhost; the API is loopback-only). Install steps: [Public host](#public-host).  
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
npm run seed           # the 54 sources in seeds/sources.json, created disabled
npm run dev            # http://127.0.0.1:4720
npm test               # every test/*.test.js against local stub sites; no internet
```

Node 22 in production (`fnm exec --using=22.22.1 npm test`). Production: `/opt/openvibe.sources`,
env `/etc/openvibe/sources.env`, unit [deploy/systemd/openvibe-sources.service](deploy/systemd/openvibe-sources.service),
database `ov_sources` on the host's data role (ADR-035; `sudo /opt/openvibe.host/roles/data/add-service.sh sources`), nginx [deploy/nginx/sources.openvibe.network.conf](deploy/nginx/sources.openvibe.network.conf).

`GET /api/health` is liveness. `GET /api/ready` (openvibe-shared/ready) is 503 only when the
database fails; a Network key that has not loaded and a fetcher that is off, stopped or behind (a
source due for more than 15 minutes) degrade it. It reports source counts by health status, runs in
flight and the outbox backlog. `GET /metrics` (openvibe-shared/metrics) answers direct loopback
callers only: golden signals by route template, `sources_sources{status}`, `sources_items{state}`,
the fetch queue (`sources_fetch_due`, `sources_fetch_oldest_wait_seconds`,
`sources_fetch_in_flight`), `sources_last_fetch_timestamp_seconds` and
`sources_last_success_timestamp_seconds`.

Requests are aggregated by route template, method and status class, never by raw URL; health,
readiness, `/metrics`, `/shared` and static files are not counted. Once a minute one `http.request`
sample per key, plus the active-requests, p95 and event-loop-lag gauges, is written to this service's
own `telemetry_samples` table (openvibe-sdk 0.46 telemetry, `platform.telemetry-sample@1`, migration
`0003_telemetry.sql`); rows older than 14 days are deleted daily. `server/app.js` mounts the SDK's
no-op-until-init `telemetryMiddleware`; `server/index.js` calls `telemetry.init()` at production
start and flushes on stop.

## The registry

A source records: `key`, `name`, `type` (`rss|atom|sitemap|jsonld|api|crawl|manual`), `category`
(`news|blog|reviews|deals|coupons|trade|hosting|crowdfunding|games|housing|food|jobs`, read from `sources.source@1`; housing, food and jobs since contracts 0.210.0), `endpoints` (for `api`: a field mapping, no code per
provider), `auth` (`none|header|bearer|query` with the **name** of an environment variable —
names must start with `SOURCES_CRED_`, so an entry can never point at this service's own
secrets), `robots_note`, `terms_note`, `license_note`, the rate limit (`min_interval_ms`),
`poll_interval_sec`, `stale_after_sec`, `max_items`, `enabled`, `review_required`,
`sensitivity`, `default_indexability`, `search_visibility` and `retire_after_sec` (since contracts 0.211.0).

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
| `rss`, `atom` (`feed@3`) | RSS 2.0, RSS 1.0/RDF, Atom 1.0 | guid/id identity, else link; text-only summary capped at 1000 chars; a deal feed's own offer elements (DealNews' `dealnews:price` with its currency, `dealnews:retailer`, `dealnews:expires`) become `fields.price`, `currency`, `seller` and `valid_until` exactly as stated (the item stays an article; nothing is read out of the headline); its `dealnews:category` fills `fields.categories` when the item has no `<category>`, and `dealnews:staffPick` is `fields.staff_pick` (true/false, absent when not stated) |
| `sitemap` (`sitemap@1`) | `<urlset>` (+ Google News extension), `<sitemapindex>` | index children are listed, not followed |
| `jsonld` (`jsonld@2`) | schema.org Product, Offer/AggregateOffer, Review, NewsArticle, BlogPosting (+ Article) | prices, ratings and availability exactly as the page states; missing = null; embedded review text not kept; a page without JSON-LD is a `parse_error`; `list_price` from a ListPrice/StrikethroughPrice/MSRP/SRP `priceSpecification`, as stated |
| `api` (`api@1`) | JSON or XML official APIs via a registry mapping | `items_path`, `items_shape` (`array` default, `map` for records keyed by id), `fields`, `extra`; epoch fields only where mapped as such |
| `crawl` (`jsonld@2`, `page@1`) | a whole site from its seeds: its sitemaps and, if asked, its links (see below) | only pages that publish JSON-LD are kept, unless `require_structured: false` keeps a `page` item from the page's own search metadata |
| `manual` (`manual@1`) | items entered through the API with an evidence URL | no fetcher |

XML with DTD entity declarations is refused; the parser expands no entities (values are decoded
per field). Fixtures and expectations: `test/adapters.test.js`.

Some official price lists key their records by id instead of listing them — Porkbun's TLD pricing
is `{ "pricing": { "com": {…}, "net": {…} } }`. `items_shape: "map"` reads that object: each own
property becomes one record in sorted key order, and the property's key is available as the
virtual path `$key` (so `fields.identity: "$key"` makes the id the identity). A property whose
value is not an object is skipped, and an `items_path` of the wrong shape is a parse error, never
an empty success. With the default `items_shape: "array"`, `$index` is a record's 0-based position in
the array (as a whole path, e.g. `"extra": { "position": "$index" }`), so a ranked list keeps its
order (Steam's top sellers).

```json
{ "url": "https://api.porkbun.com/api/json/v3/pricing/get", "format": "json",
  "items_path": "pricing", "items_shape": "map", "item_kind": "tld",
  "fields": { "identity": "$key" },
  "extra": { "tld": "$key", "registration": "registration", "renewal": "renewal" } }
```

A path segment `*` steps into the single child of an object (a path that meets an array, or an
object with zero or more than one own property, resolves to null). A path starting with `$root.`
resolves from the parsed response body rather than the record, and inside it `{$key}` stands for
the record's map key — so a keyed price list can be joined to prices held elsewhere in the same
response: `"price_hourly": "$root.terms.OnDemand.{$key}.*.priceDimensions.*.pricePerUnit.USD"`.
An endpoint may also carry `where`, up to 10 `path -> expected` conditions (expected is a string,
number or boolean, or an array of up to 20 of them, matching any): a record that fails any
condition is left out before `maxItems` is counted and reported as `meta.filtered`, e.g.
`"where": { "productFamily": "Lightsail Instance", "attributes.operatingSystem": "Linux" }`.
An expectation may instead be `{ "pattern": "<regular expression, at most 200 characters>" }`, which the value must
match as text.

**Catalogs that keep plans, hardware and prices apart** (OVHcloud's public order catalog, `ovhcloud-vps`). A key may
carry a selector, `key[field=value,…]` (one to four conditions): `key` must be an array, and the path steps into its
first element whose fields equal every value, compared as text after `scalar()` (so `interval=1` matches the number 1).
A value is literal text or `$rec.<path>`, read from the record itself. No match is null.

```json
"where": { "planCode": { "pattern": "^vps-[0-9]{4}-model[0-9]+$" } },
"extra": { "vcpu": "$root.products[name=$rec.product].blobs.technical.cpu.cores",
           "price_monthly": "pricings[mode=default,commitment=0,intervalUnit=month,interval=1].price" }
```

`max_bytes` (an integer from 1 KiB to 32 MiB) sets one endpoint's body cap instead of `SOURCES_MAX_BYTES`. OVHcloud's
catalog is about 12 MB.

`timeout_ms` (an integer from 1 s to 120 s) sets one endpoint's deadline instead of `SOURCES_FETCH_TIMEOUT_MS`. NYC Open
Data computes the HPD per-building violation tally (`nyc-hpd-open-violations`) in 12 to 60 seconds.

`request_content_type` (`application/json` only) is sent as the Content-Type of the endpoint's GET, which has no body.
Open Collective's public GraphQL API answers a GET only with it (its CSRF guard): `opencollective-accounts` (category
`crowdfunding`) reads the 100 most active and the 100 newest collectives, projects and funds every six hours, each a
`campaign` item with the amounts and counts as Open Collective states them, for OpenVibe.Deals' crowdfunding discovery.

**Facts stated in prose (`extract`, rss/atom only).** A feed endpoint may carry
`extract: { kind, require, fields }` ([server/adapters/extract.js](server/adapters/extract.js)). Each field is read from
the item's own `title` or `summary` by a pattern with one capturing group. With `as: "date"`, "October 20" becomes
2026-10-20: without a year, the first such day on or after the item's publication. An item that yields every `require`d
field is stored as `kind` with those fields; any other item is skipped and counted in the run's `items_skipped` (the
plain feed source keeps it). The registry refuses a pattern that does not compile or has no group, an unknown option,
and `extract` on an api source. `dealnews-coupon-codes` (category `coupons`) is the first: the code, the shop and the
stated end date of the DealNews deals that state a code, exactly as written.

### Crawl sources (`server/crawl.js`, contracts 0.224.0)

The owner, 2026-10-28: "aggregate all websites and select deals on all sites… a full comprehensive crawler system… the
open source Google". A crawl source walks one site from its endpoints (the seeds). Its `crawl` settings:

| Field | Default | What it does |
|---|---|---|
| `sitemaps` | `true` | read the site's sitemaps: robots.txt `Sitemap` lines, else `/sitemap.xml`; indexes and `.xml.gz` followed |
| `follow_links` | `false` | also follow same-host links (not `rel=nofollow`, not from a `nofollow` page) |
| `max_depth` | `2` | with `follow_links`, how many links from a seed or sitemap page |
| `include`, `exclude` | none | regular expressions over the path and query (seeds are fetched whatever they say) |
| `max_pages` | `5000` | the frontier's size for the site |
| `pages_per_run` | `100` | requests in one run (sitemaps count) |
| `recrawl_sec` | `86400` | when a page that changed is due again; an unchanged page waits up to 4× longer |
| `require_structured` | `true` | keep only pages with schema.org JSON-LD |

**The frontier** (`crawl_frontier`, migration 0006) holds every page and sitemap the crawl knows, with its state:

- **Page states:** `new`, `kept`, `hub`, `unstructured`, `noindex`, `duplicate`, `not_html`, `too_large`, `excluded`,
  `denied`, `missing`, `gone` and `failing`.
- **What it records per page:** when the page is due, its validators, its body hash, and the fetch run its items were
  last read in.
- **Run order:** each run reads the due sitemaps first, then the due pages, oldest first.

**Every request is a source request like any other:**
- robots.txt on the URL and on every redirect hop;
- per-host spacing with Crawl-delay and the source's `min_interval_ms`;
- conditional GETs;
- the address guard;
- one `fetch_runs` row per page.

**Scope:** a crawl never leaves its seeds' hosts (or their `www` twins).

**Pages that ask not to be kept:**
- **Canonical:** a page whose canonical is another page of the crawl is read there instead.
- **noindex:** a page that says noindex (`<meta name="robots">`, `<meta name="openvibesources">`, `X-Robots-Tag`) is
  not kept, and its items are retired.
- **Gone:** a page that answers 404 twice, or 410 once, is gone and its items are retired as `gone_from_source`.

**A page's failure is the page's:** the source fails (backoff, one `sources.fetch.failed`) only when the site does:
- robots.txt unreachable;
- a 429 or a 503 with Retry-After;
- five requests in a row with no usable answer.

**Scheduling:**
- at most `SOURCES_MAX_CONCURRENT_CRAWLS` (2) crawls run at once;
- a run lasts at most `SOURCES_CRAWL_RUN_MS` (15 min);
- while pages are still due, the next run comes after `SOURCES_CRAWL_SOON_MS` (60 s), not `poll_interval_sec`.

**Settings that don't apply:** a crawl source has no `retire_after_sec`, because a page leaves with its items as
described above.

**API:**
- `GET /api/v1/sources/:key/crawl` shows the frontier: pages by state, sitemaps, how many are due, and the latest
  fetches.
- `POST /api/v1/sources/:key/fetch` starts a crawl and answers 202.

Tests: `test/crawl.test.js`.

### Items

Each item: `source_key`, `category`, `kind`, `identity`, `canonical_url` (tracking parameters and
fragments removed), `title`, `summary`, `authors`, `published_at`, `source_updated_at`, `fields`,
`revision`, and `provenance` (`retrieved_at`, `first_seen_at`, `content_hash`, `raw_body_hash`,
`parser_version`, `fetch_run_id`, `license_note`, `terms_note`, `entered_by`). Earlier revisions
are kept in `item_revisions`. Removal (takedown, licence) is explicit, needs a reason, and is
sticky: a later fetch that still lists the item does not bring it back.

A source of jobs or listings sets `retire_after_sec` (an hour to a year; null, the default, keeps every item, as news
and datasets should). After a run in which every endpoint answered (`ok` or `not_modified`) and none failed, an item
the feed has not shown for that long is removed with reason `gone_from_source`. That is a change like any removal, so a
consumer following `GET /api/v1/items?include_removed=1` learns that the job is gone. A 304 counts as seeing again what
the endpoint's last good parse saw. At most 500 items are retired a run; the rest go on the next. Contract (released in openvibe-contracts v0.12.0):
[`sources.item@1`](docs/contracts-proposal/).

## API (service tokens, one capability per route)

Callers use an OpenVibe.Network client-credentials token for audience `openvibe.sources`. The merchant routes also
accept a signed-in person's session (see [Merchant opt-in](#merchant-opt-in-list-your-store-on-openvibe)); a first-party
service calls them with its service token and `X-OV-Subject: usr_…`.

| Capability | Routes |
|---|---|
| `sources.source.read` | `GET /api/v1/sources`, `/api/v1/sources/:key`, `/api/v1/sources/:key/runs?before=`, `/api/v1/runs?state=failed&after=`, `/api/v1/health`; `GET /api/v1/merchant/sources[/:id]` |
| `sources.item.read` | `GET /api/v1/items?source=&category=&after=<change_seq>&include_removed=1`, `GET /api/v1/items/:id?revisions=1` |
| `sources.source.manage` | `POST /api/v1/sources`, `PATCH`/`DELETE /api/v1/sources/:key`, `POST /api/v1/sources/:key/fetch`, `POST /api/v1/sources/:key/items` (manual), `DELETE /api/v1/items/:id` `{reason}`; `POST /api/v1/merchant/sources`, `/:id/verify`, `/:id/withdraw` |

`GET /api/v1/items` pages in change order (creations, revisions and — with `include_removed=1` —
removals); resume from `next_after`. Every page carries the status and staleness of the sources
it contains. The capability ids (first proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/))
are released in `openvibe-contracts` v0.12.0 (this repo pins v0.96.0); [server/auth.js](server/auth.js)
decides them with the contracts grant rule.

### Per-actor limits

Every API route also limits the principal that passed its capability guard, before any work:
`server/api/actor-limits.js`, openvibe-sdk/limits, roadmap WS-R task 4. Past a limit: `429`
problem+json `rate_limited` with `Retry-After`, one `[limits]` log line and
`sources_rate_limited_total{limit,window}`.

| Routes | Per principal, a minute / an hour |
|---|---|
| Reads (`sources.source.read`, `sources.item.read`) by an app or module (`app:…`, `mod:…`) | `SOURCES_LIMITS_MINUTE` / `SOURCES_LIMITS_HOUR` (120 / 3000) |
| `POST`, `PATCH`, `DELETE /api/v1/sources[/:key]` | 30 / 300 |
| `POST /api/v1/sources/:key/fetch` | 10 / 100 |
| `POST /api/v1/sources/:key/items` (manual) | 60 / 1200 |
| `GET /api/v1/merchant/sources[/:id]` (a merchant or a service acting for one) | 120 / 3000 |
| `POST /api/v1/merchant/sources`, `/:id/verify`, `/:id/withdraw` | 30 / 300 |
| `DELETE /api/v1/items/:id` (a takedown may cover many items) | 120 / 3000 |

A first-party service (`svc:…`) is not counted on reads: News, Reviews and Trade pull cursor pages
for all their readers, and Wiki asks about every item its editors cite. Sources' own workers (the
scheduler, fetches, the outbox relay) run in-process and never pass through HTTP. Never limited:
`/api/health`, `/api/ready`, `/release.json`, `/metrics` and the home page. `test/actor-limits.test.js`.

## Merchant opt-in ("List your store on OpenVibe")

The first permitted channel in plan §4.4. A signed-in merchant claims a domain, proves control of it, and names the
sitemap or product feed Sources may read. **Nothing is created in `sources` before the proof is found**: a pending claim
is only a `merchant_sources` row (migration `0007_merchant_sources.sql`). Verification creates one enabled source in the
same transaction, and withdrawal disables it while keeping the note.

- **Proof.** One of two challenges, the OpenVibe.Space pattern:
  - DNS: `_openvibe-sources.<domain>  TXT  "openvibe-sources-verification=<token>"`.
  - Meta: `<meta name="openvibe-sources-verification" content="<token>">` on `https://<domain>/` (or the `meta_url` the
    merchant names, on the same site). Redirects off the domain are refused.
- **Fetched politely.** A sitemap becomes a `crawl` source seeded with that sitemap (no guessed sitemaps); a product feed
  becomes an `rss`/`atom` source. Either way the ordinary fetcher runs: robots.txt on every request and redirect hop,
  per-host spacing, SSRF guard, conditional GETs. Explicit permission is not a robots override.
- **The terms note** records the merchant subject (and display name when the token carries one), the UTC verification
  time, the domain, the named sitemap/feed, and how control was verified ("DNS TXT record at _openvibe-sources.…" or
  "meta tag at …"); it also says the merchant may withdraw and that robots.txt is still obeyed.
- **Withdrawal** sets the claim to `withdrawn`, disables the source, and leaves `terms_note` and the claim row intact.
  The domain is free to claim again (a new claim, a new source key). Unlike a *served* custom domain (Space's daily
  recheck), the permission persists until the merchant withdraws: removing the TXT/meta record later does not silently
  disable the source.
- **Pending proofs** are rechecked by a slow in-process pass (`SOURCES_MERCHANT_RECHECK_MS`, default 10 min; `0` turns
  it off) and fail after `SOURCES_MERCHANT_PENDING_DAYS` (14). A merchant can also press "Check now".
- **Pages.** `GET /merchant` (guest explanation, or the signed-in merchant's list and add form),
  `GET /merchant/sources/:id` (challenge, status, terms note, last crawl), the POST actions
  `/merchant/sources`, `/:id/verify`, `/:id/withdraw`, and `/merchant/login|callback|logout`. Forms carry an HMAC CSRF
  token; the session is the Sources `ov_token` cookie, verified offline with `verifyUserToken`.
- **JSON read for Report.** `GET /api/v1/merchant/sources` (alias `/claims`) returns each claim with its source, health,
  last run, recent runs and — for a crawl — `last_crawl` (`pages`, `due`, `next_due_at`, state counts, recent pages).
  Report uses its service token and `X-OV-Subject: usr_…`; a merchant's own session needs no extra header. The read is
  the contract for the Report dashboard (which is not built here).
- **Identity.** The OAuth client is `OV_OAUTH_CLIENT_ID` (default `sources`) with
  `OV_OAUTH_REDIRECT_URI` defaulting to `<BASE_URL>/merchant/callback`; Network must register that exact redirect. A
  first-party service token may act for a merchant only with `X-OV-Subject` (an app/module token cannot). The merchant
  routes reuse the released `sources.source.read` / `sources.source.manage` capabilities; no new contract id is needed.
- **Config.** `SOURCES_SESSION_SECRET` (defaults to `OV_OAUTH_CLIENT_SECRET`), `SOURCES_COOKIE_SECURE`,
  `SOURCES_MERCHANT_PENDING_DAYS`, `SOURCES_MERCHANT_RECHECK_MS`, `SOURCES_MERCHANT_META_MAX_BYTES`,
  `SOURCES_MERCHANT_DNS_SERVERS`, and the source-shape knobs `SOURCES_MERCHANT_*` documented in
  [.env.example](.env.example). Tests: `test/merchant-optin.test.js`, `test/merchant-pages.test.js`.

## Events (transactional outbox → OpenVibe.Events when `EVENTS_URL` is set)

- `sources.item.created`, `sources.item.updated` (with the previous content hash), `sources.item.removed` (with the reason)
- `sources.fetch.failed` for `http_error`, `timeout`, `robots_denied`, `parse_error` and upstream 429 (with the state, error code, HTTP status and consecutive failures). Our own rate limiter and disabled sources are not failures.
- `sources.index_document.upserted|deleted` for sources with `search_visibility: "members"`: raw items indexed in OpenVibe.Search for staff only (`acl.groups: role:admin, role:global_mod`), always `noindex` (`third_party_content`).

All with `visibility: "internal"`. Envelopes validate as `events.event-envelope@1`.
The openvibe-sdk service outbox stores pending events in `service_outbox` and relays them with the
Sources service token. The expand migration copies pending legacy rows; `event_outbox` remains
for the N-1 rollback window.

## Seeds

[seeds/sources.json](seeds/sources.json) holds the 54 registered sources, each with its robots, terms and licence notes (the production rows are the record; the terms notes match them as of the 2026-10-23 review).
`npm run seed` creates the ones that do not exist yet, **all disabled**, and never changes an existing one; a person
enables a source after reading its terms (`PATCH /api/v1/sources/:key {"enabled": true}`), and the fetcher re-checks
robots.txt on every run. Production on 2026-10-22:

| Category | Sources (type) | Enabled in production |
|---|---|---|
| news | `nasa-news-releases`, `eu-press-corner`, `fda-food-recalls`, `noaa-news` (rss); `govuk-news` (atom) | 4 of 5: `noaa-news` is off (NOAA's robots.txt answers 403 to our user agent, so its rules cannot be read) |
| blog | `nodejs-blog` (rss) | 1 of 1 |
| reviews | `steam-reviews-<game>` for 19 games (api: Steam `appreviews` signals only, review text not mapped); `cfpb-complaints-by-company`, `nyc-restaurant-inspections`, `nyc-hpd-open-violations` (api: official records) | 22 of 22 |
| deals | `dealnews-daily` (rss, `feed@3`: the offer's price, retailer, end date, category and editors' pick) | 1 of 1 |
| coupons | `dealnews-coupon-codes` (rss with `extract`: only items that state a code and the shop, as kind `coupon`); `staff-coupon-codes` (manual, with the evidence URL) | 2 of 2 |
| trade | `sec-xbrl-filings`, `ecb-euro-reference-rates` (rss); `sec-company-tickers`, `frankfurter-eur-rates` (api) | 4 of 4 |
| hosting | `porkbun-tld-pricing`, `ovhcloud-vps`, `linode-types`, `aws-lightsail-bundles`, `vultr-plans` (api); `lowendspirit-offers`, `lowendtalk-offers`, `lowendbox-posts` (rss) | 5 of 8: `vultr-plans` is off (its API host's robots.txt disallows every path), and LowEndTalk's and LowEndBox's feeds answer 403 to the production host |
| crowdfunding | `opencollective-accounts` (api) | 1 of 1 |
| games | `steam-top-sellers`, `steam-new-releases`, `steam-specials` (api: the store's featured lists, in their order) | 3 of 3 |

Candidates rejected on 2026-09-22: CheapShark's API (`/api/1.0/` is disallowed in its
robots.txt) and EDGAR's `getcurrent` Atom feed (`/cgi-bin` disallowed). The seeded feeds were
downloaded once by hand and parsed offline with these adapters (NASA 10 items, Node.js 50,
Steam 20, DealNews 50, SEC 200); that check is not part of the test suite and proves nothing about
the terms.

## Source access (ADR 0007)

Whether a site may be read, and how, is computed from evidence, never judged:
[docs/adr/0007-source-access.md](docs/adr/0007-source-access.md). `node scripts/probe.mjs <domain>` (run from the
production host, whose egress is the crawler's) writes `evidence/<domain>.json`: robots.txt, sitemap.xml,
/products.json, llms.txt, /api/ and the home page, with statuses and challenge markers, and a verdict.
`node scripts/adapters-from-evidence.mjs` turns evidence into adapters (`ok` → an enabled crawl source,
`structured-only` → a disabled one, Lane 1) or a row in [compliance/review-queue.yaml](compliance/review-queue.yaml)
(`queued`); `node scripts/register-adapters.js` brings the registry to the adapters. The crawler identifies itself as
`Mozilla/5.0 (compatible; OpenVibeBot/1.0; +https://openvibe.network/bot)` and obeys robots.txt groups, robots meta
and X-Robots-Tag for either token, `OpenVibeBot` or `OpenVibeSources`. The crawl type itself:
[docs/adr/0006-crawl-source-type.md](docs/adr/0006-crawl-source-type.md).

Probed 2026-10-28 (`c` = challenge page):

| Domain | Verdict | Statuses | Lane | Adapter |
|---|---|---|---|---|
| adorama.com | structured-only | `/robots.txt:200 /sitemap.xml:404c /products.json:403c /llms.txt:403c /api/:403c /:403c` | Lane 1 (feeds, affiliate, API, opt-in); adapter disabled | [adapters/adorama.com.json](adapters/adorama.com.json) |
| allbirds.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:200 /llms.txt:200 /api/:404 /:200` | crawl adapter, enabled | [adapters/allbirds.com.json](adapters/allbirds.com.json) |
| anker.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:404 /llms.txt:200 /api/:404 /:200` | crawl adapter, enabled | [adapters/anker.com.json](adapters/anker.com.json) |
| backcountry.com | queued | `/robots.txt:403 /sitemap.xml:403 /products.json:403 /llms.txt:403 /api/:403 /:403` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| bestbuy.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:404 /llms.txt:404 /api/:404 /:200` | crawl adapter, enabled | [adapters/bestbuy.com.json](adapters/bestbuy.com.json) |
| bhphotovideo.com | structured-only | `/robots.txt:200 /sitemap.xml:403c /products.json:403c /llms.txt:403c /api/:403c /:403c` | Lane 1 (feeds, affiliate, API, opt-in); adapter disabled | [adapters/bhphotovideo.com.json](adapters/bhphotovideo.com.json) |
| brooksrunning.com | queued | `/robots.txt:403 /sitemap.xml:403 /products.json:403 /llms.txt:403 /api/:403 /:403` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| converse.com | queued | `/robots.txt:403 /sitemap.xml:403 /products.json:403 /llms.txt:403 /api/:403 /:403` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| dsw.com | ok | `/robots.txt:200 /sitemap.xml:404 /products.json:404 /llms.txt:404 /api/:200 /:200` | crawl adapter, enabled | [adapters/dsw.com.json](adapters/dsw.com.json) |
| footlocker.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:200 /llms.txt:200 /api/:403 /:200` | crawl adapter, enabled | [adapters/footlocker.com.json](adapters/footlocker.com.json) |
| frame.work | queued | `/robots.txt:403c /sitemap.xml:403c /products.json:403c /llms.txt:403c /api/:403c /:403c` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| gog.com | ok | `/robots.txt:200 /sitemap.xml:404 /products.json:404 /llms.txt:404 /api/:404 /:200` | crawl adapter, enabled | [adapters/gog.com.json](adapters/gog.com.json) |
| hoka.com | structured-only | `/robots.txt:200 /sitemap.xml:404 /products.json:410 /llms.txt:410 /api/:500 /:0` | Lane 1 (feeds, affiliate, API, opt-in); adapter disabled | [adapters/hoka.com.json](adapters/hoka.com.json) |
| homedepot.com | ok | `/robots.txt:200 /sitemap.xml:404 /products.json:404 /llms.txt:404 /api/:404 /:200` | crawl adapter, enabled | [adapters/homedepot.com.json](adapters/homedepot.com.json) |
| humblebundle.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:404 /llms.txt:404 /api/:404 /:200` | crawl adapter, enabled | [adapters/humblebundle.com.json](adapters/humblebundle.com.json) |
| ikea.com | queued | `/robots.txt:403c /sitemap.xml:403c /products.json:403c /llms.txt:403c /api/:403c /:403c` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| microcenter.com | queued | `/robots.txt:403c /sitemap.xml:403c /products.json:403c /llms.txt:403c /api/:403c /:403c` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| monoprice.com | structured-only | `/robots.txt:200 /sitemap.xml:403c /products.json:403c /llms.txt:404 /api/:403c /:403c` | Lane 1 (feeds, affiliate, API, opt-in); adapter disabled | [adapters/monoprice.com.json](adapters/monoprice.com.json) |
| newbalance.com | queued | `/robots.txt:403 /sitemap.xml:403 /products.json:403 /llms.txt:403 /api/:403 /:403` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| newegg.com | queued | `/robots.txt:403 /sitemap.xml:403 /products.json:403 /llms.txt:403 /api/:403 /:403` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| on.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:200 /llms.txt:200 /api/:403 /:200` | crawl adapter, enabled | [adapters/on.com.json](adapters/on.com.json) |
| patagonia.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:200 /llms.txt:200 /api/:200 /:200` | crawl adapter, enabled | [adapters/patagonia.com.json](adapters/patagonia.com.json) |
| rei.com | queued | `/robots.txt:403 /sitemap.xml:403 /products.json:403 /llms.txt:403 /api/:403 /:403` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| runningwarehouse.com | queued | `/robots.txt:0 /sitemap.xml:0 /products.json:0 /llms.txt:0 /api/:0 /:0` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| saucony.com | structured-only | `/robots.txt:200 /sitemap.xml:404 /products.json:404c /llms.txt:404c /api/:404c /:200c` | Lane 1 (feeds, affiliate, API, opt-in); adapter disabled | [adapters/saucony.com.json](adapters/saucony.com.json) |
| vans.com | queued | `/robots.txt:403 /sitemap.xml:403 /products.json:403 /llms.txt:403 /api/:403 /:403` | review queue; probed again after 24 h | [compliance/review-queue.yaml](compliance/review-queue.yaml) |
| wayfair.com | structured-only | `/robots.txt:200 /sitemap.xml:404 /products.json:404 /llms.txt:429 /api/:429 /:429` | Lane 1 (feeds, affiliate, API, opt-in); adapter disabled | [adapters/wayfair.com.json](adapters/wayfair.com.json) |
| woot.com | ok | `/robots.txt:200 /sitemap.xml:200 /products.json:404 /llms.txt:404 /api/:404 /:200` | crawl adapter, enabled | [adapters/woot.com.json](adapters/woot.com.json) |
| zappos.com | ok | `/robots.txt:200 /sitemap.xml:404 /products.json:404 /llms.txt:404 /api/:200 /:200` | crawl adapter, enabled | [adapters/zappos.com.json](adapters/zappos.com.json) |

## Processing jobs: who does what (roadmap WS-O task 7, decided 2026-09-26)

| Job | Where | How |
|---|---|---|
| **Dedupe within a source** | Sources | an item's `identity` (feed guid/id, else canonical URL) and `content_hash`: a refetch updates the item and keeps a revision, never a second item |
| **Dedupe across sources** (one story from several outlets) | the product | News groups items into a story before `news.summarize_story`; Deals and Coupons match on merchant and code. Sources does not decide two outlets' items are "the same". |
| **Classify** | Sources, coarsely; the product, finely | every source has one `category` (news, reviews, deals, coupons, trade…) and its items inherit it. Topic, entity or instrument classification is the product's, with its own review. |
| **Summarise** | the product, through OpenVibe.AI | products call AI's seeded workflows (`news.summarize_story`, `reviews.summarize_entity`, `deals.enrich_deal`, `coupons.extract_coupon`, `trade.summarize_market_context`), passing Sources items as numbered `sources` with their provenance. The result is a draft/evidence package with citations and gaps, never published by AI or Sources. |
| **Quality check** | the product | the publishing packages' indexability gate and each product's review queue decide what is shown; Sources records fetch failures as failures and never fills a gap with invented content |

**The AI ↔ Sources client:** there is none. Sources never calls AI, and AI never fetches from Sources.
The product is the only client of both: it reads items from Sources (`sources.item.read`) and sends
them to AI as run input (`ai.run.create`). Provenance then travels with the draft, and no service
publishes another's output.

## Owns

- the source registry (`sources`, `endpoint_state`, `robots_cache`) and the source/item contracts
- the merchant opt-in claims (`merchant_sources`), their proof checks and the pages/JSON read
- ingestion: `fetch_runs`, `items`, `item_revisions`, the scheduler, robots and rate-limit state
- `sources.*` events

## Does not own

- publication: what a product shows, summarises, rates or indexes from an item (News, Reviews,
  Deals, Coupons, Trade, the publishing packages' indexability gate)
- AI summarisation (OpenVibe.AI invokes adapters' output; it does not fetch here)
- legal clearance: a terms note records what a person verified; it does not replace verifying

## Depends on

- PostgreSQL 18 (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through `openvibe-sdk/db`
- OpenVibe.Contracts (service tokens, problem details, ids, the event envelope)
- OpenVibe.Network (signing key; service principal `sources`; OAuth client `sources` for merchant sign-in)
- OpenVibe.Events (outbound events)

## Capabilities

Implemented here (the service manifest's `capabilities`; routes in [API](#api-service-tokens-one-capability-per-route)):
`sources.source.read`, `sources.item.read` and `sources.source.manage`, each checked by
[server/auth.js](server/auth.js) with the contracts grant rule for audience `openvibe.sources`.

Called elsewhere, as the service principal `sources` (client credentials from OpenVibe.Network):

| Service | Grant | Why |
|---|---|---|
| OpenVibe.Events | `events.event.publish` (audience `openvibe.events`) | the outbox relays `sources.item.*`, `sources.fetch.failed` and `sources.index_document.*` |

Sources calls no other OpenVibe service: it never calls AI, and Search receives its index documents
through Events.

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
- the public host shows only an honest "internal service" page and the merchant opt-in pages, and the vhost keeps the
  API loopback-only (`test/public-host.test.js`)
- merchant opt-in: no source before the DNS/meta proof, the terms note records who/when/how, robots.txt is still obeyed,
  withdrawal disables and keeps the note, and the JSON read carries last crawl stats (`test/merchant-optin.test.js`,
  `test/merchant-pages.test.js`)

Production on 2026-10-22 (counts read from `ov_sources`):
- 43 of 47 sources enabled, each after its terms and robots were read (by category in [Seeds](#seeds)); none of them
  failing. 4,762 fetch runs since the first on 2026-10-07, 431 in the last 24 hours.
- 55,683 items, none removed: reviews 33,635, trade 15,736, deals 3,465, hosting 1,097, news 529, crowdfunding 504,
  games 362, coupons 297 and blog 58; 58,355 item revisions. The database is 253 MB.
- Their items feed News, Reviews (Steam signals and the CFPB, NYC Health and NYC HPD records), Deals (DealNews and
  Open Collective for crowdfunding), Coupons, Trade (SEC, ECB and Frankfurter rates), Host (Porkbun, OVHcloud, Linode,
  Lightsail and LowEndSpirit), Games (Steam's featured lists) and Blog's desks.

The first production fetch run was on 2026-10-07; until then every seed stayed disabled.

Restore drill: `ovhost drill sources` passed on the production host on 2026-09-23 (integrity check,
readiness, row counts; see OpenVibe.Host `docs/restore-drills.md`).

## Security

Reporting: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Auth.** Every `/api/v1` route needs an OpenVibe.Network service token for audience
  `openvibe.sources` with that route's capability, then passes the per-actor limits. The merchant API and pages are the
  one person-facing exception: a Network person session (Bearer on the API, the first-party `ov_token` cookie on the
  pages) owns its claims, and a first-party service may act for a person only with `X-OV-Subject`. There is still no
  public JSON API: the vhost keeps `/api/v1/*` loopback-only, and only `/merchant*` and `/shared/*` are public.
- **Egress.** Sources fetches outside URLs by design, only through its guard: http(s) on ports 80/443,
  every resolved address public at connect time (no DNS rebinding), each redirect re-checked, robots.txt
  obeyed, per-host spacing, one deadline and a byte cap per response (`test/robots-ssrf.test.js`,
  `test/security-ssrf.test.js`). XML entity declarations are refused.
- **Secrets.** A source's credential is the **name** of a `SOURCES_CRED_*` variable, read at fetch time,
  sent only to the configured origin, never stored or logged (`test/security-secrets.test.js`).
  `OV_OAUTH_CLIENT_SECRET` and the source credentials live in `/etc/openvibe/sources.env` (0600).
- **Data.** A failed fetch never creates or changes an item; items keep their provenance and terms;
  raw items reach Search only for staff (`acl.groups`), always `noindex`.

## Deploy

Production deploys with `sudo ovhost deploy sources` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.sources`, install on a lockfile change, restart, wait for `/api/ready`).

| | |
|---|---|
| Checkout | `/opt/openvibe.sources` |
| Unit | `openvibe-sources.service` ([deploy/systemd/](deploy/systemd/openvibe-sources.service)) |
| Port | `127.0.0.1:4720` |
| Env file | `/etc/openvibe/sources.env` |
| Data | PostgreSQL `ov_sources` (`DATABASE_URL` through PgBouncer; migrations on `DATABASE_DIRECT_URL`; schema in [migrations/](migrations/)) |
| Public host | nginx [deploy/nginx/sources.openvibe.network.conf](deploy/nginx/sources.openvibe.network.conf) (below) |

Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback sources --to <sha>`. Migrations only add tables and columns.

### Public host

`sources.openvibe.network` resolves through Cloudflare; without this vhost nginx answers it with
its default site (the admin placeholder). The vhost
([deploy/nginx/sources.openvibe.network.conf](deploy/nginx/sources.openvibe.network.conf)) uses
the Network wildcard certificate and answers only:

| Path | Answer |
|---|---|
| `/` | a short page: an internal ingestion service, nothing to browse (HTML for browsers, the text route index otherwise; noindex, no-store) |
| `/merchant`, `/merchant/*` | the merchant opt-in pages (guest explanation, signed-in claims, proof/withdraw forms; noindex, no-store) |
| `/shared/*` | this release's pinned `theme-loader.js`, `kit.css`, `kit-web.js` (served by `openvibe-shared/serve`) |
| `/api/health`, `/api/ready`, `/release.json` | proxied |
| `/robots.txt` | `Disallow: /` |
| `/metrics` | 404 (Prometheus scrapes `127.0.0.1:4720/metrics` directly) |
| `/api/v1/*` | loopback only (`allow 127.0.0.1; allow ::1; deny all`); services call `127.0.0.1:4720` |
| anything else | a JSON 404 that says what the host is |

Client-address headers come from `$remote_addr` only. Install on the host, after the service runs
a release with the new `/` page (`ovhost deploy sources`):

```bash
sudo install -m 0644 /opt/openvibe.sources/deploy/nginx/sources.openvibe.network.conf /etc/nginx/sites-available/sources.openvibe.network.conf
sudo ln -sf /etc/nginx/sites-available/sources.openvibe.network.conf /etc/nginx/sites-enabled/sources.openvibe.network.conf
sudo nginx -t && sudo systemctl reload nginx
# check
curl -sS -H 'Accept: text/html' https://sources.openvibe.network/ | grep -o '<title>[^<]*'   # OpenVibe.Sources
curl -sS -o /dev/null -w '%{http_code}\n' https://sources.openvibe.network/merchant           # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://sources.openvibe.network/shared/kit.css     # 200
curl -sS https://sources.openvibe.network/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://sources.openvibe.network/api/v1/sources    # 403
curl -sS -o /dev/null -w '%{http_code}\n' https://sources.openvibe.network/metrics           # 404
curl -sS https://sources.openvibe.network/admin                                               # JSON 404
```


## Launch rule

Sources has no public product pages by design: the only person-facing pages are the merchant opt-in flow (`/merchant`),
which exist so a merchant can prove a domain and name a sitemap/feed. It never "launches" as a site. The domain is not
in [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites); this repository's own vhost serves it.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.224.0
- openvibe-sdk: v0.67.0
- openvibe-shared: v4.43.0
<!-- versions:end -->
