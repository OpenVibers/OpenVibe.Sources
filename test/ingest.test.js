'use strict';
/**
 * Ingestion against stub sites: explicit run states, conditional GET, failure never fabricates or
 * modifies items, staleness, rate limits, one run in flight, credentials by variable name.
 */
const assert = require('assert');
const { boot, site, sourceDef, rss, fixture, sleep, suite } = require('./helpers');

const t = suite('ingest');
let svc;
let web;
let feedBody;
let feedStatus;
let feedEtag;

const FEED_V1 = rss([
    { guid: 'a-1', title: 'Alpha', link: 'https://news.example.org/a', date: 'Mon, 21 Sep 2026 10:00:00 +0000', description: 'first' },
    { guid: 'b-1', title: 'Beta', link: 'https://news.example.org/b' },
]);

function create(def) {
    svc.registry.create(def, 'test');
    return def.key;
}
const run = (key, trigger = 'manual') => svc.ingest.run(key, { trigger });
const itemsOf = (key) => svc.db.prepare('SELECT * FROM items WHERE source_key = ? ORDER BY identity').all(key);
const runsOf = (key) => svc.db.prepare('SELECT * FROM fetch_runs WHERE source_key = ? ORDER BY rid').all(key);
const events = (type) => svc.outbox.all().filter(e => e.event_type === type);
const reset = (key) => svc.db.prepare('UPDATE sources SET last_request_at = NULL, not_before = 0 WHERE key = ?').run(key);

t('boot', async () => {
    svc = await boot();
    feedBody = FEED_V1;
    feedStatus = 200;
    feedEtag = '"v1"';
    web = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nDisallow: /private/\n\nUser-agent: OpenVibeSources\nDisallow: /blocked-for-us\nAllow: /\n' }),
        '/feed.xml': (req) => {
            if (feedStatus !== 200) return { status: feedStatus, body: 'nope' };
            if (feedEtag && req.headers['if-none-match'] === feedEtag) return { status: 304 };
            return { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: feedEtag }, body: feedBody };
        },
    });
});

t('a good fetch creates items with full provenance and an ok run', async () => {
    const key = create(sourceDef({ key: 'news-a', endpoints: [`${web.origin}/feed.xml`], license_note: 'headlines only', terms_note: 'fixture terms' }));
    const out = await run(key);
    assert.deepStrictEqual(out.runs.map(r => r.state), ['ok']);
    const items = itemsOf(key);
    assert.strictEqual(items.length, 2);
    const a = items[0];
    assert.strictEqual(a.identity, 'a-1');
    assert.strictEqual(a.canonical_url, 'https://news.example.org/a');
    assert.strictEqual(a.revision, 1);
    assert.match(a.content_hash, /^[0-9a-f]{64}$/);
    assert.match(a.raw_body_hash, /^[0-9a-f]{64}$/);
    assert.strictEqual(a.parser_version, 'feed@1');
    assert.strictEqual(a.license_note, 'headlines only');
    assert.strictEqual(a.terms_note, 'fixture terms');
    assert.ok(a.retrieved_at > 0 && a.first_seen_at === a.retrieved_at);
    assert.strictEqual(a.published_at, '2026-09-21T10:00:00.000Z');
    assert.strictEqual(items[1].published_at, null);
    const [r] = runsOf(key);
    assert.deepStrictEqual([r.state, r.http_status, r.items_created, r.items_seen], ['ok', 200, 2, 2]);
    assert.strictEqual(r.raw_body_hash, a.raw_body_hash);
    assert.strictEqual(events('sources.item.created').filter(e => e.payload.source_key === key).length, 2);
    // the fetcher identified itself and asked robots.txt first
    const feedReq = web.hits('/feed.xml')[0];
    assert.match(feedReq.headers['user-agent'], /^OpenVibeSources\//);
    assert.ok(web.hits('/robots.txt')[0].at <= feedReq.at);
});

t('conditional GET: the stored ETag is sent and a 304 is not_modified with nothing changed', async () => {
    reset('news-a');
    const before = itemsOf('news-a');
    const out = await run('news-a');
    assert.deepStrictEqual(out.runs.map(r => r.state), ['not_modified']);
    const last = web.hits('/feed.xml').at(-1);
    assert.strictEqual(last.headers['if-none-match'], '"v1"');
    assert.deepStrictEqual(itemsOf('news-a').map(i => [i.revision, i.content_hash, i.retrieved_at]), before.map(i => [i.revision, i.content_hash, i.retrieved_at]));
});

t('Last-Modified is used when there is no ETag', async () => {
    const lm = 'Mon, 21 Sep 2026 10:00:00 GMT';
    const s = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/f': (req) => (req.headers['if-modified-since'] === lm ? { status: 304 } : { headers: { 'Last-Modified': lm }, body: FEED_V1 }),
    });
    try {
        const key = create(sourceDef({ endpoints: [`${s.origin}/f`] }));
        assert.strictEqual((await run(key)).runs[0].state, 'ok');
        reset(key);
        assert.strictEqual((await run(key)).runs[0].state, 'not_modified');
    } finally { await s.close(); }
});

