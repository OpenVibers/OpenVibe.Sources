'use strict';
// Track O: GET /metrics answers direct loopback callers only, labels requests by route template and
// carries the Sources gauges (sources by status, items, the fetch queue, last fetch); /api/ready is
// 503 when the database fails, and a fetcher that is off, stopped or behind degrades it.
const assert = require('assert');
const nodeHttp = require('http');
const { boot, request, serviceToken, site, sourceDef, rss, suite } = require('./helpers');
const { OVERDUE_MS } = require('../server/observability');

const t = suite('observability');
const ADMIN = serviceToken('network', ['sources.source.manage']);
const READER = serviceToken('news', ['sources.source.read', 'sources.item.read']);
let svc;
let web;

function get(base, p, headers = {}) {
    return new Promise((resolve, reject) => nodeHttp.get(base + p, { headers }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject));
}

t('boot (worker off) and fetch one feed of three items by hand', async () => {
    svc = await boot();
    await svc.keyLoaded;
    web = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/feed.xml': () => ({ body: rss([1, 2, 3].map(i => ({ guid: `g${i}`, title: `Item ${i}`, link: `https://example.org/${i}` }))) }),
    });
    const c = await request(svc.base, 'POST', '/api/v1/sources', { token: ADMIN, body: sourceDef({ key: 'feed-obs', endpoints: [`${web.origin}/feed.xml`] }) });
    assert.strictEqual(c.status, 201, c.text);
    const f = await request(svc.base, 'POST', '/api/v1/sources/feed-obs/fetch', { token: ADMIN });
    assert.deepStrictEqual(f.body.runs.map(r => [r.state, r.items.created]), [['ok', 3]]);
});

t('/api/ready: db is the only required check; a worker that is off degrades it (still 200)', async () => {
    const r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.ready, true);
    assert.strictEqual(r.body.status, 'degraded');
    assert.strictEqual(r.body.service, 'sources');
    assert.deepStrictEqual(Object.keys(r.body.checks), ['db', 'network_jwks', 'fetcher']);
    assert.deepStrictEqual(r.body.degraded, ['fetcher']);
    for (const [name, c] of Object.entries(r.body.checks)) {
        assert.strictEqual(c.required, name === 'db', name);
        assert.strictEqual(typeof c.latency_ms, 'number');
        assert.ok(Date.parse(c.checked_at));
    }
    assert.match(r.body.checks.fetcher.error, /SOURCES_WORKER=off/);
    assert.ok(Date.parse(r.body.checks.fetcher.detail.last_fetch_at));
    assert.deepStrictEqual(r.body.sources, { healthy: 1 });
});

t('/metrics: 404 through a proxy; route templates and Sources gauges direct', async () => {
    await request(svc.base, 'GET', '/api/v1/sources/feed-obs', { token: READER });
    for (const hdr of [{ 'X-Forwarded-For': '203.0.113.7' }, { 'X-Real-IP': '203.0.113.7' }, { 'CF-Connecting-IP': '203.0.113.7' }]) {
        const m = await get(svc.base, '/metrics', hdr);
        assert.strictEqual(m.status, 404, JSON.stringify(hdr));
        assert.ok(!m.body.includes('sources_items'));
    }
    const m = await get(svc.base, '/metrics');
    assert.strictEqual(m.status, 200);
    const text = m.body;
    assert.ok(/http_requests_total\{method="POST",route="\/api\/v1\/sources\/:key\/fetch",status_class="2xx"\} 1\n/.test(text), 'route template');
    assert.ok(/http_requests_total\{method="GET",route="\/api\/v1\/sources\/:key",status_class="2xx"\} 1\n/.test(text));
    assert.ok(!/route="[^"]*feed-obs/.test(text), 'no source key in any label');
    assert.ok(/\nprocess_resident_memory_bytes \d+\n/.test(text));
    assert.ok(/release_info\{service="sources",release="[^"]+"\} 1\n/.test(text));
    assert.ok(/sources_sources\{status="healthy"\} 1\n/.test(text));
    assert.ok(/sources_sources\{status="failing"\} 0\n/.test(text));
    assert.ok(/sources_items\{state="current"\} 3\n/.test(text));
    assert.ok(/sources_items\{state="removed"\} 0\n/.test(text));
    assert.ok(/\nsources_fetch_due 0\n/.test(text));
    assert.ok(/\nsources_fetch_in_flight 0\n/.test(text));
    const last = text.match(/\nsources_last_fetch_timestamp_seconds ([\d.]+)\n/);
    assert.ok(last && Math.abs(Number(last[1]) - Date.now() / 1000) < 60, 'last fetch time in Unix seconds');
    assert.ok(/\nsources_last_success_timestamp_seconds [\d.]+\n/.test(text));
    assert.ok(/\nsources_outbox_pending \d+\n/.test(text));
});

t('a broken database makes the service unready (503); /metrics still answers', async () => {
    svc.db.close();
    const r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 503, r.text);
    assert.strictEqual(r.body.ready, false);
    assert.ok(r.body.failed.includes('db'), r.text);
    assert.strictEqual(r.body.sources, null);
    const m = await get(svc.base, '/metrics');
    assert.strictEqual(m.status, 200);
    assert.ok(!/sources_items\{/.test(m.body), 'a gauge that cannot be read is left out, not invented');
    try { await svc.stop(); } catch { /* the database is already closed */ }
});

t('worker on: ready; a fetch queue that falls behind, or a stopped worker, degrades it', async () => {
    const clock = { offset: 0 };
    // No run slot, so nothing due is ever started; the clock moves forward by hand.
    svc = await boot({ worker: 'on', env: { SOURCES_MAX_CONCURRENT: '0' }, now: () => Date.now() + clock.offset });
    let r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.body.status, 'ready', r.text);
    assert.strictEqual(r.body.checks.fetcher.detail.running, true);
    await request(svc.base, 'POST', '/api/v1/sources', { token: ADMIN, body: sourceDef({ key: 'feed-late', endpoints: [`${web.origin}/feed.xml`] }) });
    r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.body.status, 'ready', 'a source that just became due is not late');
    assert.strictEqual(r.body.checks.fetcher.detail.due, 1);

    clock.offset = OVERDUE_MS + 60_000;
    r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.degraded, ['fetcher']);
    assert.match(r.body.checks.fetcher.error, /the fetch queue is behind: 1 source\(s\) due, the oldest for 16 min/);
    const text = (await get(svc.base, '/metrics')).body;
    assert.ok(/\nsources_fetch_due 1\n/.test(text));
    const wait = Number(text.match(/\nsources_fetch_oldest_wait_seconds ([\d.]+)\n/)[1]);
    assert.ok(wait >= OVERDUE_MS / 1000, String(wait));

    clock.offset = 0;
    await svc.scheduler.stop();
    r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.degraded, ['fetcher']);
    assert.strictEqual(r.body.checks.fetcher.error, 'the ingestion worker is not running');
    await svc.stop();
    await web.close();
});

t.run();
