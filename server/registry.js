'use strict';
/**
 * The source registry: validation, CRUD, and the health/staleness view.
 *
 * A source records where it is fetched from and on what terms: endpoints, the auth mode with the
 * NAME of the environment variable holding the credential (never its value; names must start with
 * SOURCES_CRED_ so a registry entry can never point at this service's own secrets), robots and
 * terms notes, the rate limit, whether it is enabled, review/sensitivity flags and the default
 * indexability downstream products start from. A source cannot be enabled without a terms note:
 * an adapter existing is not permission to ingest (roadmap anti-goal 26). A crawl source also
 * carries how it walks its site (`crawl`, server/crawl.js); its endpoints are the seeds.
 */
const { checkApiMapping } = require('./adapters');
const extract = require('./adapters/extract');

const TYPES = ['rss', 'atom', 'sitemap', 'jsonld', 'api', 'bulk', 'crawl', 'manual'];
// The categories are sources.source@1's (openvibe-contracts), read from the schema so the two never drift: housing, food
// and jobs since contracts 0.210.0, for Rent and Homes, Food and Work (plan 2026-10-22, track F1).
const CATEGORIES = Object.freeze([...require('openvibe-contracts/contracts/sources/source.v1.json').properties.category.enum]);
const SENSITIVITY = ['none', 'financial', 'health', 'political', 'legal', 'adult'];
const AUTH_MODES = ['none', 'header', 'bearer', 'query'];
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ENV_RE = /^SOURCES_CRED_[A-Z0-9_]{2,60}$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'user-agent', 'accept-encoding', 'if-none-match', 'if-modified-since']);

class RegistryError extends Error {
    constructor(detail, code = 'sources.bad_source') { super(detail); this.code = code; }
}

function httpUrl(v, what) {
    let u;
    try { u = new URL(String(v)); } catch { throw new RegistryError(`${what} is not a URL`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RegistryError(`${what} must be http(s)`);
    if (u.username || u.password) throw new RegistryError(`${what} must not carry credentials`);
    if (String(v).length > 2048) throw new RegistryError(`${what} is too long`);
    return u.toString();
}

const text = (v, max, what) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || v.length > max) throw new RegistryError(`${what} must be a string of at most ${max} characters`);
    return v.trim() || null;
};
const intIn = (v, min, max, d, what) => {
    if (v === undefined || v === null) return d;
    if (!Number.isInteger(v) || v < min || v > max) throw new RegistryError(`${what} must be an integer between ${min} and ${max}`);
    return v;
};
const bool = (v, d, what) => {
    if (v === undefined || v === null) return d;
    if (typeof v !== 'boolean') throw new RegistryError(`${what} must be true or false`);
    return v;
};

const CRAWL_FIELDS = ['sitemaps', 'follow_links', 'include', 'exclude', 'max_pages', 'pages_per_run', 'recrawl_sec', 'max_depth', 'require_structured'];

/** A crawl source's walk (sources.source@1 `crawl`), every default filled in so the crawler reads one shape. */
function validateCrawl(c) {
    const v = c == null ? {} : c;
    if (typeof v !== 'object' || Array.isArray(v)) throw new RegistryError('crawl must be an object');
    for (const k of Object.keys(v)) if (!CRAWL_FIELDS.includes(k)) throw new RegistryError(`unknown crawl field ${k}`);
    const patterns = (list, what) => {
        if (list == null) return [];
        if (!Array.isArray(list) || list.length > 20) throw new RegistryError(`${what} must be an array of at most 20 patterns`);
        return list.map((p, i) => {
            if (typeof p !== 'string' || !p || p.length > 200) throw new RegistryError(`${what}[${i}] must be a pattern of 1 to 200 characters`);
            try { new RegExp(p); } catch (err) { throw new RegistryError(`${what}[${i}] is not a regular expression: ${err.message}`); }
            return p;
        });
    };
    return {
        sitemaps: bool(v.sitemaps, true, 'crawl.sitemaps'),
        follow_links: bool(v.follow_links, false, 'crawl.follow_links'),
        include: patterns(v.include, 'crawl.include'),
        exclude: patterns(v.exclude, 'crawl.exclude'),
        max_pages: intIn(v.max_pages, 1, 200000, 5000, 'crawl.max_pages'),
        pages_per_run: intIn(v.pages_per_run, 1, 1000, 100, 'crawl.pages_per_run'),
        recrawl_sec: intIn(v.recrawl_sec, 3600, 30 * 86400, 86400, 'crawl.recrawl_sec'),
        max_depth: intIn(v.max_depth, 0, 10, 2, 'crawl.max_depth'),
        require_structured: bool(v.require_structured, true, 'crawl.require_structured'),
    };
}

