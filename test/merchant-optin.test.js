'use strict';
/**
 * Merchant opt-in (plan §4.4 channel 1): a signed-in merchant proves a domain with DNS or a meta tag, a source is
 * created only then with an explicit-permission terms note, the crawler still obeys robots.txt, and withdrawal
 * disables the source while keeping the note. Also covers the JSON read Report calls, including last crawl stats.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, serviceToken, userToken, site, fixture, suite } = require('./helpers');

const t = suite('merchant-optin');
let svc;
let shopWeb;
let metaWeb;
let blockedWeb;
let dns;
let shopClaim;
let shopSourceKey;

const ALICE = ids.newId('user');
const BOB = ids.newId('user');
const ALICE_TOKEN = userToken(ALICE, { username: 'alice' });
const BOB_TOKEN = userToken(BOB, { username: 'bob' });
const READER = serviceToken('report', ['sources.source.read']);
const ADMIN = serviceToken('network', ['sources.source.manage']);

const api = (method, p, opts = {}) => request(svc.base, method, p, opts);

t('boot: a stub shop, meta site and a robots-closed site, with an injectable TXT resolver', async () => {
    dns = {
        records: new Map(),
        async resolveTxt(name) {
            if (!this.records.has(name)) { const err = new Error('no record'); err.code = 'ENOTFOUND'; throw err; }
            return this.records.get(name);
        },
        set(domain, value) { this.records.set(`_openvibe-sources.${domain}`, [[value]]); },
    };
    // Every stub name resolves to the loopback server; SOURCES_ALLOW_PRIVATE_HOSTS exempts the names below.
    const lookupImpl = (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    shopWeb = await site({});
    metaWeb = await site({});
    blockedWeb = await site({});
    const shopBase = `http://shop.example.com:${new URL(shopWeb.origin).port}`;
    const metaBase = `http://meta.example.com:${new URL(metaWeb.origin).port}`;
    const blockedBase = `http://blocked.example.com:${new URL(blockedWeb.origin).port}`;

    shopWeb.routes['/robots.txt'] = () => ({ body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } });
    shopWeb.routes['/sitemap.xml'] = () => ({
        body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${shopBase}/products/1</loc></url></urlset>`,
        headers: { 'content-type': 'application/xml' },
    });
    shopWeb.routes['/products/1'] = () => ({ body: fixture('product.html'), headers: { 'content-type': 'text/html' } });

    let metaToken = '';
    metaWeb.routes['/robots.txt'] = () => ({ body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } });
    metaWeb.routes['/'] = () => ({
        body: `<!doctype html><html><head><meta name="openvibe-sources-verification" content="${metaToken}"><title>Meta Shop</title></head><body>meta</body></html>`,
        headers: { 'content-type': 'text/html' },
    });
    metaWeb.routes['/feed.xml'] = () => ({
        body: '<?xml version="1.0"?><rss version="2.0"><channel><title>Meta Shop</title><item><guid>p1</guid><title>Product one</title><link>https://meta.example.com/p/1</link><description>One.</description></item></channel></rss>',
        headers: { 'content-type': 'application/rss+xml' },
    });

    blockedWeb.routes['/robots.txt'] = () => ({ body: 'User-agent: *\nDisallow: /\n', headers: { 'content-type': 'text/plain' } });
    blockedWeb.routes['/sitemap.xml'] = () => ({ body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', headers: { 'content-type': 'application/xml' } });

    svc = await boot({
        resolver: dns,
        lookupImpl,
        env: {
            BASE_URL: 'https://sources.test',
            SOURCES_ALLOW_PRIVATE_HOSTS: '127.0.0.1,shop.example.com,meta.example.com,blocked.example.com',
        },
    });
    svc.metaBase = metaBase;
    svc.shopBase = shopBase;
    svc.blockedBase = blockedBase;
    svc.setMetaToken = (v) => { metaToken = v; };
});

t('a pending claim creates no source; verification creates one with who/when/how in its terms note', async () => {
    const c = await api('POST', '/api/v1/merchant/sources', { token: ALICE_TOKEN, body: {
        domain: 'shop.example.com', store_name: 'Example Shop', method: 'dns', listing_kind: 'sitemap',
        listing_url: `${svc.shopBase}/sitemap.xml`,
    } });
    assert.strictEqual(c.status, 201, c.text);
    shopClaim = c.body.merchant_source;
    assert.deepStrictEqual([shopClaim.status, shopClaim.source_key, shopClaim.method], ['pending', null, 'dns']);
    assert.strictEqual(shopClaim.verification.challenge.name, '_openvibe-sources.shop.example.com');
    assert.match(shopClaim.verification.challenge.value, /^openvibe-sources-verification=[a-f0-9]{40}$/);
    assert.strictEqual((await svc.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE key LIKE 'merchant-%'").get()).n, 0, 'no source before verification');

    const before = await api('POST', `/api/v1/merchant/sources/${shopClaim.id}/verify`, { token: ALICE_TOKEN });
    assert.strictEqual(before.status, 200);
    assert.deepStrictEqual([before.body.verified, before.body.merchant_source.status, before.body.merchant_source.source_key], [false, 'pending', null]);
    assert.match(before.body.merchant_source.verification.last_error, /no TXT record/);

    dns.set('shop.example.com', shopClaim.verification.challenge.value);
    const after = await api('POST', `/api/v1/merchant/sources/${shopClaim.id}/verify`, { token: ALICE_TOKEN });
    assert.strictEqual(after.status, 200, after.text);
    assert.deepStrictEqual([after.body.verified, after.body.merchant_source.status, after.body.source_created], [true, 'verified', true]);
    shopSourceKey = after.body.merchant_source.source_key;
    assert.match(shopSourceKey, /^merchant-shop-example-com-[a-z0-9]{8}$/);
    const terms = after.body.merchant_source.terms_note;
    assert.ok(terms.length <= 2000);
    for (const bit of [ALICE, 'alice', 'explicit permission', 'shop.example.com', 'sitemap', 'DNS TXT record', 'robots.txt', 'withdraw']) {
        assert.ok(terms.includes(bit), `terms note should mention ${bit}`);
    }

    const source = await api('GET', `/api/v1/sources/${shopSourceKey}`, { token: READER });
    assert.strictEqual(source.status, 200);
    assert.deepStrictEqual([source.body.source.enabled, source.body.source.type, source.body.source.category], [true, 'crawl', 'deals']);
    assert.strictEqual(source.body.source.endpoints[0].url, `${svc.shopBase}/sitemap.xml`);
    assert.strictEqual(source.body.source.terms_note, terms);
    assert.match(source.body.source.robots_note, /robots\.txt/);
    assert.strictEqual(source.body.source.crawl.sitemaps, false, 'the merchant named this sitemap; no guessed ones');
});

t('the crawl reads the named sitemap and the merchant read reports its last run and frontier', async () => {
    const out = await svc.ingest.run(shopSourceKey, { trigger: 'manual' });
    assert.deepStrictEqual(out.runs.map(r => r.state), ['ok', 'ok']);
    assert.strictEqual(out.runs[1].items_created, 1);

    const read = await api('GET', '/api/v1/merchant/sources', { token: ALICE_TOKEN });
    assert.strictEqual(read.status, 200);
    const listed = read.body.sources.find(s => s.id === shopClaim.id);
    assert.ok(listed);
    assert.deepStrictEqual([listed.source.enabled, listed.source.health.status], [true, 'healthy']);
    assert.strictEqual(listed.last_run.state, 'ok');
    assert.strictEqual(listed.last_run.items.created, 1);
    assert.strictEqual(listed.last_crawl.pages, 1);
    assert.strictEqual(listed.last_crawl.pages_by_state.kept, 1);
    assert.ok(listed.last_crawl.recent.some(p => p.url.endsWith('/products/1') && p.state === 'kept'));

    // Report reads the same by naming the merchant it acts for.
    const report = await api('GET', '/api/v1/merchant/sources', { token: READER, headers: { 'X-OV-Subject': ALICE } });
    assert.strictEqual(report.status, 200);
    assert.strictEqual(report.body.sources[0].last_crawl.pages, 1);
    assert.strictEqual((await api('GET', '/api/v1/merchant/sources', { token: READER })).status, 400);
    // Another merchant sees nothing of this claim, even by id.
    assert.strictEqual((await api('GET', `/api/v1/merchant/sources/${shopClaim.id}`, { token: BOB_TOKEN })).status, 404);
    assert.strictEqual((await api('GET', '/api/v1/merchant/sources', { token: BOB_TOKEN })).body.sources.length, 0);
});

t('withdrawal disables the source and keeps the permission note', async () => {
    const before = await api('GET', `/api/v1/merchant/sources/${shopClaim.id}`, { token: ALICE_TOKEN });
    const w = await api('POST', `/api/v1/merchant/sources/${shopClaim.id}/withdraw`, { token: ALICE_TOKEN });
    assert.strictEqual(w.status, 200, w.text);
    assert.strictEqual(w.body.merchant_source.status, 'withdrawn');
    assert.strictEqual(w.body.merchant_source.terms_note, before.body.merchant_source.terms_note, 'the note is kept verbatim');
    assert.strictEqual(w.body.merchant_source.source.enabled, false);
    assert.strictEqual(w.body.merchant_source.source.health.status, 'disabled');
    assert.ok(w.body.merchant_source.withdrawal.at);

    const source = await api('GET', `/api/v1/sources/${shopSourceKey}`, { token: READER });
    assert.deepStrictEqual([source.body.source.enabled, source.body.source.terms_note], [false, before.body.merchant_source.terms_note]);
    assert.strictEqual((await api('POST', `/api/v1/merchant/sources/${shopClaim.id}/verify`, { token: ALICE_TOKEN })).status, 409);
    // A withdrawn claim frees the domain: the merchant may opt in again (a new claim, a new source).
    assert.strictEqual((await api('POST', '/api/v1/merchant/sources', { token: ALICE_TOKEN, body: {
        domain: 'shop.example.com', method: 'dns', listing_kind: 'feed', listing_url: `${svc.shopBase}/feed.xml`,
    } })).status, 201);
});

t('a meta tag proves control and a product feed becomes an enabled rss source', async () => {
    const c = await api('POST', '/api/v1/merchant/sources', { token: ALICE_TOKEN, body: {
        domain: 'meta.example.com', method: 'meta', meta_url: `${svc.metaBase}/`, listing_kind: 'feed',
        listing_url: `${svc.metaBase}/feed.xml`,
    } });
    assert.strictEqual(c.status, 201, c.text);
    const claim = c.body.merchant_source;
    assert.strictEqual(claim.verification.challenge.name, 'openvibe-sources-verification');
    const before = await api('POST', `/api/v1/merchant/sources/${claim.id}/verify`, { token: ALICE_TOKEN });
    assert.strictEqual(before.body.verified, false);
    assert.match(before.body.merchant_source.verification.last_error, /no openvibe-sources-verification meta tag/);

    svc.setMetaToken(claim.verification.challenge.value);
    const after = await api('POST', `/api/v1/merchant/sources/${claim.id}/verify`, { token: ALICE_TOKEN });
    assert.strictEqual(after.status, 200, after.text);
    assert.deepStrictEqual([after.body.verified, after.body.merchant_source.status], [true, 'verified']);
    assert.match(after.body.merchant_source.terms_note, /meta tag at/);
    const source = await api('GET', `/api/v1/sources/${after.body.merchant_source.source_key}`, { token: READER });
    assert.deepStrictEqual([source.body.source.enabled, source.body.source.type], [true, 'rss']);
    const run = await svc.ingest.run(after.body.merchant_source.source_key, { trigger: 'manual' });
    assert.deepStrictEqual(run.runs.map(r => [r.state, r.items_created]), [['ok', 1]]);
});

t('a merchant opt-in still obeys robots.txt: a disallowed site is never read', async () => {
    const c = await api('POST', '/api/v1/merchant/sources', { token: ALICE_TOKEN, body: {
        domain: 'blocked.example.com', method: 'dns', listing_kind: 'sitemap', listing_url: `${svc.blockedBase}/sitemap.xml`,
    } });
    const claim = c.body.merchant_source;
    dns.set('blocked.example.com', claim.verification.challenge.value);
    const v = await api('POST', `/api/v1/merchant/sources/${claim.id}/verify`, { token: ALICE_TOKEN });
    assert.strictEqual(v.body.merchant_source.status, 'verified');
    const key = v.body.merchant_source.source_key;
    const run = await svc.ingest.run(key, { trigger: 'manual' });
    assert.deepStrictEqual(run.runs.map(r => [r.state, r.items_seen, r.items_created]), [['robots_denied', 0, 0]]);
    assert.strictEqual((await svc.db.prepare('SELECT COUNT(*) AS n FROM items WHERE source_key = ?').get(key)).n, 0);
    const read = await api('GET', `/api/v1/merchant/sources/${claim.id}`, { token: ALICE_TOKEN });
    assert.strictEqual(read.body.merchant_source.last_run.state, 'robots_denied');
    assert.strictEqual(read.body.merchant_source.last_crawl.pages, 0);
});

t('domains, listing URLs and duplicate claims are validated', async () => {
    const bad = async (body, re) => {
        const r = await api('POST', '/api/v1/merchant/sources', { token: ALICE_TOKEN, body });
        assert.strictEqual(r.status, 422, JSON.stringify(body) + ' -> ' + r.status + ' ' + r.text);
        assert.match(r.body.detail, re);
    };
    await bad({ domain: 'localhost', method: 'dns', listing_kind: 'sitemap', listing_url: 'https://localhost/sitemap.xml' }, /fully qualified/);
    await bad({ domain: 'shop.example.com', method: 'dns', listing_kind: 'sitemap', listing_url: 'https://evil.example.net/sitemap.xml' }, /on shop\.example\.com/);
    await bad({ domain: 'shop.example.com', method: 'dns', listing_kind: 'feed', listing_url: 'https://shop.example.com/feed.xml?api_key=secret' }, /credential/);
    await bad({ domain: 'shop.example.com', method: 'fax', listing_kind: 'sitemap', listing_url: 'https://shop.example.com/sitemap.xml' }, /method/);
    await bad({ domain: 'shop.example.com', method: 'dns', listing_kind: 'csv', listing_url: 'https://shop.example.com/sitemap.xml' }, /listing_kind/);
    // The second claim from the previous test is pending on shop.example.com.
    const dup = await api('POST', '/api/v1/merchant/sources', { token: BOB_TOKEN, body: {
        domain: 'shop.example.com', method: 'dns', listing_kind: 'sitemap', listing_url: 'https://shop.example.com/sitemap.xml',
    } });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.body.code, 'merchant.domain_taken');

    // `/claims` is the same resource; a first-party service may act for the merchant with X-OV-Subject, and needs manage.
    assert.strictEqual((await api('GET', '/api/v1/merchant/claims', { token: ALICE_TOKEN })).status, 200);
    assert.strictEqual((await api('POST', '/api/v1/merchant/claims', {
        token: READER, headers: { 'X-OV-Subject': ALICE }, body: {
            domain: 'report.example.com', method: 'dns', listing_kind: 'feed', listing_url: 'https://report.example.com/feed.xml',
        },
    })).status, 403);
    const delegated = await api('POST', '/api/v1/merchant/claims', {
        token: ADMIN, headers: { 'X-OV-Subject': ALICE }, body: {
            domain: 'report.example.com', method: 'dns', listing_kind: 'feed', listing_url: 'https://report.example.com/feed.xml',
        },
    });
    assert.strictEqual(delegated.status, 201, delegated.text);
    assert.strictEqual(delegated.body.merchant_source.owner.subject, ALICE);
});

t('done', async () => {
    await shopWeb.close();
    await metaWeb.close();
    await blockedWeb.close();
    await svc.stop();
});

t.run();
