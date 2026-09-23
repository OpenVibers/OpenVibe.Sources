'use strict';
/** Read and admin API: capabilities, registry validation, items paging, manual items, removal, health. */
const assert = require('assert');
const { boot, request, serviceToken, site, sourceDef, rss, suite } = require('./helpers');

const t = suite('api');
let svc;
let web;
const ADMIN = serviceToken('network', ['sources.source.manage']);
const READER = serviceToken('news', ['sources.source.read', 'sources.item.read']);
const ITEMS_ONLY = serviceToken('deals', ['sources.item.read']);

const api = (method, p, opts = {}) => request(svc.base, method, p, opts);

t('boot', async () => {
    svc = await boot();
    web = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/feed.xml': () => ({ body: rss([1, 2, 3, 4, 5].map(i => ({ guid: `g${i}`, title: `Item ${i}`, link: `https://example.org/${i}` }))) }),
    });
});

t('every route needs a service token with its one capability', async () => {
    assert.strictEqual((await api('GET', '/api/v1/sources')).status, 401);
    assert.strictEqual((await api('GET', '/api/v1/sources', { token: ITEMS_ONLY })).status, 403);
    assert.strictEqual((await api('GET', '/api/v1/items', { token: serviceToken('news', ['sources.source.read']) })).status, 403);
    assert.strictEqual((await api('POST', '/api/v1/sources', { token: READER, body: sourceDef() })).status, 403);
    assert.strictEqual((await api('GET', '/api/v1/sources', { token: serviceToken('news', ['sources.source.read'], { aud: 'openvibe.search' }) })).status, 401);
    assert.strictEqual((await api('GET', '/api/v1/sources', { token: serviceToken('news', ['sources.*']) })).status, 200, 'a family grant covers it');
});

t('registry validation: terms before enabling, credentials by SOURCES_CRED_ name only, sane types', async () => {
    const bad = async (def, re) => {
        const r = await api('POST', '/api/v1/sources', { token: ADMIN, body: def });
        assert.strictEqual(r.status, 422, JSON.stringify(def));
        assert.match(r.body.detail, re);
    };
    await bad(sourceDef({ terms_note: undefined, endpoints: ['https://example.org/feed'] }), /terms_note/);
    await bad(sourceDef({ robots_note: undefined, endpoints: ['https://example.org/feed'] }), /robots_note/);
    await bad(sourceDef({ endpoints: ['https://example.org/feed'], auth: { mode: 'bearer', env: 'OV_OAUTH_CLIENT_SECRET' } }), /SOURCES_CRED_/);
    await bad(sourceDef({ endpoints: ['https://example.org/feed'], auth: { mode: 'bearer', env: 'SOURCES_CRED_XX', value: 'secret' } }), /unknown auth field/);
    await bad(sourceDef({ endpoints: ['https://example.org/feed'], auth: { mode: 'header', env: 'SOURCES_CRED_XX', header: 'Cookie' } }), /header/);
    await bad(sourceDef({ endpoints: ['file:///etc/passwd'] }), /http/);
    await bad(sourceDef({ endpoints: [] }), /endpoint/);
    await bad(sourceDef({ type: 'manual', endpoints: ['https://example.org/'] }), /manual/);
    await bad(sourceDef({ category: 'gossip', endpoints: ['https://example.org/'] }), /category/);
    await bad(sourceDef({ type: 'api', endpoints: [{ url: 'https://api.example.org/', fields: { title: 'x' } }] }), /identity/);
    await bad(sourceDef({ endpoints: ['https://example.org/'], sensitivity: 'financial', default_indexability: 'index', review_required: false }), /review/);
    // disabled without notes is fine: a proposal waiting for review
    const draft = await api('POST', '/api/v1/sources', { token: ADMIN, body: { key: 'proposal', name: 'Proposal', type: 'rss', category: 'blog', endpoints: ['https://example.org/feed'] } });
    assert.strictEqual(draft.status, 201);
    assert.deepStrictEqual([draft.body.source.enabled, draft.body.source.review_required, draft.body.source.default_indexability], [false, true, 'noindex']);
    assert.strictEqual(draft.body.source.health.status, 'disabled');
    assert.strictEqual((await api('POST', '/api/v1/sources', { token: ADMIN, body: { key: 'proposal', name: 'x', type: 'rss', category: 'blog', endpoints: ['https://example.org/f'] } })).status, 409);
    const enable = await api('PATCH', '/api/v1/sources/proposal', { token: ADMIN, body: { enabled: true } });
    assert.strictEqual(enable.status, 422);
    assert.strictEqual(enable.body.code, 'sources.terms_required');
});

