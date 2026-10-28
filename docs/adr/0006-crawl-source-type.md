# 0006 — The crawl source type

Status: Accepted · 2026-10-28 · Contracts 0.224.0 (`sources.source@1`, `sources.source-write-request@1`) · Sources#128

## Context
Feeds and APIs cover the sources that publish one. Many sites publish their catalogue only as pages with
schema.org JSON-LD and a sitemap. Deals, Shoes and the open index need those pages without a bespoke
adapter per site.

## Decision
A source of type `crawl` walks one site from its endpoints (the seeds).

- **Frontier.** `crawl_frontier` holds every known URL of the source (page or sitemap), its depth, how it was
  found, its next fetch time, validators (ETag, Last-Modified), body hash, item count and failures.
- **Discovery.** Sitemaps named in robots.txt (else `/sitemap.xml`; `.xml.gz` gunzipped; indexes followed, at
  most 1000 sitemaps and 50 000 URLs each). With `follow_links`, same-host links up to `max_depth`.
  `include`/`exclude` are regular expressions over path and query. A crawl never leaves its seeds' hosts
  (or their `www` twins).
- **Budget.** `max_pages` (default 5000) known pages, `pages_per_run` (100) per run, at most
  `SOURCES_MAX_CONCURRENT_CRAWLS` (2) crawls at once. A run with pages still due asks for another run in 60 s.
- **Recrawl.** `recrawl_sec` (default 86 400, 3600–2 592 000); an unchanged page waits ×1.5 longer each
  time, up to ×4. A sitemap `lastmod` newer than the last fetch brings a page forward.
- **Items.** Pages are parsed with `jsonld@2`; `require_structured` (default true) keeps only pages that
  publish JSON-LD. Without it, a `page@1` item comes from the page's own search metadata.
- **Respect.** robots.txt per request and per redirect hop; `noindex`/`nofollow` from the robots meta, a
  meta named for our product tokens, and X-Robots-Tag; canonical links win over the fetched URL.
- **Retirement.** A page answering 404 twice, or 410 once, retires its items (`items.retireRun`).
  `retire_after_sec` is refused on a crawl source.
- **Failure.** A page's failure is the page's. The source fails only when robots.txt is unreachable, the
  site answers 429 or 503 with Retry-After, or 5 requests in a row go unanswered.
- **API.** `GET /api/v1/sources/:key/crawl` reports the frontier; a manual fetch of a crawl source answers
  202 and runs on the scheduler.

## Consequences
Whether a site may be crawled at all, and with which technique, is not this ADR's question: ADR 0007
computes it from probe evidence. This ADR only says how an enabled crawl source behaves.