t('a changed item is a new revision; the old one stays in item_revisions', async () => {
    reset('news-a');
    feedEtag = '"v2"';
    feedBody = rss([
        { guid: 'a-1', title: 'Alpha (corrected)', link: 'https://news.example.org/a', date: 'Mon, 21 Sep 2026 10:00:00 +0000', description: 'first, corrected' },
        { guid: 'b-1', title: 'Beta', link: 'https://news.example.org/b' },
    ]);
    const out = await run('news-a');
    assert.strictEqual(out.runs[0].state, 'ok');
    assert.deepStrictEqual([out.runs[0].items_updated, out.runs[0].items_unchanged], [1, 1]);
    const a = itemsOf('news-a')[0];
    assert.strictEqual(a.revision, 2);
    assert.strictEqual(a.title, 'Alpha (corrected)');
    const revs = svc.db.prepare('SELECT revision, snapshot FROM item_revisions WHERE item_id = ? ORDER BY revision').all(a.id);
    assert.deepStrictEqual(revs.map(r => [r.revision, JSON.parse(r.snapshot).title]), [[1, 'Alpha'], [2, 'Alpha (corrected)']]);
    const upd = events('sources.item.updated').find(e => e.payload.item_id === a.id);
    assert.ok(upd && upd.payload.previous_content_hash && upd.payload.revision === 2);
});

t('failure never fabricates: http errors, timeouts, parse errors and oversize bodies leave items exactly as they were', async () => {
    const snapshot = () => JSON.stringify(itemsOf('news-a'));
    const before = snapshot();
    const count = svc.db.prepare('SELECT COUNT(*) AS n FROM items').get().n;

    feedStatus = 500;
    reset('news-a');
    let out = await run('news-a');
    assert.deepStrictEqual([out.runs[0].state, out.runs[0].http_status, out.runs[0].error_code], ['http_error', 500, 'http_500']);

    feedStatus = 200;
    feedEtag = '"v3"';
    feedBody = '<rss><channel><item><title>Broken';
    reset('news-a');
    out = await run('news-a');
    assert.strictEqual(out.runs[0].state, 'parse_error');
    assert.match(out.runs[0].raw_body_hash, /^[0-9a-f]{64}$/, 'the unreadable body is identified by its hash');

    feedBody = '<html><body>Service temporarily replaced by a login page</body></html>';
    reset('news-a');
    out = await run('news-a');
    assert.strictEqual(out.runs[0].state, 'parse_error');

    assert.strictEqual(snapshot(), before, 'no item created, changed, re-dated or re-hashed');
    assert.strictEqual(svc.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, count);

    // after a failed parse the validator was not stored: the next good body is fetched in full
    feedBody = FEED_V1;
    reset('news-a');
    out = await run('news-a');
    assert.strictEqual(out.runs[0].state, 'ok');
    assert.notStrictEqual(web.hits('/feed.xml').at(-1).headers['if-none-match'], '"v3"');

    const failed = events('sources.fetch.failed').filter(e => e.payload.source_key === 'news-a');
    assert.deepStrictEqual(failed.map(e => e.payload.state), ['http_error', 'parse_error', 'parse_error']);
    assert.deepStrictEqual(failed.map(e => e.payload.consecutive_failures), [1, 2, 3]);
    assert.strictEqual(svc.registry.get('news-a').consecutive_failures, 0, 'reset by the good run');
});

t('timeouts and oversize bodies are explicit states', async () => {
    const s = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/slow': () => ({ delayMs: 3000, body: FEED_V1 }),
        '/huge': () => ({ body: 'x'.repeat(4096) }),
    });
    try {
        const key = create(sourceDef({ endpoints: [`${s.origin}/slow`] }));
        const out = await run(key);
        assert.deepStrictEqual([out.runs[0].state, out.runs[0].error_code], ['timeout', 'timeout']);
        assert.strictEqual(itemsOf(key).length, 0);

        const small = await boot({ env: { SOURCES_MAX_BYTES: '1024' } });
        try {
            small.registry.create(sourceDef({ key: 'huge', endpoints: [`${s.origin}/huge`] }), 'test');
            const r = await small.ingest.run('huge', { trigger: 'manual' });
            assert.deepStrictEqual([r.runs[0].state, r.runs[0].error_code], ['http_error', 'too_large']);
        } finally { await small.stop(); }
    } finally { await s.close(); }
});