t('create, read, fetch, list runs; views never carry a credential value', async () => {
    const def = sourceDef({ key: 'feed-a', endpoints: [`${web.origin}/feed.xml`], auth: { mode: 'query', env: 'SOURCES_CRED_FEED_A', param: 'key' } });
    const c = await api('POST', '/api/v1/sources', { token: ADMIN, body: def });
    assert.strictEqual(c.status, 201);
    assert.deepStrictEqual(c.body.source.auth, { mode: 'query', env: 'SOURCES_CRED_FEED_A', param: 'key' });
    // the variable is not set in this process: the fetch is recorded as disabled
    let f = await api('POST', '/api/v1/sources/feed-a/fetch', { token: ADMIN });
    assert.strictEqual(f.body.runs[0].state, 'disabled');
    await api('PATCH', '/api/v1/sources/feed-a', { token: ADMIN, body: { auth: { mode: 'none' } } });
    svc.db.prepare('UPDATE sources SET last_request_at = NULL').run();
    f = await api('POST', '/api/v1/sources/feed-a/fetch', { token: ADMIN });
    assert.strictEqual(f.status, 200);
    assert.deepStrictEqual(f.body.runs.map(r => [r.state, r.items.created]), [['ok', 5]]);
    const runs = await api('GET', '/api/v1/sources/feed-a/runs', { token: READER });
    assert.deepStrictEqual(runs.body.runs.map(r => r.state), ['ok', 'disabled']);
    const all = await api('GET', '/api/v1/runs?state=failed', { token: READER });
    assert.strictEqual(all.status, 200);
    const one = await api('GET', '/api/v1/sources/feed-a', { token: READER });
    assert.strictEqual(one.body.source.health.status, 'healthy');
    assert.strictEqual((await api('GET', '/api/v1/sources/nope', { token: READER })).status, 404);
});

t('items page in change order and carry provenance and source staleness', async () => {
    const p1 = await api('GET', '/api/v1/items?source=feed-a&limit=2', { token: ITEMS_ONLY });
    assert.strictEqual(p1.status, 200);
    assert.strictEqual(p1.body.items.length, 2);
    assert.strictEqual(p1.body.more, true);
    const p2 = await api('GET', `/api/v1/items?source=feed-a&limit=10&after=${p1.body.next_after}`, { token: ITEMS_ONLY });
    assert.strictEqual(p2.body.items.length, 3);
    assert.strictEqual(p2.body.more, false);
    const it = p1.body.items[0];
    assert.ok(it.provenance.retrieved_at && it.provenance.content_hash && it.provenance.raw_body_hash && it.provenance.parser_version === 'feed@1');
    assert.strictEqual(it.provenance.terms_note, 'test fixture');
    assert.deepStrictEqual(Object.keys(p1.body.sources), ['feed-a']);
    assert.strictEqual(p1.body.sources['feed-a'].stale, false);
    const byCat = await api('GET', '/api/v1/items?category=news', { token: ITEMS_ONLY });
    assert.strictEqual(byCat.body.items.length, 5);
    assert.strictEqual((await api('GET', '/api/v1/items?category=gossip', { token: ITEMS_ONLY })).status, 400);
    // resume after the last page: nothing new yet
    const tail = await api('GET', `/api/v1/items?source=feed-a&after=${p2.body.next_after}`, { token: ITEMS_ONLY });
    assert.deepStrictEqual([tail.body.items.length, tail.body.next_after], [0, p2.body.next_after]);
});

