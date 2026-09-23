'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the Sources gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real query on the source registry: without it nothing is served or fetched
 *   network_jwks  optional  the Network signing key has loaded. Without it no service token can be
 *                           verified (the API answers 503), but the fetcher keeps ingesting, so it
 *                           degrades rather than fails
 *   fetcher       optional  the ingestion worker is on and running, and its queue keeps up: no enabled
 *                           source has waited longer than OVERDUE_MS. Without it the API still
 *                           serves what was fetched, but nothing new arrives
 *
 * Gauges: sources by health status, items (current and removed), the queue (due sources, runs in
 * flight), the time of the last finished fetch and of the last successful one, and the outbox backlog.
 */
const { createReadiness } = require('openvibe-shared/ready');

const OVERDUE_MS = 15 * 60 * 1000;
const STATUSES = ['healthy', 'stale', 'failing', 'never_fetched', 'disabled', 'manual'];

function readers(db, { startedAt }) {
    // A source waits from when it became due, when it was last changed (a new or re-enabled source
    // is due at once, from next_due_at 0) or when this process started, whichever is latest.
    const due = db.prepare(`SELECT COUNT(*) AS n, MIN(MAX(next_due_at, not_before, updated_at)) AS oldest FROM sources
        WHERE enabled = 1 AND type != 'manual' AND next_due_at <= @now AND not_before <= @now`);
    const lastRun = db.prepare('SELECT finished_at FROM fetch_runs ORDER BY rid DESC LIMIT 1');
    const lastSuccess = db.prepare('SELECT MAX(last_success_at) AS t FROM sources');
    const items = db.prepare('SELECT COUNT(*) AS n, COUNT(removed_at) AS removed FROM items');
    return {
        /** Enabled fetched sources whose turn has come, and how long the oldest has waited. */
        queue(t) {
            const r = due.get({ now: t });
            return { due: r.n, oldest_wait_ms: r.n ? Math.max(0, t - Math.max(r.oldest, startedAt)) : 0 };
        },
        lastFetchAt: () => { const r = lastRun.get(); return r ? r.finished_at : null; },
        lastSuccessAt: () => lastSuccess.get().t,
        items: () => { const r = items.get(); return { current: r.n - r.removed, removed: r.removed }; },
    };
}

function createSourcesReadiness({ db, keys, config, registry, ingest, scheduler, outbox, relay, now, release = null }) {
    const read = readers(db, { startedAt: now() });
    const iso = (v) => (v == null ? null : new Date(v).toISOString());
    return createReadiness({
        service: 'sources',
        release,
        checks: [
            { name: 'db', required: true, check: () => { db.prepare('SELECT COUNT(*) AS n FROM sources').get(); return true; } },
            { name: 'network_jwks', required: false, check: () => keys.loaded() || 'Network signing key not loaded yet: no service token can be verified' },
            {
                name: 'fetcher', required: false,
                check: () => {
                    const q = read.queue(now());
                    const detail = {
                        enabled: config.worker.enabled, running: scheduler.running(), in_flight: ingest.inflight().length,
                        max_concurrent: config.worker.maxConcurrent, due: q.due, oldest_wait_ms: q.oldest_wait_ms,
                        last_fetch_at: iso(read.lastFetchAt()),
                    };
                    if (!config.worker.enabled) return { ok: false, error: 'the ingestion worker is off (SOURCES_WORKER=off): nothing is fetched', detail };
                    if (!scheduler.running()) return { ok: false, error: 'the ingestion worker is not running', detail };
                    if (q.oldest_wait_ms > OVERDUE_MS) return { ok: false, error: `the fetch queue is behind: ${q.due} source(s) due, the oldest for ${Math.round(q.oldest_wait_ms / 60000)} min`, detail };
                    return { ok: true, detail };
                },
            },
        ],
        details: (body) => {
            const dbOk = body.checks.db.status === 'ok';
            let sources = null;
            if (dbOk) {
                sources = {};
                for (const r of registry.all()) {
                    const s = registry.health(r).status;
                    sources[s] = (sources[s] || 0) + 1;
                }
            }
            return {
                sources,
                runs_in_flight: ingest.inflight().length,
                outbox: dbOk ? { pending: outbox.pending(), rejected: outbox.rejected(), relay: config.events.url ? (relay.running() ? 'running' : 'stopped') : 'off (EVENTS_URL unset)' } : null,
            };
        },
    });
}

/** Sources gauges on the openvibe-shared/metrics registry. */
function registerSourcesGauges(registry, { db, sources, ingest, outbox, now }) {
    const read = readers(db, { startedAt: now() });
    const seconds = (ms) => (ms == null ? null : ms / 1000);
    registry.gauge({
        name: 'sources_sources', help: 'Registered sources by health status', labelNames: ['status'],
        collect: () => {
            const n = Object.fromEntries(STATUSES.map((s) => [s, 0]));
            for (const r of sources.all()) { const s = sources.health(r).status; n[s] = (n[s] || 0) + 1; }
            return Object.entries(n).map(([status, value]) => ({ labels: { status }, value }));
        },
    });
    registry.gauge({
        name: 'sources_items', help: 'Items held, current and removed', labelNames: ['state'],
        collect: () => Object.entries(read.items()).map(([state, value]) => ({ labels: { state }, value })),
    });
    registry.gauge({ name: 'sources_fetch_due', help: 'Enabled sources whose next fetch is due now (the fetch queue)', collect: () => read.queue(now()).due });
    registry.gauge({ name: 'sources_fetch_oldest_wait_seconds', help: 'How long the longest-waiting due source has waited', collect: () => read.queue(now()).oldest_wait_ms / 1000 });
    registry.gauge({ name: 'sources_fetch_in_flight', help: 'Fetch runs in progress', collect: () => ingest.inflight().length });
    // Left out until there is a fetch: a timestamp of 0 would read as "1970", not "never".
    registry.gauge({ name: 'sources_last_fetch_timestamp_seconds', help: 'When the last fetch run finished (any outcome), Unix seconds', collect: () => seconds(read.lastFetchAt()) });
    registry.gauge({ name: 'sources_last_success_timestamp_seconds', help: 'When a source was last fetched successfully, Unix seconds', collect: () => seconds(read.lastSuccessAt()) });
    registry.gauge({ name: 'sources_outbox_pending', help: 'Events waiting in the outbox', collect: () => outbox.pending() });
}

module.exports = { createSourcesReadiness, registerSourcesGauges, OVERDUE_MS };
