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

/** Validate an endpoint mapping (registry side). Returns an error string or null. */
function checkMapping(ep) {
    if (!['json', 'xml'].includes(ep.format || 'json')) return 'format must be json or xml';
    if (ep.items_path !== undefined && ep.items_path !== '' && !PATH_RE.test(ep.items_path)) return 'items_path is malformed';
    const fields = ep.fields || {};
    if (!fields.identity && !fields.url) return 'fields.identity or fields.url is required';
    for (const [k, p] of Object.entries(fields)) {
        if (!['identity', 'url', 'title', 'summary', 'author', 'published_at', 'published_at_epoch', 'updated_at', 'updated_at_epoch'].includes(k)) return `unknown field ${k}`;
        if (typeof p !== 'string' || !PATH_RE.test(p)) return `fields.${k} path is malformed`;
    }
    const extra = ep.extra || {};
    if (Object.keys(extra).length > 30) return 'at most 30 extra fields';
    for (const [k, p] of Object.entries(extra)) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || typeof p !== 'string' || !PATH_RE.test(p)) return `extra.${k} is malformed`;
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
    const list = at(body, endpoint.items_path || '');
    if (!Array.isArray(list)) throw new ParseError(`items_path "${endpoint.items_path || ''}" is not an array in the response`);
    const f = endpoint.fields || {};
    const items = [];
    let skipped = 0;
    const seen = new Set();
    for (const rec of list) {
        if (items.length >= maxItems || !rec || typeof rec !== 'object') { skipped++; continue; }
        const link = f.url ? canonicalUrl(scalar(at(rec, f.url)), url) : null;
        const identity = (f.identity ? toId(scalar(at(rec, f.identity))) : null) || link;
        if (!identity || seen.has(identity)) { skipped++; continue; }
        seen.add(identity);
        const extra = {};
        for (const [k, p] of Object.entries(endpoint.extra || {})) extra[k] = scalar(at(rec, p));
        items.push({
            identity: String(identity),
            kind: endpoint.item_kind || 'record',
            canonical_url: link,
            title: f.title ? toText(scalar(at(rec, f.title)), 500) : null,
            summary: f.summary ? toText(scalar(at(rec, f.summary)), summaryMax) : null,
            authors: f.author ? [toText(scalar(at(rec, f.author)), 200)].filter(Boolean) : [],
            published_at: f.published_at ? toIsoDate(scalar(at(rec, f.published_at))) : f.published_at_epoch ? epochSecondsToIso(scalar(at(rec, f.published_at_epoch))) : null,
            updated_at: f.updated_at ? toIsoDate(scalar(at(rec, f.updated_at))) : f.updated_at_epoch ? epochSecondsToIso(scalar(at(rec, f.updated_at_epoch))) : null,
            fields: extra,
        });
    }
    return { items, skipped, meta: { format } };
}

module.exports = { parse, PARSER_VERSION, checkMapping };
