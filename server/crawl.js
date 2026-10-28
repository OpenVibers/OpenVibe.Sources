'use strict';
/**
 * Crawl sources (sources.source@1 type crawl; the owner, 2026-10-28: "aggregate all websites… a full comprehensive
 * crawler system… the open source Google"). A crawl walks one site from its endpoints (the seeds) and reads, page by
 * page, only what the site publishes for machines: schema.org JSON-LD (products and offers for deals, articles,
 * reviews) and, for a source that does not require it, the page's own search metadata (adapters/page.js).
 *
 * The frontier (crawl_frontier) is every page and sitemap the crawl knows, with when each is due again:
 *   - found from the seeds, the site's sitemaps (robots.txt Sitemap lines, else /sitemap.xml; indexes followed, and a
 *     newer <lastmod> makes a known page due again), its canonical links and, with follow_links, its same-host links
 *     up to max_depth; include/exclude patterns, robots.txt and max_pages decide what is added
 *   - each run fetches the sitemaps that are due, then up to pages_per_run due pages, oldest first
 *   - a page is due again recrawl_sec after a fetch that changed something; while it stays the same the wait grows to
 *     four times that, and a change brings it back: a price seen twice becomes a history (Deals' observations)
 *
 * Every request is a request like any other source's: robots.txt (RFC 9309) on the URL and every redirect hop, the
 * per-host spacing with Crawl-delay and the source's min_interval_ms, conditional GETs, the address guard, a fetch_runs
 * row per page. A crawl never leaves its seeds' hosts (or their www twins). A page that says noindex (meta robots, our
 * own token's meta, X-Robots-Tag) is not kept and its items are retired; nofollow stops its links from being followed.
 *
 * Page states: new | kept (items read) | hub (no items, links followed) | unstructured (no items: dropped) | noindex |
 * duplicate (its canonical is another page) | not_html | too_large | excluded | denied (robots) | missing (404 once) |
 * gone (404/410 twice: its items are retired) | failing. Sitemaps: new | read | denied | missing | gone | failing.
 *
 * A failing page is the page's business; the source fails (backoff, sources.fetch.failed) only when the site does:
 * robots.txt unreachable, a 429 or a 503 with Retry-After, or five requests in a row that got no usable answer.
 */
const zlib = require('zlib');
const jsonld = require('./adapters/jsonld');
const sitemap = require('./adapters/sitemap');
const page = require('./adapters/page');
const { sha256, decodeBody, canonicalUrl, ParseError } = require('./adapters/util');

const HTML_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1';
const XML_ACCEPT = 'application/xml, text/xml;q=0.9, application/x-gzip;q=0.5, */*;q=0.1';
const DAY_MS = 86400 * 1000;
const GONE_RECHECK_MS = 30 * DAY_MS;
const STREAK_LIMIT = 5;