/** Validate a full source definition → normalized record (no runtime state). */
function validateSource(input, { maxItemsCap = 12000 } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RegistryError('body must be a source object');
    const known = new Set(['key', 'name', 'type', 'category', 'homepage_url', 'endpoints', 'auth', 'robots_note', 'terms_note', 'license_note',
        'min_interval_ms', 'poll_interval_sec', 'stale_after_sec', 'max_items', 'enabled', 'review_required', 'sensitivity',
        'default_indexability', 'search_visibility', 'retire_after_sec', 'crawl']);
    for (const k of Object.keys(input)) if (!known.has(k)) throw new RegistryError(`unknown field ${k}`);
    if (!KEY_RE.test(String(input.key || ''))) throw new RegistryError('key must match ^[a-z0-9][a-z0-9-]{1,63}$');
    const name = text(input.name, 200, 'name');
    if (!name) throw new RegistryError('name is required');
    if (!TYPES.includes(input.type)) throw new RegistryError(`type must be one of ${TYPES.join('|')}`);
    if (!CATEGORIES.includes(input.category)) throw new RegistryError(`category must be one of ${CATEGORIES.join('|')}`);

    const endpoints = input.endpoints == null ? [] : input.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length > 20) throw new RegistryError('endpoints must be an array of at most 20');
    if (input.type === 'manual' && endpoints.length) throw new RegistryError('a manual source has no endpoints');
    if (input.type !== 'manual' && !endpoints.length) throw new RegistryError('at least one endpoint is required');
    const eps = endpoints.map((ep, i) => {
        const e = typeof ep === 'string' ? { url: ep } : ep;
        if (!e || typeof e !== 'object') throw new RegistryError(`endpoints[${i}] must be a URL or an object`);
        const out = { url: httpUrl(e.url, `endpoints[${i}].url`) };
        if (input.type === 'api') {
            // A resolver walks several JSON endpoints of one API (HN Who is hiring), instead of reading one items_path:
            // it has no field mapping of its own, so it does not go through the api mapping checks.
            if (e.resolver !== undefined) {
                for (const k of Object.keys(e)) {
                    // The normalized row written by the create path carries the api defaults; accepting them back
                    // (only as their defaults) is what lets PATCH { enabled: true } validate a stored resolver.
                    if (!['url', 'format', 'resolver', 'item_kind', 'max_bytes', 'timeout_ms', 'items_shape', 'items_path', 'fields', 'extra'].includes(k)) throw new RegistryError(`endpoints[${i}].${k} is not a resolver field`);
                }
                if (e.resolver !== 'hn-whoishiring') throw new RegistryError(`endpoints[${i}].resolver must be hn-whoishiring`);
                if (e.format !== undefined && e.format !== 'json') throw new RegistryError(`endpoints[${i}].format must be json for a resolver`);
                if (e.items_shape !== undefined && e.items_shape !== 'array') throw new RegistryError(`endpoints[${i}].items_shape must be array for a resolver`);
                if (e.items_path !== undefined && e.items_path !== '') throw new RegistryError(`endpoints[${i}].items_path must be "" for a resolver`);
                if (e.fields !== undefined && (!e.fields || typeof e.fields !== 'object' || Array.isArray(e.fields) || Object.keys(e.fields).length)) throw new RegistryError(`endpoints[${i}].fields must be empty for a resolver`);
                if (e.extra !== undefined && (!e.extra || typeof e.extra !== 'object' || Array.isArray(e.extra) || Object.keys(e.extra).length)) throw new RegistryError(`endpoints[${i}].extra must be empty for a resolver`);
                if (!/\.json(\?|$)/.test(out.url)) throw new RegistryError(`endpoints[${i}].resolver needs a .json endpoint`);
                if (e.item_kind !== undefined && !/^[a-z][a-z0-9_]{1,39}$/.test(e.item_kind)) throw new RegistryError(`endpoints[${i}].item_kind is malformed`);
                if (e.max_bytes !== undefined && (!Number.isInteger(e.max_bytes) || e.max_bytes < 1024 || e.max_bytes > 32 * 1024 * 1024)) throw new RegistryError(`endpoints[${i}].max_bytes must be an integer from 1024 to 33554432`);
                if (e.timeout_ms !== undefined && (!Number.isInteger(e.timeout_ms) || e.timeout_ms < 1000 || e.timeout_ms > 120000)) throw new RegistryError(`endpoints[${i}].timeout_ms must be an integer from 1000 to 120000`);
                Object.assign(out, { format: 'json', items_shape: 'array', items_path: '', item_kind: e.item_kind || 'job', fields: {}, extra: {}, resolver: e.resolver });
                if (e.max_bytes !== undefined) out.max_bytes = e.max_bytes;
                if (e.timeout_ms !== undefined) out.timeout_ms = e.timeout_ms;
                return out;
            }
            const err = checkApiMapping(e);
            if (err) throw new RegistryError(`endpoints[${i}]: ${err}`);
            Object.assign(out, { format: e.format || 'json', items_shape: e.items_shape || 'array', items_path: e.items_path || '', item_kind: e.item_kind || 'record', fields: e.fields || {}, extra: e.extra || {} });
            // `where` and its alias `filter` are only copied when given, so records without conditions stay byte-identical.
            if (e.where) out.where = e.where;
            if (e.filter) out.filter = e.filter;
            // and `extra_lists` (tags, job types) the same way.
            if (e.extra_lists) out.extra_lists = e.extra_lists;
            if (e.duplicates !== undefined) out.duplicates = e.duplicates;
            if (e.max_bytes !== undefined) out.max_bytes = e.max_bytes;
            if (e.timeout_ms !== undefined) out.timeout_ms = e.timeout_ms;
            if (e.request_content_type !== undefined) out.request_content_type = e.request_content_type;
        } else if (input.type === 'bulk') {
            if (endpoints.length !== 1) throw new RegistryError('a bulk source is one dataset file: exactly one endpoint');
            const err = checkApiMapping(e, { bulk: true });
            if (err) throw new RegistryError(`endpoints[${i}]: ${err}`);
            for (const k of Object.keys(e)) {
                if (!['url', 'format', 'item_kind', 'fields', 'extra', 'extra_lists', 'max_bytes', 'max_rows', 'timeout_ms', 'resolver'].includes(k)) throw new RegistryError(`endpoints[${i}].${k} is not a bulk field`);
            }
            // An off-delta bulk source reads a text index and then only the delta files it lists (Open Food Facts).
            if (e.resolver !== undefined) {
                if (e.resolver !== 'off-delta') throw new RegistryError(`endpoints[${i}].resolver must be off-delta`);
                if (!/\.txt(\?|$)/.test(out.url)) throw new RegistryError(`endpoints[${i}].resolver needs the index .txt endpoint`);
                if (e.format !== 'jsonl') throw new RegistryError(`endpoints[${i}].format must be jsonl for an off-delta resolver`);
            }
            Object.assign(out, {
                format: e.format || 'csv',
                item_kind: e.item_kind || 'record',
                fields: e.fields || {},
                extra: e.extra || {},
                max_rows: e.max_rows === undefined ? 1000 : e.max_rows,
            });
            if (e.extra_lists) out.extra_lists = e.extra_lists;
            if (e.max_bytes !== undefined) out.max_bytes = e.max_bytes;
            if (e.timeout_ms !== undefined) out.timeout_ms = e.timeout_ms;
            if (e.resolver !== undefined) out.resolver = e.resolver;
        } else {
            // A feed may read structured facts out of its items' prose (adapters/extract.js).
            for (const k of Object.keys(e)) if (k !== 'url' && !(k === 'extract' && (input.type === 'rss' || input.type === 'atom'))) throw new RegistryError(`endpoints[${i}].${k} is only for api sources`);
            if (e.extract !== undefined) {
                const err = extract.check(e.extract);
                if (err) throw new RegistryError(`endpoints[${i}]: ${err}`);
                out.extract = e.extract;
            }
        }
        return out;
    });
    if (new Set(eps.map(e => e.url)).size !== eps.length) throw new RegistryError('endpoints must be distinct');

    const a = input.auth == null ? { mode: 'none' } : input.auth;
    if (typeof a !== 'object' || !AUTH_MODES.includes(a.mode)) throw new RegistryError(`auth.mode must be one of ${AUTH_MODES.join('|')}`);
    const auth = { mode: a.mode };
    if (a.mode !== 'none') {
        if (input.type === 'manual') throw new RegistryError('a manual source has no credential');
        if (!ENV_RE.test(String(a.env || ''))) throw new RegistryError('auth.env must be an environment variable NAME matching ^SOURCES_CRED_[A-Z0-9_]+$ (never a value)');
        auth.env = a.env;
        if (a.mode === 'header') {
            if (!HEADER_RE.test(String(a.header || '')) || FORBIDDEN_HEADERS.has(String(a.header).toLowerCase())) throw new RegistryError('auth.header must be a plain header name');
            auth.header = a.header;
        }
        if (a.mode === 'query') {
            if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(a.param || ''))) throw new RegistryError('auth.param must be a query parameter name');
            auth.param = a.param;
        }
    }
    for (const k of Object.keys(a)) if (!['mode', 'env', 'header', 'param'].includes(k)) throw new RegistryError(`unknown auth field ${k}`);

    const pollIntervalSec = intIn(input.poll_interval_sec, 1, 7 * 86400, 3600, 'poll_interval_sec');
    const record = {
        key: input.key,
        name,
        type: input.type,
        category: input.category,
        homepage_url: input.homepage_url ? httpUrl(input.homepage_url, 'homepage_url') : null,
        endpoints: eps,
        auth,
        robots_note: text(input.robots_note, 2000, 'robots_note'),
        terms_note: text(input.terms_note, 2000, 'terms_note'),
        license_note: text(input.license_note, 2000, 'license_note'),
        min_interval_ms: intIn(input.min_interval_ms, 0, 86400000, 60000, 'min_interval_ms'),
        poll_interval_sec: pollIntervalSec,
        stale_after_sec: intIn(input.stale_after_sec, 1, 90 * 86400, pollIntervalSec * 3, 'stale_after_sec'),
        max_items: intIn(input.max_items, 1, maxItemsCap, Math.min(200, maxItemsCap), 'max_items'),
        enabled: bool(input.enabled, false, 'enabled'),
        review_required: bool(input.review_required, true, 'review_required'),
        sensitivity: input.sensitivity == null ? 'none' : input.sensitivity,
        default_indexability: input.default_indexability == null ? 'noindex' : input.default_indexability,
        search_visibility: input.search_visibility == null ? null : input.search_visibility,
        // Retire what the feed stopped showing (jobs, listings): an hour to a year, or null to keep every item (server/ingest.js).
        retire_after_sec: intIn(input.retire_after_sec, 3600, 365 * 86400, null, 'retire_after_sec'),
        crawl: input.type === 'crawl' ? validateCrawl(input.crawl) : null,
    };
    if (input.type !== 'crawl' && input.crawl != null) throw new RegistryError('crawl is only for crawl sources');
    // A crawl reaches a page again only when its turn comes, so "not seen for a while" says nothing about a product: a crawl
    // retires a page's items when the page is gone (404 or 410 twice, server/crawl.js) or asks not to be indexed.
    if (input.type === 'crawl' && record.retire_after_sec != null) throw new RegistryError('a crawl source retires a page\'s items when the page is gone; retire_after_sec is for feeds');
    // A bulk run reads up to max_rows and stops; it never sees the rest of the file, so "not seen" says nothing.
    if (input.type === 'bulk' && record.retire_after_sec != null) throw new RegistryError('a bulk source reads a row limit per run; retire_after_sec would retire the rows it did not reach');
    if (!SENSITIVITY.includes(record.sensitivity)) throw new RegistryError(`sensitivity must be one of ${SENSITIVITY.join('|')}`);
    if (!['index', 'noindex'].includes(record.default_indexability)) throw new RegistryError('default_indexability must be index or noindex');
    if (record.sensitivity !== 'none' && record.default_indexability === 'index' && record.review_required === false) {
        throw new RegistryError('a sensitive source needs review before anything from it can be indexable');
    }
    if (![null, 'members'].includes(record.search_visibility)) throw new RegistryError('search_visibility must be null or "members" (staff-only search of raw items)');
    if (record.enabled && !record.terms_note) throw new RegistryError('a source cannot be enabled without a terms_note (access and terms must be verified first)', 'sources.terms_required');
    if (record.enabled && record.type !== 'manual' && !record.robots_note) throw new RegistryError('a fetched source cannot be enabled without a robots_note', 'sources.terms_required');
    return record;
}

