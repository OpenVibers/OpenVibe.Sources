'use strict';
/**
 * The source registry: validation, CRUD, and the health/staleness view.
 *
 * A source records where it is fetched from and on what terms: endpoints, the auth mode with the
 * NAME of the environment variable holding the credential (never its value; names must start with
 * SOURCES_CRED_ so a registry entry can never point at this service's own secrets), robots and
 * terms notes, the rate limit, whether it is enabled, review/sensitivity flags and the default
 * indexability downstream products start from. A source cannot be enabled without a terms note:
 * an adapter existing is not permission to ingest (roadmap anti-goal 26).
 */
const { checkApiMapping } = require('./adapters');

const TYPES = ['rss', 'atom', 'sitemap', 'jsonld', 'api', 'manual'];
const CATEGORIES = ['news', 'blog', 'reviews', 'deals', 'coupons', 'trade'];
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

/** Validate a full source definition → normalized record (no runtime state). */
function validateSource(input, { maxItemsCap = 500 } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RegistryError('body must be a source object');
    const known = new Set(['key', 'name', 'type', 'category', 'homepage_url', 'endpoints', 'auth', 'robots_note', 'terms_note', 'license_note',
        'min_interval_ms', 'poll_interval_sec', 'stale_after_sec', 'max_items', 'enabled', 'review_required', 'sensitivity',
        'default_indexability', 'search_visibility']);
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
            const err = checkApiMapping(e);
            if (err) throw new RegistryError(`endpoints[${i}]: ${err}`);
            Object.assign(out, { format: e.format || 'json', items_path: e.items_path || '', item_kind: e.item_kind || 'record', fields: e.fields || {}, extra: e.extra || {} });
        } else {
            for (const k of Object.keys(e)) if (k !== 'url') throw new RegistryError(`endpoints[${i}].${k} is only for api sources`);
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
    };
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

function createRegistry({ db, now = () => Date.now(), maxItemsCap = 500 }) {
    const st = {
        get: db.prepare('SELECT * FROM sources WHERE key = ?'),
        all: db.prepare('SELECT * FROM sources ORDER BY key'),
        insert: db.prepare(`INSERT INTO sources (key, name, type, category, homepage_url, endpoints, auth, robots_note, terms_note, license_note,
            min_interval_ms, poll_interval_sec, stale_after_sec, max_items, enabled, review_required, sensitivity, default_indexability,
            search_visibility, created_at, updated_at, updated_by, next_due_at)
            VALUES (@key, @name, @type, @category, @homepage_url, @endpoints, @auth, @robots_note, @terms_note, @license_note,
            @min_interval_ms, @poll_interval_sec, @stale_after_sec, @max_items, @enabled, @review_required, @sensitivity, @default_indexability,
            @search_visibility, @created_at, @updated_at, @updated_by, 0)`),
        update: db.prepare(`UPDATE sources SET name = @name, type = @type, category = @category, homepage_url = @homepage_url, endpoints = @endpoints,
            auth = @auth, robots_note = @robots_note, terms_note = @terms_note, license_note = @license_note, min_interval_ms = @min_interval_ms,
            poll_interval_sec = @poll_interval_sec, stale_after_sec = @stale_after_sec, max_items = @max_items, enabled = @enabled,
            review_required = @review_required, sensitivity = @sensitivity, default_indexability = @default_indexability,
            search_visibility = @search_visibility, updated_at = @updated_at, updated_by = @updated_by WHERE key = @key`),
        del: db.prepare('DELETE FROM sources WHERE key = ?'),
        itemCount: db.prepare('SELECT COUNT(*) AS n FROM items WHERE source_key = ?'),
    };

    function toRow(rec, by) {
        return {
            ...rec,
            endpoints: JSON.stringify(rec.endpoints),
            auth: JSON.stringify(rec.auth),
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

    function create(input, by) {
        const rec = validateSource(input, { maxItemsCap });
        if (st.get.get(rec.key)) throw new RegistryError(`source ${rec.key} exists`, 'sources.exists');
        st.insert.run(toRow(rec, by));
        return st.get.get(rec.key);
    }

    function patch(key, changes, by) {
        const row = st.get.get(key);
        if (!row) return null;
        if (changes && changes.key !== undefined && changes.key !== key) throw new RegistryError('key cannot change');
        if (changes && changes.type !== undefined && changes.type !== row.type && st.itemCount.get(key).n) {
            throw new RegistryError('type cannot change once the source has items (register a new source)');
        }
        const merged = { ...fromRow(row), ...(changes || {}), key };
        const rec = validateSource(merged, { maxItemsCap });
        st.update.run({ ...toRow(rec, by) });
        return st.get.get(key);
    }

    /** Only a source that never produced an item can be deleted; otherwise disable it. */
    function remove(key) {
        const row = st.get.get(key);
        if (!row) return null;
        if (st.itemCount.get(key).n) throw new RegistryError('the source has items; disable it instead (provenance must stay resolvable)', 'sources.has_items');
        st.del.run(key);
        return true;
    }

    return { get: (k) => st.get.get(k), all: () => st.all.all(), create, patch, remove, view, fromRow, health };
}

module.exports = { createRegistry, validateSource, RegistryError, TYPES, CATEGORIES };
