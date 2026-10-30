'use strict';
/**
 * Official APIs (JSON or XML) described by a mapping in the source registry — no code per
 * provider. Each endpoint says where the records are and which field is which:
 *
 *   { "url": "https://…", "format": "json", "item_kind": "offer", "items_path": "deals",
 *     "fields": { "identity": "dealID", "url": "link", "title": "title", "summary": "…",
 *                 "author": "…", "published_at": "…", "published_at_epoch": "releaseDate",
 *                 "updated_at": "…", "updated_at_epoch": "lastChange" },
 *     "extra": { "sale_price": "salePrice", "normal_price": "normalPrice", "store_id": "storeID" } }
 *
 * Paths are dot-separated keys (array indexes allowed); `items_path` "" means the body itself is
 * the array. `extra` values are copied as the API gave them (scalars only, strings capped):
 * a missing field is null, never a default. A record without an identity is skipped.
 *
 * `extra_lists` maps a field to a list the API gives (tags, job types): an array of scalars is kept
 * as up to 20 of them (a lone scalar is a list of one, a missing one an empty list). It is separate
 * from `extra` so a mapping that points `extra` at an array keeps reading null, as it always did.
 *
 * A path segment `*` steps into the single child of an object: when the current value is a
 * non-array object with exactly one own property it steps into that property, and otherwise the
 * path resolves to undefined (so the field is null). It may appear anywhere in a path.
 *
 * A path starting with `$root.` is resolved from the parsed response body rather than the record,
 * so a record can reach a value kept elsewhere in the same response. Inside such a path a segment
 * written `{$key}` is the record's map key (only valid when `items_shape` is "map", and only
 * inside `$root.`). Example — join an AWS Lightsail SKU to its price:
 *
 *   "extra": { "price_hourly": "$root.terms.OnDemand.{$key}.*.priceDimensions.*.pricePerUnit.USD" }
 *
 * An endpoint may carry `where` (or its alias `filter`): an object of up to 10 `path -> expected`
 * conditions whose paths follow the same rules (relative, `$key`, `$root.`, `*`). Expected is a
 * string, number or boolean (compared to the value after `scalar()`), or an array of up to 20 such
 * values (any of them matches). A record that fails any condition is left out before `maxItems` is
 * counted and reported as `meta.filtered`, not `skipped`. `filter` is the name the BLS CPI rent
 * seed uses; both are applied when both are given:
 *
 *   "filter": { "series_id": "CUUR0000SEHA" }
 *   "where": { "productFamily": "Lightsail Instance", "attributes.operatingSystem": "Linux" }
 *
 * A key may carry a selector, `key[field=value,…]` (one to four conditions): `key` must be an array, and
 * the path steps into its first element whose fields equal every value (compared as text after
 * `scalar()`, so `interval=1` matches the number 1). A value is literal text (letters, digits, spaces,
 * `_ : @ + -`) or `$rec.<path>`, a plain dotted path read from the record itself. No match, a missing
 * value or a non-array is undefined (the field is null). OVHcloud's catalog lists plans and their
 * hardware separately and keeps every price variant in one array:
 *
 *   "extra": { "vcpu": "$root.products[name=$rec.product].blobs.technical.cpu.cores",
 *              "price": "pricings[mode=default,commitment=0,intervalUnit=month].price" }
 *
 * A `where` expectation may also be `{ "pattern": "<regular expression>" }` (at most 200 characters):
 * the value must be text the expression matches, e.g. `{ "planCode": { "pattern": "^vps-[0-9]{4}-model[0-9]+$" } }`.
 *
 * `max_bytes` (an integer from 1 KiB to 64 MiB) raises or lowers the body cap for one endpoint
 * (SOURCES_MAX_BYTES otherwise); OVHcloud's VPS catalog is about 12 MB.
 *
 * `timeout_ms` (an integer from 1 s to 120 s) gives one endpoint its own deadline (SOURCES_FETCH_TIMEOUT_MS otherwise):
 * NYC Open Data computes the HPD per-building tally in 12 to 60 seconds.
 *
 * `request_content_type` ("application/json" only) is sent as the GET's Content-Type (the request has no body): Open
 * Collective's public GraphQL API answers a GET only with it, as its CSRF guard.
 *
 * Some price lists key their records by id instead of listing them: Porkbun returns
 * `{ "pricing": { "com": {…}, "net": {…} } }` and AWS Lightsail keys its price list by SKU.
 * `"items_shape": "map"` reads such an object: each own property becomes one record, in sorted
 * key order, and the key is available as the virtual path `$key` (so `fields.identity: "$key"`
 * makes the id the identity) or as `{$key}` inside a `$root.` path. `"array"` (the default) is
 * today's behaviour, and there the record's 0-based position in the array is the virtual path `$index` (a ranked
 * list's order, e.g. Steam's top sellers). A property whose value is not an object is skipped; a non-object
 * `items_path` is a parse error, never an empty success.
 *
 * `"format": "tsv"` reads a tab-separated file whose first line names the columns: each further line is one record,
 * its values trimmed text keyed by those names, and the body is that array (so `items_path` is ""). The Bureau of
 * Labor Statistics publishes its series this way (download.bls.gov/pub/time.series/…: series_id, year, period,
 * value). A line with a different number of values than the header is skipped; a file without a header is a parse
 * error.
 *
 * Two records with the same identity keep the first (`"duplicates": "first"`, the default). `"duplicates": "last"`
 * keeps the last instead, in the first one's place: a file that lists each series oldest to newest then yields its
 * newest value.
 */