function createRegistry({ db, now = () => Date.now(), maxItemsCap = 12000 }) {
    const st = {
        get: db.prepare('SELECT * FROM sources WHERE key = ?'),
        all: db.prepare('SELECT * FROM sources ORDER BY key'),
        insert: db.prepare(`INSERT INTO sources (key, name, type, category, homepage_url, endpoints, auth, robots_note, terms_note, license_note,
            min_interval_ms, poll_interval_sec, stale_after_sec, max_items, enabled, review_required, sensitivity, default_indexability,
            search_visibility, retire_after_sec, crawl, created_at, updated_at, updated_by, next_due_at)
            VALUES (@key, @name, @type, @category, @homepage_url, @endpoints, @auth, @robots_note, @terms_note, @license_note,
            @min_interval_ms, @poll_interval_sec, @stale_after_sec, @max_items, @enabled, @review_required, @sensitivity, @default_indexability,
            @search_visibility, @retire_after_sec, @crawl, @created_at, @updated_at, @updated_by, 0)`),
        update: db.prepare(`UPDATE sources SET name = @name, type = @type, category = @category, homepage_url = @homepage_url, endpoints = @endpoints,
            auth = @auth, robots_note = @robots_note, terms_note = @terms_note, license_note = @license_note, min_interval_ms = @min_interval_ms,
            poll_interval_sec = @poll_interval_sec, stale_after_sec = @stale_after_sec, max_items = @max_items, enabled = @enabled,
            review_required = @review_required, sensitivity = @sensitivity, default_indexability = @default_indexability,
            search_visibility = @search_visibility, retire_after_sec = @retire_after_sec, crawl = @crawl, updated_at = @updated_at, updated_by = @updated_by
            WHERE key = @key`),
        del: db.prepare('DELETE FROM sources WHERE key = ?'),
        itemCount: db.prepare('SELECT COUNT(*) AS n FROM items WHERE source_key = ?'),
        dropFrontier: db.prepare('DELETE FROM crawl_frontier WHERE source_key = ?'),
        dropState: db.prepare('DELETE FROM source_state WHERE source_key = ?'),
        resetValidators: db.prepare('DELETE FROM endpoint_state WHERE source_key = ?'),
    };

    function toRow(rec, by) {
        return {
            ...rec,
            endpoints: JSON.stringify(rec.endpoints),
            auth: JSON.stringify(rec.auth),
            crawl: rec.crawl ? JSON.stringify(rec.crawl) : null,
            enabled: rec.enabled ? 1 : 0,
            review_required: rec.review_required ? 1 : 0,
            created_at: now(),
            updated_at: now(),
            updated_by: by || null,
        };
    }

    function fromRow(row) {
        if (!row) return null;
        return {
            key: row.key, name: row.name, type: row.type, category: row.category, homepage_url: row.homepage_url,
            endpoints: JSON.parse(row.endpoints), auth: JSON.parse(row.auth),
            robots_note: row.robots_note, terms_note: row.terms_note, license_note: row.license_note,
            min_interval_ms: row.min_interval_ms, poll_interval_sec: row.poll_interval_sec, stale_after_sec: row.stale_after_sec,
            max_items: row.max_items, enabled: Boolean(row.enabled), review_required: Boolean(row.review_required),
            sensitivity: row.sensitivity, default_indexability: row.default_indexability, search_visibility: row.search_visibility,
            retire_after_sec: row.retire_after_sec == null ? null : Number(row.retire_after_sec),
            crawl: row.crawl ? JSON.parse(row.crawl) : null,
        };
    }

    /** Health and staleness, computed from the runtime columns. */
    function health(row) {
        const t = now();
        const neverSucceeded = row.last_success_at == null;
        const stale = row.type === 'manual' ? false : neverSucceeded || (t - row.last_success_at) > row.stale_after_sec * 1000;
        let status;
        if (!row.enabled) status = 'disabled';
        else if (row.type === 'manual') status = 'manual';
        else if (row.last_run_at == null) status = 'never_fetched';
        else if (row.consecutive_failures > 0) status = 'failing';
        else if (stale) status = 'stale';
        else status = 'healthy';
        const iso = (v) => (v == null ? null : new Date(v).toISOString());
        return {
            status,
            stale,
            last_success_at: iso(row.last_success_at),
            last_run_at: iso(row.last_run_at),
            last_state: row.last_state,
            consecutive_failures: row.consecutive_failures,
            next_due_at: row.enabled && row.type !== 'manual' ? iso(Math.max(row.next_due_at, row.not_before)) : null,
            stale_after_sec: row.stale_after_sec,
        };
    }

    function view(row) {
        return { ...fromRow(row), health: health(row), created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() };
    }

    async function create(input, by) {
        const rec = validateSource(input, { maxItemsCap });
        if (await st.get.get(rec.key)) throw new RegistryError(`source ${rec.key} exists`, 'sources.exists');
        await st.insert.run(toRow(rec, by));
        return await st.get.get(rec.key);
    }

    async function patch(key, changes, by) {
        const row = await st.get.get(key);
        if (!row) return null;
        if (changes && changes.key !== undefined && changes.key !== key) throw new RegistryError('key cannot change');
        if (changes && changes.type !== undefined && changes.type !== row.type && (await st.itemCount.get(key)).n) {
            throw new RegistryError('type cannot change once the source has items (register a new source)');
        }
        const merged = { ...fromRow(row), ...(changes || {}), key };
        const rec = validateSource(merged, { maxItemsCap });
        const next = toRow(rec, by);
        await st.update.run({ ...next });
        // New endpoint settings must reach the next fetch: the stored ETag/Last-Modified would make it a 304 that parses
        // nothing until the upstream file changes (bls-average-prices' duplicates: last waited on BLS's monthly file).
        if (next.endpoints !== row.endpoints) await st.resetValidators.run(key);
        return await st.get.get(key);
    }

    /** Only a source that never produced an item can be deleted; otherwise disable it. */
    async function remove(key) {
        const row = await st.get.get(key);
        if (!row) return null;
        if ((await st.itemCount.get(key)).n) throw new RegistryError('the source has items; disable it instead (provenance must stay resolvable)', 'sources.has_items');
        await st.del.run(key);
        await st.dropFrontier.run(key);
        await st.dropState.run(key);
        return true;
    }

    return { get: async (k) => await st.get.get(k), all: async () => await st.all.all(), create, patch, remove, view, fromRow, health };
}

module.exports = { createRegistry, validateSource, validateCrawl, RegistryError, TYPES, CATEGORIES };
