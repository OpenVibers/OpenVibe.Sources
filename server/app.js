'use strict';
/** Express app: request context, the v1 API, health/readiness, metrics. */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { createSourcesReadiness, registerSourcesGauges } = require('./observability');
const { sourcesRouter } = require('./api/sources');
const { itemsRouter } = require('./api/items');
const pkg = require('../package.json');

function createApp({ config, db, registry, items, ingest, scheduler, auth, keys, outbox, relay, now, log = console }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    const release = createRelease({ service: 'sources', root: path.join(__dirname, '..') });
    // HTTP golden signals by route template, process metrics, release_info and the Sources gauges;
    // GET /metrics answers direct loopback callers only (Track O).
    const metrics = instrument(app, { service: 'sources', release: release.release });
    registerSourcesGauges(metrics.registry, { db, sources: registry, ingest, outbox, now });
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

    // Readiness (openvibe-shared/ready): 503 only when the database fails; the Network key and the
    // fetcher (worker running, queue keeping up) are optional and degrade it (see observability.js).
    const readiness = createSourcesReadiness({ db, keys, config, registry, ingest, scheduler, outbox, relay, now, release: release.release });
    app.get('/api/ready', readiness.handler);
    app.get('/release.json', release.handler);

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
            'GET  /api/health, /api/ready, /release.json',
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

    app.locals.metrics = metrics;
    return app;
}

module.exports = { createApp };