t('staleness is computed from the last success and exposed in health', async () => {
    const key = create(sourceDef({ endpoints: [`${web.origin}/feed.xml`], stale_after_sec: 1 }));
    let h = svc.registry.health(svc.registry.get(key));
    assert.deepStrictEqual([h.status, h.stale], ['never_fetched', true]);
    feedEtag = null;
    await run(key);
    h = svc.registry.health(svc.registry.get(key));
    assert.deepStrictEqual([h.status, h.stale], ['healthy', false]);
    await sleep(1100);
    h = svc.registry.health(svc.registry.get(key));
    assert.deepStrictEqual([h.status, h.stale], ['stale', true]);
    feedStatus = 503;
    reset(key);
    await run(key);
    h = svc.registry.health(svc.registry.get(key));
    assert.deepStrictEqual([h.status, h.stale, h.consecutive_failures], ['failing', true, 1]);
    feedStatus = 200;
});

t('rate limit: requests to a source are spaced by min_interval_ms; an early trigger is rate_limited without a request', async () => {
    const s = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/one': () => ({ body: FEED_V1 }),
        '/two': () => ({ body: FEED_V1 }),
    });
    try {
        const key = create(sourceDef({ endpoints: [`${s.origin}/one`, `${s.origin}/two`], min_interval_ms: 400 }));
        const out = await run(key);
        assert.deepStrictEqual(out.runs.map(r => r.state), ['ok', 'ok']);
        const gap = s.hits('/two')[0].at - s.hits('/one')[0].at;
        assert.ok(gap >= 380, `requests ${gap} ms apart`);
        const again = await run(key);
        assert.deepStrictEqual([again.runs[0].state, again.runs[0].error_code], ['rate_limited', 'local_rate_limit']);
        assert.strictEqual(s.hits('/one').length, 1, 'nothing was requested');
        assert.ok(!events('sources.fetch.failed').some(e => e.payload.source_key === key), 'our own limiter is not a source failure');
    } finally { await s.close(); }
});

t('a 429 is rate_limited, stops the run and honours Retry-After', async () => {
    const s = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/a': () => ({ status: 429, headers: { 'Retry-After': '120' } }),
        '/b': () => ({ body: FEED_V1 }),
    });
    try {
        const key = create(sourceDef({ endpoints: [`${s.origin}/a`, `${s.origin}/b`] }));
        const out = await run(key);
        assert.deepStrictEqual(out.runs.map(r => [r.state, r.error_code]), [['rate_limited', 'upstream_429']]);
        assert.strictEqual(s.hits('/b').length, 0);
        const row = svc.registry.get(key);
        assert.ok(row.not_before - Date.now() > 100 * 1000, 'Retry-After respected');
        const early = await run(key);
        assert.strictEqual(early.runs[0].state, 'rate_limited');
        assert.strictEqual(s.hits('/a').length, 1);
    } finally { await s.close(); }
});

t('one run per source in flight', async () => {
    const s = await site({ '/robots.txt': () => ({ status: 404 }), '/slow': () => ({ delayMs: 300, body: FEED_V1 }) });
    try {
        const key = create(sourceDef({ endpoints: [`${s.origin}/slow`] }));
        const first = run(key);
        await sleep(50);
        const second = await run(key);
        assert.deepStrictEqual(second, { busy: true });
        assert.strictEqual((await first).runs[0].state, 'ok');
        assert.strictEqual(s.hits('/slow').length, 1);
    } finally { await s.close(); }
});

t('disabled sources and missing credentials are recorded as disabled, nothing is requested', async () => {
    const key = create(sourceDef({ endpoints: [`${web.origin}/feed.xml`], enabled: false }));
    const n = web.requests.length;
    const out = await run(key);
    assert.deepStrictEqual([out.runs[0].state, out.runs[0].error_code], ['disabled', 'source_disabled']);
    const key2 = create(sourceDef({ endpoints: [`${web.origin}/feed.xml`], auth: { mode: 'bearer', env: 'SOURCES_CRED_NOT_SET' } }));
    const out2 = await run(key2);
    assert.deepStrictEqual([out2.runs[0].state, out2.runs[0].error_code], ['disabled', 'credential_missing']);
    assert.match(out2.runs[0].detail, /SOURCES_CRED_NOT_SET/);
    assert.strictEqual(web.requests.length, n);
});

