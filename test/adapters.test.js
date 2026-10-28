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

t('RSS 2.0 deal feed (DealNews namespace): price, currency, retailer and end date as stated; malformed ones left out', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:dealnews="https://www.dealnews.com/ns/rss/1.0.htm"><channel><title>D</title>
<item><title>Air Mattress for $67 + free shipping</title><link>https://www.dealnews.com/p/1.html?iref=rss</link><guid>https://www.dealnews.com/1.html</guid>
<dealnews:retailer>Amazon</dealnews:retailer><dealnews:expires>2027-01-13T19:54:28-05:00</dealnews:expires><dealnews:price currency="USD">67.00</dealnews:price>
<dealnews:category>Bed &amp; Bath</dealnews:category><dealnews:staffPick>true</dealnews:staffPick></item>
<item><title>Sale at Target</title><link>https://www.dealnews.com/p/2.html</link><guid>https://www.dealnews.com/2.html</guid>
<dealnews:retailer>Target</dealnews:retailer><dealnews:price currency="dollars">about 10</dealnews:price><dealnews:category></dealnews:category><dealnews:staffPick>false</dealnews:staffPick></item>
<item><title>Plain news</title><link>https://www.dealnews.com/p/3.html</link><guid>https://www.dealnews.com/3.html</guid></item>
</channel></rss>`;
    const r = feed.parse(xml, { url: 'https://www.dealnews.com/?rss=1' });
    const [a, b, c] = r.items;
    assert.strictEqual(a.kind, 'article', 'still an article');
    assert.deepStrictEqual([a.fields.price, a.fields.currency, a.fields.seller, a.fields.valid_until], ['67.00', 'USD', 'Amazon', '2027-01-14T00:54:28.000Z']);
    assert.deepStrictEqual([b.fields.price, b.fields.currency, b.fields.seller], [undefined, undefined, 'Target'], 'a price that is not a number is not kept');
    assert.ok(!('price' in c.fields) && !('seller' in c.fields), 'an item that states none has none');
    assert.deepStrictEqual([a.fields.categories, a.fields.staff_pick], [['Bed & Bath'], true], 'its category and editors\' pick as stated');
    assert.deepStrictEqual([b.fields.categories, b.fields.staff_pick], [[], false], 'an empty category is no category');
    assert.ok(!('staff_pick' in c.fields), 'a pick that is not stated is not there');
    assert.strictEqual(feed.PARSER_VERSION, 'feed@3');
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

t('Atom: an entry with only <updated> (GOV.UK) is dated by it, and says so', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>https://www.gov.uk/news</id><title>GOV.UK</title><updated>2026-10-14T12:00:00+01:00</updated>
<entry><id>https://www.gov.uk/government/news/a</id><link rel="alternate" href="https://www.gov.uk/government/news/a"/><title>Rail strategy</title><updated>2026-10-14T11:15:00+01:00</updated><summary>s</summary></entry>
<entry><id>https://www.gov.uk/government/news/b</id><title>Both dates</title><published>2026-10-13T09:00:00Z</published><updated>2026-10-14T09:00:00Z</updated></entry></feed>`;
    const [only, both] = feed.parse(xml, { url: 'https://www.gov.uk/news.atom' }).items;
    assert.strictEqual(only.published_at, '2026-10-14T10:15:00.000Z');
    assert.strictEqual(only.updated_at, '2026-10-14T10:15:00.000Z');
    assert.strictEqual(only.fields.dated_by, 'updated');
    assert.strictEqual(both.published_at, '2026-10-13T09:00:00.000Z', 'a stated <published> wins');
    assert.strictEqual(both.fields.dated_by, undefined);
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
        type: 'Offer', price: '19.99', low_price: null, high_price: null, list_price: null, offer_count: null, currency: 'USD', availability: 'InStock',
        condition: null, valid_until: '2026-12-31T00:00:00.000Z', url: 'https://shop.example.com/p/widget-pro', seller: 'Example Shop',
    });
    assert.strictEqual(p.fields.offers[1].price, null, 'no price on the page = null, never 0 or a guess');
    assert.strictEqual(p.fields.offers[1].list_price, null, 'no priceSpecification = no list price');
    assert.strictEqual(p.fields.offers[1].availability, 'OutOfStock');
    assert.deepStrictEqual(p.fields.aggregate_rating, { value: 4.4, best: null, worst: null, count: null, review_count: 89 });
    assert.deepStrictEqual(p.fields.reviews, [{ author: 'Sam', rating: { value: 5, best: 5, worst: null, count: null, review_count: null }, date: '2026-08-01T00:00:00.000Z' }]);
    assert.ok(!JSON.stringify(p).includes('Long text'), 'embedded review bodies are not stored');
});