const { parseXml, toText, toIsoDate, epochSecondsToIso, canonicalUrl, toId, ParseError } = require('./util');

const PARSER_VERSION = 'api@1';
// A segment is `*` (the single child of an object), `{$key}` (the map key, only inside `$root.`),
// or an ordinary key. PATH_RE is syntax only; keyPathViolation enforces where each token may sit.
// A selector condition is `field=value`, the value literal text or `$rec.` and a plain dotted path.
const SEL_COND = '[A-Za-z0-9_]+=(?:\\$rec(?:\\.[A-Za-z0-9_]+)+|[A-Za-z0-9_ :@+-]+)';
const SELECTOR = `\\[${SEL_COND}(?:,${SEL_COND}){0,3}\\]`;
const PATH_SEG = `(?:\\*|\\{\\$key\\}|[A-Za-z0-9_@:$-]+(?:${SELECTOR})?)`;
const PATH_RE = new RegExp(`^${PATH_SEG}(?:\\.${PATH_SEG})*$`);

/** A path's segments: dots split it, except inside a selector (whose `$rec.` values have dots of their own). */
const SPLIT = new Map();
function splitPath(path) {
    let segs = SPLIT.get(path);
    if (segs) return segs;
    segs = [];
    let depth = 0;
    let cur = '';
    for (const ch of path) {
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        if (ch === '.' && depth === 0) { segs.push(cur); cur = ''; } else cur += ch;
    }
    segs.push(cur);
    if (SPLIT.size < 1000) SPLIT.set(path, segs);
    return segs;
}

/** `key[a=b,c=$rec.d]` → { name, conds: [[field, value]] }, or null for a plain segment. */
function selectorOf(seg) {
    const m = /^([^[]+)\[(.+)\]$/.exec(seg);
    if (!m) return null;
    return { name: m[1], conds: m[2].split(',').map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]) };
}

/**
 * Walk a dot path: `*` steps into an object's single own property, `{$key}` uses the map key, and
 * `key[field=value,…]` steps into the first element of the array `key` whose fields match.
 */
function walk(obj, path, key, rec) {
    let cur = obj;
    for (const seg of splitPath(path)) {
        if (cur == null || typeof cur !== 'object') return undefined;
        if (seg === '*') {
            if (Array.isArray(cur)) return undefined;
            const own = Object.keys(cur);
            if (own.length !== 1) return undefined;
            cur = cur[own[0]];
        } else if (seg === '{$key}') {
            if (key === undefined) return undefined;
            cur = cur[key];
        } else {
            const sel = selectorOf(seg);
            if (!sel) { cur = cur[seg]; continue; }
            const list = cur[sel.name];
            if (!Array.isArray(list)) return undefined;
            const wanted = sel.conds.map(([f, v]) => [f, v.startsWith('$rec.') ? scalar(walk(rec, v.slice('$rec.'.length), key, rec)) : v]);
            if (wanted.some(([, v]) => v == null)) return undefined;
            cur = list.find((el) => el && typeof el === 'object' && wanted.every(([f, v]) => {
                const a = scalar(el[f]);
                return a != null && String(a) === String(v);
            }));
        }
    }
    return cur;
}

