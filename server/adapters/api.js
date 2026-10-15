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
 * An endpoint may carry `where`: an object of up to 10 `path -> expected` conditions whose paths
 * follow the same rules (relative, `$key`, `$root.`, `*`). Expected is a string, number or boolean
 * (compared to the value after `scalar()`), or an array of up to 20 such values (any of them
 * matches). A record that fails any condition is left out before `maxItems` is counted and
 * reported as `meta.filtered`, not `skipped`:
 *
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
 * `max_bytes` (an integer from 1 KiB to 32 MiB) raises or lowers the body cap for one endpoint
 * (SOURCES_MAX_BYTES otherwise); OVHcloud's VPS catalog is about 12 MB.
 *
 * `request_content_type` ("application/json" only) is sent as the GET's Content-Type (the request has no body): Open
 * Collective's public GraphQL API answers a GET only with it, as its CSRF guard.
 *
 * Some price lists key their records by id instead of listing them: Porkbun returns
 * `{ "pricing": { "com": {…}, "net": {…} } }` and AWS Lightsail keys its price list by SKU.
 * `"items_shape": "map"` reads such an object: each own property becomes one record, in sorted
 * key order, and the key is available as the virtual path `$key` (so `fields.identity: "$key"`
 * makes the id the identity) or as `{$key}` inside a `$root.` path. `"array"` (the default) is
 * today's behaviour. A property whose value is not an object is skipped; a non-object
 * `items_path` is a parse error, never an empty success.
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
    if (hasBare) return 'a $key path is exactly "$key"';
    return null;
}

/** Validate an endpoint mapping (registry side). Returns an error string or null. */
function checkMapping(ep) {
    if (!['json', 'xml'].includes(ep.format || 'json')) return 'format must be json or xml';
    const shape = ep.items_shape || 'array';
    if (!['array', 'map'].includes(shape)) return 'items_shape must be array or map';
    if (ep.items_path !== undefined && ep.items_path !== '' && !PATH_RE.test(ep.items_path)) return 'items_path is malformed';
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
    const where = ep.where == null ? {} : ep.where;
    if (typeof where !== 'object' || Array.isArray(where)) return 'where must be an object of path -> expected';
    if (Object.keys(where).length > 10) return 'at most 10 where conditions';
    for (const [p, expected] of Object.entries(where)) {
        if (!PATH_RE.test(p)) return `where.${p} path is malformed`;
        const kerr = keyPathViolation(p, shape);
        if (kerr) return `where.${p}: ${kerr}`;
        if (isPattern(expected)) {
            if (Object.keys(expected).length !== 1 || typeof expected.pattern !== 'string' || !expected.pattern || expected.pattern.length > 200) return `where.${p}: a pattern is { "pattern": "<at most 200 characters>" }`;
            try { new RegExp(expected.pattern); } catch { return `where.${p}: the pattern is not a valid regular expression`; }
            continue;
        }
        const wanted = Array.isArray(expected) ? expected : [expected];
        if (wanted.length > 20) return `where.${p} has at most 20 expected values`;
        for (const v of wanted) {
            if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return `where.${p} expectations must be strings, numbers or booleans`;
        }
    }
    if (ep.item_kind !== undefined && !/^[a-z][a-z0-9_]{1,39}$/.test(ep.item_kind)) return 'item_kind is malformed';
    if (ep.max_bytes !== undefined && (!Number.isInteger(ep.max_bytes) || ep.max_bytes < 1024 || ep.max_bytes > 32 * 1024 * 1024)) return 'max_bytes is an integer from 1024 to 33554432';
    if (ep.request_content_type !== undefined && ep.request_content_type !== 'application/json') return 'request_content_type may only be application/json';
    return null;
}

function parse(text, { url, endpoint = {}, summaryMax = 1000, maxItems = 500 } = {}) {
    const format = endpoint.format || 'json';
    let body;
    if (format === 'xml') body = parseXml(text);
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
        records = node.map((value) => ({ key: undefined, value }));
    }
    const f = endpoint.fields || {};
    const where = endpoint.where && typeof endpoint.where === 'object' && !Array.isArray(endpoint.where) ? endpoint.where : {};
    const filterKeys = Object.keys(where);
    const items = [];
    let skipped = 0;
    let filtered = 0;
    const seen = new Set();
    for (const { key, value: rec } of records) {
        if (!rec || typeof rec !== 'object' || (shape === 'map' && Array.isArray(rec))) { skipped++; continue; }
        if (filterKeys.length && !matchesWhere(body, rec, key, where)) { filtered++; continue; }
        if (items.length >= maxItems) { skipped++; continue; }
        const get = (p) => getField(body, rec, key, p);
        const link = f.url ? canonicalUrl(scalar(get(f.url)), url) : null;
        const identity = (f.identity ? toId(scalar(get(f.identity))) : null) || link;
        if (!identity || seen.has(identity)) { skipped++; continue; }
        seen.add(identity);
        const extra = {};
        for (const [k, p] of Object.entries(endpoint.extra || {})) extra[k] = scalar(get(p));
        items.push({
            identity: String(identity),
            kind: endpoint.item_kind || 'record',
            canonical_url: link,
            title: f.title ? toText(scalar(get(f.title)), 500) : null,
            summary: f.summary ? toText(scalar(get(f.summary)), summaryMax) : null,
            authors: f.author ? [toText(scalar(get(f.author)), 200)].filter(Boolean) : [],
            published_at: f.published_at ? toIsoDate(scalar(get(f.published_at))) : f.published_at_epoch ? epochSecondsToIso(scalar(get(f.published_at_epoch))) : null,
            updated_at: f.updated_at ? toIsoDate(scalar(get(f.updated_at))) : f.updated_at_epoch ? epochSecondsToIso(scalar(get(f.updated_at_epoch))) : null,
            fields: extra,
        });
    }
    return { items, skipped, meta: { format, filtered } };
}

module.exports = { parse, PARSER_VERSION, checkMapping };
