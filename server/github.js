'use strict';
/**
 * The GitHub client shared by ingestion and the code search API. One process has one client, so the
 * token, the request spacing and the last rate-limit headers are the same for a scheduled fetch and a
 * person's search.
 *
 * The token is read by name at request time (server/settings.js: the owner's setting, then
 * SOURCES_GITHUB_TOKEN, then GITHUB_TOKEN). It is never stored, logged, returned or put in a URL.
 * Without one, GitHub's search limit is 10 requests a minute; with one it is 30. The client keeps the
 * last x-ratelimit-remaining/reset, waits out a 403/429 the API sends, and lets a batch end early: a
 * run that already has items records them and says when the next request may go.
 *
 * Nothing here fetches github.com pages. The only host is api.github.com, and every request goes through
 * the same robots, spacing and address guard as every other Sources fetch.
 */
const crypto = require('crypto');
const github = require('./adapters/github');
const settings = require('./settings');
const { decodeBody, ParseError } = require('./adapters/util');

const HOST = 'api.github.com';
const SEARCH_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 200;

class RateLimitError extends Error {
    constructor(retryAfterMs, detail) {
        super(detail || 'GitHub asked us to wait');
        this.code = 'rate_limited';
        this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    }
}

const int = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(value, now) {
    if (value == null) return null;
    const s = String(value).trim();
    if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

function createGithub({ config, fetcher, robots, spacer, now = () => Date.now(), log = console, capBytes = 4 * 1024 * 1024 }) {
    const limiter = { remaining: null, resetAt: 0, at: 0 };
    const cache = new Map();       // search URL → { at, value }
    const inflight = new Map();

    const token = () => {
        try { return settings.githubToken() || config.secrets.GITHUB_TOKEN || ''; } catch { return config.secrets.GITHUB_TOKEN || ''; }
    };

    function headers() {
        const h = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': config.fetch.userAgent,
        };
        const t = token();
        if (t) h.Authorization = `Bearer ${t}`;
        return h;
    }

    /** One API GET: robots, spacing, the token and the rate-limit ledger. Returns { body, status, bytes, headers }. */
    async function request(url, { beforeRequest = null, minIntervalMs = null } = {}) {
        // A used-up search budget is a wait, not a stream of refused requests. GitHub resets the search
        // limit within a minute; resetAt comes from its own headers.
        if (limiter.remaining === 0 && limiter.resetAt > now()) {
            throw new RateLimitError(limiter.resetAt - now(), 'the GitHub search limit is used up');
        }
        const verdict = await robots.check(url);
        if (!verdict.allowed) {
            if (verdict.refusedCode) throw Object.assign(new Error(`${HOST} is not fetchable (${verdict.refusedCode})`), { code: verdict.refusedCode });
            throw Object.assign(new Error(verdict.reason || 'robots.txt disallows this URL'), { code: 'robots_denied' });
        }
        await spacer.space(HOST, minIntervalMs == null ? (token() ? 2000 : 6500) : minIntervalMs);
        if (beforeRequest) await beforeRequest();
        limiter.at = now();
        const res = await fetcher.fetchUrl(url, {
            headers: headers(),
            capBytes,
            sensitiveHeaders: ['Authorization'],
            beforeHop: async (next) => {
                const v = await robots.check(next.toString());
                return v.allowed ? null : { refuse: v.reason };
            },
        });
        const remaining = int(res.headers['x-ratelimit-remaining']);
        const reset = int(res.headers['x-ratelimit-reset']);
        if (remaining != null) limiter.remaining = remaining;
        if (reset != null) limiter.resetAt = reset * 1000;
        if (res.status === 429 || (res.status === 403 && (remaining === 0 || retryAfterMs(res.headers['retry-after'], now()) != null))) {
            const wait = retryAfterMs(res.headers['retry-after'], now())
                ?? (limiter.resetAt > now() ? limiter.resetAt - now() : 60_000);
            throw new RateLimitError(wait, `GitHub answered ${res.status}`);
        }
        if (res.status === 401) throw Object.assign(new Error('GitHub refused the token (401)'), { code: 'http_error', status: 401 });
        if (res.status === 403) throw Object.assign(new Error('GitHub answered 403 (the token may lack access)'), { code: 'http_error', status: 403 });
        if (res.status !== 200 && res.status !== 203) throw Object.assign(new Error(`GitHub answered HTTP ${res.status}`), { code: 'http_error', status: res.status });
        let body;
        try { body = JSON.parse(decodeBody(res.body, res.headers['content-type'])); } catch {
            throw new ParseError('GitHub answered non-JSON');
        }
        return { body, status: res.status, bytes: res.bytes || 0, headers: res.headers };
    }

    /**
     * One ingestion run's share of the query plan. Starts at the stored cursor, asks at most `budget`
     * questions, and returns the cursor for the next run. A rate limit after some answers keeps those
     * answers and reports when to come back; a rate limit before any is thrown so the run is recorded
     * as rate_limited, never as an empty success.
     */
    async function fetchQueries({ source, cursor = {}, budget = 8, beforeRequest = null } = {}) {
        const list = github.plan(now());
        const start = Number.isInteger(cursor.next) ? ((cursor.next % list.length) + list.length) % list.length : 0;
        const items = new Map();
        const stars = new Map();
        let next = start;
        let queries = 0;
        let lastStatus = null;
        let bytes = 0;
        const hash = crypto.createHash('sha256');
        let notBefore = 0;
        let limited = null;
        for (let i = 0; i < budget; i++) {
            const index = (start + i) % list.length;
            const query = list[index];
            let out;
            try {
                out = await request(github.queryUrl(query), { beforeRequest, minIntervalMs: source.min_interval_ms });
            } catch (err) {
                if (err.code === 'rate_limited') {
                    notBefore = Math.max(notBefore, now() + err.retryAfterMs);
                    limited = err;
                    break;
                }
                throw err;
            }
            lastStatus = out.status;
            bytes += out.bytes;
            hash.update(Buffer.from(JSON.stringify(out.body)));
            const parsed = github.parseSearch(out.body);
            for (const raw of parsed.items) {
                const item = github.repoItem(raw, config.items.summaryMax);
                if (!item) continue;
                items.set(item.identity, item);
                const starsNow = item.fields.stars;
                if (starsNow != null) stars.set(item.identity, starsNow);
            }
            queries++;
            next = (index + 1) % list.length;
        }
        if (!queries && limited) throw limited;
        return {
            items: [...items.values()],
            stars: [...stars.entries()].map(([full_name, n]) => ({ full_name, stars: n })),
            next, queries, lastStatus, bytes,
            rawBodyHash: hash.digest('hex'),
            notBefore,
            limited: Boolean(limited),
        };
    }

    /**
     * A live repository search for the public API: GitHub's own query syntax passes through, with an
     * optional language and sort. Cached for ten minutes; a request that GitHub rate-limits answers
     * the last copy for up to an hour, marked stale, instead of inventing an empty result.
     */
    async function search({ q, lang = null, sort = 'best', page = 1 } = {}) {
        const text = String(q || '').trim().slice(0, 300);
        if (!text) throw Object.assign(new Error('a search needs q'), { code: 'bad_query' });
        const language = lang ? String(lang).trim().slice(0, 60) : '';
        const order = ['stars', 'updated', 'best'].includes(sort) ? sort : 'best';
        const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), 10);
        const u = new URL(github.API);
        u.searchParams.set('q', language ? `${text} language:"${language.replace(/"/g, '')}"` : text);
        if (order !== 'best') { u.searchParams.set('sort', order); u.searchParams.set('order', 'desc'); }
        u.searchParams.set('per_page', '30');
        u.searchParams.set('page', String(p));
        const url = u.toString();
        const hit = cache.get(url);
        if (hit && now() - hit.at < SEARCH_TTL_MS) return { ...hit.value, cached: true, stale: false };
        if (inflight.has(url)) return await inflight.get(url);
        const job = (async () => {
            try {
                const out = await request(url, { minIntervalMs: token() ? 2000 : 6500 });
                const parsed = github.parseSearch(out.body);
                const items = parsed.items.map((r) => github.repoItem(r, config.items.summaryMax)).filter(Boolean)
                    .map((i) => github.publicRepository(i));
                const value = { items, total: parsed.total, incomplete: parsed.incomplete, page: p, sort: order, q: text, lang: language || null };
                cache.set(url, { at: now(), value });
                if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
                return { ...value, cached: false, stale: false };
            } catch (err) {
                if (err.code === 'rate_limited' && hit && now() - hit.at < 60 * 60 * 1000) {
                    return { ...hit.value, cached: true, stale: true, retry_after_ms: err.retryAfterMs };
                }
                throw err;
            } finally {
                inflight.delete(url);
            }
        })();
        inflight.set(url, job);
        return await job;
    }

    return { request, fetchQueries, search, rateLimit: () => ({ ...limiter }), hasToken: () => Boolean(token()) };
}

module.exports = { createGithub, RateLimitError, retryAfterMs, SEARCH_TTL_MS };