const looksLikeSitemap = (u) => /\.xml(\.gz)?$/i.test(new URL(u).pathname);
const twins = (host) => (host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`]);

function retryAfterMs(value, t) {
    if (value == null) return null;
    const s = String(value).trim();
    if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
    const d = Date.parse(s);
    return Number.isFinite(d) ? Math.max(0, d - t) : null;
}

function createCrawler({ db, config, items, robots, fetcher, spacer, record, now = () => Date.now(), log = console }) {
    const st = {
        seed: db.prepare(`INSERT INTO crawl_frontier (source_key, url, kind, depth, found_via, first_seen_at, next_fetch_at)
            VALUES (@k, @url, @kind, 0, @via, @now, @now) ON CONFLICT (source_key, url) DO NOTHING`),
        count: db.prepare('SELECT COUNT(*) AS n FROM crawl_frontier WHERE source_key = ? AND kind = ?'),
        addMany: db.prepare(`INSERT INTO crawl_frontier (source_key, url, kind, depth, found_via, first_seen_at, next_fetch_at, lastmod_at)
            SELECT @k, t.u, @kind, @depth, @via, @now, @now, t.lm FROM unnest(@urls::text[], @lms::bigint[]) AS t(u, lm)
            WHERE NOT EXISTS (SELECT 1 FROM crawl_frontier f WHERE f.source_key = @k AND f.url = t.u)
            LIMIT @room
            ON CONFLICT (source_key, url) DO NOTHING`),
        // A sitemap that says a known page changed after we last fetched it makes the page due now.
        touchLastmod: db.prepare(`UPDATE crawl_frontier f SET lastmod_at = t.lm, next_fetch_at = LEAST(COALESCE(f.next_fetch_at, @now), @now)
            FROM unnest(@urls::text[], @lms::bigint[]) AS t(u, lm)
            WHERE f.source_key = @k AND f.url = t.u AND t.lm IS NOT NULL AND f.last_fetch_at IS NOT NULL AND t.lm > f.last_fetch_at
            AND f.state NOT IN ('noindex', 'duplicate', 'excluded')`),
        due: db.prepare(`SELECT * FROM crawl_frontier WHERE source_key = @k AND kind = @kind AND next_fetch_at <= @now
            ORDER BY next_fetch_at, url LIMIT @limit`),
        dueCount: db.prepare('SELECT COUNT(*) AS n FROM crawl_frontier WHERE source_key = ? AND next_fetch_at <= ?'),
        stateOf: db.prepare('SELECT state FROM crawl_frontier WHERE source_key = ? AND url = ?'),
        save: db.prepare(`UPDATE crawl_frontier SET state = @state, next_fetch_at = @next_fetch_at, last_fetch_at = @last_fetch_at,
            interval_sec = @interval_sec, last_status = @last_status, etag = @etag, last_modified = @last_modified, body_hash = @body_hash,
            last_ok_run_id = @last_ok_run_id, items = @items, fails = @fails WHERE source_key = @source_key AND url = @url`),
        summary: db.prepare(`SELECT kind, state, COUNT(*) AS n, SUM(CASE WHEN next_fetch_at <= @now THEN 1 ELSE 0 END) AS due
            FROM crawl_frontier WHERE source_key = @k GROUP BY kind, state`),
        recent: db.prepare(`SELECT url, kind, state, depth, found_via, last_fetch_at, next_fetch_at, last_status, items, fails
            FROM crawl_frontier WHERE source_key = ? AND last_fetch_at IS NOT NULL ORDER BY last_fetch_at DESC, url LIMIT ?`),
        nextDue: db.prepare('SELECT MIN(next_fetch_at) AS at FROM crawl_frontier WHERE source_key = ?'),
    };

    const save = (r, changes) => st.save.run({ ...r, ...changes });

    /** The crawl's reach: its hosts, its include/exclude patterns, and robots.txt per origin (one compiled matcher a run). */
    function scopeOf(source) {
        const c = source.crawl;
        const hosts = new Set();
        for (const e of source.endpoints) for (const h of twins(new URL(e.url).host)) hosts.add(h);
        const include = c.include.map(p => new RegExp(p));
        const exclude = c.exclude.map(p => new RegExp(p));
        const matchers = new Map();
        return {
            inHost: (u) => hosts.has(u.host),
            wanted(u) {
                const pq = u.pathname + u.search;
                if (exclude.some(re => re.test(pq))) return false;
                return !include.length || include.some(re => re.test(pq));
            },
            async allowed(u) {
                let m = matchers.get(u.origin);
                if (!m) { m = await robots.matcher(u.href); matchers.set(u.origin, m); }
                return m(u.pathname + u.search);
            },
        };
    }

    /** Add URLs to the frontier (in scope, wanted, allowed, within the cap); a newer lastmod makes a known page due. → added */
    async function enqueue(source, scope, list, { kind, depth, via }) {
        const urls = [];
        const lms = [];
        const seen = new Set();
        for (const it of list) {
            let u;
            try { u = new URL(it.url); } catch { continue; }
            if (seen.has(u.href) || !scope.inHost(u)) continue;
            if (kind === 'page' && !scope.wanted(u)) continue;
            if (!(await scope.allowed(u))) continue;
            seen.add(u.href);
            urls.push(u.href);
            lms.push(Number.isFinite(it.lastmod) ? it.lastmod : null);
        }
        const cap = kind === 'sitemap' ? config.crawl.maxSitemaps : source.crawl.max_pages;
        const t = now();
        let added = 0;
        for (let i = 0; i < urls.length; i += 1000) {
            const chunk = { k: source.key, kind, depth, via, now: t, urls: urls.slice(i, i + 1000), lms: lms.slice(i, i + 1000) };
            if (kind === 'page') await st.touchLastmod.run(chunk);
            const room = cap - Number((await st.count.get(source.key, kind)).n);
            if (room > 0) added += (await st.addMany.run({ ...chunk, room })).changes || 0;
        }
        return added;
    }

    /** Every run: the seeds, and the sitemaps robots.txt names (else /sitemap.xml). Known rows are left as they are. */
    async function seed(source, scope) {
        const t = now();
        const origins = new Set();
        for (const e of source.endpoints) {
            const url = canonicalUrl(e.url);
            if (!url) continue;
            origins.add(new URL(url).origin);
            await st.seed.run({ k: source.key, url, kind: looksLikeSitemap(url) ? 'sitemap' : 'page', via: 'seed', now: t });
        }
        if (!source.crawl.sitemaps) return;
        for (const origin of origins) {
            const named = await robots.sitemaps(origin);
            const list = named.length ? named : [`${origin}/sitemap.xml`];
            for (const s of list) {
                const url = canonicalUrl(s);
                if (url && scope.inHost(new URL(url))) await st.seed.run({ k: source.key, url, kind: 'sitemap', via: named.length ? 'robots' : 'guess', now: t });
            }
        }
    }

    /** A redirect stays on the crawl's hosts, passes robots.txt, and a new host is spaced like any request to it. */
    const hop = (source, scope, host) => async (next) => {
        if (!scope.inHost(next)) return { refuse: `${next.host} is outside this crawl` };
        const v = await robots.check(next.toString());
        if (!v.allowed) return { refuse: v.reason };
        if (next.host !== host) {
            spacer.setCrawlDelay(next.host, v.crawlDelaySec);
            await spacer.space(next.host, source.min_interval_ms);
        }
        return null;
    };

    const backoffMs = (source, fails) => Math.min(source.crawl.recrawl_sec * 4000, 15 * 60 * 1000 * 2 ** Math.min(fails - 1, 10));
    const grown = (source, prev) => Math.min(Math.round((prev || source.crawl.recrawl_sec) * 1.5), source.crawl.recrawl_sec * 4);

    /**
     * robots.txt for the URL, then the request. → { res } | { out } when it ended before or at the request (the run row is
     * recorded and the frontier row saved).
     */
    async function request(source, scope, r, run, { accept, capBytes }) {
        const u = new URL(r.url);
        const verdict = await robots.check(r.url);
        spacer.setCrawlDelay(u.host, verdict.crawlDelaySec);
        if (!verdict.allowed) {
            if (verdict.refusedCode || /^robots\.txt unreachable/.test(verdict.reason || '')) {
                // The whole host is closed to us for now: the source's failure, not this page's.
                Object.assign(run, verdict.refusedCode
                    ? { state: 'http_error', error_code: verdict.refusedCode, detail: `${u.host} is not fetchable (${verdict.refusedCode})` }
                    : { state: 'robots_denied', error_code: 'robots', detail: verdict.reason }, { finished_at: now() });
                await record.insertRun(run);
                return { out: { run, stop: true } };
            }
            Object.assign(run, { state: 'robots_denied', error_code: 'robots', detail: verdict.reason, finished_at: now() });
            await record.insertRun(run);
            await save(r, { state: 'denied', next_fetch_at: now() + config.fetch.robotsTtlMs });
            return { out: { run } };
        }
        await spacer.space(u.host, source.min_interval_ms);
        await record.requested(now(), source.key);
        try {
            const res = await fetcher.fetchUrl(r.url, {
                headers: { Accept: accept }, etag: r.etag || null, lastModified: r.last_modified || null,
                capBytes, beforeHop: hop(source, scope, u.host),
            });
            Object.assign(run, { http_status: res.status, bytes: res.bytes != null ? res.bytes : null, finished_at: now() });
            return { res };
        } catch (err) {
            const t = now();
            const state = err.code === 'timeout' ? 'timeout' : err.code === 'hop_refused' ? 'robots_denied' : 'http_error';
            Object.assign(run, { state, error_code: err.code || 'network', detail: String(err.message).slice(0, 500), finished_at: t });
            await record.insertRun(run);
            if (['address_refused', 'port_refused'].includes(err.code)) return { out: { run, stop: true } };
            if (err.code === 'hop_refused') {
                await save(r, { state: 'denied', last_fetch_at: t, next_fetch_at: t + source.crawl.recrawl_sec * 1000 });
                return { out: { run, requested: true, answered: true } };
            }
            if (err.code === 'too_large' || err.code === 'too_many_redirects' || err.code === 'bad_url') {
                await save(r, { state: err.code === 'too_large' ? 'too_large' : 'failing', last_fetch_at: t, next_fetch_at: err.code === 'too_large' ? null : t + source.crawl.recrawl_sec * 4000 });
                return { out: { run, requested: true, answered: true } };
            }
            const fails = Number(r.fails) + 1;
            await save(r, { state: r.state === 'new' ? 'failing' : r.state, fails, last_fetch_at: t, next_fetch_at: t + backoffMs(source, fails) });
            return { out: { run, requested: true, unanswered: true } };
        }
    }

    /** Statuses a page and a sitemap answer alike; null when the body is for the caller to read. */
    async function common(source, r, run, res) {
        const t = run.finished_at;
        if (res.status === 429 || (res.status === 503 && res.headers['retry-after'] != null)) {
            const wait = Math.min(retryAfterMs(res.headers['retry-after'], t) ?? 10 * 60 * 1000, 24 * 3600 * 1000);
            Object.assign(run, res.status === 429
                ? { state: 'rate_limited', error_code: 'upstream_429', detail: `the site asked us to wait ${Math.round(wait / 1000)} s` }
                : { state: 'http_error', error_code: 'http_503', detail: `HTTP 503, retry after ${Math.round(wait / 1000)} s` });
            await record.insertRun(run);
            await save(r, { next_fetch_at: t + wait });
            return { run, requested: true, stop: true, notBefore: t + wait };
        }
        if (res.status === 404 || res.status === 410) {
            const gone = res.status === 410 || [404, 410].includes(Number(r.last_status));
            Object.assign(run, { state: 'http_error', error_code: `http_${res.status}`, detail: gone ? 'gone: its items are retired' : `HTTP ${res.status}, checked again tomorrow` });
            await record.insertRun(run);
            if (gone && r.last_ok_run_id) await items.retireRun(source, r.last_ok_run_id, 'gone_from_source');
            await save(r, { state: gone ? 'gone' : 'missing', last_status: res.status, last_fetch_at: t, next_fetch_at: t + (gone ? GONE_RECHECK_MS : DAY_MS), etag: null, last_modified: null });
            return { run, requested: true, answered: true };
        }
        if (res.status !== 200 && res.status !== 203 && res.status !== 304) {
            Object.assign(run, { state: 'http_error', error_code: `http_${res.status}`, detail: `HTTP ${res.status}` });
            await record.insertRun(run);
            const fails = Number(r.fails) + 1;
            await save(r, { state: r.state === 'new' ? 'failing' : r.state, fails, last_status: res.status, last_fetch_at: t, next_fetch_at: t + backoffMs(source, fails) });
            // A server error or a refusal (401, 403) is the site not answering us; a 400 or 451 is about the page.
            return { run, requested: true, ...(res.status >= 500 || res.status === 401 || res.status === 403 ? { unanswered: true } : { answered: true }) };
        }
        return null;
    }

    // ── A page ───────────────────────────────────────────────

    async function fetchPage(source, scope, r, trigger) {
        const c = source.crawl;
        const u = new URL(r.url);
        if (!scope.inHost(u) || (r.found_via !== 'seed' && !scope.wanted(u))) {
            // The source's patterns changed since the page was found (a seed is fetched whatever they say): nothing is requested.
            await save(r, { state: 'excluded', next_fetch_at: null });
            return {};
        }
        const run = record.baseRun(source, r.url, trigger, now());
        const req = await request(source, scope, r, run, { accept: HTML_ACCEPT });
        if (req.out) return req.out;
        const { res } = req;
        const t = run.finished_at;
        const early = await common(source, r, run, res);
        if (early) return early;

        const unchanged = async (hash) => {
            const interval = grown(source, r.interval_sec);
            Object.assign(run, { state: res.status === 304 ? 'not_modified' : 'ok', detail: res.status === 304 ? null : 'the page is the same' });
            if (hash) run.raw_body_hash = hash;
            await record.insertRun(run);
            if (r.last_ok_run_id) await items.seenAgain(source, r.last_ok_run_id, t);
            await save(r, {
                last_status: res.status, last_fetch_at: t, interval_sec: interval, next_fetch_at: t + interval * 1000, fails: 0,
                etag: res.headers.etag || r.etag, last_modified: res.headers['last-modified'] || r.last_modified,
            });
            return { run, requested: true, answered: true };
        };
        if (res.status === 304) return await unchanged(null);

        const type = String(res.headers['content-type'] || '').toLowerCase();
        if (type && !/html|xml/.test(type)) {
            Object.assign(run, { state: 'ok', detail: `not a web page (${type.split(';')[0]}): not kept` });
            await record.insertRun(run);
            await save(r, { state: 'not_html', last_status: res.status, last_fetch_at: t, next_fetch_at: null });
            return { run, requested: true, answered: true };
        }
        const hash = sha256(res.body);
        run.raw_body_hash = hash;
        if (hash === r.body_hash && ['kept', 'hub'].includes(r.state)) return await unchanged(hash);

        const text = decodeBody(res.body, res.headers['content-type']);
        const finalUrl = canonicalUrl(res.finalUrl) || r.url;
        const follow = c.follow_links && Number(r.depth) < c.max_depth;
        const meta = page.read(text, { url: finalUrl, agent: config.fetch.robotsAgent, headers: res.headers, links: follow });
        const validators = { etag: res.headers.etag || null, last_modified: res.headers['last-modified'] || null };

        if (meta.noindex) {
            // The site asked search engines not to keep this page: we keep nothing from it either.
            const retired = r.last_ok_run_id ? await items.retireRun(source, r.last_ok_run_id, 'noindex') : 0;
            Object.assign(run, { state: 'ok', detail: `noindex: not kept${retired ? `, ${retired} item(s) retired` : ''}` });
            await record.insertRun(run);
            await save(r, { state: 'noindex', last_status: res.status, last_fetch_at: t, next_fetch_at: t + GONE_RECHECK_MS, body_hash: hash, items: 0, fails: 0, ...validators });
            return { run, requested: true, answered: true };
        }

        // A page whose canonical is another page of the crawl is read there instead (unless that page points back here).
        if (meta.canonical && meta.canonical !== r.url && meta.canonical !== finalUrl) {
            const cu = new URL(meta.canonical);
            if (scope.inHost(cu) && scope.wanted(cu)) {
                const known = await st.stateOf.get(source.key, meta.canonical);
                const added = known ? 0 : await enqueue(source, scope, [{ url: meta.canonical }], { kind: 'page', depth: Number(r.depth), via: 'canonical' });
                if ((known && known.state !== 'duplicate') || added) {
                    Object.assign(run, { state: 'ok', detail: `canonical is ${meta.canonical}` });
                    await record.insertRun(run);
                    await save(r, { state: 'duplicate', last_status: res.status, last_fetch_at: t, next_fetch_at: null, body_hash: hash, fails: 0, ...validators });
                    return { run, requested: true, answered: true };
                }
            }
        }

        const linked = meta.links.length ? await enqueue(source, scope, meta.links.map(url => ({ url })), { kind: 'page', depth: Number(r.depth) + 1, via: 'link' }) : 0;

        let parsed = { items: [], skipped: 0 };
        let parser = jsonld.PARSER_VERSION;
        try {
            parsed = jsonld.parse(text, { url: finalUrl, summaryMax: config.items.summaryMax, maxItems: source.max_items });
        } catch (err) {
            if (!(err instanceof ParseError)) log.error(`[crawl] ${source.key}: jsonld crashed on ${r.url}: ${err.stack || err}`);
        }
        let found = parsed.items;
        if (!found.length && !c.require_structured) {
            const it = page.pageItem(meta, finalUrl, config.items.summaryMax);
            if (it) { found = [it]; parser = page.PARSER_VERSION; }
        }

        if (!found.length) {
            // A page that only leads to others stays a hub; one that never had anything is dropped, one that lost its data
            // is looked at again later.
            const hub = follow && meta.links.length > 0;
            const state = hub ? 'hub' : 'unstructured';
            const next = hub ? t + grown(source, r.interval_sec) * 1000 : r.state === 'kept' ? t + c.recrawl_sec * 4000 : null;
            Object.assign(run, { state: 'ok', items_skipped: parsed.skipped, detail: hub ? `no structured data; ${linked} new link(s) followed` : 'no structured data: not kept' });
            await record.insertRun(run);
            await save(r, { state, last_status: res.status, last_fetch_at: t, next_fetch_at: next, interval_sec: hub ? grown(source, r.interval_sec) : r.interval_sec, body_hash: hash, items: 0, fails: 0, ...validators });
            return { run, requested: true, answered: true };
        }

        // The only path that touches items: the run row, the items and the frontier row commit together.
        await db.tx(async () => {
            const counts = await items.ingest(source, found, { runId: run.id, rawBodyHash: hash, parserVersion: parser, retrievedAt: t });
            Object.assign(run, {
                state: 'ok', parser_version: parser, items_seen: found.length, items_created: counts.created, items_updated: counts.updated,
                items_unchanged: counts.unchanged, items_skipped: parsed.skipped + counts.skipped, detail: linked ? `${linked} new link(s) followed` : null,
            });
            await record.insertRun(run);
            const changed = counts.created + counts.updated > 0;
            const interval = changed ? c.recrawl_sec : grown(source, r.interval_sec);
            await save(r, {
                state: 'kept', last_status: res.status, last_fetch_at: t, interval_sec: interval, next_fetch_at: t + interval * 1000,
                body_hash: hash, last_ok_run_id: run.id, items: found.length, fails: 0, ...validators,
            });
        });
        return { run, requested: true, answered: true };
    }

    // ── A sitemap ────────────────────────────────────────────

    async function fetchSitemap(source, scope, r, trigger) {
        const run = record.baseRun(source, r.url, trigger, now());
        const req = await request(source, scope, r, run, { accept: XML_ACCEPT, capBytes: config.crawl.sitemapMaxBytes });
        if (req.out) return req.out;
        const { res } = req;
        const t = run.finished_at;
        const early = await common(source, r, run, res);
        if (early) return early;
        const again = t + Math.min(source.crawl.recrawl_sec * 1000, DAY_MS);
        const validators = { etag: res.headers.etag || null, last_modified: res.headers['last-modified'] || null };
        if (res.status === 304) {
            Object.assign(run, { state: 'not_modified' });
            await record.insertRun(run);
            await save(r, { state: 'read', last_status: 304, last_fetch_at: t, next_fetch_at: again, fails: 0 });
            return { run, requested: true, answered: true };
        }
        const hash = sha256(res.body);
        run.raw_body_hash = hash;
        run.parser_version = sitemap.PARSER_VERSION;
        if (hash === r.body_hash && r.state === 'read') {
            Object.assign(run, { state: 'ok', detail: 'the sitemap is the same' });
            await record.insertRun(run);
            await save(r, { last_status: res.status, last_fetch_at: t, next_fetch_at: again, fails: 0, ...validators });
            return { run, requested: true, answered: true };
        }
        let parsed;
        try {
            let body = res.body;
            // A .xml.gz sitemap is a gzip file, not a gzip-encoded response.
            if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body, { maxOutputLength: config.crawl.sitemapMaxBytes });
            parsed = sitemap.parse(decodeBody(body, res.headers['content-type']), { url: res.finalUrl, maxItems: config.crawl.sitemapMaxUrls });
        } catch (err) {
            Object.assign(run, { state: 'parse_error', error_code: err instanceof ParseError ? 'unreadable' : 'adapter_error', detail: String(err.message).slice(0, 500) });
            await record.insertRun(run);
            const fails = Number(r.fails) + 1;
            await save(r, { state: 'failing', fails, last_status: res.status, last_fetch_at: t, next_fetch_at: t + backoffMs(source, fails) });
            return { run, requested: true, answered: true };
        }
        const index = parsed.meta.format === 'sitemapindex';
        const list = parsed.items.map(it => ({ url: it.canonical_url, lastmod: it.updated_at ? Date.parse(it.updated_at) : null }));
        const added = await enqueue(source, scope, list, index ? { kind: 'sitemap', depth: 0, via: 'sitemap' } : { kind: 'page', depth: 0, via: 'sitemap' });
        Object.assign(run, { state: 'ok', items_seen: parsed.items.length, items_skipped: parsed.skipped, detail: `${added} new ${index ? 'sitemap' : 'page'}(s)` });
        await record.insertRun(run);
        await save(r, { state: 'read', last_status: res.status, last_fetch_at: t, next_fetch_at: again, body_hash: hash, items: parsed.items.length, fails: 0, ...validators });
        return { run, requested: true, answered: true };
    }

    // ── One run ──────────────────────────────────────────────

    /**
     * run(source, { trigger, stopping }) → { runs, anyFailure, anySuccess, failedRun, notBefore, more }
     * Sitemaps first, then pages, until pages_per_run requests, SOURCES_CRAWL_RUN_MS, a stop, or nothing due.
     */
    async function run(source, { trigger = 'schedule', stopping = () => false } = {}) {
        const scope = scopeOf(source);
        const out = { runs: [], anyFailure: false, anySuccess: false, failedRun: null, notBefore: 0, more: false };
        const deadline = now() + config.crawl.runMs;
        await seed(source, scope);
        let budget = source.crawl.pages_per_run;
        let streak = 0;
        const done = new Set();
        const live = () => budget > 0 && !stopping() && now() < deadline;
        crawl: while (live()) {
            let batch = (await st.due.all({ k: source.key, kind: 'sitemap', now: now(), limit: 5 })).filter(r => !done.has(r.url));
            if (!batch.length) batch = (await st.due.all({ k: source.key, kind: 'page', now: now(), limit: Math.min(budget, 50) })).filter(r => !done.has(r.url));
            if (!batch.length) break;
            for (const r of batch) {
                if (!live()) break crawl;
                done.add(r.url);
                let res;
                try {
                    res = r.kind === 'sitemap' ? await fetchSitemap(source, scope, r, trigger) : await fetchPage(source, scope, r, trigger);
                } catch (err) {
                    // Anything unexpected is a recorded failure of that page, never a silent gap or a stuck frontier row.
                    log.error(`[crawl] ${source.key}: ${r.url}: ${err.stack || err}`);
                    const failed = record.baseRun(source, r.url, trigger, now());
                    Object.assign(failed, { state: 'http_error', error_code: 'internal', detail: String(err.message).slice(0, 300) });
                    await record.insertRun(failed);
                    const fails = Number(r.fails) + 1;
                    await save(r, { fails, next_fetch_at: now() + backoffMs(source, fails) });
                    res = { run: failed, requested: true, unanswered: true };
                }
                if (res.run) out.runs.push(res.run);
                if (res.requested) budget--;
                if (res.answered) { out.anySuccess = true; streak = 0; }
                if (res.unanswered) streak++;
                if (res.stop || streak >= STREAK_LIMIT) {
                    out.anyFailure = true;
                    out.failedRun = res.run;
                    out.notBefore = res.notBefore || 0;
                    break crawl;
                }
            }
        }
        out.more = Number((await st.dueCount.get(source.key, now())).n) > 0;
        // Nothing was due: the crawl is up to date, which is a success.
        if (!out.anyFailure && !out.runs.length) out.anySuccess = true;
        return out;
    }

    /** The frontier at a glance: counts by kind and state (with how many are due), the next due time, the latest fetches. */
    async function status(source, { recent = 20 } = {}) {
        const t = now();
        const rows = await st.summary.all({ k: source.key, now: t });
        const by = { page: {}, sitemap: {} };
        let pages = 0;
        let due = 0;
        for (const row of rows) {
            (by[row.kind] || (by[row.kind] = {}))[row.state] = Number(row.n);
            if (row.kind === 'page') pages += Number(row.n);
            due += Number(row.due || 0);
        }
        const next = (await st.nextDue.get(source.key)).at;
        const iso = (v) => (v == null ? null : new Date(Number(v)).toISOString());
        return {
            pages, max_pages: source.crawl.max_pages, due, next_due_at: iso(next),
            pages_by_state: by.page, sitemaps_by_state: by.sitemap,
            recent: (await st.recent.all(source.key, recent)).map(row => ({
                url: row.url, kind: row.kind, state: row.state, depth: Number(row.depth), found_via: row.found_via,
                last_fetch_at: iso(row.last_fetch_at), next_fetch_at: iso(row.next_fetch_at), http_status: row.last_status == null ? null : Number(row.last_status),
                items: Number(row.items), fails: Number(row.fails),
            })),
        };
    }

    return { run, status };
}

module.exports = { createCrawler, looksLikeSitemap };