/** A record's value: `$key` is its map key, `$root.…` resolves from the body, else the record. */
function getField(body, rec, key, p) {
    if (!p) return rec;
    if (p === '$key') return key;
    if (p.startsWith('$root.')) return walk(body, p.slice('$root.'.length), key, rec);
    return walk(rec, p, key, rec);
}

function at(obj, path) {
    if (!path) return obj;
    return walk(obj, path, undefined);
}

/** A list the API gives → up to 20 of its scalars (a lone scalar → a list of one; nothing → []). */
function scalars(v) {
    const all = Array.isArray(v) ? v : v == null ? [] : [v];
    const out = [];
    for (const x of all) {
        const s = scalar(x);
        if (s != null && s !== '') out.push(s);
        if (out.length >= 20) break;
    }
    return out;
}

function scalar(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return Number.isFinite(v) || typeof v === 'boolean' ? v : null;
    if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 499)}…` : v;
    if (typeof v === 'object' && v['#text'] != null) return scalar(v['#text']);
    return null;
}

const PATTERNS = new Map();
function patternOf(source) {
    let re = PATTERNS.get(source);
    if (!re) { re = new RegExp(source); if (PATTERNS.size < 100) PATTERNS.set(source, re); }
    return re;
}
const isPattern = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && 'pattern' in v;

/** Does one record satisfy every `where` condition? Values compare after scalar(); a pattern tests text. */
function matchesWhere(body, rec, key, where) {
    for (const [p, expected] of Object.entries(where)) {
        const actual = scalar(getField(body, rec, key, p));
        if (isPattern(expected)) {
            if (typeof actual !== 'string' || !patternOf(expected.pattern).test(actual)) return false;
            continue;
        }
        const wanted = Array.isArray(expected) ? expected : [expected];
        if (!wanted.some((w) => w === actual)) return false;
    }
    return true;
}

/**
 * `$key` is the map key: as a whole relative path only when items_shape is "map", or as the
 * segment `{$key}` inside a `$root.` path. `$root` must be followed by a path.
 */
function keyPathViolation(p, shape) {
    const segs = splitPath(p);
    const hasBare = segs.includes('$key');
    const hasBrace = segs.includes('{$key}');
    if (p === '$root' || p.startsWith('$root.')) {
        if (p === '$root') return '$root must be followed by a path';
        if (hasBare) return 'inside a $root. path, use "{$key}" for the record key';
        if (hasBrace && shape !== 'map') return '{$key} requires items_shape "map"';
        return null;
    }
    if (hasBrace) return '{$key} is only valid inside a $root. path';
    if (p === '$key') return shape === 'map' ? null : '$key requires items_shape "map"';
    if (p === '$index') return shape === 'map' ? '$index requires items_shape "array"' : null;
    if (segs.includes('$index')) return 'an $index path is exactly "$index"';
    if (hasBare) return 'a $key path is exactly "$key"';
    return null;
}

/** The `where` / `filter` conditions: path -> expected value(s) or { pattern }. */
function checkConditions(where, label, shape) {
    if (typeof where !== 'object' || Array.isArray(where)) return `${label} must be an object of path -> expected`;
    if (Object.keys(where).length > 10) return `at most 10 ${label} conditions`;
    for (const [p, expected] of Object.entries(where)) {
        if (!PATH_RE.test(p)) return `${label}.${p} path is malformed`;
        const kerr = keyPathViolation(p, shape);
        if (kerr) return `${label}.${p}: ${kerr}`;
        if (isPattern(expected)) {
            if (Object.keys(expected).length !== 1 || typeof expected.pattern !== 'string' || !expected.pattern || expected.pattern.length > 200) return `${label}.${p}: a pattern is { "pattern": "<at most 200 characters>" }`;
            try { new RegExp(expected.pattern); } catch { return `${label}.${p}: the pattern is not a valid regular expression`; }
            continue;
        }
        const wanted = Array.isArray(expected) ? expected : [expected];
        if (wanted.length > 20) return `${label}.${p} has at most 20 expected values`;
        for (const v of wanted) {
            if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return `${label}.${p} expectations must be strings, numbers or booleans`;
        }
    }
    return null;
}

/** Validate an endpoint mapping (registry side). `bulk` is the streaming dataset download's own schema. */
function checkMapping(ep, { bulk = false } = {}) {
    const formats = bulk ? ['csv', 'jsonl', 'tsv'] : ['json', 'xml', 'tsv'];
    if (!formats.includes(ep.format || (bulk ? 'csv' : 'json'))) return bulk ? 'format must be csv, jsonl or tsv' : 'format must be json, xml or tsv';
    if (['tsv', 'csv', 'jsonl'].includes(ep.format) && ep.items_path) return `a ${ep.format} body is the array itself: items_path is ""`;
    if (!bulk && ep.duplicates !== undefined && !['first', 'last'].includes(ep.duplicates)) return 'duplicates must be first or last';
    const shape = ep.items_shape || 'array';
    if (!bulk && !['array', 'map'].includes(shape)) return 'items_shape must be array or map';
    if (!bulk && ep.items_path !== undefined && ep.items_path !== '' && !PATH_RE.test(ep.items_path)) return 'items_path is malformed';
    const fields = ep.fields || {};
    if (!fields.identity && !fields.url) return 'fields.identity or fields.url is required';
    for (const [k, p] of Object.entries(fields)) {
        if (!['identity', 'url', 'title', 'summary', 'author', 'published_at', 'published_at_epoch', 'updated_at', 'updated_at_epoch'].includes(k)) return `unknown field ${k}`;
        if (typeof p !== 'string' || !PATH_RE.test(p)) return `fields.${k} path is malformed`;
        const kerr = keyPathViolation(p, shape);
        if (kerr) return `fields.${k}: ${kerr}`;
    }
    const extra = ep.extra || {};
    if (Object.keys(extra).length > 30) return 'at most 30 extra fields';
    for (const [k, p] of Object.entries(extra)) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || typeof p !== 'string' || !PATH_RE.test(p)) return `extra.${k} is malformed`;
        const kerr = keyPathViolation(p, shape);
        if (kerr) return `extra.${k}: ${kerr}`;
    }
    const lists = ep.extra_lists == null ? {} : ep.extra_lists;
    if (typeof lists !== 'object' || Array.isArray(lists)) return 'extra_lists must be an object of field -> path';
    if (Object.keys(lists).length > 10) return 'at most 10 extra_lists fields';
    for (const [k, p] of Object.entries(lists)) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || typeof p !== 'string' || !PATH_RE.test(p)) return `extra_lists.${k} is malformed`;
        if (Object.prototype.hasOwnProperty.call(extra, k)) return `extra_lists.${k} is also an extra field`;
        const kerr = keyPathViolation(p, shape);
        if (kerr) return `extra_lists.${k}: ${kerr}`;
    }
    for (const label of ['where', 'filter']) {
        if (ep[label] == null) continue;
        const err = checkConditions(ep[label], label, shape);
        if (err) return err;
    }
    if (ep.item_kind !== undefined && !/^[a-z][a-z0-9_]{1,39}$/.test(ep.item_kind)) return 'item_kind is malformed';
    if (ep.max_bytes !== undefined && (!Number.isInteger(ep.max_bytes) || ep.max_bytes < 1024 || ep.max_bytes > (bulk ? 16 * 1024 * 1024 * 1024 : 64 * 1024 * 1024))) {
        return bulk ? 'max_bytes is an integer from 1024 to 17179869184' : 'max_bytes is an integer from 1024 to 67108864';
    }
    if (ep.max_rows !== undefined && (!bulk || !Number.isInteger(ep.max_rows) || ep.max_rows < 1 || ep.max_rows > 5000000)) return 'max_rows is an integer from 1 to 5000000';
    if (ep.timeout_ms !== undefined && (!Number.isInteger(ep.timeout_ms) || ep.timeout_ms < 1000 || ep.timeout_ms > 120000)) return 'timeout_ms is an integer from 1000 to 120000';
    if (!bulk && ep.request_content_type !== undefined && ep.request_content_type !== 'application/json') return 'request_content_type may only be application/json';
    return null;
}


/** A tab-separated body as records keyed by its header line's names (values trimmed); malformed lines are counted. */
function parseTsv(text) {
    const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) throw new ParseError('tsv body has no header line');
    const names = lines[0].split('\t').map((s) => s.trim());
    if (names.some((n) => !n) || new Set(names).size !== names.length) throw new ParseError('tsv header names must be present and distinct');
    const records = [];
    let bad = 0;
    for (const line of lines.slice(1)) {
        const values = line.split('\t');
        if (values.length !== names.length) { bad++; continue; }
        const rec = {};
        names.forEach((n, i) => { rec[n] = values[i].trim(); });
        records.push(rec);
    }
    return { records, bad };
}

/** One record → the item every api-shaped adapter stores, or null when it states no identity. */
function mapRecord(body, rec, key, index, endpoint, url, summaryMax = 1000) {
    const f = endpoint.fields || {};
    const get = (p) => (p === '$index' ? index : getField(body, rec, key, p));
    const link = f.url ? canonicalUrl(scalar(get(f.url)), url) : null;
    const identity = (f.identity ? toId(scalar(get(f.identity))) : null) || link;
    if (!identity) return null;
    const extra = {};
    for (const [k, p] of Object.entries(endpoint.extra || {})) extra[k] = scalar(get(p));
    for (const [k, p] of Object.entries(endpoint.extra_lists || {})) extra[k] = scalars(get(p));
    return {
        identity: String(identity),
        kind: endpoint.item_kind || 'record',
        canonical_url: link,
        title: f.title ? toText(scalar(get(f.title)), 500) : null,
        summary: f.summary ? toText(scalar(get(f.summary)), summaryMax) : null,
        authors: f.author ? [toText(scalar(get(f.author)), 200)].filter(Boolean) : [],
        published_at: f.published_at ? toIsoDate(scalar(get(f.published_at))) : f.published_at_epoch ? epochSecondsToIso(scalar(get(f.published_at_epoch))) : null,
        updated_at: f.updated_at ? toIsoDate(scalar(get(f.updated_at))) : f.updated_at_epoch ? epochSecondsToIso(scalar(get(f.updated_at_epoch))) : null,
        fields: extra,
    };
}

function parse(text, { url, endpoint = {}, summaryMax = 1000, maxItems = 500 } = {}) {
    const format = endpoint.format || 'json';
    let body;
    let malformed = 0;
    if (format === 'xml') body = parseXml(text);
    else if (format === 'tsv') ({ records: body, bad: malformed } = parseTsv(text));
    else {
        try { body = JSON.parse(text); } catch { throw new ParseError('body is not valid JSON'); }
    }
    const shape = endpoint.items_shape || 'array';
    const itemsPath = endpoint.items_path || '';
    const node = at(body, itemsPath);
    let records;
    if (shape === 'map') {
        if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ParseError(`items_path "${itemsPath}" is not an object in the response`);
        records = Object.keys(node).sort().map((key) => ({ key, value: node[key] }));
    } else {
        if (!Array.isArray(node)) throw new ParseError(`items_path "${itemsPath}" is not an array in the response`);
        records = node.map((value, index) => ({ key: undefined, index, value }));
    }
    const conditions = [];
    for (const label of ['filter', 'where']) {
        const c = endpoint[label];
        if (c && typeof c === 'object' && !Array.isArray(c)) conditions.push(c);
    }
    const items = [];
    let skipped = malformed;
    let filtered = 0;
    const seen = new Map();   // identity → its index in items
    const keepLast = endpoint.duplicates === 'last';
    for (const { key, index, value: rec } of records) {
        if (!rec || typeof rec !== 'object' || (shape === 'map' && Array.isArray(rec))) { skipped++; continue; }
        if (conditions.length && !conditions.every((c) => matchesWhere(body, rec, key, c))) { filtered++; continue; }
        const item = mapRecord(body, rec, key, index, endpoint, url, summaryMax);
        const again = item && seen.has(item.identity);
        if (!item || (again && !keepLast)) { skipped++; continue; }
        if (!again && items.length >= maxItems) { skipped++; continue; }
        if (again) skipped++;   // the earlier record it replaces
        if (again) items[seen.get(item.identity)] = item;
        else { seen.set(item.identity, items.length); items.push(item); }
    }
    return { items, skipped, meta: { format, filtered } };
}

module.exports = { parse, mapRecord, PARSER_VERSION, checkMapping };
