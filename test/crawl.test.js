'use strict';
/**
 * Crawl sources against stub sites: the registry's crawl settings, sitemaps from robots.txt (indexes, gzip, lastmod),
 * include/exclude and robots.txt on every page, JSON-LD products kept with provenance, recrawl and its growing wait,
 * noindex, canonical duplicates, 404 twice retires a page's items, links followed to max_depth (nofollow and other
 * hosts skipped), page items when structured data is not required, the site failing as the source's failure (robots
 * unreachable, 429), the run budget, the scheduler's crawl limit, and the API.
 */
const assert = require('assert');
const zlib = require('zlib');
const { boot, site, sourceDef, request, serviceToken, suite } = require('./helpers');
const { validateSource } = require('../server/registry');
const page = require('../server/adapters/page');

const t = suite('crawl');
const ADMIN = serviceToken('network', ['sources.source.manage', 'sources.source.read']);
const clock = { offset: 0 };
const DAY = 86400 * 1000;
let svc;
let web;
let price;
let gonePage;

const product = (name, sku, p) => `<!doctype html><html lang="en"><head><title>${name}</title>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, sku,
        offers: { '@type': 'Offer', price: p, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } })}</script></head><body><h1>${name}</h1></body></html>`;
const html = (head, body = '') => ({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: `<!doctype html><html><head>${head}</head><body>${body}</body></html>` });
const xml = (body) => ({ headers: { 'Content-Type': 'application/xml' }, body });
const urlset = (urls) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u =>
    `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('')}</urlset>`;

const frontier = async (key) => await svc.db.prepare('SELECT * FROM crawl_frontier WHERE source_key = ? ORDER BY url').all(key);
const rowOf = async (key, path) => (await frontier(key)).find(r => r.url === `${web.origin}${path}`);
const itemsOf = async (key) => await svc.db.prepare('SELECT * FROM items WHERE source_key = ? ORDER BY identity').all(key);
const runsOf = async (key) => await svc.db.prepare('SELECT * FROM fetch_runs WHERE source_key = ? ORDER BY rid').all(key);
const events = async (type) => (await svc.db.prepare('SELECT envelope FROM service_outbox ORDER BY id').all()).map(r => r.envelope).filter(e => e.event_type === type);
const run = async (key) => await svc.ingest.run(key, { trigger: 'manual' });
const crawlDef = (o = {}) => sourceDef({ type: 'crawl', category: 'deals', endpoints: [`${web.origin}/`], min_interval_ms: 0, ...o });

