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
 */
const { ids } = require('openvibe-contracts');
const { ADAPTERS } = require('./adapters');
const { sha256, decodeBody } = require('./adapters/util');

const FAILURE_STATES = new Set(['http_error', 'timeout', 'robots_denied', 'parse_error', 'rate_limited']);

function retryAfterMs(value, now) {
    if (value == null) return null;
    const s = String(value).trim();
    if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

function createIngest({ db, config, registry, items, robots, fetcher, spacer, outbox, now = () => Date.now(), log = console, relay = null }) {
    const inflight = new Set();
    const { space, setCrawlDelay } = spacer;

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

    function failedEvent(source, run, failures) {
        outbox.enqueue({
            event_type: 'sources.fetch.failed',
            subject: { type: 'source', id: source.key },
            payload: {
                source_key: source.key, category: source.category, run_id: run.id, endpoint_url: run.endpoint_url,
                state: run.state, error_code: run.error_code, http_status: run.http_status, consecutive_failures: failures,
            },
        });
    }

    /** Record a run that changed no item (every non-ok outcome, and 304). */
    function recordNoItems(source, run, { countsAsFailure, failures }) {
        db.transaction(() => {
            st.insertRun.run(run);
            if (run.endpoint_url && run.http_status != null) st.touchEndpoint.run({ k: source.key, u: run.endpoint_url, status: run.http_status, at: run.finished_at });
            if (countsAsFailure) failedEvent(source, run, failures);
        })();
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

        const validators = st.endpoint.get(source.key, endpoint.url) || {};
        await space(host, source.min_interval_ms);
        st.requested.run(now(), source.key);
        let res;
        try {
            res = await fetcher.fetchUrl(requestUrl.toString(), {
                headers,
                etag: validators.etag || null,
                lastModified: validators.last_modified || null,
                sensitiveHeaders: sensitive,
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
        } catch (err) {
            Object.assign(run, { state: 'parse_error', error_code: err.code === 'parse_error' ? 'unreadable' : 'adapter_error', detail: String(err.message).slice(0, 500) });
            if (err.code !== 'parse_error') log.error(`[ingest] ${source.key}: adapter crashed: ${err.stack || err}`);
            return { run, failed: true };
        }

        // The only path that touches items: the run row, items, validators and events commit together.
        db.transaction(() => {
            const counts = items.ingest(source, parsed.items, {
                runId: run.id, rawBodyHash: run.raw_body_hash, parserVersion: adapter.version, retrievedAt: run.finished_at,
            });
            Object.assign(run, {
                state: 'ok', items_seen: parsed.items.length, items_created: counts.created, items_updated: counts.updated,
                items_unchanged: counts.unchanged, items_skipped: parsed.skipped + counts.skipped,
            });
            st.insertRun.run(run);
            st.saveValidators.run({
                k: source.key, u: endpoint.url, etag: res.headers.etag || null, lm: res.headers['last-modified'] || null,
                status: res.status, at: run.finished_at,
            });
        })();
        return { run, failed: false, success: true, recorded: true };
    }

    // ── One source ───────────────────────────────────────────

    /**
     * run(key, { trigger }) → { runs: [...] } | { busy: true } | { manual: true } | null (unknown)
     */
    async function run(key, { trigger = 'schedule' } = {}) {
        const row = registry.get(key);
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
                runs.push(recordNoItems(source, r, { countsAsFailure: false }));
                return { runs };
            }
            const sinceLast = row.last_request_at == null ? Infinity : t - row.last_request_at;
            if (sinceLast < source.min_interval_ms || t < row.not_before) {
                const r = baseRun(source, null, trigger, t);
                const until = Math.max(row.not_before, (row.last_request_at || 0) + source.min_interval_ms);
                Object.assign(r, { state: 'rate_limited', error_code: 'local_rate_limit', detail: `next request allowed at ${new Date(until).toISOString()}` });
                runs.push(recordNoItems(source, r, { countsAsFailure: false }));
                return { runs, rateLimitedUntil: until };
            }

            let anyFailure = false;
            let anySuccess = false;
            let notBefore = 0;
            let failures = row.consecutive_failures;
            for (const endpoint of source.endpoints) {
                let out;
                try {
                    out = await fetchEndpoint(source, endpoint, trigger);
                } catch (err) {
                    // Anything unexpected is still a recorded failure, never a silent gap.
                    const r = baseRun(source, endpoint.url, trigger, t);
                    Object.assign(r, { state: 'http_error', error_code: 'internal', detail: String(err.message).slice(0, 300), finished_at: now() });
                    log.error(`[ingest] ${key}: ${err.stack || err}`);
                    out = { run: r, failed: true };
                }
                if (out.failed) { anyFailure = true; failures = row.consecutive_failures + 1; }
                if (out.success) anySuccess = true;
                if (out.notBefore) notBefore = Math.max(notBefore, out.notBefore);
                if (!out.recorded) recordNoItems(source, out.run, { countsAsFailure: out.failed, failures });
                runs.push(out.run);
                if (out.run.state === 'rate_limited') break;   // the site asked us to stop
            }

            const finishedAt = now();
            const newFailures = anyFailure ? row.consecutive_failures + 1 : 0;
            const backoff = anyFailure
                ? Math.min(source.poll_interval_sec * 1000 * 2 ** Math.min(newFailures - 1, 10), Math.max(config.worker.maxBackoffMs, source.poll_interval_sec * 1000))
                : source.poll_interval_sec * 1000;
            const lastState = runs.map(r => r.state).find(s => FAILURE_STATES.has(s)) || runs[runs.length - 1].state;
            st.finish.run({
                key, at: finishedAt, state: lastState, failures: newFailures,
                success_at: anySuccess ? finishedAt : null, next_due: finishedAt + backoff, not_before: notBefore,
            });
            if (relay) relay.flush().catch(() => {});
            return { runs };
        } finally {
            inflight.delete(key);
        }
    }

    return { run, inflight: () => [...inflight] };
}

module.exports = { createIngest, FAILURE_STATES, retryAfterMs };