t('removal needs a reason, is visible with include_removed, and appears in the change feed', async () => {
    const list = await api('GET', '/api/v1/items?source=feed-a', { token: ITEMS_ONLY });
    const target = list.body.items[0];
    const last = list.body.next_after;
    assert.strictEqual((await api('DELETE', `/api/v1/items/${target.id}`, { token: ADMIN, body: {} })).status, 422);
    const del = await api('DELETE', `/api/v1/items/${target.id}`, { token: ADMIN, body: { reason: 'licence withdrawn' } });
    assert.strictEqual(del.status, 200);
    assert.match(del.body.item.removed.reason, /licence withdrawn \(by svc:network\)/);
    const feed = await api('GET', `/api/v1/items?source=feed-a&after=${last}&include_removed=1`, { token: ITEMS_ONLY });
    assert.deepStrictEqual(feed.body.items.map(i => [i.id, Boolean(i.removed)]), [[target.id, true]]);
    const hidden = await api('GET', `/api/v1/items?source=feed-a&after=${last}`, { token: ITEMS_ONLY });
    assert.strictEqual(hidden.body.items.length, 0);
    const one = await api('GET', `/api/v1/items/${target.id}?revisions=1`, { token: ITEMS_ONLY });
    assert.deepStrictEqual(one.body.item.revisions.map(r => r.revision), [1, 2]);
    assert.strictEqual((await api('DELETE', '/api/v1/sources/feed-a', { token: ADMIN })).status, 409, 'a source with items cannot be deleted');
    const gone = await api('DELETE', '/api/v1/sources/proposal', { token: ADMIN });
    assert.strictEqual(gone.status, 204, gone.text + JSON.stringify(svc.db.prepare('SELECT key FROM sources').all()));
});

t('manual sources: items need an evidence URL; fetches are refused', async () => {
    const m = await api('POST', '/api/v1/sources', { token: ADMIN, body: { key: 'staff-coupons', name: 'Staff-entered codes', type: 'manual', category: 'coupons', terms_note: 'codes the merchant published itself', enabled: true } });
    assert.strictEqual(m.status, 201);
    assert.strictEqual(m.body.source.health.status, 'manual');
    assert.strictEqual((await api('POST', '/api/v1/sources/staff-coupons/fetch', { token: ADMIN })).status, 409);
    assert.strictEqual((await api('POST', '/api/v1/sources/staff-coupons/items', { token: ADMIN, body: { title: 'SAVE10' } })).status, 422);
    assert.strictEqual((await api('POST', '/api/v1/sources/staff-coupons/items', { token: ADMIN, body: { title: 'SAVE10', url: 'https://merchant.example/promo', published_at: 'soon' } })).status, 422);
    const add = await api('POST', '/api/v1/sources/staff-coupons/items', { token: ADMIN, body: {
        title: 'SAVE10', url: 'https://merchant.example/promo?utm_source=x', kind: 'coupon', fields: { code: 'SAVE10', expires: null },
    } });
    assert.strictEqual(add.status, 201);
    assert.strictEqual(add.body.item.canonical_url, 'https://merchant.example/promo');
    assert.strictEqual(add.body.item.fields.expires, null, 'unknown expiry stays unknown');
    assert.strictEqual(add.body.item.provenance.entered_by, 'svc:network');
    assert.strictEqual(add.body.item.provenance.parser_version, 'manual@1');
    const again = await api('POST', '/api/v1/sources/staff-coupons/items', { token: ADMIN, body: { title: 'SAVE10', url: 'https://merchant.example/promo', kind: 'coupon', fields: { code: 'SAVE10', expires: null } } });
    assert.strictEqual(again.body.outcome, 'unchanged');
    assert.strictEqual((await api('POST', '/api/v1/sources/feed-a/items', { token: ADMIN, body: { title: 'x', url: 'https://x.example/' } })).status, 409);
});

t('health lists what needs attention', async () => {
    await api('POST', '/api/v1/sources', { token: ADMIN, body: sourceDef({ key: 'never', endpoints: ['https://example.org/feed'] }) });
    const h = await api('GET', '/api/v1/health', { token: READER });
    assert.strictEqual(h.status, 200);
    assert.ok(h.body.counts.healthy >= 1 && h.body.counts.manual === 1);
    assert.ok(h.body.attention.some(a => a.key === 'never' && a.status === 'never_fetched'));
    const ready = await api('GET', '/api/ready');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual(ready.body.checks.db, true);
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
