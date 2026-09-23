'use strict';
/**
 * Items API (service tokens).
 *
 *   sources.item.read
 *     GET /api/v1/items?source=&category=&after=<change_seq>&limit=&include_removed=1
 *         items in change order (created, updated, removed); resume from next_after. Each page
 *         carries the staleness of every source it contains, so a consumer never mistakes an old
 *         observation for a current one.
 *     GET /api/v1/items/:id?revisions=1
 *   sources.source.manage
 *     POST   /api/v1/sources/:key/items   add or revise an item of a `manual` source (evidence URL required)
 *     DELETE /api/v1/items/:id            { reason } — takedown/licence removal, sticky
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { CAPS } = require('../auth');
const { CATEGORIES } = require('../registry');
const { MANUAL_VERSION } = require('../adapters');
const { toText, toIsoDate, canonicalUrl, toId } = require('../adapters/util');

function manualItem(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
    const url = canonicalUrl(body.url);
    if (!url) return { error: 'url (the evidence: where this was published) must be an http(s) URL' };
    const title = toText(body.title, 500);
    if (!title) return { error: 'title is required' };
    const kind = body.kind === undefined ? 'record' : body.kind;
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(String(kind))) return { error: 'kind is malformed' };
    if (body.published_at != null && !toIsoDate(body.published_at)) return { error: 'published_at must be a date the source states' };
    const fields = body.fields == null ? {} : body.fields;
    if (typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 30) return { error: 'fields must be an object of at most 30 scalars' };
    for (const [k, v] of Object.entries(fields)) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return { error: `fields.${k} is malformed` };
        if (!(v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 500))) return { error: `fields.${k} must be a scalar` };
    }
    const identity = body.identity == null ? url : toId(body.identity);
    if (!identity) return { error: 'identity is malformed' };
    return {
        item: {
            identity, kind, canonical_url: url, title, summary: toText(body.summary, 1000),
            authors: Array.isArray(body.authors) ? body.authors.map(a => toText(a, 200)).filter(Boolean).slice(0, 20) : [],
            published_at: body.published_at == null ? null : toIsoDate(body.published_at),
            updated_at: body.updated_at == null ? null : toIsoDate(body.updated_at),
            fields,
        },
    };
}

function itemsRouter({ db, registry, items, auth, relay, now }) {
    const router = express.Router();
    const read = auth.requireCap(CAPS.items);
    const manage = auth.requireCap(CAPS.manage);

    router.get('/api/v1/items', read, (req, res) => {
        const source = req.query.source ? String(req.query.source) : null;
        const category = req.query.category ? String(req.query.category) : null;
        if (category && !CATEGORIES.includes(category)) return http.sendProblem(res, 400, 'sources.bad_query', { detail: `category must be one of ${CATEGORIES.join('|')}`, ctx: req.ov });
        const after = /^\d{1,15}$/.test(String(req.query.after || '')) ? Number(req.query.after) : 0;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const page = items.list({ source, category, after, limit, includeRemoved: req.query.include_removed === '1' });
        const keys = [...new Set(page.items.map(i => i.source_key))];
        const sources = {};
        for (const k of keys) {
            const row = registry.get(k);
            if (row) {
                const h = registry.health(row);
                sources[k] = { status: h.status, stale: h.stale, last_success_at: h.last_success_at };
            }
        }
        res.json({ ...page, sources });
    });

    router.get('/api/v1/items/:id', read, (req, res) => {
        const item = items.get(String(req.params.id), { revisions: req.query.revisions === '1' });
        if (!item) return http.sendProblem(res, 404, 'sources.not_found', { detail: 'no such item', ctx: req.ov });
        const row = registry.get(item.source_key);
        const h = row ? registry.health(row) : null;
        res.json({ item, source: h ? { key: item.source_key, status: h.status, stale: h.stale, last_success_at: h.last_success_at } : null });
    });

    router.post('/api/v1/sources/:key/items', manage, (req, res) => {
        const row = registry.get(req.params.key);
        if (!row) return http.sendProblem(res, 404, 'sources.not_found', { detail: 'no such source', ctx: req.ov });
        if (row.type !== 'manual') return http.sendProblem(res, 409, 'sources.not_manual', { detail: 'items of fetched sources come from their fetches only', ctx: req.ov });
        const source = registry.fromRow(row);
        if (!source.enabled) return http.sendProblem(res, 409, 'sources.disabled', { detail: 'the source is disabled', ctx: req.ov });
        const m = manualItem(req.body);
        if (m.error) return http.sendProblem(res, 422, 'sources.bad_item', { detail: m.error, ctx: req.ov });
        const t = now();
        const counts = db.transaction(() => items.ingest(source, [m.item], { runId: null, rawBodyHash: null, parserVersion: MANUAL_VERSION, retrievedAt: t, enteredBy: req.principal.sub }))();
        db.prepare('UPDATE sources SET last_success_at = ?, last_run_at = ? WHERE key = ?').run(t, t, source.key);
        if (relay) relay.flush().catch(() => {});
        const saved = db.prepare('SELECT id FROM items WHERE source_key = ? AND identity = ?').get(source.key, m.item.identity);
        const outcome = counts.created ? 'created' : counts.updated ? 'updated' : counts.skipped ? 'removed' : 'unchanged';
        res.status(counts.created ? 201 : 200).json({ outcome, item: items.get(saved.id) });
    });

    router.delete('/api/v1/items/:id', manage, (req, res) => {
        const reason = toText(req.body && req.body.reason, 300);
        if (!reason) return http.sendProblem(res, 422, 'sources.reason_required', { detail: 'a removal needs a reason (takedown, licence, error…)', ctx: req.ov });
        const found = items.get(String(req.params.id));
        if (!found) return http.sendProblem(res, 404, 'sources.not_found', { detail: 'no such item', ctx: req.ov });
        const source = registry.fromRow(registry.get(found.source_key));
        const item = items.remove(source, found.id, reason, req.principal.sub);
        if (relay) relay.flush().catch(() => {});
        res.json({ item });
    });

    return router;
}

module.exports = { itemsRouter, manualItem };