t('boot', async () => {
    svc = await boot({ now: () => Date.now() + clock.offset });
    price = '19.99';
    gonePage = false;
    web = await site({
        '/robots.txt': () => ({ body: `User-agent: *\nDisallow: /private/\nSitemap: ${web.origin}/sitemap-index.xml\n` }),
        '/sitemap-index.xml': () => xml(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <sitemap><loc>${web.origin}/sitemap-products.xml.gz</loc></sitemap><sitemap><loc>https://elsewhere.example/sitemap.xml</loc></sitemap></sitemapindex>`),
        '/sitemap-products.xml.gz': () => ({
            headers: { 'Content-Type': 'application/x-gzip' },
            body: zlib.gzipSync(urlset([
                { loc: `${web.origin}/products/lamp`, lastmod: '2026-10-01' },
                { loc: `${web.origin}/products/chair` },
                { loc: `${web.origin}/products/gone` },
                { loc: `${web.origin}/products/cart-thing` },
                { loc: `${web.origin}/private/secret` },
                { loc: `${web.origin}/about` },
                { loc: `${web.origin}/products/plain` },
                { loc: `${web.origin}/products/hidden` },
                { loc: `${web.origin}/products/lamp-copy` },
                { loc: 'https://elsewhere.example/products/x' },
            ])),
        }),
        '/': () => html('<title>Shop</title>'),
        '/products/lamp': (req) => {
            const body = product('Desk lamp', 'L-1', price);
            const etag = `"lamp-${price}"`;
            if (req.headers['if-none-match'] === etag) return { status: 304 };
            return { headers: { 'Content-Type': 'text/html', ETag: etag }, body };
        },
        '/products/chair': () => ({ headers: { 'Content-Type': 'text/html' }, body: product('Chair', 'C-1', '49.00') }),
        '/products/gone': () => (gonePage ? { status: 404, body: 'gone' } : { headers: { 'Content-Type': 'text/html' }, body: product('Old thing', 'G-1', '5.00') }),
        '/products/cart-thing': () => ({ headers: { 'Content-Type': 'text/html' }, body: product('Never fetched', 'X', '1.00') }),
        '/products/plain': () => html('<title>Plain page</title><meta name="description" content="A page without structured data.">'),
        '/products/hidden': () => ({ headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex' }, body: product('Hidden', 'H-1', '2.00') }),
        '/products/lamp-copy': () => html(`<link rel="canonical" href="${web.origin}/products/lamp"><title>Lamp (copy)</title>`),
        '/private/secret': () => ({ headers: { 'Content-Type': 'text/html' }, body: product('Secret', 'S', '1.00') }),
    });
});

t('the registry fills a crawl source\'s defaults and refuses what does not belong', () => {
    const rec = validateSource({ ...crawlDef({ key: 'c-defaults' }) });
    assert.deepStrictEqual(rec.crawl, {
        sitemaps: true, follow_links: false, include: [], exclude: [], max_pages: 5000, pages_per_run: 100,
        recrawl_sec: 86400, max_depth: 2, require_structured: true,
    });
    assert.strictEqual(validateSource(sourceDef({ key: 'c-rss', endpoints: [`${web.origin}/f.xml`] })).crawl, null);
    assert.throws(() => validateSource(sourceDef({ key: 'c-rss2', endpoints: [`${web.origin}/f.xml`], crawl: {} })), /only for crawl sources/);
    assert.throws(() => validateSource(crawlDef({ key: 'c-bad', crawl: { include: ['(['] } })), /not a regular expression/);
    assert.throws(() => validateSource(crawlDef({ key: 'c-bad2', crawl: { speed: 9 } })), /unknown crawl field speed/);
    assert.throws(() => validateSource(crawlDef({ key: 'c-bad3', crawl: { recrawl_sec: 60 } })), /recrawl_sec/);
    assert.throws(() => validateSource(crawlDef({ key: 'c-bad4', retire_after_sec: 86400 })), /retire_after_sec is for feeds/);
});

t('a crawl reads the sitemaps robots.txt names and keeps the products their pages publish', async () => {
    await svc.registry.create(crawlDef({ key: 'shop', crawl: { include: ['^/products/', '^/private/', '^/about'], exclude: ['cart'] } }), 'test');
    const out = await run('shop');
    const rows = await frontier('shop');
    const by = Object.fromEntries(rows.map(r => [r.url.replace(web.origin, ''), r]));
    // robots.txt's sitemap, the gzip child; never the other host's
    assert.strictEqual(by['/sitemap-index.xml'].found_via, 'robots');
    assert.strictEqual(by['/sitemap-index.xml'].state, 'read');
    assert.strictEqual(by['/sitemap-products.xml.gz'].state, 'read');
    assert.ok(!rows.some(r => r.url.includes('elsewhere.example')), 'nothing from another host');
    // include/exclude and robots.txt decide what joins the frontier
    assert.ok(!by['/products/cart-thing'], 'excluded by pattern');
    assert.ok(!by['/private/secret'], 'disallowed by robots.txt');
    assert.strictEqual(web.hits('/private/secret').length, 0);
    assert.strictEqual(web.hits('/products/cart-thing').length, 0);
    // the seed itself is a page with nothing structured: dropped
    assert.strictEqual(by['/'].state, 'unstructured');
    assert.strictEqual(by['/'].next_fetch_at, null);

    assert.strictEqual(by['/products/lamp'].state, 'kept');
    assert.strictEqual(by['/products/chair'].state, 'kept');
    assert.strictEqual(by['/products/plain'].state, 'unstructured');
    assert.strictEqual(by['/products/hidden'].state, 'noindex');
    assert.strictEqual(by['/products/lamp-copy'].state, 'duplicate');
    assert.strictEqual(by['/about'].state, 'missing', 'a first 404 is checked again tomorrow');
    const items = await itemsOf('shop');
    assert.deepStrictEqual(items.map(i => i.title).sort(), ['Chair', 'Desk lamp', 'Old thing']);
    const lamp = items.find(i => i.title === 'Desk lamp');
    assert.strictEqual(lamp.kind, 'product');
    assert.strictEqual(JSON.parse(lamp.fields).offers[0].price, '19.99');
    assert.strictEqual(lamp.parser_version, 'jsonld@1');
    assert.strictEqual(lamp.last_fetch_run_id, by['/products/lamp'].last_ok_run_id);
    const runs = await runsOf('shop');
    assert.ok(runs.every(r => r.state !== 'parse_error'));
    assert.strictEqual(out.runs.length, runs.length, 'one run row per request');
    assert.strictEqual((await svc.registry.get('shop')).last_state, 'ok');
    assert.strictEqual((await svc.registry.get('shop')).consecutive_failures, 0);
});

t('nothing due: a run requests nothing and the crawl counts as current', async () => {
    const before = web.requests.length;
    const out = await run('shop');
    assert.deepStrictEqual(out.runs, []);
    assert.strictEqual(web.requests.length, before);
    const row = await svc.registry.get('shop');
    assert.strictEqual(row.last_state, 'ok');
});

t('recrawl: a changed price is a new revision, an unchanged page waits longer, a 304 refreshes its items', async () => {
    clock.offset += 2 * DAY;
    price = '17.49';
    await run('shop');
    const lamp = (await itemsOf('shop')).find(i => i.title === 'Desk lamp');
    assert.strictEqual(lamp.revision, 2);
    assert.strictEqual(JSON.parse(lamp.fields).offers[0].price, '17.49');
    const lampRow = await rowOf('shop', '/products/lamp');
    assert.strictEqual(Number(lampRow.interval_sec), 86400, 'a change keeps the base wait');
    const chairRow = await rowOf('shop', '/products/chair');
    assert.strictEqual(Number(chairRow.interval_sec), 129600, 'the same page waits 1.5 times longer');

    clock.offset += 2 * DAY;
    const etagHits = web.hits('/products/lamp').length;
    await run('shop');
    assert.strictEqual(web.hits('/products/lamp').length, etagHits + 1);
    assert.strictEqual(web.hits('/products/lamp').slice(-1)[0].headers['if-none-match'], '"lamp-17.49"');
    const lampRuns = (await runsOf('shop')).filter(r => r.endpoint_url.endsWith('/products/lamp'));
    assert.strictEqual(lampRuns[lampRuns.length - 1].state, 'not_modified');
    const lamp2 = (await itemsOf('shop')).find(i => i.title === 'Desk lamp');
    assert.ok(Number(lamp2.retrieved_at) > Number(lamp.retrieved_at), 'a 304 counts as seeing the item again');
});

t('a page that answers 404 twice is gone and its items are retired', async () => {
    gonePage = true;
    clock.offset += 5 * DAY;
    await run('shop');
    let row = await rowOf('shop', '/products/gone');
    assert.strictEqual(row.state, 'missing');
    assert.strictEqual((await itemsOf('shop')).find(i => i.title === 'Old thing').removed_at, null, 'one 404 is not enough');
    clock.offset += 2 * DAY;
    await run('shop');
    row = await rowOf('shop', '/products/gone');
    assert.strictEqual(row.state, 'gone');
    const old = (await itemsOf('shop')).find(i => i.title === 'Old thing');
    assert.ok(old.removed_at);
    assert.strictEqual(old.removed_reason, 'gone_from_source');
    assert.strictEqual((await svc.registry.get('shop')).consecutive_failures, 0, 'a missing page is not the source failing');
    assert.strictEqual((await events('sources.fetch.failed')).filter(e => e.payload.source_key === 'shop').length, 0);
});

t('a newer lastmod in the sitemap makes a known page due again', async () => {
    const row = await rowOf('shop', '/products/lamp');
    const r = await svc.db.prepare('UPDATE crawl_frontier SET next_fetch_at = ?, last_fetch_at = ? WHERE source_key = ? AND url = ?')
        .run(Date.now() + clock.offset + 10 * DAY, Date.parse('2026-09-01'), 'shop', row.url);
    assert.strictEqual(r.changes, 1);
    // the sitemap's lastmod (2026-10-01) is after that fetch: the next read of the sitemap makes the page due
    await svc.db.prepare("UPDATE crawl_frontier SET next_fetch_at = 0, body_hash = NULL WHERE source_key = 'shop' AND kind = 'sitemap'").run();
    await run('shop');
    const after = await rowOf('shop', '/products/lamp');
    assert.ok(Number(after.last_fetch_at) > Date.parse('2026-09-01'), 'fetched again in the same run');
});

t('links are followed to max_depth on the crawl\'s hosts; nofollow and other hosts are not', async () => {
    const hub = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n' }),
        '/': () => html('<title>Hub</title>', `<a href="/c/1">one</a> <a href="/c/2" rel="nofollow">two</a> <a href="https://elsewhere.example/x">out</a> <a href="/c/1#top">again</a>`),
        '/c/1': () => html('<title>Category</title>', '<a href="/p/1">product</a>'),
        '/p/1': () => ({ headers: { 'Content-Type': 'text/html' }, body: product('Linked', 'P-1', '3.00') }),
        '/c/2': () => html('<title>Two</title>'),
    });
    await svc.registry.create(sourceDef({ key: 'hub', type: 'crawl', category: 'deals', endpoints: [`${hub.origin}/`], min_interval_ms: 0,
        crawl: { sitemaps: false, follow_links: true, max_depth: 1 } }), 'test');
    await run('hub');
    const rows = Object.fromEntries((await svc.db.prepare('SELECT * FROM crawl_frontier WHERE source_key = ?').all('hub')).map(r => [r.url.replace(hub.origin, ''), r]));
    assert.strictEqual(rows['/'].state, 'hub');
    assert.ok(rows['/'].next_fetch_at != null, 'a hub is crawled again');
    assert.strictEqual(Number(rows['/c/1'].depth), 1);
    assert.strictEqual(rows['/c/1'].state, 'unstructured', 'at max_depth its links are not followed, so it is no hub');
    assert.ok(!rows['/c/2'], 'rel=nofollow');
    assert.ok(!rows['/p/1'], 'beyond max_depth');
    assert.ok(!Object.keys(rows).some(k => k.includes('elsewhere')));
    assert.strictEqual(hub.hits('/sitemap.xml').length, 0, 'sitemaps: false');
    await hub.close();
});

t('a source that does not require structured data keeps a page item from the page\'s metadata', async () => {
    const blog = await site({
        '/robots.txt': () => ({ body: '' }),
        '/post': () => html('<title>A post</title><meta name="description" content="What the post says it is about."><meta property="og:image" content="/img.png"><meta property="article:published_time" content="2026-10-20T10:00:00Z">'),
        '/quiet': () => html('<title>Quiet</title><meta name="robots" content="noindex">'),
        '/other-bot': () => ({ headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': 'otherbot: noindex' }, body: '<html><head><title>Other bot</title></head></html>' }),
    });
    await svc.registry.create(sourceDef({ key: 'blog', type: 'crawl', category: 'blog', endpoints: [`${blog.origin}/post`, `${blog.origin}/quiet`, `${blog.origin}/other-bot`], min_interval_ms: 0,
        crawl: { sitemaps: false, require_structured: false } }), 'test');
    await run('blog');
    const items = await itemsOf('blog');
    assert.deepStrictEqual(items.map(i => i.title).sort(), ['A post', 'Other bot']);
    const post = items.find(i => i.title === 'A post');
    assert.strictEqual(post.kind, 'page');
    assert.strictEqual(post.summary, 'What the post says it is about.');
    assert.strictEqual(post.published_at, '2026-10-20T10:00:00.000Z');
    assert.strictEqual(JSON.parse(post.fields).image, `${blog.origin}/img.png`);
    assert.strictEqual(post.parser_version, 'page@1');
    assert.ok(!items.some(i => i.title === 'Quiet'), 'noindex');
    await blog.close();
});

t('X-Robots-Tag scoped to another crawler does not apply; scoped to ours it does', () => {
    assert.deepStrictEqual(page.headerDirectives('otherbot: noindex', 'OpenVibeSources'), { noindex: false, nofollow: false });
    assert.deepStrictEqual(page.headerDirectives('openvibesources: noindex, nofollow', 'OpenVibeSources'), { noindex: true, nofollow: true });
    assert.deepStrictEqual(page.headerDirectives(['none'], 'OpenVibeSources'), { noindex: true, nofollow: true });
    assert.deepStrictEqual(page.headerDirectives('unavailable_after: 2030-01-01', 'OpenVibeSources'), { noindex: false, nofollow: false });
});

t('the site failing is the source failing: robots.txt unreachable, then a 429', async () => {
    let robotsStatus = 500;
    let limited = false;
    const down = await site({
        '/robots.txt': () => (robotsStatus === 200 ? { body: '' } : { status: robotsStatus, body: 'oops' }),
        '/a': () => (limited ? { status: 429, headers: { 'Retry-After': '120' }, body: 'slow down' } : { headers: { 'Content-Type': 'text/html' }, body: product('A', 'A', '1.00') }),
        '/b': () => ({ headers: { 'Content-Type': 'text/html' }, body: product('B', 'B', '1.00') }),
    });
    await svc.registry.create(sourceDef({ key: 'down', type: 'crawl', category: 'deals', endpoints: [`${down.origin}/a`, `${down.origin}/b`], min_interval_ms: 0, crawl: { sitemaps: false } }), 'test');
    let out = await run('down');
    assert.strictEqual(out.runs.length, 1, 'the first page tells: the run stops');
    assert.strictEqual(out.runs[0].state, 'robots_denied');
    assert.strictEqual(down.hits('/a').length, 0);
    let row = await svc.registry.get('down');
    assert.strictEqual(row.consecutive_failures, 1);
    assert.strictEqual(row.last_state, 'robots_denied');
    assert.strictEqual((await events('sources.fetch.failed')).filter(e => e.payload.source_key === 'down').length, 1, 'one event for the run');

    robotsStatus = 200;
    limited = true;
    await svc.robots.forget(down.origin);
    await svc.db.prepare("UPDATE sources SET last_request_at = NULL, not_before = 0 WHERE key = 'down'").run();
    out = await run('down');
    assert.strictEqual(out.runs[out.runs.length - 1].state, 'rate_limited');
    assert.strictEqual(down.hits('/b').length, 0, 'nothing after the site asked us to wait');
    row = await svc.registry.get('down');
    assert.strictEqual(row.consecutive_failures, 2);
    assert.ok(Number(row.not_before) >= Date.now() + clock.offset + 100 * 1000);
    await down.close();
});

t('pages_per_run caps one run, and pages still due bring the next run sooner', async () => {
    const many = await site({
        '/robots.txt': () => ({ body: '' }),
        '*': (req, res, ctx) => ({ headers: { 'Content-Type': 'text/html' }, body: product(`Item ${ctx.url.pathname}`, ctx.url.pathname, '1.00') }),
    });
    await svc.registry.create(sourceDef({ key: 'many', type: 'crawl', category: 'deals', poll_interval_sec: 3600, min_interval_ms: 0,
        endpoints: [1, 2, 3, 4, 5].map(n => `${many.origin}/p/${n}`), crawl: { sitemaps: false, pages_per_run: 2 } }), 'test');
    const out = await run('many');
    assert.strictEqual(out.runs.length, 2);
    const row = await svc.registry.get('many');
    const soon = Number(row.next_due_at) - Number(row.last_run_at);
    assert.ok(soon <= 60 * 1000, `next run in ${soon} ms, not the poll interval`);
    await many.close();
});

t('the API shows the frontier and starts a crawl without waiting for it', async () => {
    let r = await request(svc.base, 'GET', '/api/v1/sources/shop/crawl', { token: ADMIN });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.crawl.pages >= 8);
    assert.strictEqual(r.body.crawl.pages_by_state.kept, 2);
    assert.strictEqual(r.body.crawl.pages_by_state.gone, 2, '/products/gone and /about');
    assert.strictEqual(r.body.crawl.sitemaps_by_state.read, 2);
    assert.ok(r.body.crawl.recent.length > 0);
    assert.ok(r.body.crawl.recent[0].url.startsWith(web.origin));
    r = await request(svc.base, 'GET', '/api/v1/sources/nope/crawl', { token: ADMIN });
    assert.strictEqual(r.status, 404);
    await svc.registry.create(sourceDef({ key: 'feedish', endpoints: [`${web.origin}/feed.xml`] }), 'test');
    r = await request(svc.base, 'GET', '/api/v1/sources/feedish/crawl', { token: ADMIN });
    assert.strictEqual(r.status, 409);
    r = await request(svc.base, 'POST', '/api/v1/sources/shop/fetch', { token: ADMIN });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.started, true);
    r = await request(svc.base, 'GET', '/api/v1/sources/shop', { token: ADMIN });
    assert.strictEqual(r.body.source.crawl.max_pages, 5000);
    // let the background run finish before the next test
    for (let i = 0; i < 100 && svc.ingest.inflight().includes('shop'); i++) await new Promise(res => setTimeout(res, 20));
});

t('the scheduler runs at most SOURCES_MAX_CONCURRENT_CRAWLS crawls at once', async () => {
    const two = await boot({ env: { SOURCES_MAX_CONCURRENT_CRAWLS: '1', SOURCES_MAX_CONCURRENT: '4' } });
    const slow = await site({ '/robots.txt': () => ({ body: '' }), '*': () => ({ delayMs: 300, headers: { 'Content-Type': 'text/html' }, body: product('S', 'S', '1.00') }) });
    for (const k of ['crawl-a', 'crawl-b']) await two.registry.create(sourceDef({ key: k, type: 'crawl', category: 'deals', endpoints: [`${slow.origin}/${k}`], min_interval_ms: 0, crawl: { sitemaps: false } }), 'test');
    await two.registry.create(sourceDef({ key: 'feed-c', endpoints: [`${slow.origin}/feed.xml`] }), 'test');
    const started = await two.scheduler.tick();
    assert.deepStrictEqual(started.sort(), ['crawl-a', 'feed-c']);
    for (let i = 0; i < 200 && two.scheduler.active().length; i++) await new Promise(res => setTimeout(res, 20));
    await two.stop();
    await slow.close();
});

t('teardown', async () => {
    await svc.stop();
    await web.close();
});

t.run();
