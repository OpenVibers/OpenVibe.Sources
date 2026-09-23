'use strict';
/** Parsers against fixtures: what the source states is kept, what it does not state stays null. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const feed = require('../server/adapters/feed');
const sitemap = require('../server/adapters/sitemap');
const jsonld = require('../server/adapters/jsonld');
const api = require('../server/adapters/api');
const { decodeBody, toIsoDate, canonicalUrl } = require('../server/adapters/util');
const { suite } = require('./helpers');

const t = suite('adapters');
const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

t('RSS 2.0: guid identity, cleaned link, text-only summary, dates, skips', () => {
    const r = feed.parse(fx('rss2.xml'), { url: 'https://news.example.org/feed.xml' });
    assert.strictEqual(r.meta.format, 'rss2');
    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(r.skipped, 2, 'the identity-less item and the duplicate guid');
    const [a, b] = r.items;
    assert.strictEqual(a.identity, 'news-0001');
    assert.strictEqual(a.canonical_url, 'https://news.example.org/2026/09/first-light?id=7', 'tracking params and fragment removed');
    assert.strictEqual(a.title, 'Telescope sees first light');
    assert.strictEqual(a.summary, 'The new telescope & its camera saw first light .');
    assert.ok(!a.summary.includes('alert'), 'scripts are dropped');
    assert.strictEqual(a.published_at, '2026-09-21T14:30:00.000Z');
    assert.deepStrictEqual(a.authors, ['Ada Example']);
    assert.deepStrictEqual(a.fields.categories, ['Astronomy', 'Instruments']);
    assert.deepStrictEqual(a.fields.enclosure, { url: 'https://news.example.org/img/first-light.jpg', type: 'image/jpeg', length: 12345 });
    assert.strictEqual(b.identity, 'https://news.example.org/2026/09/undated');
    assert.strictEqual(b.published_at, null, 'no date in the feed = no date, never "now"');
    assert.deepStrictEqual(b.authors, []);
});

t('Atom: id identity, relative alternate link, html title, bad dates are null', () => {
    const r = feed.parse(fx('atom.xml'), { url: 'https://blog.example.com/feed.atom' });
    assert.strictEqual(r.meta.format, 'atom');
    assert.strictEqual(r.items.length, 2);
    const [a, b] = r.items;
    assert.strictEqual(a.identity, 'tag:blog.example.com,2026:posts/release-2');
    assert.strictEqual(a.canonical_url, 'https://blog.example.com/posts/release-2');
    assert.strictEqual(a.title, 'Release 2.0 notes');
    assert.strictEqual(a.published_at, '2026-09-19T10:00:00.000Z');
    assert.strictEqual(a.updated_at, '2026-09-20T18:30:02.000Z');
    assert.deepStrictEqual(a.authors, ['Grace Example']);
    assert.deepStrictEqual(a.fields.categories, ['releases']);
    assert.strictEqual(b.updated_at, null);
    assert.strictEqual(b.summary, 'Body');
});

t('a large real-world-sized feed with thousands of entities parses (no expansion limit tripped)', () => {
    const items = Array.from({ length: 1500 }, (_, i) => `<item><title>Deal ${i} &amp; more &#8212; $${i}</title><link>https://deals.example.com/d/${i}?a=1&amp;b=2</link><guid>d-${i}</guid></item>`).join('');
    const r = feed.parse(`<?xml version="1.0"?><rss version="2.0"><channel><title>Big &amp; busy</title>${items}</channel></rss>`, { url: 'https://deals.example.com/rss', maxItems: 2000 });
    assert.strictEqual(r.items.length, 1500);
    assert.strictEqual(r.items[7].title, 'Deal 7 & more — $7');
    assert.strictEqual(r.items[7].canonical_url, 'https://deals.example.com/d/7?a=1&b=2');
});

t('RSS 1.0 (RDF)', () => {
    const r = feed.parse(fx('rss1.rdf'), { url: 'https://rdf.example.net/index.rdf' });
    assert.strictEqual(r.meta.format, 'rss1');
    assert.strictEqual(r.items[0].identity, 'https://rdf.example.net/a');
    assert.strictEqual(r.items[0].published_at, '2026-09-18T08:00:00.000Z');
});

t('XML with entity declarations is refused; garbage is a parse error', () => {
    assert.throws(() => feed.parse(fx('xxe.xml'), { url: 'https://x.example/' }), (e) => e.code === 'parse_error' && /entity/.test(e.message));
    assert.throws(() => feed.parse('<html><body>not a feed</body></html>', { url: 'https://x.example/' }), (e) => e.code === 'parse_error');
    assert.throws(() => feed.parse('<rss><channel><item>', { url: 'https://x.example/' }), (e) => e.code === 'parse_error');
});

t('sitemap urlset with the news extension; index lists children without following them', () => {
    const r = sitemap.parse(fx('sitemap.xml'), { url: 'https://deals.example.com/sitemap.xml' });
    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(r.skipped, 1, 'a non-http loc');
    assert.strictEqual(r.items[0].canonical_url, 'https://deals.example.com/offers/1');
    assert.strictEqual(r.items[0].updated_at, '2026-09-21T00:00:00.000Z');
    assert.strictEqual(r.items[0].fields.priority, 0.8);
    assert.strictEqual(r.items[0].title, null);
    assert.strictEqual(r.items[1].title, 'Launch week');
    assert.strictEqual(r.items[1].published_at, '2026-09-20T09:00:00.000Z');
    assert.strictEqual(r.items[1].fields.publication, 'Deals Example');
    const idx = sitemap.parse(fx('sitemap-index.xml'), { url: 'https://deals.example.com/sitemap-index.xml' });
    assert.deepStrictEqual(idx.items.map(i => [i.kind, i.canonical_url]), [
        ['sitemap', 'https://deals.example.com/sitemap-1.xml'], ['sitemap', 'https://deals.example.com/sitemap-2.xml'],
    ]);
});

t('JSON-LD Product: offers as stated, missing price stays null, rating copied not computed, review text not kept', () => {
    const r = jsonld.parse(fx('product.html'), { url: 'https://shop.example.com/p/widget-pro' });
    assert.strictEqual(r.items.length, 1, 'BreadcrumbList and Organization are not items');
    const p = r.items[0];
    assert.strictEqual(p.kind, 'product');
    assert.strictEqual(p.identity, 'https://shop.example.com/p/widget-pro');
    assert.strictEqual(p.title, 'Widget Pro');
    assert.strictEqual(p.summary, 'A very good widget.');
    assert.strictEqual(p.fields.sku, 'WP-100');
    assert.strictEqual(p.fields.gtin, '0012345678905');
    assert.strictEqual(p.fields.brand, 'Example Co');
    assert.deepStrictEqual(p.fields.offers[0], {
        type: 'Offer', price: '19.99', low_price: null, high_price: null, offer_count: null, currency: 'USD', availability: 'InStock',
        condition: null, valid_until: '2026-12-31T00:00:00.000Z', url: 'https://shop.example.com/p/widget-pro', seller: 'Example Shop',
    });
    assert.strictEqual(p.fields.offers[1].price, null, 'no price on the page = null, never 0 or a guess');
    assert.strictEqual(p.fields.offers[1].availability, 'OutOfStock');
    assert.deepStrictEqual(p.fields.aggregate_rating, { value: 4.4, best: null, worst: null, count: null, review_count: 89 });
    assert.deepStrictEqual(p.fields.reviews, [{ author: 'Sam', rating: { value: 5, best: 5, worst: null, count: null, review_count: null }, date: '2026-08-01T00:00:00.000Z' }]);
    assert.ok(!JSON.stringify(p).includes('Long text'), 'embedded review bodies are not stored');
});

t('JSON-LD NewsArticle, Review and BlogPosting; an invalid block is skipped, not fatal', () => {
    const r = jsonld.parse(fx('article.html'), { url: 'https://times.example.org/2026/09/budget' });
    assert.deepStrictEqual(r.items.map(i => i.kind), ['article', 'review', 'article']);
    const [news, review, blog] = r.items;
    assert.strictEqual(news.title, 'Council approves budget');
    assert.strictEqual(news.canonical_url, 'https://times.example.org/2026/09/budget');
    assert.strictEqual(news.published_at, '2026-09-21T05:00:00.000Z');
    assert.deepStrictEqual(news.authors, ['Lee Reporter']);
    assert.strictEqual(news.fields.publisher, 'Example Times');
    assert.strictEqual(review.fields.item_reviewed, 'Widget Pro');
    assert.deepStrictEqual(review.fields.rating, { value: 3, best: 5, worst: null, count: null, review_count: null });
    assert.strictEqual(review.summary, 'Solid, not spectacular.');
    assert.strictEqual(blog.identity, 'https://times.example.org/blog/why-widgets');
    assert.strictEqual(r.skipped, 1, 'the invalid JSON block');
    assert.notStrictEqual(news.identity, review.identity);
});

t('a page without JSON-LD is a parse error, not an empty success', () => {
    assert.throws(() => jsonld.parse(fx('no-jsonld.html'), { url: 'https://x.example/' }), (e) => e.code === 'parse_error');
    assert.throws(() => jsonld.parse('<script type="application/ld+json">nope</script>', { url: 'https://x.example/' }), (e) => e.code === 'parse_error');
});

t('API mapping: fields by path, epoch dates, nulls kept, identity-less records skipped', () => {
    const endpoint = {
        format: 'json', items_path: 'deals', item_kind: 'offer',
        fields: { identity: 'dealID', url: 'link', title: 'title', published_at_epoch: 'releaseDate' },
        extra: { sale_price: 'salePrice', normal_price: 'normalPrice', store_id: 'storeID' },
    };
    assert.strictEqual(api.checkMapping(endpoint), null);
    const r = api.parse(fx('deals.json'), { url: 'https://api.example.com/deals', endpoint });
    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(r.skipped, 1);
    assert.deepStrictEqual(r.items[0].fields, { sale_price: '4.99', normal_price: '19.99', store_id: '1' });
    assert.strictEqual(r.items[0].published_at, '2024-09-20T00:00:00.000Z');
    assert.strictEqual(r.items[1].fields.sale_price, null);
    assert.strictEqual(r.items[1].canonical_url, null);
    assert.strictEqual(r.items[1].published_at, null);
    assert.throws(() => api.parse('{"deals": {}}', { url: 'https://api.example.com/', endpoint }), (e) => e.code === 'parse_error');
    assert.throws(() => api.parse('not json', { url: 'https://api.example.com/', endpoint }), (e) => e.code === 'parse_error');
    assert.match(api.checkMapping({ fields: { title: 'a' } }), /identity/);
    assert.match(api.checkMapping({ fields: { identity: 'a b' } }), /malformed/);
});

t('helpers: charset decoding, date and URL strictness', () => {
    const latin = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><x>caf\xe9</x>', 'latin1');
    assert.ok(decodeBody(latin, 'text/xml').includes('café'));
    assert.strictEqual(toIsoDate('1726790400'), null, 'bare numbers are ambiguous');
    assert.strictEqual(toIsoDate('yesterday'), null);
    assert.strictEqual(toIsoDate('1970-01-01'), null, 'implausible years are refused');
    assert.strictEqual(canonicalUrl('javascript:alert(1)'), null);
    assert.strictEqual(canonicalUrl('https://user:pw@example.com/'), null);
    assert.strictEqual(canonicalUrl('HTTPS://Example.COM:443/a?gclid=1&b=2#x'), 'https://example.com/a?b=2');
});

t.run();
