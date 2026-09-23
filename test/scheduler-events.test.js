'use strict';
/** The in-process scheduler, failure backoff, and the outbox relay to OpenVibe.Events. */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { boot, site, sourceDef, rss, sleep, suite } = require('./helpers');

const t = suite('scheduler-events');
const FEED = rss([{ guid: 's1', title: 'Scheduled', link: 'https://example.org/s1' }]);

async function waitFor(fn, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
    throw new Error('timed out waiting');
}

t('due, enabled sources are fetched on schedule; disabled and manual ones never are', async () => {
    let status = 200;
    const s = await site({ '/robots.txt': () => ({ status: 404 }), '/f': () => (status === 200 ? { body: FEED } : { status }) });
    const svc = await boot({ worker: 'on' });
    try {
        svc.registry.create(sourceDef({ key: 'sched', endpoints: [`${s.origin}/f`], poll_interval_sec: 3600 }), 'test');
        svc.registry.create(sourceDef({ key: 'off', endpoints: [`${s.origin}/f`], enabled: false }), 'test');
        svc.registry.create({ key: 'hand', name: 'Manual', type: 'manual', category: 'coupons', terms_note: 'x', enabled: true }, 'test');
        await waitFor(() => svc.db.prepare("SELECT 1 FROM fetch_runs WHERE source_key = 'sched'").get());
        const row = svc.registry.get('sched');
        assert.strictEqual(row.last_state, 'ok');
        assert.ok(row.next_due_at - Date.now() > 3500 * 1000, 'next poll one interval later');
        await sleep(200);
        assert.strictEqual(svc.db.prepare("SELECT COUNT(*) AS n FROM fetch_runs WHERE source_key IN ('off', 'hand')").get().n, 0);
        assert.strictEqual(svc.db.prepare("SELECT COUNT(*) AS n FROM fetch_runs WHERE source_key = 'sched'").get().n, 1, 'not refetched before it is due');

        // a failing source backs off exponentially
        status = 500;
        svc.db.prepare("UPDATE sources SET next_due_at = 0, last_request_at = NULL WHERE key = 'sched'").run();
        await waitFor(() => svc.registry.get('sched').consecutive_failures === 1);
        const f1 = svc.registry.get('sched').next_due_at - svc.registry.get('sched').last_run_at;
        svc.db.prepare("UPDATE sources SET next_due_at = 0, last_request_at = NULL WHERE key = 'sched'").run();
        await waitFor(() => svc.registry.get('sched').consecutive_failures === 2);
        const f2 = svc.registry.get('sched').next_due_at - svc.registry.get('sched').last_run_at;
        assert.strictEqual(f1, 3600 * 1000);
        assert.strictEqual(f2, 2 * 3600 * 1000);

        // not_before (Retry-After) holds the scheduler back
        svc.db.prepare("UPDATE sources SET next_due_at = 0, not_before = ?, last_request_at = NULL WHERE key = 'sched'").run(Date.now() + 60000);
        const n = s.hits('/f').length;
        await sleep(300);
        assert.strictEqual(s.hits('/f').length, n);
    } finally { await svc.stop(); await s.close(); }
});

t('events are valid envelopes and reach OpenVibe.Events through the relay', async () => {
    const received = [];
    const events = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            received.push(...(body.events || [body]));
            res.statusCode = 201;
            res.end('{}');
        });
    });
    await new Promise(r => events.listen(0, '127.0.0.1', r));
    const s = await site({ '/robots.txt': () => ({ status: 404 }), '/f': () => ({ body: FEED }), '/bad': () => ({ status: 502 }) });
    const tokenClient = { async authHeaders() { return { Authorization: 'Bearer relay' }; }, invalidate() {} };
    const svc = await boot({ env: { EVENTS_URL: `http://127.0.0.1:${events.address().port}` }, tokenClient });
    try {
        svc.registry.create(sourceDef({ key: 'ev', endpoints: [`${s.origin}/f`, `${s.origin}/bad`] }), 'test');
        await svc.ingest.run('ev', { trigger: 'manual' });
        for (let i = 0; i < 5 && svc.outbox.pending(); i++) await svc.relay.flush();
        assert.strictEqual(svc.outbox.pending(), 0);
        assert.deepStrictEqual(received.map(e => e.event_type).sort(), ['sources.fetch.failed', 'sources.item.created']);
        for (const e of received) {
            const v = validate('events.event-envelope@1', e);
            assert.ok(v.valid, JSON.stringify(v.errors));
            assert.strictEqual(e.source, 'sources');
            assert.strictEqual(e.visibility, 'internal');
        }
        const failed = received.find(e => e.event_type === 'sources.fetch.failed');
        assert.deepStrictEqual([failed.payload.state, failed.payload.http_status, failed.payload.error_code], ['http_error', 502, 'http_502']);
    } finally { await svc.stop(); await s.close(); await new Promise(r => events.close(() => r())); }
});

t.run();