t('a credential is read by name, sent only to its origin, and never stored', async () => {
    const other = await site({ '/robots.txt': () => ({ status: 404 }), '/landing': () => ({ body: FEED_V1 }) });
    const s = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/api': () => ({ status: 302, headers: { Location: `${other.origin}/landing` } }),
    });
    const secret = 'sk_test_' + 'q'.repeat(24);
    const svc2 = await boot({ env: { SOURCES_CRED_EXAMPLE: secret } });
    try {
        svc2.registry.create(sourceDef({ key: 'cred', endpoints: [`${s.origin}/api`], auth: { mode: 'header', env: 'SOURCES_CRED_EXAMPLE', header: 'X-Api-Key' } }), 'test');
        const out = await svc2.ingest.run('cred', { trigger: 'manual' });
        assert.strictEqual(out.runs[0].state, 'ok');
        assert.strictEqual(s.hits('/api')[0].headers['x-api-key'], secret);
        assert.strictEqual(other.hits('/landing')[0].headers['x-api-key'], undefined, 'not forwarded across origins');
        const dump = JSON.stringify(svc2.db.prepare('SELECT * FROM sources').all()) + JSON.stringify(svc2.db.prepare('SELECT * FROM fetch_runs').all())
            + JSON.stringify(svc2.db.prepare('SELECT * FROM items').all()) + JSON.stringify(svc2.outbox.all());
        assert.ok(!dump.includes(secret), 'the secret value is nowhere in the database or events');
        assert.ok(dump.includes('SOURCES_CRED_EXAMPLE'), 'the variable name is recorded');
    } finally { await svc2.stop(); await s.close(); await other.close(); }
});

t('removal is explicit and sticky; the next fetch does not bring the item back', async () => {
    const key = 'news-a';
    const a = itemsOf(key).find(i => i.identity === 'a-1');
    const source = svc.registry.fromRow(svc.registry.get(key));
    const removed = svc.items.remove(source, a.id, 'publisher takedown request', 'svc:network');
    assert.ok(removed.removed && /takedown/.test(removed.removed.reason));
    reset(key);
    feedEtag = '"v9"';
    feedBody = FEED_V1;
    await run(key);
    const again = svc.items.get(a.id);
    assert.ok(again.removed, 'still removed');
    assert.ok(events('sources.item.removed').some(e => e.payload.item_id === a.id));
});

t('JSON-LD and sitemap sources ingest end to end', async () => {
    const s = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n' }),
        '/p/widget-pro': () => ({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: fixture('product.html') }),
        '/sitemap.xml': () => ({ headers: { 'Content-Type': 'application/xml' }, body: fixture('sitemap.xml') }),
    });
    try {
        const p = create(sourceDef({ type: 'jsonld', category: 'deals', endpoints: [`${s.origin}/p/widget-pro`] }));
        assert.strictEqual((await run(p)).runs[0].state, 'ok');
        const [prod] = itemsOf(p);
        assert.strictEqual(prod.kind, 'product');
        assert.strictEqual(JSON.parse(prod.fields).offers[0].price, '19.99');
        assert.strictEqual(prod.parser_version, 'jsonld@1');
        const sm = create(sourceDef({ type: 'sitemap', category: 'deals', endpoints: [`${s.origin}/sitemap.xml`] }));
        const out = await run(sm);
        assert.deepStrictEqual([out.runs[0].state, out.runs[0].items_created, out.runs[0].items_skipped], ['ok', 2, 1]);
    } finally { await s.close(); }
});

t('sources with search_visibility send staff-only, noindex index documents through the outbox', async () => {
    const s = await site({ '/robots.txt': () => ({ status: 404 }), '/f': () => ({ body: FEED_V1 }) });
    try {
        const key = create(sourceDef({ endpoints: [`${s.origin}/f`], search_visibility: 'members' }));
        await run(key);
        const docs = events('sources.index_document.upserted').filter(e => e.payload.facets.source === key);
        assert.strictEqual(docs.length, 2);
        const d = docs[0].payload;
        assert.deepStrictEqual([d.owner, d.type, d.visibility, d.indexability.decision], ['sources', 'item', 'members', 'noindex']);
        assert.deepStrictEqual(d.acl.groups, ['role:admin', 'role:global_mod']);
        assert.deepStrictEqual(docs[0].subject, { type: 'item', id: d.id, revision: d.revision });
        assert.strictEqual(docs[0].visibility, 'internal');
        const item = itemsOf(key)[0];
        svc.items.remove(svc.registry.fromRow(svc.registry.get(key)), item.id, 'test', null);
        const del = events('sources.index_document.deleted').find(e => e.payload.id === item.id);
        assert.deepStrictEqual(del.payload, { type: 'item', id: item.id, revision: 2 });
        // a source without search_visibility sends none
        assert.ok(!events('sources.index_document.upserted').some(e => e.payload.facets.source === 'news-a'));
    } finally { await s.close(); }
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
