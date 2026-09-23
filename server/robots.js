'use strict';
/**
 * robots.txt (RFC 9309), checked before every request an ingestion run makes, including each
 * redirect hop to a new origin.
 *
 *   - the group whose User-agent names our product token (case-insensitive) applies, else `*`;
 *     several matching groups are merged
 *   - Allow/Disallow with `*` and `$`; the longest matching rule wins, Allow wins a tie
 *   - 2xx: parsed; 4xx (e.g. 404) except 429: no restrictions; 429, 5xx, network error or timeout:
 *     complete disallow ("unreachable") — never guessed as allowed
 *   - cached per origin for SOURCES_ROBOTS_TTL_MS (24 h); Crawl-delay is honoured as a minimum
 *     gap between requests (non-standard, but a clear wish of the site)
 * A source-adapter name is never permission to fetch (roadmap anti-goal 26): if robots says no,
 * the fetch run is `robots_denied` and nothing is requested.
 */

function parseRobots(text, agent) {
    const token = String(agent).toLowerCase();
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    for (const rawLine of String(text).split(/\r\n|\r|\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        if (key === 'user-agent') {
            if (!lastWasAgent || !current) {
                current = { agents: [], rules: [], crawlDelay: null };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;
        if (!current) continue;
        // Bounded: a hostile robots.txt cannot make matching expensive.
        if ((key === 'allow' || key === 'disallow') && value.length <= 512 && current.rules.length < 1000) {
            current.rules.push({ allow: key === 'allow', path: value.replace(/\*+/g, '*') });
        }
        else if (key === 'crawl-delay') {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) current.crawlDelay = Math.min(n, 3600);
        }
    }
    // RFC 9309: the product token is matched case-insensitively against the User-agent value.
    let chosen = groups.filter(g => g.agents.some(a => a.split('/')[0].trim() === token));
    if (!chosen.length) chosen = groups.filter(g => g.agents.includes('*'));
    const delays = chosen.map(g => g.crawlDelay).filter(d => d != null);
    return {
        // An empty Disallow (or Allow) path matches nothing: "allow everything".
        rules: chosen.flatMap(g => g.rules).filter(r => r.path !== ''),
        crawlDelaySec: delays.length ? Math.max(...delays) : null,
    };
}

function ruleRegex(path) {
    let p = path;
    const anchored = p.endsWith('$');
    if (anchored) p = p.slice(0, -1);
    const body = p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp('^' + body + (anchored ? '$' : ''));
}

function normalizePath(p) {
    // Compare percent-encoding consistently: decode what is safe to decode, re-encode the rest.
    try { return encodeURI(decodeURI(p)); } catch { return p; }
}

/** Is `pathWithQuery` allowed by the parsed rules? */
function isAllowed(parsed, pathWithQuery) {
    const target = normalizePath(pathWithQuery || '/');
    let best = null;
    for (const r of parsed.rules) {
        const re = ruleRegex(normalizePath(r.path));
        if (!re.test(target)) continue;
        const len = r.path.length;
        if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
    }
    return best ? best.allow : true;
}

/**
 * createRobots({ db, fetcher, agent, ttlMs, maxBytes, now, beforeRequest(host) })
 *   check(url) → { allowed, reason, crawlDelaySec, source: 'cache'|'fetched' }
 */
function createRobots({ db, fetcher, agent, ttlMs, maxBytes, now = () => Date.now(), beforeRequest = async () => {} }) {
    const get = db.prepare('SELECT * FROM robots_cache WHERE origin = ?');
    const put = db.prepare(`INSERT INTO robots_cache (origin, fetched_at, expires_at, status, outcome, rules, crawl_delay_sec, detail)
        VALUES (@origin, @fetched_at, @expires_at, @status, @outcome, @rules, @crawl_delay_sec, @detail)
        ON CONFLICT(origin) DO UPDATE SET fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, status = excluded.status,
        outcome = excluded.outcome, rules = excluded.rules, crawl_delay_sec = excluded.crawl_delay_sec, detail = excluded.detail`);
    const inflight = new Map();

    async function load(origin) {
        await beforeRequest(new URL(origin).host);
        const t = now();
        let row;
        try {
            const r = await fetcher.fetchUrl(`${origin}/robots.txt`, { headers: { Accept: 'text/plain' }, capBytes: maxBytes });
            if (r.status >= 200 && r.status < 300) {
                const parsed = parseRobots(r.body.toString('utf8'), agent);
                row = { status: r.status, outcome: 'parsed', rules: JSON.stringify(parsed.rules), crawl_delay_sec: parsed.crawlDelaySec, detail: null };
            } else if (r.status >= 400 && r.status < 500 && r.status !== 429) {
                row = { status: r.status, outcome: 'unavailable', rules: '[]', crawl_delay_sec: null, detail: `HTTP ${r.status}: no restrictions` };
            } else {
                row = { status: r.status, outcome: 'unreachable', rules: '[]', crawl_delay_sec: null, detail: `HTTP ${r.status}: complete disallow` };
            }
        } catch (err) {
            // Network error, timeout, refused address or an oversized file: refuse, never guess.
            row = { status: null, outcome: 'unreachable', rules: '[]', crawl_delay_sec: null, detail: `${err.code || 'error'}: ${err.message}`.slice(0, 300) };
        }
        // An unreachable robots.txt is retried sooner than a parsed one.
        const ttl = row.outcome === 'unreachable' ? Math.min(ttlMs, 15 * 60 * 1000) : ttlMs;
        const full = { origin, fetched_at: t, expires_at: t + ttl, ...row };
        put.run(full);
        return full;
    }

    async function entry(origin) {
        const cached = get.get(origin);
        if (cached && cached.expires_at > now()) return { row: cached, source: 'cache' };
        if (!inflight.has(origin)) inflight.set(origin, load(origin).finally(() => inflight.delete(origin)));
        return { row: await inflight.get(origin), source: 'fetched' };
    }

    async function check(input) {
        const url = new URL(input);
        const { row, source } = await entry(url.origin);
        if (row.outcome === 'unreachable') {
            // A refused address/port is a policy refusal of the host itself, not a robots answer.
            const code = row.status == null ? String(row.detail || '').split(':')[0] : null;
            return { allowed: false, reason: `robots.txt unreachable (${row.detail})`, crawlDelaySec: null, source, refusedCode: ['address_refused', 'port_refused', 'bad_url'].includes(code) ? code : null };
        }
        if (row.outcome === 'unavailable') return { allowed: true, reason: null, crawlDelaySec: null, source };
        const parsed = { rules: JSON.parse(row.rules) };
        const allowed = isAllowed(parsed, url.pathname + url.search);
        return { allowed, reason: allowed ? null : `disallowed by ${url.origin}/robots.txt`, crawlDelaySec: row.crawl_delay_sec, source };
    }

    return { check, forget: (origin) => db.prepare('DELETE FROM robots_cache WHERE origin = ?').run(origin) };
}

module.exports = { parseRobots, isAllowed, createRobots };