t('JSON-LD priceSpecification: list price from ListPrice/StrikethroughPrice/MSRP/SRP as stated, only in the offer\'s currency; SalePrice or an untyped specification fills a missing price', () => {
    const r = jsonld.parse(fx('list-price.html'), { url: 'https://shop.example.com/p/deals' });
    assert.strictEqual(r.items.length, 1);
    const o = r.items[0].fields.offers;
    assert.strictEqual(o.length, 9);
    const [a, b, c, d, e, f, g, h, i] = o;
    assert.strictEqual(a.price, '99.99');
    assert.strictEqual(a.list_price, '129.99', 'the prefixed ListPrice specification, exactly as stated');
    assert.strictEqual(b.list_price, '79.95', 'an unprefixed StrikethroughPrice is read');
    assert.strictEqual(c.list_price, null, 'a list price in EUR on a USD offer is not comparable');
    assert.strictEqual(d.list_price, '99.99', 'MSRP');
    assert.strictEqual(e.list_price, '84.99', 'SRP');
    assert.strictEqual(f.price, '79.00', 'a SalePrice specification supplies the current price when the offer states none');
    assert.strictEqual(f.list_price, null, 'a SalePrice is not a list price');
    assert.strictEqual(g.price, null, 'a SalePrice in another currency does not supply the price');
    assert.strictEqual(h.price, '44.00', 'a specification without priceType supplies the current price');
    assert.strictEqual(i.price, '15.50');
    assert.strictEqual(i.currency, 'GBP', 'a price stated only in the specification brings its currency');
    assert.strictEqual(a.currency, 'USD');
    assert.strictEqual(jsonld.PARSER_VERSION, 'jsonld@2');
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

t('an api summary from HTML longer than the 500-character cap keeps no half tag (Arbeitnow descriptions)', () => {
    const description = `<p><strong>About us</strong></p><p>${'We build things. '.repeat(26)}</p><p><a href="https://example.org/apply">Apply</a></p>`;
    const body = JSON.stringify({ data: [{ slug: 'dev-1', url: 'https://www.arbeitnow.com/jobs/dev-1', title: 'Developer', description, created_at: 1761177600 }] });
    const endpoint = { format: 'json', items_path: 'data', item_kind: 'job', fields: { identity: 'slug', url: 'url', title: 'title', summary: 'description', published_at_epoch: 'created_at' } };
    const [item] = api.parse(body, { url: 'https://www.arbeitnow.com/api/job-board-api', endpoint }).items;
    assert.match(item.summary, /^About us We build things\./);
    assert.ok(!/[<>]/.test(item.summary), `no markup left: ${item.summary.slice(-60)}`);
});

t('api extra_lists keep an array of scalars as a list (tags, job types); extra still reads an array as null', () => {
    const body = JSON.stringify({ data: [
        { slug: 'a', url: 'https://www.arbeitnow.com/jobs/a', title: 'A', tags: ['Node.js', 'PostgreSQL', { x: 1 }, ''], job_types: ['full time'] },
        { slug: 'b', url: 'https://www.arbeitnow.com/jobs/b', title: 'B', tags: 'Go', job_types: null },
        { slug: 'c', url: 'https://www.arbeitnow.com/jobs/c', title: 'C', tags: Array.from({ length: 30 }, (_, i) => `t${i}`) },
    ] });
    const endpoint = { format: 'json', items_path: 'data', item_kind: 'job', fields: { identity: 'slug', url: 'url', title: 'title' },
        extra: { tags_scalar: 'tags' }, extra_lists: { tags: 'tags', job_types: 'job_types' } };
    assert.strictEqual(api.checkMapping(endpoint), null);
    const [a, b, c] = api.parse(body, { url: 'https://www.arbeitnow.com/api/job-board-api', endpoint }).items;
    assert.deepStrictEqual([a.fields.tags, a.fields.job_types, a.fields.tags_scalar], [['Node.js', 'PostgreSQL'], ['full time'], null]);
    assert.deepStrictEqual([b.fields.tags, b.fields.job_types], [['Go'], []]);
    assert.strictEqual(c.fields.tags.length, 20);
    assert.match(api.checkMapping({ ...endpoint, extra: { tags: 'tags' } }), /also an extra field/);
    assert.match(api.checkMapping({ ...endpoint, extra_lists: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`l${i}`, 'tags'])) }), /at most 10/);
    assert.match(api.checkMapping({ ...endpoint, extra_lists: ['tags'] }), /must be an object/);
});

t.run();
