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

const TEXT_INDEX = [
    'OpenVibe.Sources: the source registry and ingestion workers for the network\'s publication products.',
    'Every item carries its source, canonical URL, retrieval time, content hash and terms; a failed fetch is',
    'recorded as a failure and never replaced with invented content.',
    '',
    'This is an internal service. Its API is for OpenVibe services on the production host (service tokens);',
    'sources.openvibe.network answers only this page, /api/health, /api/ready and /release.json.',
    '',
    'GET  /api/v1/sources, /api/v1/sources/:key, /api/v1/sources/:key/runs, /api/v1/runs, /api/v1/health   (sources.source.read)',
    'GET  /api/v1/items?source=&category=&after=, /api/v1/items/:id                                          (sources.item.read)',
    'POST/PATCH/DELETE /api/v1/sources[/:key], POST /api/v1/sources/:key/fetch, /items, DELETE /api/v1/items/:id (sources.source.manage)',
    'GET  /api/health, /api/ready, /release.json',
    '',
    'Source: https://github.com/OpenVibers/OpenVibe.Sources',
    '',
].join('\n');

const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>OpenVibe.Sources</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #5c5c66; --accent: #2456d6; }
@media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #e8e8ec; --muted: #a0a0ab; --accent: #7aa2ff; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 1.4rem; margin: 0 0 12px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: .9rem; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>OpenVibe.Sources</h1>
<p>This is an internal service of the OpenVibe network, not a website. It keeps the list of outside sources
(feeds, sitemaps, APIs) the network's publication products may read, fetches them politely, and records
where every item came from, when it was fetched and under which terms. A failed fetch is recorded as a
failure, never replaced with invented content.</p>
<p>There is nothing to browse here. What reaches readers is published by the products themselves, under
their own rules.</p>
<p class="muted">Health: <a href="/api/health">/api/health</a> · Readiness: <a href="/api/ready">/api/ready</a> ·
Source code: <a href="https://github.com/OpenVibers/OpenVibe.Sources">OpenVibers/OpenVibe.Sources</a></p>
</main>
</body>
</html>
`;

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
    // GET /release.json (ADR-016) and POST /release-metrics (open tabs' update reports into /metrics).
    release.mount(app, { registry: metrics.registry });

    app.use(sourcesRouter({ db, registry, ingest, auth }));
    app.use(itemsRouter({ db, registry, items, auth, relay, now }));

    // The public host (sources.openvibe.network) shows only this page, health, readiness and
    // /release.json: Sources is internal. Browsers get a short honest HTML page, other clients the
    // text route index. Never cached, never indexed.
    app.get('/', (req, res) => {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Vary', 'Accept');
        if (/\btext\/html\b/.test(String(req.get('accept') || ''))) {
            res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
            return res.type('html').send(HOME_HTML);
        }
        return res.type('text/plain').send(TEXT_INDEX);
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
