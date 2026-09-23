'use strict';
/**
 * Registry and fetch-run API (service tokens, one capability per route).
 *
 *   sources.source.read
 *     GET  /api/v1/sources                    every source with health and staleness
 *     GET  /api/v1/sources/:key
 *     GET  /api/v1/sources/:key/runs?before=&limit=   fetch runs, newest first
 *     GET  /api/v1/runs?state=&source=&after=&limit=  fetch runs across sources, oldest first
 *     GET  /api/v1/health                     status counts and every source that is not healthy
 *   sources.source.manage
 *     POST   /api/v1/sources                  create (disabled unless enabled: true + notes)
 *     PATCH  /api/v1/sources/:key             change fields (enable/disable too)
 *     DELETE /api/v1/sources/:key             only while it has no items
 *     POST   /api/v1/sources/:key/fetch       run now (409 while a run is in flight)
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { CAPS } = require('../auth');
const { RegistryError } = require('../registry');

const STATES = ['ok', 'not_modified', 'http_error', 'timeout', 'robots_denied', 'parse_error', 'rate_limited', 'disabled'];

function runView(r) {
    const iso = (v) => (v == null ? null : new Date(v).toISOString());
    return {
        id: r.id, source_key: r.source_key, endpoint_url: r.endpoint_url, trigger: r.trigger,
        started_at: iso(r.started_at), finished_at: iso(r.finished_at), state: r.state, http_status: r.http_status,
        error_code: r.error_code, detail: r.detail, bytes: r.bytes, raw_body_hash: r.raw_body_hash, parser_version: r.parser_version,
        items: { seen: r.items_seen, created: r.items_created, updated: r.items_updated, unchanged: r.items_unchanged, skipped: r.items_skipped },
        seq: r.rid,
    };
}

function sourcesRouter({ db, registry, ingest, auth }) {
    const router = express.Router();
    const read = auth.requireCap(CAPS.read);
    const manage = auth.requireCap(CAPS.manage);

    const fail = (res, req, err) => {
        if (err instanceof RegistryError) {
            const status = err.code === 'sources.exists' || err.code === 'sources.has_items' ? 409 : 422;
            return http.sendProblem(res, status, err.code, { detail: err.message, ctx: req.ov });
        }
        throw err;
    };
    const notFound = (res, req) => http.sendProblem(res, 404, 'sources.not_found', { detail: 'no such source', ctx: req.ov });

    router.get('/api/v1/sources', read, (req, res) => {
        res.json({ sources: registry.all().map(registry.view) });
    });

    router.get('/api/v1/sources/:key', read, (req, res) => {
        const row = registry.get(req.params.key);
        if (!row) return notFound(res, req);
        res.json({ source: registry.view(row) });
    });

    router.get('/api/v1/sources/:key/runs', read, (req, res) => {
        if (!registry.get(req.params.key)) return notFound(res, req);
        const before = /^\d{1,15}$/.test(String(req.query.before || '')) ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const rows = db.prepare('SELECT * FROM fetch_runs WHERE source_key = ? AND rid < ? ORDER BY rid DESC LIMIT ?').all(req.params.key, before, limit);
        res.json({ runs: rows.map(runView), next_before: rows.length === limit ? rows[rows.length - 1].rid : null });
    });

    router.get('/api/v1/runs', read, (req, res) => {
        const state = req.query.state ? String(req.query.state) : null;
        if (state && state !== 'failed' && !STATES.includes(state)) return http.sendProblem(res, 400, 'sources.bad_query', { detail: `state must be failed or one of ${STATES.join('|')}`, ctx: req.ov });
        const after = /^\d{1,15}$/.test(String(req.query.after || '')) ? Number(req.query.after) : 0;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const rows = db.prepare(`SELECT * FROM fetch_runs WHERE rid > @after AND (@source IS NULL OR source_key = @source)
            AND (@state IS NULL OR state = @state OR (@state = 'failed' AND state IN ('http_error','timeout','robots_denied','parse_error','rate_limited')))
            ORDER BY rid LIMIT @limit`).all({ after, source: req.query.source ? String(req.query.source) : null, state, limit });
        res.json({ runs: rows.map(runView), next_after: rows.length ? rows[rows.length - 1].rid : after });
    });

    router.get('/api/v1/health', read, (req, res) => {
        const views = registry.all().map(r => ({ key: r.key, category: r.category, type: r.type, ...registry.health(r) }));
        const counts = {};
        for (const v of views) counts[v.status] = (counts[v.status] || 0) + 1;
        res.json({ counts, attention: views.filter(v => ['failing', 'stale', 'never_fetched'].includes(v.status)) });
    });

    router.post('/api/v1/sources', manage, (req, res) => {
        try {
            const row = registry.create(req.body, req.principal.sub);
            res.status(201).json({ source: registry.view(row) });
        } catch (err) { fail(res, req, err); }
    });

    router.patch('/api/v1/sources/:key', manage, (req, res) => {
        try {
            const row = registry.patch(req.params.key, req.body, req.principal.sub);
            if (!row) return notFound(res, req);
            res.json({ source: registry.view(row) });
        } catch (err) { fail(res, req, err); }
    });

    router.delete('/api/v1/sources/:key', manage, (req, res) => {
        try {
            const ok = db.transaction(() => {
                const r = registry.remove(req.params.key);
                if (r) {
                    db.prepare('DELETE FROM fetch_runs WHERE source_key = ?').run(req.params.key);
                    db.prepare('DELETE FROM endpoint_state WHERE source_key = ?').run(req.params.key);
                }
                return r;
            })();
            if (!ok) return notFound(res, req);
            res.status(204).end();
        } catch (err) { fail(res, req, err); }
    });

    router.post('/api/v1/sources/:key/fetch', manage, async (req, res, next) => {
        try {
            const out = await ingest.run(req.params.key, { trigger: 'manual' });
            if (!out) return notFound(res, req);
            if (out.manual) return http.sendProblem(res, 409, 'sources.manual_source', { detail: 'a manual source is not fetched; add items with POST /api/v1/sources/:key/items', ctx: req.ov });
            if (out.busy) return http.sendProblem(res, 409, 'sources.fetch_in_flight', { detail: 'a run of this source is in flight', ctx: req.ov });
            res.json({ runs: out.runs.map(r => runView({ ...r, rid: null })) });
        } catch (err) { next(err); }
    });

    return router;
}

module.exports = { sourcesRouter, runView };
