'use strict';
/**
 * Ingestion runs: one source at a time (never two runs of the same source in flight), each
 * endpoint fetched in order, every attempt recorded as a fetch_runs row with an explicit state:
 *
 *   ok             fetched and parsed; items created/updated/unchanged
 *   not_modified   304 to a conditional GET (ETag / Last-Modified from the last good parse)
 *   http_error     any other status, or a refused/failed connection, oversize body, bad redirect
 *   timeout        no complete response within SOURCES_FETCH_TIMEOUT_MS
 *   robots_denied  robots.txt disallows the URL (or a redirect target), or is unreachable
 *   parse_error    the body is not what the adapter reads
 *   rate_limited   the source's rate limit or a Retry-After has not elapsed (nothing requested),
 *                  or the site answered 429
 *   disabled       the source is disabled, or its credential variable is not set
 *
 * A failed run never creates or modifies an item: only the `ok` path calls items.ingest(), in the
 * same transaction as its run row. Validators (ETag/Last-Modified) are stored only after a good
 * parse, so a body that failed to parse is fetched and parsed again next time, not skipped as 304.
 *
 * A source with retire_after_sec (jobs, listings) retires what its feed stopped showing: after a run
 * in which every endpoint answered (ok or 304) and none failed, its items not seen for that long are
 * removed as gone_from_source. A 304 counts as seeing again what the endpoint's last good parse saw.
 *
 * A crawl source (type crawl) walks its site's frontier instead of a list of endpoints (server/crawl.js): one fetch_runs
 * row per page, a page's own failure stays the page's, and the source fails only when the site does. While pages are
 * still due after a run, the next one comes sooner (SOURCES_CRAWL_SOON_MS) than poll_interval_sec.
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { ADAPTERS, RESOLVERS } = require('./adapters');
const offDelta = require('./adapters/off-delta');
const extract = require('./adapters/extract');
const { createCrawler } = require('./crawl');
const { sha256, decodeBody, ParseError } = require('./adapters/util');

const FAILURE_STATES = new Set(['http_error', 'timeout', 'robots_denied', 'parse_error', 'rate_limited']);

function retryAfterMs(value, now) {
    if (value == null) return null;
    const s = String(value).trim();
    if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

function createIngest({ db, config, registry, items, robots, fetcher, spacer, emitEvent, now = () => Date.now(), log = console, outbox = null }) {
    const inflight = new Set();
    const { space, setCrawlDelay } = spacer;
    let stopping = false;

    const st = {
        insertRun: db.prepare(`INSERT INTO fetch_runs (id, source_key, endpoint_url, trigger, started_at, finished_at, state, http_status,
            error_code, detail, bytes, raw_body_hash, parser_version, items_seen, items_created, items_updated, items_unchanged, items_skipped)
            VALUES (@id, @source_key, @endpoint_url, @trigger, @started_at, @finished_at, @state, @http_status, @error_code, @detail, @bytes,
            @raw_body_hash, @parser_version, @items_seen, @items_created, @items_updated, @items_unchanged, @items_skipped)`),
        endpoint: db.prepare('SELECT * FROM endpoint_state WHERE source_key = ? AND url = ?'),
        saveValidators: db.prepare(`INSERT INTO endpoint_state (source_key, url, etag, last_modified, last_status, last_fetch_at) VALUES (@k, @u, @etag, @lm, @status, @at)
            ON CONFLICT(source_key, url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, last_status = excluded.last_status, last_fetch_at = excluded.last_fetch_at`),
        touchEndpoint: db.prepare(`INSERT INTO endpoint_state (source_key, url, last_status, last_fetch_at) VALUES (@k, @u, @status, @at)
            ON CONFLICT(source_key, url) DO UPDATE SET last_status = excluded.last_status, last_fetch_at = excluded.last_fetch_at`),
        requested: db.prepare('UPDATE sources SET last_request_at = ? WHERE key = ?'),
        stateGet: db.prepare('SELECT value FROM source_state WHERE source_key = ? AND name = ?'),
        stateSet: db.prepare(`INSERT INTO source_state (source_key, name, value, updated_at) VALUES (@k, @n, @v, @at)
            ON CONFLICT(source_key, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
        lastOk: db.prepare(`SELECT id FROM fetch_runs WHERE source_key = ? AND endpoint_url = ? AND state = 'ok' ORDER BY rid DESC LIMIT 1`),
        finish: db.prepare(`UPDATE sources SET last_run_at = @at, last_state = @state, consecutive_failures = @failures,
            last_success_at = COALESCE(@success_at, last_success_at), next_due_at = @next_due, not_before = @not_before WHERE key = @key`),
    };

    // ── Run rows ─────────────────────────────────────────────

    function baseRun(source, endpointUrl, trigger, startedAt) {
        return {
            id: `frn_${ids.ulid(startedAt)}`, source_key: source.key, endpoint_url: endpointUrl, trigger,
            started_at: startedAt, finished_at: now(), state: null, http_status: null, error_code: null, detail: null,
            bytes: null, raw_body_hash: null, parser_version: null,
            items_seen: 0, items_created: 0, items_updated: 0, items_unchanged: 0, items_skipped: 0,
        };
    }

    // An endpoint may carry a provider credential in its query string (?api_key=…). Events travel to
    // other services and their logs, so the event names the endpoint with such values redacted.
    const SECRET_PARAM = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|client[_-]?secret|password|passwd|sig|signature)$/i;
    function redactedUrl(u) {
        try {
            const url = new URL(u);
            for (const k of [...url.searchParams.keys()]) if (SECRET_PARAM.test(k)) url.searchParams.set(k, 'redacted');
            return url.href;
        } catch { return null; }
    }

    async function failedEvent(source, run, failures) {
        await emitEvent({
            event_type: 'sources.fetch.failed',
            subject: { type: 'source', id: source.key },
            payload: {
                source_key: source.key, category: source.category, run_id: run.id, endpoint_url: redactedUrl(run.endpoint_url),
                state: run.state, error_code: run.error_code, http_status: run.http_status, consecutive_failures: failures,
            },
        });
    }

    /** Record a run that changed no item (every non-ok outcome, and 304). */
    async function recordNoItems(source, run, { countsAsFailure, failures }) {
        await db.tx(async () => {
            await st.insertRun.run(run);
            if (run.endpoint_url && run.http_status != null) await st.touchEndpoint.run({ k: source.key, u: run.endpoint_url, status: run.http_status, at: run.finished_at });
            if (countsAsFailure) await failedEvent(source, run, failures);
        });
        return run;
    }

    // ── One endpoint ─────────────────────────────────────────

    async function fetchEndpoint(source, endpoint, trigger) {
        const adapter = ADAPTERS[source.type];
        const startedAt = now();
        const run = baseRun(source, endpoint.url, trigger, startedAt);
        const target = new URL(endpoint.url);
        const host = target.host;

        // credential by variable name, read now, never stored
        const headers = { Accept: adapter.accept };
        // An api endpoint may name the Content-Type its GET carries (adapters/api.js `request_content_type`).
        if (endpoint.request_content_type) headers['Content-Type'] = endpoint.request_content_type;
        const sensitive = [];
        let requestUrl = target;
        if (source.auth.mode !== 'none') {
            const secret = config.secrets[source.auth.env];
            if (!secret) {
                Object.assign(run, { state: 'disabled', error_code: 'credential_missing', detail: `environment variable ${source.auth.env} is not set`, finished_at: now() });
                return { run, failed: false };
            }
            if (source.auth.mode === 'bearer') { headers.Authorization = `Bearer ${secret}`; sensitive.push('Authorization'); }
            if (source.auth.mode === 'header') { headers[source.auth.header] = secret; sensitive.push(source.auth.header); }
            if (source.auth.mode === 'query') { requestUrl = new URL(target); requestUrl.searchParams.set(source.auth.param, secret); }
        }

        // robots.txt for the endpoint's origin (a robots fetch is a request to the host too)
        const verdict = await robots.check(target.toString());
        setCrawlDelay(host, verdict.crawlDelaySec);
        if (!verdict.allowed) {
            if (verdict.refusedCode) Object.assign(run, { state: 'http_error', error_code: verdict.refusedCode, detail: `${host} is not fetchable (${verdict.refusedCode})`, finished_at: now() });
            else Object.assign(run, { state: 'robots_denied', error_code: 'robots', detail: verdict.reason, finished_at: now() });
            return { run, failed: true };
        }

        const validators = await st.endpoint.get(source.key, endpoint.url) || {};
        await space(host, source.min_interval_ms);
        await st.requested.run(now(), source.key);
        let res;
        try {
            res = await fetcher.fetchUrl(requestUrl.toString(), {
                headers,
                etag: validators.etag || null,
                lastModified: validators.last_modified || null,
                sensitiveHeaders: sensitive,
                // an api endpoint may set its own body cap (adapters/api.js `max_bytes`)
                capBytes: endpoint.max_bytes || undefined,
                // and its own deadline (`timeout_ms`)
                timeoutMs: endpoint.timeout_ms || undefined,
                // every redirect hop is checked against its own origin's robots.txt and, on a new
                // host, spaced like any other request to that host
                beforeHop: async (next) => {
                    const v = await robots.check(next.toString());
                    if (!v.allowed) return { refuse: v.reason };
                    if (next.host !== host) {
                        setCrawlDelay(next.host, v.crawlDelaySec);
                        await space(next.host, source.min_interval_ms);
                    }
                    return null;
                },
            });
        } catch (err) {
            const state = err.code === 'timeout' ? 'timeout' : err.code === 'hop_refused' ? 'robots_denied' : 'http_error';
            Object.assign(run, { state, error_code: err.code || 'network', detail: String(err.message).slice(0, 500), finished_at: now() });
            return { run, failed: true };
        }
        run.http_status = res.status;
        run.bytes = res.bytes != null ? res.bytes : null;
        run.finished_at = now();

        if (res.status === 304) {
            Object.assign(run, { state: 'not_modified' });
            if (source.retire_after_sec) {
                const last = await st.lastOk.get(source.key, endpoint.url);
                if (last) await items.seenAgain(source, last.id, run.finished_at);
            }
            return { run, failed: false, success: true };
        }
        if (res.status === 429) {
            const wait = Math.min(retryAfterMs(res.headers['retry-after'], now()) ?? 10 * 60 * 1000, 24 * 3600 * 1000);
            Object.assign(run, { state: 'rate_limited', error_code: 'upstream_429', detail: `the site asked us to wait ${Math.round(wait / 1000)} s` });
            return { run, failed: true, notBefore: now() + wait };
        }
        if (res.status !== 200 && res.status !== 203) {
            const wait = res.status === 503 ? retryAfterMs(res.headers['retry-after'], now()) : null;
            Object.assign(run, { state: 'http_error', error_code: `http_${res.status}`, detail: `HTTP ${res.status}` });
            return { run, failed: true, notBefore: wait != null ? now() + Math.min(wait, 24 * 3600 * 1000) : null };
        }

        run.raw_body_hash = sha256(res.body);
        run.parser_version = adapter.version;
        let parsed;
        try {
            const text = decodeBody(res.body, res.headers['content-type']);
            parsed = adapter.parse(text, { url: res.finalUrl, endpoint, summaryMax: config.items.summaryMax, maxItems: source.max_items });
            // An endpoint that reads facts out of its items' prose keeps only the items that state them (adapters/extract.js).
            if (endpoint.extract) {
                const x = extract.apply(parsed.items, endpoint.extract);
                parsed = { ...parsed, items: x.items, skipped: parsed.skipped + x.skipped };
            }
        } catch (err) {
            Object.assign(run, { state: 'parse_error', error_code: err.code === 'parse_error' ? 'unreadable' : 'adapter_error', detail: String(err.message).slice(0, 500) });
            if (err.code !== 'parse_error') log.error(`[ingest] ${source.key}: adapter crashed: ${err.stack || err}`);
            return { run, failed: true };
        }

        // The only path that touches items: the run row, items, validators and events commit together.
        await db.tx(async () => {
            const counts = await items.ingest(source, parsed.items, {
                runId: run.id, rawBodyHash: run.raw_body_hash, parserVersion: adapter.version, retrievedAt: run.finished_at,
            });
            Object.assign(run, {
                state: 'ok', items_seen: parsed.items.length, items_created: counts.created, items_updated: counts.updated,
                items_unchanged: counts.unchanged, items_skipped: parsed.skipped + counts.skipped,
            });
            await st.insertRun.run(run);
            await st.saveValidators.run({
                k: source.key, u: endpoint.url, etag: res.headers.etag || null, lm: res.headers['last-modified'] || null,
                status: res.status, at: run.finished_at,
            });
        });
        return { run, failed: false, success: true, recorded: true };
    }

    /**
     * A bulk dataset file: one streamed GET, parsed row by row. The stream is stopped at the row limit, so a
     * multi-GB file is never downloaded whole and never held in memory; the endpoint's max_bytes is the cap.
     */
    async function fetchBulkEndpoint(source, endpoint, trigger) {
        const adapter = ADAPTERS.bulk;
        const startedAt = now();
        const run = baseRun(source, endpoint.url, trigger, startedAt);
        const target = new URL(endpoint.url);
        const host = target.host;

        const headers = { Accept: adapter.accept };
        const sensitive = [];
        let requestUrl = target;
        if (source.auth.mode !== 'none') {
            const secret = config.secrets[source.auth.env];
            if (!secret) {
                Object.assign(run, { state: 'disabled', error_code: 'credential_missing', detail: `environment variable ${source.auth.env} is not set`, finished_at: now() });
                return { run, failed: false };
            }
            if (source.auth.mode === 'bearer') { headers.Authorization = `Bearer ${secret}`; sensitive.push('Authorization'); }
            if (source.auth.mode === 'header') { headers[source.auth.header] = secret; sensitive.push(source.auth.header); }
            if (source.auth.mode === 'query') { requestUrl = new URL(target); requestUrl.searchParams.set(source.auth.param, secret); }
        }

        const verdict = await robots.check(target.toString());
        setCrawlDelay(host, verdict.crawlDelaySec);
        if (!verdict.allowed) {
            if (verdict.refusedCode) Object.assign(run, { state: 'http_error', error_code: verdict.refusedCode, detail: `${host} is not fetchable (${verdict.refusedCode})`, finished_at: now() });
            else Object.assign(run, { state: 'robots_denied', error_code: 'robots', detail: verdict.reason, finished_at: now() });
            return { run, failed: true };
        }

        await space(host, source.min_interval_ms);
        await st.requested.run(now(), source.key);
        const parser = adapter.createParser({ endpoint, url: endpoint.url, maxItems: source.max_items, summaryMax: config.items.summaryMax });
        const hash = crypto.createHash('sha256');
        let res;
        try {
            res = await fetcher.streamUrl(requestUrl.toString(), {
                headers,
                capBytes: endpoint.max_bytes || config.fetch.maxBytes,
                timeoutMs: endpoint.timeout_ms || undefined,
                beforeHop: async (next) => {
                    const v = await robots.check(next.toString());
                    if (!v.allowed) return { refuse: v.reason };
                    if (next.host !== host) {
                        setCrawlDelay(next.host, v.crawlDelaySec);
                        await space(next.host, source.min_interval_ms);
                    }
                    return null;
                },
            }, (chunk) => { hash.update(chunk); return parser.write(chunk); });
        } catch (err) {
            const state = err.code === 'timeout' ? 'timeout' : err.code === 'hop_refused' ? 'robots_denied'
                : err.code === 'parse_error' ? 'parse_error' : 'http_error';
            Object.assign(run, { state, error_code: err.code || 'network', detail: String(err.message).slice(0, 500), finished_at: now() });
            return { run, failed: true };
        }
        run.http_status = res.status;
        run.bytes = res.bytes != null ? res.bytes : null;
        run.finished_at = now();

        if (res.status === 429) {
            const wait = Math.min(retryAfterMs(res.headers['retry-after'], now()) ?? 10 * 60 * 1000, 24 * 3600 * 1000);
            Object.assign(run, { state: 'rate_limited', error_code: 'upstream_429', detail: `the site asked us to wait ${Math.round(wait / 1000)} s` });
            return { run, failed: true, notBefore: now() + wait };
        }
        if (res.status !== 200 && res.status !== 203) {
            const wait = res.status === 503 ? retryAfterMs(res.headers['retry-after'], now()) : null;
            Object.assign(run, { state: 'http_error', error_code: `http_${res.status}`, detail: `HTTP ${res.status}` });
            return { run, failed: true, notBefore: wait != null ? now() + Math.min(wait, 24 * 3600 * 1000) : null };
        }

        let parsed;
        try {
            parsed = parser.end();
        } catch (err) {
            Object.assign(run, { state: 'parse_error', error_code: err.code === 'parse_error' ? 'unreadable' : 'adapter_error', detail: String(err.message).slice(0, 500) });
            return { run, failed: true };
        }
        run.raw_body_hash = hash.digest('hex');
        run.parser_version = adapter.version;
        await db.tx(async () => {
            const counts = await items.ingest(source, parsed.items, {
                runId: run.id, rawBodyHash: run.raw_body_hash, parserVersion: adapter.version, retrievedAt: run.finished_at,
            });
            Object.assign(run, {
                state: 'ok', items_seen: parsed.items.length, items_created: counts.created, items_updated: counts.updated,
                items_unchanged: counts.unchanged, items_skipped: parsed.skipped + counts.skipped,
            });
            await st.insertRun.run(run);
            await st.saveValidators.run({
                k: source.key, u: endpoint.url, etag: res.headers.etag || null, lm: res.headers['last-modified'] || null,
                status: res.status, at: run.finished_at,
            });
        });
        return { run, failed: false, success: true, recorded: true };
    }

    /**
     * An api endpoint with a resolver (HN Who is hiring): a few JSON documents walked by server/adapters/hn.js.
     * Every URL is checked against robots and must be a .json path; the resolver returns the same shape a parser does.
     */
    async function fetchResolverEndpoint(source, endpoint, trigger) {
        const adapter = ADAPTERS.api;
        const { resolve, version: resolverVersion } = RESOLVERS[endpoint.resolver];
        const startedAt = now();
        const run = baseRun(source, endpoint.url, trigger, startedAt);
        const target = new URL(endpoint.url);
        const host = target.host;

        const headers = { Accept: 'application/json' };
        const sensitive = [];
        let requestUrl = target;
        if (source.auth.mode !== 'none') {
            const secret = config.secrets[source.auth.env];
            if (!secret) {
                Object.assign(run, { state: 'disabled', error_code: 'credential_missing', detail: `environment variable ${source.auth.env} is not set`, finished_at: now() });
                return { run, failed: false };
            }
            if (source.auth.mode === 'bearer') { headers.Authorization = `Bearer ${secret}`; sensitive.push('Authorization'); }
            if (source.auth.mode === 'header') { headers[source.auth.header] = secret; sensitive.push(source.auth.header); }
            if (source.auth.mode === 'query') { requestUrl = new URL(target); requestUrl.searchParams.set(source.auth.param, secret); }
        }

        const hash = crypto.createHash('sha256');
        let bytes = 0;
        let lastStatus = null;
        const getJson = async (url, cap) => {
            const verdict = await robots.check(url);
            if (!verdict.allowed) throw Object.assign(new Error(verdict.reason || 'robots.txt disallows this URL'), { code: 'robots_denied' });
            const r = await fetcher.fetchUrl(url, {
                headers,
                capBytes: Math.min(Number(cap) || 1048576, 32 * 1024 * 1024),
                timeoutMs: endpoint.timeout_ms || undefined,
                sensitiveHeaders: sensitive,
                beforeHop: async (next) => {
                    const v = await robots.check(next.toString());
                    return v.allowed ? null : { refuse: v.reason };
                },
            });
            lastStatus = r.status;
            run.http_status = r.status;
            if (r.status === 429) throw Object.assign(new Error('the Hacker News API answered 429'), { code: 'rate_limited' });
            if (r.status !== 200 && r.status !== 203) throw Object.assign(new Error(`HTTP ${r.status} for ${url}`), { code: 'http_error' });
            bytes += r.bytes || 0;
            hash.update(r.body || Buffer.alloc(0));
            try { return JSON.parse(decodeBody(r.body, r.headers['content-type'])); } catch { throw new ParseError('the Hacker News API answered non-JSON'); }
        };

        await space(host, source.min_interval_ms);
        await st.requested.run(now(), source.key);
        let parsed;
        try {
            parsed = await resolve({ endpoint, getJson, maxItems: source.max_items, summaryMax: config.items.summaryMax, cap: endpoint.max_bytes || 1048576 });
        } catch (err) {
            const state = err.code === 'robots_denied' ? 'robots_denied' : err.code === 'rate_limited' ? 'rate_limited'
                : err.code === 'parse_error' ? 'parse_error' : err.code === 'timeout' ? 'timeout' : 'http_error';
            Object.assign(run, { state, error_code: err.code || 'network', detail: String(err.message).slice(0, 500), finished_at: now() });
            if (err.code !== 'parse_error') log.error(`[ingest] ${source.key}: resolver failed: ${err.stack || err}`);
            return { run, failed: true };
        }
        run.http_status = lastStatus;
        run.bytes = bytes;
        run.finished_at = now();
        run.raw_body_hash = hash.digest('hex');
        run.parser_version = resolverVersion;
        await db.tx(async () => {
            const counts = await items.ingest(source, parsed.items, {
                runId: run.id, rawBodyHash: run.raw_body_hash, parserVersion: resolverVersion, retrievedAt: run.finished_at,
            });
            Object.assign(run, {
                state: 'ok', items_seen: parsed.items.length, items_created: counts.created, items_updated: counts.updated,
                items_unchanged: counts.unchanged, items_skipped: parsed.skipped + counts.skipped,
            });
            await st.insertRun.run(run);
            await st.saveValidators.run({ k: source.key, u: endpoint.url, etag: null, lm: null, status: lastStatus, at: run.finished_at });
        });
        return { run, failed: false, success: true, recorded: true };
    }

    /**
     * A bulk source with `resolver: "off-delta"`: read a text index, then only the delta parts not finished yet.
     * The full export is one gzip stream and cannot be resumed, so the first run starts at the oldest part in the
     * index. A run reads up to its row limit across parts; a part stopped by the limit keeps its row offset in
     * source_state, and the next run streams that part again only to skip those rows, then continues.
     */
    async function fetchOffDeltaEndpoint(source, endpoint, trigger) {
        const adapter = ADAPTERS.bulk;
        const startedAt = now();
        const run = baseRun(source, endpoint.url, trigger, startedAt);
        const target = new URL(endpoint.url);
        const host = target.host;

        const headers = { Accept: 'text/plain' };
        const sensitive = [];
        let requestUrl = target;
        if (source.auth.mode !== 'none') {
            const secret = config.secrets[source.auth.env];
            if (!secret) {
                Object.assign(run, { state: 'disabled', error_code: 'credential_missing', detail: `environment variable ${source.auth.env} is not set`, finished_at: now() });
                return { run, failed: false };
            }
            if (source.auth.mode === 'bearer') { headers.Authorization = `Bearer ${secret}`; sensitive.push('Authorization'); }
            if (source.auth.mode === 'header') { headers[source.auth.header] = secret; sensitive.push(source.auth.header); }
            if (source.auth.mode === 'query') { requestUrl = new URL(target); requestUrl.searchParams.set(source.auth.param, secret); }
        }

        const verdict = await robots.check(target.toString());
        setCrawlDelay(host, verdict.crawlDelaySec);
        if (!verdict.allowed) {
            if (verdict.refusedCode) Object.assign(run, { state: 'http_error', error_code: verdict.refusedCode, detail: `${host} is not fetchable (${verdict.refusedCode})`, finished_at: now() });
            else Object.assign(run, { state: 'robots_denied', error_code: 'robots', detail: verdict.reason, finished_at: now() });
            return { run, failed: true };
        }

        await space(host, source.min_interval_ms);
        await st.requested.run(now(), source.key);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        let lastStatus = null;
        const beforeHop = async (next) => {
            const v = await robots.check(next.toString());
            if (!v.allowed) return { refuse: v.reason };
            if (next.host !== host) {
                setCrawlDelay(next.host, v.crawlDelaySec);
                await space(next.host, source.min_interval_ms);
            }
            return null;
        };
        const read = async (url, cap, accept) => {
            const v = await robots.check(url);
            if (!v.allowed) throw Object.assign(new Error(v.reason || 'robots.txt disallows this URL'), { code: 'robots_denied' });
            const r = await fetcher.fetchUrl(url, {
                headers: { Accept: accept }, capBytes: cap, timeoutMs: endpoint.timeout_ms || undefined,
                sensitiveHeaders: sensitive, beforeHop,
            });
            lastStatus = r.status;
            run.http_status = r.status;
            if (r.status === 429) throw Object.assign(new Error('the delta index answered 429'), { code: 'rate_limited' });
            if (r.status !== 200 && r.status !== 203) throw Object.assign(new Error(`HTTP ${r.status} for ${url}`), { code: 'http_error' });
            bytes += r.bytes || 0;
            hash.update(r.body || Buffer.alloc(0));
            return r;
        };
        const failure = (err) => {
            const state = err.code === 'robots_denied' ? 'robots_denied' : err.code === 'rate_limited' ? 'rate_limited'
                : err.code === 'timeout' ? 'timeout' : err.code === 'parse_error' ? 'parse_error' : 'http_error';
            Object.assign(run, { state, error_code: err.code || 'network', detail: String(err.message).slice(0, 500), finished_at: now() });
            if (err.code !== 'parse_error') log.error(`[ingest] ${source.key}: off-delta failed: ${err.stack || err}`);
            return { run, failed: true };
        };

        let files;
        try {
            const index = await read(requestUrl.toString(), Math.min(endpoint.max_bytes || 1024 * 1024, 1024 * 1024), 'text/plain');
            files = offDelta.parseIndex(decodeBody(index.body, index.headers['content-type'] || 'text/plain'), endpoint.url);
        } catch (err) { return failure(err); }

        const stateRow = await st.stateGet.get(source.key, offDelta.STATE_NAME);
        const state = offDelta.readState(stateRow && stateRow.value);
        if (state.current && !files.some((f) => f.name === state.current)) {
            state.current = null;
            state.offset = 0;
        }
        const queue = offDelta.nextFiles(files, state);
        const budget = Math.max(1, Math.min(Number(endpoint.max_rows) || 1000, Number(source.max_items) || 500));
        let remaining = budget;
        const collected = new Map();         // identity → item, later parts win
        let duplicates = 0;
        let skipped = 0;
        let cursor = { seen: state.seen, seen_end: state.seen_end, current: state.current, offset: state.offset };

        for (const file of queue) {
            if (remaining <= 0) break;
            const offset = cursor.current === file.name ? cursor.offset : 0;
            const parser = adapter.createParser({
                endpoint: { ...endpoint, max_rows: Math.min(Number(endpoint.max_rows) || 1000, remaining) },
                url: file.url, maxItems: remaining, summaryMax: config.items.summaryMax, skipRows: offset,
            });
            let res;
            try {
                const v = await robots.check(file.url);
                if (!v.allowed) throw Object.assign(new Error(v.reason || 'robots.txt disallows this delta'), { code: 'robots_denied' });
                res = await fetcher.streamUrl(file.url, {
                    headers: { Accept: adapter.accept },
                    capBytes: endpoint.max_bytes || config.fetch.maxBytes,
                    timeoutMs: endpoint.timeout_ms || undefined,
                    beforeHop,
                }, (chunk) => { hash.update(chunk); return parser.write(chunk); });
            } catch (err) { return failure(err); }
            lastStatus = res.status;
            run.http_status = res.status;
            if (res.status === 429) {
                const wait = Math.min(retryAfterMs(res.headers['retry-after'], now()) ?? 10 * 60 * 1000, 24 * 3600 * 1000);
                Object.assign(run, { state: 'rate_limited', error_code: 'upstream_429', detail: `the site asked us to wait ${Math.round(wait / 1000)} s` });
                return { run, failed: true, notBefore: now() + wait };
            }
            if (res.status !== 200 && res.status !== 203) {
                Object.assign(run, { state: 'http_error', error_code: `http_${res.status}`, detail: `HTTP ${res.status}` });
                return { run, failed: true };
            }
            bytes += res.bytes || 0;
            let parsed;
            try { parsed = parser.end(); } catch (err) { return failure(err); }
            for (const it of parsed.items) {
                if (collected.has(it.identity)) duplicates++;
                collected.delete(it.identity);
                collected.set(it.identity, it);
            }
            skipped += parsed.skipped;
            remaining -= parsed.items.length;
            if (res.stopped) {               // the row limit stopped this part: keep its offset for the next run
                cursor = { ...cursor, current: file.name, offset: offset + parsed.meta.rows };
                break;
            }
            cursor = { seen: file.name, seen_end: file.end, current: null, offset: 0 };
            if (remaining <= 0) break;
        }

        const parsedItems = [...collected.values()];
        run.bytes = bytes;
        run.finished_at = now();
        run.raw_body_hash = hash.digest('hex');
        run.parser_version = offDelta.PARSER_VERSION;
        await db.tx(async () => {
            const counts = await items.ingest(source, parsedItems, {
                runId: run.id, rawBodyHash: run.raw_body_hash, parserVersion: offDelta.PARSER_VERSION, retrievedAt: run.finished_at,
            });
            Object.assign(run, {
                state: 'ok', items_seen: parsedItems.length, items_created: counts.created, items_updated: counts.updated,
                items_unchanged: counts.unchanged, items_skipped: skipped + duplicates + counts.skipped,
            });
            await st.insertRun.run(run);
            await st.stateSet.run({ k: source.key, n: offDelta.STATE_NAME, v: JSON.stringify(cursor), at: run.finished_at });
            await st.saveValidators.run({ k: source.key, u: endpoint.url, etag: null, lm: null, status: lastStatus, at: run.finished_at });
        });
        return { run, failed: false, success: true, recorded: true };
    }

    const crawler = createCrawler({
        db, config, items, robots, fetcher, spacer, now, log,
        record: { baseRun, insertRun: (r) => st.insertRun.run(r), requested: (t, key) => st.requested.run(t, key) },
    });

    /** Every endpoint in order (feeds, sitemaps, JSON-LD pages, APIs). */
    async function fetchEndpoints(source, row, trigger, t) {
        const runs = [];
        let anyFailure = false;
        let anySuccess = false;
        let allAnswered = true;     // every endpoint ok or 304: what retirement needs to trust the feed
        let notBefore = 0;
        let failures = row.consecutive_failures;
        for (const endpoint of source.endpoints) {
            let out;
            try {
                out = source.type === 'bulk'
                    ? endpoint.resolver === 'off-delta'
                        ? await fetchOffDeltaEndpoint(source, endpoint, trigger)
                        : await fetchBulkEndpoint(source, endpoint, trigger)
                    : endpoint.resolver
                        ? await fetchResolverEndpoint(source, endpoint, trigger)
                        : await fetchEndpoint(source, endpoint, trigger);
            } catch (err) {
                // Anything unexpected is still a recorded failure, never a silent gap.
                const r = baseRun(source, endpoint.url, trigger, t);
                Object.assign(r, { state: 'http_error', error_code: 'internal', detail: String(err.message).slice(0, 300), finished_at: now() });
                log.error(`[ingest] ${source.key}: ${err.stack || err}`);
                out = { run: r, failed: true };
            }
            if (out.failed) { anyFailure = true; failures = row.consecutive_failures + 1; }
            if (out.success) anySuccess = true;
            else allAnswered = false;
            if (out.notBefore) notBefore = Math.max(notBefore, out.notBefore);
            if (!out.recorded) await recordNoItems(source, out.run, { countsAsFailure: out.failed, failures });
            runs.push(out.run);
            if (out.run.state === 'rate_limited') break;   // the site asked us to stop
        }

        if (source.retire_after_sec && source.type !== 'bulk' && anySuccess && allAnswered && !anyFailure) {
            try {
                const retired = await items.retireUnseen(source, now() - source.retire_after_sec * 1000);
                if (retired) log.log(`[ingest] ${source.key}: retired ${retired} item(s) the feed stopped showing`);
            } catch (err) {
                log.error(`[ingest] ${source.key}: retiring unseen items failed: ${err.stack || err}`);
            }
        }
        const lastState = runs.map(r => r.state).find(s => FAILURE_STATES.has(s)) || runs[runs.length - 1].state;
        return { runs, anyFailure, anySuccess, notBefore, lastState, more: false };
    }

    /** The site's frontier, up to pages_per_run pages; one sources.fetch.failed when the site fails, never one per page. */
    async function crawl(source, row, trigger) {
        const out = await crawler.run(source, { trigger, stopping: () => stopping });
        if (out.failedRun) {
            const failed = out.failedRun;
            await db.tx(async () => { await failedEvent(source, failed, row.consecutive_failures + 1); });
        }
        return { ...out, lastState: out.failedRun ? out.failedRun.state : 'ok' };
    }

    // ── One source ───────────────────────────────────────────

    /**
     * run(key, { trigger }) → { runs: [...] } | { busy: true } | { manual: true } | null (unknown)
     */
    async function run(key, { trigger = 'schedule' } = {}) {
        const row = await registry.get(key);
        if (!row) return null;
        if (row.type === 'manual') return { manual: true };
        if (inflight.has(key)) return { busy: true };
        inflight.add(key);
        try {
            const source = registry.fromRow(row);
            const t = now();
            const runs = [];

            if (!source.enabled) {
                const r = baseRun(source, null, trigger, t);
                Object.assign(r, { state: 'disabled', error_code: 'source_disabled', detail: 'the source is disabled' });
                runs.push(await recordNoItems(source, r, { countsAsFailure: false }));
                return { runs };
            }
            const sinceLast = row.last_request_at == null ? Infinity : t - row.last_request_at;
            if (sinceLast < source.min_interval_ms || t < row.not_before) {
                const r = baseRun(source, null, trigger, t);
                const until = Math.max(row.not_before, (row.last_request_at || 0) + source.min_interval_ms);
                Object.assign(r, { state: 'rate_limited', error_code: 'local_rate_limit', detail: `next request allowed at ${new Date(until).toISOString()}` });
                runs.push(await recordNoItems(source, r, { countsAsFailure: false }));
                return { runs, rateLimitedUntil: until };
            }

            const { runs: done, anyFailure, anySuccess, notBefore, lastState, more } = source.type === 'crawl'
                ? await crawl(source, row, trigger)
                : await fetchEndpoints(source, row, trigger, t);
            runs.push(...done);

            const finishedAt = now();
            const newFailures = anyFailure ? row.consecutive_failures + 1 : 0;
            const poll = source.poll_interval_sec * 1000;
            const backoff = anyFailure
                ? Math.min(poll * 2 ** Math.min(newFailures - 1, 10), Math.max(config.worker.maxBackoffMs, poll))
                : more ? Math.min(poll, config.crawl.soonMs) : poll;
            await st.finish.run({
                key, at: finishedAt, state: lastState, failures: newFailures,
                success_at: anySuccess ? finishedAt : null, next_due: finishedAt + backoff, not_before: notBefore,
            });
            if (outbox) outbox.kick().catch(() => {});
            return { runs };
        } finally {
            inflight.delete(key);
        }
    }

    /** Status of a crawl source's frontier (GET /api/v1/sources/:key/crawl). */
    async function crawlStatus(key) {
        const row = await registry.get(key);
        if (!row) return null;
        const source = registry.fromRow(row);
        return source.type === 'crawl' ? await crawler.status(source) : { not_crawl: true };
    }

    /** Shutting down: a crawl ends after the page in flight instead of working through its budget. */
    function stop() { stopping = true; }

    return { run, crawlStatus, stop, inflight: () => [...inflight] };
}

module.exports = { createIngest, FAILURE_STATES, retryAfterMs };
