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
 * Some price lists key their records by id instead of listing them: Porkbun returns
 * `{ "pricing": { "com": {…}, "net": {…} } }` and AWS Lightsail keys its price list by SKU.
 * `"items_shape": "map"` reads such an object: each own property becomes one record, in sorted
 * key order, and the key is available as the virtual path `$key` (so `fields.identity: "$key"`
 * makes the id the identity). `"array"` (the default) is today's behaviour. A property whose value
 * is not an object is skipped; a non-object `items_path` is a parse error, never an empty success.
 */
const { parseXml, toText, toIsoDate, epochSecondsToIso, canonicalUrl, toId, ParseError } = require('./util');

const PARSER_VERSION = 'api@1';
const PATH_RE = /^[A-Za-z0-9_@:$-]+(\.[A-Za-z0-9_@:$-]+)*$/;

function at(obj, path) {
    if (!path) return obj;
    let cur = obj;
    for (const seg of path.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[seg];
    }
    return cur;
}

function scalar(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return Number.isFinite(v) || typeof v === 'boolean' ? v : null;
    if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 499)}…` : v;
    if (typeof v === 'object' && v['#text'] != null) return scalar(v['#text']);
    return null;
}

/** `$key` is the map key: only as a whole path, and only when items_shape is "map". */
function keyPathViolation(p, shape) {
    if (!p.includes('$key')) return null;
    if (p !== '$key') return 'a $key path is exactly "$key"';
    if (shape !== 'map') return '$key requires items_shape "map"';
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
    if (ep.item_kind !== undefined && !/^[a-z][a-z0-9_]{1,39}$/.test(ep.item_kind)) return 'item_kind is malformed';
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
    const items = [];
    let skipped = 0;
    const seen = new Set();
    for (const { key, value: rec } of records) {
        if (items.length >= maxItems || !rec || typeof rec !== 'object' || (shape === 'map' && Array.isArray(rec))) { skipped++; continue; }
        const get = (p) => (shape === 'map' && p === '$key' ? key : at(rec, p));
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
    return { items, skipped, meta: { format } };
}

module.exports = { parse, PARSER_VERSION, checkMapping };
