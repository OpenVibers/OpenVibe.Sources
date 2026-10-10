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
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); }
    throw new Error('timed out waiting');
}

t('due, enabled sources are fetched on schedule; disabled and manual ones never are', async () => {
    let status = 200;
    const s = await site({ '/robots.txt': () => ({ status: 404 }), '/f': () => (status === 200 ? { body: FEED } : { status }) });
    const svc = await boot({ worker: 'on' });
    try {
        await svc.registry.create(sourceDef({ key: 'sched', endpoints: [`${s.origin}/f`], poll_interval_sec: 3600 }), 'test');
        await svc.registry.create(sourceDef({ key: 'off', endpoints: [`${s.origin}/f`], enabled: false }), 'test');
        await svc.registry.create({ key: 'hand', name: 'Manual', type: 'manual', category: 'coupons', terms_note: 'x', enabled: true }, 'test');
        // The run row commits with the items; the source's outcome is recorded right after it.
        await waitFor(async () => (await svc.db.prepare("SELECT 1 FROM fetch_runs WHERE source_key = 'sched'").get()) && (await svc.registry.get('sched')).last_state);
        const row = await svc.registry.get('sched');
        assert.strictEqual(row.last_state, 'ok');
        assert.ok(row.next_due_at - Date.now() > 3500 * 1000, 'next poll one interval later');
        await sleep(200);
        assert.strictEqual((await svc.db.prepare("SELECT COUNT(*) AS n FROM fetch_runs WHERE source_key IN ('off', 'hand')").get()).n, 0);
        assert.strictEqual((await svc.db.prepare("SELECT COUNT(*) AS n FROM fetch_runs WHERE source_key = 'sched'").get()).n, 1, 'not refetched before it is due');

        // a failing source backs off exponentially
        status = 500;
        await svc.db.prepare("UPDATE sources SET next_due_at = 0, last_request_at = NULL WHERE key = 'sched'").run();
        await waitFor(async () => (await svc.registry.get('sched')).consecutive_failures === 1);
        const f1 = (await svc.registry.get('sched')).next_due_at - (await svc.registry.get('sched')).last_run_at;
        await svc.db.prepare("UPDATE sources SET next_due_at = 0, last_request_at = NULL WHERE key = 'sched'").run();
        await waitFor(async () => (await svc.registry.get('sched')).consecutive_failures === 2);
        const f2 = (await svc.registry.get('sched')).next_due_at - (await svc.registry.get('sched')).last_run_at;
        assert.strictEqual(f1, 3600 * 1000);
        assert.strictEqual(f2, 2 * 3600 * 1000);

        // not_before (Retry-After) holds the scheduler back
        await svc.db.prepare("UPDATE sources SET next_due_at = 0, not_before = ?, last_request_at = NULL WHERE key = 'sched'").run(Date.now() + 60000);
        const n = s.hits('/f').length;
        await sleep(300);
        assert.strictEqual(s.hits('/f').length, n);
    } finally { await svc.stop(); await s.close(); }
});

t('events are valid envelopes and reach OpenVibe.Events through the relay', async () => {
    const received = [];
    const tokenRequests = [];
    const events = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            if (req.url === '/oauth/token') {
                tokenRequests.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ access_token: 'relay', token_type: 'Bearer', expires_in: 300 }));
                return;
            }
            assert.strictEqual(req.headers.authorization, 'Bearer relay');
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const sent = body.events || [body];
            received.push(...sent);
            res.statusCode = 201;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body.events ? { results: sent.map((e, i) => ({ event_id: e.event_id, seq: i + 1 })) } : { event_id: sent[0].event_id, seq: 1 }));
        });
    });
    await new Promise(r => events.listen(0, '127.0.0.1', r));
    const s = await site({ '/robots.txt': () => ({ status: 404 }), '/f': () => ({ body: FEED }), '/bad': () => ({ status: 502 }) });
    const svc = await boot({ env: { EVENTS_URL: `http://127.0.0.1:${events.address().port}`, OV_NETWORK_INTERNAL_URL: `http://127.0.0.1:${events.address().port}`, OV_OAUTH_CLIENT_SECRET: 'test-secret' } });
    try {
        await svc.registry.create(sourceDef({ key: 'ev', endpoints: [`${s.origin}/f`, `${s.origin}/bad`] }), 'test');
        await svc.ingest.run('ev', { trigger: 'manual' });
        for (let i = 0; i < 5 && (await svc.outbox.status()).pending; i++) await svc.outbox.outbox.flush();
        assert.strictEqual((await svc.outbox.status()).pending, 0);
        assert.ok(tokenRequests.some(r => r.audience === 'openvibe.events' && r.scope === 'events.event.publish' && r.client_secret === 'test-secret'));
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
