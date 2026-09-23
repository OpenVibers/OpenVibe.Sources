'use strict';
/** Express app: request context, the v1 API, health/readiness. */
const express = require('express');
const { http } = require('openvibe-contracts');
const { sourcesRouter } = require('./api/sources');
const { itemsRouter } = require('./api/items');
const pkg = require('../package.json');

function createApp({ config, db, registry, items, ingest, scheduler, auth, keys, outbox, relay, now, log = console }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    app.use('/api', express.json({ limit: '256kb', type: ['application/json', 'application/*+json'] }));

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'openvibe-sources', version: pkg.version });
    });

    app.get('/api/ready', (_req, res) => {
        let dbOk = false;
        try { dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { dbOk = false; }
        const checks = { db: dbOk, key: keys.loaded(), worker: !config.worker.enabled || scheduler.running() };
        const ready = Object.values(checks).every(Boolean);
        let sources = null;
        if (dbOk) {
            sources = {};
            for (const r of registry.all()) {
                const s = registry.health(r).status;
                sources[s] = (sources[s] || 0) + 1;
            }
        }
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not_ready',
            checks,
            sources,
            runs_in_flight: ingest.inflight().length,
            outbox: dbOk ? { pending: outbox.pending(), rejected: outbox.rejected(), relay: config.events.url ? (relay.running() ? 'running' : 'stopped') : 'off (EVENTS_URL unset)' } : null,
        });
    });

    app.use(sourcesRouter({ db, registry, ingest, auth }));
    app.use(itemsRouter({ db, registry, items, auth, relay, now }));

    app.get('/', (_req, res) => {
        res.type('text/plain').send([
            'OpenVibe.Sources: the source registry and ingestion workers for the network\'s publication products.',
            'Every item carries its source, canonical URL, retrieval time, content hash and terms; a failed fetch is',
            'recorded as a failure and never replaced with invented content.',
            '',
            'GET  /api/v1/sources, /api/v1/sources/:key, /api/v1/sources/:key/runs, /api/v1/runs, /api/v1/health   (sources.source.read)',
            'GET  /api/v1/items?source=&category=&after=, /api/v1/items/:id                                          (sources.item.read)',
            'POST/PATCH/DELETE /api/v1/sources[/:key], POST /api/v1/sources/:key/fetch, /items, DELETE /api/v1/items/:id (sources.source.manage)',
            'GET  /api/health, /api/ready',
            '',
            'Source: https://github.com/OpenVibers/OpenVibe.Sources',
            '',
        ].join('\n'));
    });

    app.use((req, res) => http.sendProblem(res, 404, 'sources.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'sources.bad_json', { detail: 'request body is not valid JSON', ctx: req.ov });
        if (err.type === 'entity.too.large') return http.sendProblem(res, 413, 'sources.too_large', { detail: 'request body too large', ctx: req.ov });
        log.error(`[app] ${req.method} ${req.path}: ${err.stack || err}`);
        if (res.headersSent) return res.end();
        return http.sendProblem(res, 500, 'sources.internal', { detail: 'internal error', ctx: req.ov });
    });

    return app;
}

module.exports = { createApp };
